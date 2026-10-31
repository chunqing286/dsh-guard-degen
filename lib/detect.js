/**
 * 统一退化判定器 —— 把四个蓝本各自为战的检测规则收进一套可解释的裁决里。
 *
 * ## 为什么要有这一层
 *
 * `dsh-guard-repeat-output`（短语重复 / 低信息密度）、
 * `dsh-repetition-suppressor`（精确周期 / 8-gram 塌缩 / 词表多样性）、
 * `@argszero/cordis-plugin-thinking-loop-guard`（相同 delta 连击 / 周期尾巴 / 句单元新颖度）
 * 各自的规则都是对的，但互不知情：阈值口径不同、起点定位不同、处置也不同。
 * 本模块把它们统一成 **一个 Detector → 一个 Verdict**：
 *
 *   - 每条规则是一个独立函数（可单测），命中时返回 `{ onset, evidence, detail }`；
 *   - 同一时刻所有适用规则一起评估，按 (严重度降序, 起点升序) 选出唯一裁决；
 *   - 裁决里的 `onset` 是**字符级绝对起点**，供流式守卫精确切断。
 *
 * 另加一条四个蓝本都没有的规则：`symbol-run` —— 模型输出退化成符号噪声
 * （`⇒ ⇒ ⇒ …` / `★ ★ ★ …`）。本机实测这是 MiniMax 系模型的主要退化形态，
 * 而短语重复、周期性、低熵三类规则都拿它没办法。
 *
 * 再加一条 `unit-run` —— 退化**不一定是单个符号的重复**，也可能是
 * **一个多字符单元的重复**（`⇒⇒§ ⇒⇒§ §` 整段整段地重复）。
 * 这一形态对 `symbol-run` 完全不可见（段与段之间隔着空白与别的符号，
 * 单个符号凑不出 `minRun` 个），对 `phrase-run` 也不可见（那条只认含字母数字的内容短语）。
 *
 * @module lib/detect
 */

/** 关注的符号字符集。默认取实测退化里出现过的全部形态。 */
export const DEFAULT_SYMBOLS = '⇒★·…※☆●◆■▪'

/** 规则严重度（高 → 低）。同严重度时起点更早者胜出。 */
export const RULE_SEVERITY = {
	'symbol-run': 'high',
	'unit-run': 'high',
	'identical-chunks': 'high',
	'exact-cycle': 'high',
	'reasoning-cycle': 'high',
	'phrase-run': 'medium',
	'novelty': 'medium',
	'collapse-gram': 'medium',
	'low-info-dup': 'medium',
	'collapse-token': 'low',
}

/** 规则 id 顺序（GUI 展示顺序）。 */
export const RULE_IDS = Object.keys(RULE_SEVERITY)

/**
 * 每条规则的默认参数。
 *
 * 阈值口径说明：
 * - `symbol-run.minRun = 20`：实测被污染的工程文件里，退化游程长度是 32–93；
 *   正常工程文本里最长的同类符号串只有个位数（`★` 单个标记最多）。
 * - `exact-cycle.minCycleChars = 256` 与 `collapse-*` 的 0.80 阈值直接沿用
 *   suppressor 的标定口径（它用 192 字符窗口标定，低于 0.68 的是正常结构化输出）。
 * - `collapse-gram.gram = 8`：取 4 会误伤 JSON 数组与高度相似的代码行。
 *
 * `channels` 决定规则在哪些通道生效：`reasoning` / `text`。
 * 塌缩类规则的阈值是在 reasoning 的 192 字符窗口上标定的，可见文本里
 * 列表 / 表格 / 代码天然低多样性，默认不启用。
 *
 * `unit-run` 的阈值口径（多字符单元重复）：
 * - `minRepeats = 4`：同一个单元连续出现 4 次才算退化。实测退化样本是 12 次；
 *   正常文本里同一个「符号单元」连续出现 4 次几乎不存在。
 * - `minUnitChars = 3` / `maxUnitChars = 64`：单元本身的长度区间。
 *   单字符不算「多字符单元」（那是 `symbol-run` 的活儿）。
 * - `minDistinctChars = 2`：单元里至少要有两种不同字符。
 *   **同一个符号连成一串**（`⇒⇒⇒…`）是 `symbol-run` 的活儿（阈值 20 个），
 *   这条只管「多字符单元」的重复，两条规则不重复上报同一段退化。
 * - `minSpanChars = 12`：重复段的总跨度下限。挡掉「同一个短符号重复三四次」这种正常写法。
 * - `requireExotic = true`：单元里必须至少有一个**非 ASCII 符号**。
 *   这一条是关键：工程文件里 `});`、`}}`、`| --- |` 这些 ASCII 结构符号天然会重复，
 *   不按「特殊字符族」收口，扫描器会把正常代码和 markdown 表格当成退化。
 *   真正的退化（`⇒⇒§`、`★★☆`）用的都是非 ASCII 的特殊字符。
 */
/**
 * `unit-run` 规则的默认阈值。
 *
 * 单独提出来是为了让**所有**用到这条规则的地方共用同一份口径：
 * 规则表、流式守卫、工具守卫、会话治理、工件治理。
 * 以前每个调用点各写一份字面量，改一处忘一处就会让各层口径不一致。
 */
export const UNIT_RUN_DEFAULTS = {
	minRepeats: 4,
	minUnitChars: 3,
	maxUnitChars: 64,
	minSpanChars: 12,
	minDistinctChars: 2,
	requireExotic: true,
}

export const DEFAULT_RULES = {
	'symbol-run': { on: true, minRun: 20, channels: ['reasoning', 'text'] },
	'unit-run': { on: true, ...UNIT_RUN_DEFAULTS, channels: ['reasoning', 'text'] },
	'identical-chunks': { on: true, maxRepeatedText: 60, channels: ['reasoning', 'text'] },
	'exact-cycle': { on: true, maxCycleChars: 64, minCycleChars: 256, channels: ['reasoning', 'text'] },
	'reasoning-cycle': { on: true, maxCycleChars: 64, minCycleChars: 256, allowSingleContentChar: true, channels: ['reasoning'] },
	'phrase-run': { on: true, minRepeats: 8, minPhraseChars: 4, maxPhraseChars: 64, channels: ['reasoning', 'text'] },
	'novelty': { on: true, minSentences: 64, minUnitChars: 8, maxNoveltyRatio: 0.05, channels: ['reasoning', 'text'] },
	'low-info-dup': { on: true, threshold: 0.8, fragmentChars: 64, minFragments: 8, channels: ['reasoning'] },
	'collapse-gram': { on: true, gram: 8, threshold: 0.8, collapseWindow: 192, collapseMinChars: 96, channels: ['reasoning'] },
	'collapse-token': { on: true, threshold: 0.2, minTokens: 24, collapseWindow: 192, collapseMinChars: 96, channels: ['reasoning'] },
}

/**
 * 规整规则配置：补默认值、夹紧范围、剔除未知 id。
 * @param {unknown} input - 用户配置
 * @returns {Record<string, any>} 规整后的规则表
 */
export function normalizeRules(input) {
	const raw = (input && typeof input === 'object') ? input : {}
	const out = {}
	for (const id of RULE_IDS) {
		const def = DEFAULT_RULES[id]
		const given = (raw[id] && typeof raw[id] === 'object') ? raw[id] : {}
		const merged = { ...def, ...given }
		merged.on = merged.on !== false
		if (!Array.isArray(merged.channels) || merged.channels.length === 0) merged.channels = def.channels
		out[id] = merged
	}
	return out
}

/**
 * 每条规则「调高一档」时动的那个阈值。
 *
 * 误报反馈闭环（`/degen-ack`）不只登记白名单，还会把对应规则的阈值调高一档 ——
 * 阈值只能靠猜的问题，靠「用户点一下误报」来收敛。
 */
export const RULE_RELAX_STEP = {
	'symbol-run': { key: 'minRun', step: 5 },
	'unit-run': { key: 'minRepeats', step: 1 },
	'identical-chunks': { key: 'maxRepeatedText', step: 10 },
	'exact-cycle': { key: 'maxCycleChars', step: 8 },
	'reasoning-cycle': { key: 'maxCycleChars', step: 8 },
	'phrase-run': { key: 'minRepeats', step: 1 },
	'novelty': { key: 'maxNoveltyRatio', step: 0.01 },
	'low-info-dup': { key: 'threshold', step: 0.05 },
	'collapse-gram': { key: 'threshold', step: 0.05 },
	'collapse-token': { key: 'threshold', step: 0.05 },
}

/**
 * 把某条规则的阈值调高一档，返回**新的**规则表（不改原对象）。
 * @param {Record<string, any>} rules - 规则表
 * @param {string} ruleId - 规则 id
 * @param {number} [times] - 调高几档（默认 1）
 * @returns {Record<string, any>} 新的规则表
 */
export function relaxRule(rules, ruleId, times = 1) {
	const current = normalizeRules(rules)
	const next = { ...current, [ruleId]: { ...current[ruleId] } }
	const relax = RULE_RELAX_STEP[ruleId]
	if (!relax) return next
	const step = relax.step * Math.max(1, Number(times) || 1)
	const value = Number(next[ruleId][relax.key] ?? 0) + step
	next[ruleId][relax.key] = relax.key === 'threshold' || relax.key === 'maxNoveltyRatio'
		? Math.min(0.95, Number(value.toFixed(4)))
		: value
	return next
}

/**
 * 在文本中找符号游程。
 *
 * 取**最早一段**而不是最后一段：同一段增量里可能同时出现多段游程，
 * 而守卫必须按时间顺序处理 —— 先折叠（或切断）最早的那一段，
 * 否则后面那段的判定会把前面那段挡在视野外，原始符号就原样进了宿主。
 *
 * @param {string} text - 文本
 * @param {{minRun: number, chars: string, fromIndex?: number}} options - 选项
 * @returns {{char: string, count: number, index: number, length: number} | null} 命中信息
 */
export function findSymbolRun(text, options) {
	const minRun = Math.max(2, Number(options?.minRun) || 20)
	const chars = options?.chars || DEFAULT_SYMBOLS
	const from = Math.max(0, Number(options?.fromIndex) || 0)
	if (typeof text !== 'string' || text.length < minRun) return null
	const isSymbolChar = (char) => char !== undefined && chars.includes(char)
	// 游程内部的空白只认这四种（与原来的正则 `[ \t\r\n]*` 一致）。
	const isRunSpace = (char) => char === ' ' || char === '\t' || char === '\r' || char === '\n'
	let i = from
	while (i < text.length) {
		if (!isSymbolChar(text[i])) {
			i += 1
			continue
		}
		// 从 i 开始的那一整段游程：符号 + 符号之间的空白。
		let count = 0
		let firstChar = ''
		let lastSymbolEnd = i
		let j = i
		while (j < text.length) {
			const char = text[j]
			if (isSymbolChar(char)) {
				if (count === 0) firstChar = char
				count += 1
				lastSymbolEnd = j + 1
				j += 1
				continue
			}
			if (isRunSpace(char)) {
				// 空白只有「后面还跟着符号」才算游程内部。
				let k = j
				while (k < text.length && isRunSpace(text[k])) k += 1
				if (k < text.length && isSymbolChar(text[k])) {
					j = k
					continue
				}
			}
			break
		}
		if (count >= minRun) {
			// `char` 是**那个符号本身**（例如 '⇒'），不是整段游程 ——
			// 复审缺陷 S5：日志与裁决里要能一眼看出命中的是哪个符号。
			return { char: firstChar, count, index: i, length: lastSymbolEnd - i }
		}
		// 这一段不够长：跳过整段继续找（段内更靠后的位置只会更短）。
		i = j > i ? j : i + 1
	}
	return null
}

/**
 * 找出文本末尾那段符号游程的起点。
 *
 * 游程内部允许有空白（与 `findSymbolRun` 的正则一致），所以要连着空白一起往前吞。
 *
 * @param {string} text - 文本
 * @param {number} end - 结束位置（不含）
 * @param {string} [chars] - 符号集
 * @returns {number} 起点；末尾没有游程时返回 -1
 */
export function trailingRunStart(text, chars = DEFAULT_SYMBOLS) {
	if (typeof text !== 'string' || text.length === 0) return -1
	const isSymbolChar = (char) => char !== undefined && chars.includes(char)
	let i = text.length
	// 末尾的空白可能属于游程内部，先跳过
	while (i > 0 && /\s/.test(text[i - 1])) i -= 1
	if (i === 0 || !isSymbolChar(text[i - 1])) return -1
	let start = i - 1
	while (start > 0) {
		let j = start
		while (j > 0 && /\s/.test(text[j - 1])) j -= 1
		if (j === 0 || !isSymbolChar(text[j - 1])) break
		start = j - 1
	}
	return start
}

/**
 * 内容字符（字母或数字）。
 *
 * 「不含字母数字」是符号型内容的判据：内容型短语的重复归 `phrase-run` 管，
 * 这里只管符号型单元的重复，两条规则互不重叠。
 */
const CONTENT_CHAR_RE = /[\p{L}\p{N}]/u

/**
 * 非 ASCII 字符（退化实际使用的那一族「特殊字符」）。
 *
 * ASCII 结构符号（`}`、`)`、`|`、`-`…）在工程文件里天然重复，
 * 把它们算成退化会把代码和 markdown 表格误伤；真正的退化用的是
 * `⇒ ★ § ☆ …` 这类非 ASCII 的特殊字符。
 */
const EXOTIC_CHAR_RE = /[^\x00-\x7F]/u

/**
 * 统计文本里非空白字符的数量（退化「符号数」的口径）。
 * @param {string} value - 文本
 * @returns {number} 非空白字符数
 */
function countNonSpace(value) {
	let count = 0
	for (const char of value) {
		if (!/\s/.test(char)) count += 1
	}
	return count
}

/**
 * 统计一段文本里出现了几种不同的字符。
 * @param {string} value - 文本
 * @returns {number} 不同字符的种数
 */
function countDistinctChars(value) {
	const seen = new Set()
	for (const char of value) seen.add(char)
	return seen.size
}

/**
 * 收一段候选：把「周期 p、匹配长度 L」翻译成一段退化。
 *
 * 匹配串 `[i0, i0 + L)` 上的 `text[i] === text[i + p]`，
 * 意味着 `[i0, i0 + L + p)` 这一段是 p 周期的：
 * 里面是 `repeats` 份单元，最后一份可能是被截断的。
 *
 * @param {string} text - 全文
 * @param {number} i0 - 段首下标
 * @param {number} L - 匹配长度
 * @param {number} p - 周期（字符数）
 * @param {object} opts - 判定参数
 * @param {Array<object>} out - 收集容器
 * @returns {boolean} 是否收下一段退化
 */
function collectUnitRun(text, i0, L, p, opts, out) {
	if (i0 < 0 || L <= 0) return false
	const spanStart = i0
	const spanEnd = i0 + L + p
	const span = spanEnd - spanStart
	// 份数：整份的算一份，末尾被截断的那份**只要还带着内容**也算一份 ——
	// 用户给的退化样本正是这种形态（最后一块没写完）。
	// 末尾只剩空白的不算：那是分隔符，不是又一份单元。
	const whole = Math.floor(span / p)
	const tail = text.slice(spanStart + whole * p, spanEnd)
	const repeats = whole + (tail.trim().length > 0 ? 1 : 0)
	if (repeats < opts.minRepeats) return false
	if (span < opts.minSpanChars) return false
	const unit = text.slice(spanStart, spanStart + p)
	// 单元必须落在「特殊字符族」里：至少含一个非 ASCII 符号。
	// 否则 `});`、`}}`、`| --- |` 这些工程文件里天然重复的 ASCII 结构符号
	// 会被当成退化，把正常代码和 markdown 表格误伤。
	if (opts.requireExotic && !EXOTIC_CHAR_RE.test(unit)) return false
	// 单元至少要含两种不同字符：**同一个符号连成一串**是 `symbol-run` 的活
	// （阈值 20 个），这条只管「多字符单元」的重复，两条规则不重复上报。
	if (countDistinctChars(unit) < opts.minDistinctChars) return false
	out.push({
		start: spanStart,
		end: spanEnd,
		unit,
		unitChars: p,
		repeats,
		count: countNonSpace(text.slice(spanStart, spanEnd)),
	})
	return true
}

/**
 * 在一段「不含字母数字」的文本里找周期重复。
 *
 * 字符级的周期检测：对每个周期 p，找连续满足 `text[i] === text[i + p]`
 * 的位置串，串起来就是一整段 p 周期的重复。
 *
 * 周期从小到大扫，**扫到就停**：周期越小，单元越小、份数越多，
 * 后面的周期（它的倍数）只会给出更少份数的同一段内容。
 *
 * @param {string} text - 全文
 * @param {number} start - 区域起点（含）
 * @param {number} end - 区域终点（不含）
 * @param {object} opts - 判定参数
 * @param {Array<object>} out - 收集容器
 */
function scanSymbolicRegion(text, start, end, opts, out) {
	const length = end - start
	if (length < opts.minSpanChars) return
	// 份数至少要 minRepeats，跨度又只有 length，所以周期不可能太大。
	const maxPeriod = Math.min(opts.maxUnitChars, Math.floor((length - 1) / Math.max(1, opts.minRepeats - 1)))
	for (let p = opts.minUnitChars; p <= maxPeriod; p++) {
		let runStart = -1
		let runLen = 0
		let found = false
		for (let i = start; i + p < end; i++) {
			if (text.charCodeAt(i) === text.charCodeAt(i + p)) {
				if (runLen === 0) runStart = i
				runLen += 1
				continue
			}
			if (runLen > 0) {
				if (collectUnitRun(text, runStart, runLen, p, opts, out)) found = true
			}
			runStart = -1
			runLen = 0
		}
		if (runLen > 0) {
			if (collectUnitRun(text, runStart, runLen, p, opts, out)) found = true
		}
		if (found) break
	}
}

/**
 * 合并重叠的候选段：份数多的留下（周期更小的单元信息量更大）。
 * @param {Array<object>} runs - 候选段
 * @returns {Array<object>} 合并后的段（按起点升序）
 */
function mergeUnitRuns(runs) {
	if (runs.length === 0) return []
	const sorted = [...runs].sort((a, b) => (
		a.start - b.start
		|| b.repeats - a.repeats
		|| (b.end - b.start) - (a.end - a.start)
	))
	const merged = []
	for (const run of sorted) {
		const last = merged[merged.length - 1]
		if (last && run.start < last.end) {
			if (run.repeats > last.repeats) merged[merged.length - 1] = run
			continue
		}
		merged.push(run)
	}
	return merged
}

/**
 * 找出文本里所有「多字符单元重复」的退化段。
 *
 * ## 为什么要有这一条
 *
 * 退化不总是「同一个符号连成一串」（`symbol-run` 管的那种）。
 * 实测还有一种形态：**一个由多个字符组成的单元**被整段整段地重复，例如
 *
 * ```text
 * ⇒⇒§ ⇒⇒§ §
 *
 * ⇒⇒§ ⇒⇒§ §
 * ```
 *
 * 这类内容对 `symbol-run` 完全不可见：段与段之间隔着空白与 `§`，
 * 单个符号凑不出 `minRun`（默认 20）个；`phrase-run` 也看不见它——
 * 那条只认含字母数字的内容短语。
 *
 * ## 判定口径
 *
 * 1. 只在**不含字母数字**的文本区域里找（内容型短语归 `phrase-run`）；
 * 2. 字符级周期检测：区域里存在周期 p（p 个字符为一组），重复份数 ≥ `minRepeats`；
 * 3. 单元还要满足：长度在 `[minUnitChars, maxUnitChars]` 之间、
 *    至少含两种不同字符（`minDistinctChars`）、
 *    含至少一个非 ASCII 特殊字符（`requireExotic`）、
 *    重复段的总跨度 ≥ `minSpanChars`。
 *
 * 「特殊字符族」这条是关键：工程文件里 `});`、`}}`、`| --- |` 这类结构符号
 * 天然会重复，但它们都是 ASCII；真正的退化（`⇒⇒§`、`★★☆`）用的是非 ASCII 的特殊字符。
 *
 * @param {string} text - 文本
 * @param {{minRepeats?: number, minUnitChars?: number, maxUnitChars?: number,
 *          minSpanChars?: number, minDistinctChars?: number,
 *          requireExotic?: boolean, fromIndex?: number}} [options] - 判定参数
 * @returns {Array<{start: number, end: number, unit: string, unitChars: number,
 *                  repeats: number, count: number}>} 退化段列表（按起点升序，end 为开区间）
 */
export function findUnitRuns(text, options = {}) {
	const minRepeats = Math.max(2, Number(options?.minRepeats) || 4)
	const minUnitChars = Math.max(1, Number(options?.minUnitChars) || 3)
	const maxUnitChars = Math.max(minUnitChars, Number(options?.maxUnitChars) || 64)
	const minSpanChars = Math.max(minUnitChars, Number(options?.minSpanChars) || 12)
	const minDistinctChars = Math.max(1, Number(options?.minDistinctChars) || 2)
	const requireExotic = options?.requireExotic !== false
	// `fromIndex`：只找这一段之后的退化段。流式守卫用它定位「判定点之后的那一段」，
	// 避免把更早的一段也当成同一处退化。
	const from = Math.max(0, Number(options?.fromIndex) || 0)
	if (typeof text !== 'string' || text.length === 0) return []
	if (from >= text.length) return []
	if (text.length < minRepeats * minUnitChars) return []

	const opts = { minRepeats, minUnitChars, maxUnitChars, minSpanChars, minDistinctChars, requireExotic }
	const candidates = []
	// 找「含字母数字」的内容段，剩下的空白/符号区域才是要找重复的地方。
	//
	// 量词要**封顶**：V8 的正则引擎在超长匹配（连续 4MB 以上）上会抛
	// `RangeError: Maximum call stack size exceeded` ——
	// 一个退化文件本来就可能有几 MB，不能让它把整个扫描带崩。
	const contentRe = /[\p{L}\p{N}]{1,4096}/gu
	let contentEnd = 0
	let m
	while ((m = contentRe.exec(text)) !== null) {
		const start = m.index
		const end = m.index + m[0].length
		if (m.index === contentRe.lastIndex) contentRe.lastIndex++
		if (start > contentEnd) {
			// 区域起点不能早于 `from`，也不能早于上一段内容（那段是正文，不是符号区）。
			const regionStart = Math.max(contentEnd, from)
			if (start > regionStart) scanSymbolicRegion(text, regionStart, start, opts, candidates)
		}
		contentEnd = end
	}
	if (contentEnd < text.length) {
		const regionStart = Math.max(contentEnd, from)
		if (text.length > regionStart) scanSymbolicRegion(text, regionStart, text.length, opts, candidates)
	}
	return mergeUnitRuns(candidates)
}

/**
 * 折叠文本里的多字符单元重复（用于「净化」通道：把整段重复换成一句可读标记）。
 *
 * 与 {@link collapseSymbolRuns} 同一套用法：返回改写后的文本与被折叠的段，
 * 段里带重复份数（标记上写的是「重复了几份」，不是「多少个字符」）。
 *
 * @param {string} text - 文本
 * @param {{minRepeats?: number, minUnitChars?: number, maxUnitChars?: number,
 *          minSpanChars?: number, minDistinctChars?: number,
 *          requireExotic?: boolean, marker?: (n: number) => string}} [options] - 选项
 * @returns {{text: string, runs: Array<{start: number, end: number, repeats: number, count: number, unit: string}>}} 折叠结果
 */
export function collapseUnitRuns(text, options = {}) {
	if (typeof text !== 'string' || text.length === 0) return { text: text ?? '', runs: [] }
	const marker = options?.marker || ((n) => `〔退化单元×${n}〕`)
	const hits = findUnitRuns(text, {
		minRepeats: options?.minRepeats,
		minUnitChars: options?.minUnitChars,
		maxUnitChars: options?.maxUnitChars,
		minSpanChars: options?.minSpanChars,
		minDistinctChars: options?.minDistinctChars,
		requireExotic: options?.requireExotic,
	})
	if (hits.length === 0) return { text, runs: [] }
	const runs = []
	let out = ''
	let cursor = 0
	for (const hit of hits) {
		out += text.slice(cursor, hit.start)
		out += marker(hit.repeats)
		runs.push({ start: hit.start, end: hit.end, repeats: hit.repeats, count: hit.count, unit: hit.unit })
		cursor = hit.end
	}
	out += text.slice(cursor)
	return { text: out, runs }
}

/**
 * 在「摘掉符号游程之后的残渣」里找多字符单元重复，并把区间映射回原文。
 *
 * ## 为什么要在残渣上找
 *
 * 退化内容常常是「长游程 + 碎片」交替的样子：
 *
 * ```text
 * ⇒⇒⇒⇒⇒⇒⇒⇒⇒⇒⇒⇒⇒⇒⇒⇒⇒⇒⇒ ⇒⇒⇒⇒⇒⇒⇒⇒⇒⇒ ⇒⇒⇒⇒⇒⇒⇒⇒⇒⇒ …
 * ```
 *
 * 治理时游程被整段摘掉，碎片就贴到了一起 —— 「⇒⇒ **⇒⇒⇒⇒⇒⇒⇒」
 * 这样的残渣会拼出一个**新的**多字符单元重复。
 * 只在原文上找单元重复的话，摘完游程才发现残渣也在重复，
 * 落盘前的复核就通不过（会话治理会直接拒绝落盘，报告「复核未通过」）。
 *
 * 所以这里先摘掉游程、在残渣上找单元重复，再把区间映射回原文 ——
 * 一次治理就把「游程 + 残渣」整段换掉。
 *
 * @param {string} text - 原文
 * @param {Array<{start: number, end: number}>} symbolRuns - 已知的符号游程区间（按起点升序、不相交）
 * @param {{minRepeats?: number, minUnitChars?: number, maxUnitChars?: number,
 *          minSpanChars?: number, minDistinctChars?: number,
 *          requireExotic?: boolean}} [options] - 判定参数
 * @returns {Array<{start: number, end: number, count: number, repeats: number, unit: string}>} 重复段列表
 */
export function findUnitRunsInResidue(text, symbolRuns, options = {}) {
	if (typeof text !== 'string' || text.length === 0) return []
	const runs = Array.isArray(symbolRuns) ? symbolRuns : []
	if (runs.length === 0) return findUnitRuns(text, options)
	// 摘掉游程，记住每个残留字符在原文里的位置。
	let residue = ''
	/** 残渣下标 → 原文下标。 */
	const origin = []
	let cursor = 0
	for (const run of runs) {
		const start = Math.max(cursor, Math.min(Number(run?.start) || 0, text.length))
		const end = Math.max(start, Math.min(Number(run?.end) || 0, text.length))
		residue += text.slice(cursor, start)
		for (let i = cursor; i < start; i++) origin.push(i)
		cursor = end
	}
	residue += text.slice(cursor)
	for (let i = cursor; i < text.length; i++) origin.push(i)
	const hits = findUnitRuns(residue, options)
	const out = []
	for (const hit of hits) {
		const first = origin[hit.start]
		const last = origin[hit.end - 1]
		if (first === undefined || last === undefined) continue
		out.push({
			start: first,
			end: last + 1,
			count: hit.count,
			repeats: hit.repeats,
			unit: hit.unit,
		})
	}
	return out
}

/**
 * 折叠文本里的符号游程（用于「净化」通道：把噪声换成一句可读标记）。
 * @param {string} text - 文本
 * @param {{minRun: number, chars: string, keep?: number, marker?: (n: number) => string}} options - 选项
 * @returns {{text: string, runs: Array<{char: string, count: number}>}} 折叠结果
 */
export function collapseSymbolRuns(text, options) {
	const minRun = Math.max(2, Number(options?.minRun) || 20)
	const chars = options?.chars || DEFAULT_SYMBOLS
	const keep = Math.max(0, Number(options?.keep) || 0)
	const marker = options?.marker || ((n) => `〔退化符号流×${n}〕`)
	if (typeof text !== 'string' || text.length === 0) return { text: text ?? '', runs: [] }
	const className = [...new Set([...chars])].map((c) => c.replace(/[\\\]^\-]/g, '\\$&')).join('')
	const re = new RegExp(`([${className}](?:[ \\t\\r\\n]*[${className}]){${minRun - 1},})`, 'gu')
	const runs = []
	const out = text.replace(re, (whole, unit) => {
		const symbols = [...unit].filter((c) => chars.includes(c)).length
		runs.push({ char: [...unit].find((c) => chars.includes(c)) ?? '', count: symbols })
		const head = keep > 0 ? unit.slice(0, keep) : ''
		return `${head}${marker(symbols)}`
	})
	return { text: out, runs }
}

/**
 * 取一段文本的预览（用于证据与日志，长度可控）。
 * @param {string} text - 文本
 * @param {number} [max=120] - 最大长度
 * @returns {string} 预览
 */
export function preview(text, max = 120) {
	const s = String(text ?? '').replace(/\s+/g, ' ').trim()
	return s.length > max ? `${s.slice(0, max)}…` : s
}

/**
 * 检测尾部是否存在精确周期重复。
 *
 * @param {string} buf - 文本缓冲
 * @param {{maxPeriod: number, minSpan: number, minDistinctChars?: number,
 *          allowSingleContentChar?: boolean, contentOnly?: boolean}} options - 选项
 * @returns {{period: number, reps: number, onset: number} | null} 命中信息
 */
export function detectCycle(buf, options) {
	const maxPeriod = Math.max(1, Number(options?.maxPeriod) || 64)
	const minSpan = Math.max(1, Number(options?.minSpan) || 256)
	const minDistinct = options?.minDistinctChars ?? 2
	const allowSingle = options?.allowSingleContentChar === true
	const contentOnly = options?.contentOnly === true
	const len = buf.length
	if (len < minSpan) return null
	const limit = Math.min(maxPeriod, Math.floor(len / 2))
	for (let p = 1; p <= limit; p++) {
		let k = 1
		while (len - (k + 1) * p >= 0) {
			const off = len - (k + 1) * p
			let same = true
			for (let i = 0; i < p; i++) {
				if (buf[off + i] !== buf[len - p + i]) { same = false; break }
			}
			if (!same) break
			k++
		}
		const span = k * p
		if (span < minSpan) continue
		const unit = buf.slice(len - p)
		if (p === 1) {
			if (!allowSingle) continue
			if (!/[\p{L}\p{N}]/u.test(unit)) continue
		} else if (new Set(unit).size < minDistinct) {
			continue
		}
		if (contentOnly && !/[\p{L}\p{N}]/u.test(unit)) continue
		// 向前回溯周期起点（前缀不属于周期时停住）
		let onset = len - span
		while (onset - p >= 0) {
			let same = true
			for (let i = 0; i < p; i++) {
				if (buf[onset - p + i] !== buf[onset + i]) { same = false; break }
			}
			if (!same) break
			onset -= p
		}
		return { period: p, reps: k, onset }
	}
	return null
}

/**
 * 句单元切分（兼容中英标点，无需空白）。
 * @param {string} text - 文本
 * @returns {Array<{text: string, index: number}>} 句单元
 */
export function splitSentences(text) {
	const out = []
	const re = /[^。！？!?；;\n]+[。！？!?；;\n]?/gu
	let m
	while ((m = re.exec(text)) !== null) {
		out.push({ text: m[0], index: m.index })
		if (m.index === re.lastIndex) re.lastIndex++
	}
	return out
}

/**
 * 规则：符号游程。
 * @param {string} buf - 缓冲
 * @param {Record<string, any>} rule - 规则参数
 * @param {{chars?: string}} [opts] - 额外选项
 * @returns {{onset: number, evidence: string, detail: object} | null} 命中
 */
export function detectSymbolRun(buf, rule, opts = {}) {
	const hit = findSymbolRun(buf, { minRun: rule.minRun, chars: opts.chars || DEFAULT_SYMBOLS })
	if (!hit) return null
	return {
		onset: hit.index,
		evidence: preview(hit.char, 40),
		detail: { char: hit.char.trim(), count: hit.count, runChars: hit.length },
	}
}

/**
 * 规则：多字符单元重复（`⇒⇒§ ⇒⇒§ §` 这种形态）。
 *
 * 报的是**最后一段**（最靠后的一段）而不是第一段：采样规则每次都扫整个窗口，
 * 报最靠后的一段才能让 onset 一直往前走，不会反复报同一段旧内容。
 *
 * @param {string} buf - 缓冲
 * @param {Record<string, any>} rule - 规则参数
 * @returns {{onset: number, evidence: string, detail: object} | null} 命中
 */
export function detectUnitRun(buf, rule) {
	const hits = findUnitRuns(buf, rule)
	if (hits.length === 0) return null
	const hit = hits[hits.length - 1]
	return {
		onset: hit.start,
		evidence: preview(hit.unit, 60),
		detail: { repeats: hit.repeats, unitChars: hit.unitChars, unit: hit.unit, count: hit.count },
	}
}

/**
 * 规则：精确周期。
 * @param {string} buf - 缓冲
 * @param {Record<string, any>} rule - 规则参数
 * @returns {{onset: number, evidence: string, detail: object} | null} 命中
 */
export function detectExactCycle(buf, rule) {
	const hit = detectCycle(buf, { maxPeriod: rule.maxCycleChars, minSpan: rule.minCycleChars, minDistinctChars: 2 })
	if (!hit) return null
	return {
		onset: hit.onset,
		evidence: preview(buf.slice(hit.onset, hit.onset + hit.period * 2), 60),
		detail: { period: hit.period, reps: hit.reps },
	}
}

/**
 * 规则：reasoning 专属周期（允许单字符内容重复）。
 * @param {string} buf - 缓冲
 * @param {Record<string, any>} rule - 规则参数
 * @returns {{onset: number, evidence: string, detail: object} | null} 命中
 */
export function detectReasoningCycle(buf, rule) {
	const hit = detectCycle(buf, {
		maxPeriod: rule.maxCycleChars,
		minSpan: rule.minCycleChars,
		allowSingleContentChar: rule.allowSingleContentChar !== false,
		contentOnly: true,
	})
	if (!hit) return null
	return {
		onset: hit.onset,
		evidence: preview(buf.slice(hit.onset, hit.onset + hit.period * 2), 60),
		detail: { period: hit.period, reps: hit.reps },
	}
}

/**
 * 规则：短语连击（内容短语连续重复）。
 * @param {string} buf - 缓冲
 * @param {Record<string, any>} rule - 规则参数
 * @returns {{onset: number, evidence: string, detail: object} | null} 命中
 */
export function detectPhraseRun(buf, rule) {
	const hit = detectCycle(buf, {
		maxPeriod: rule.maxPhraseChars,
		minSpan: rule.minRepeats * rule.minPhraseChars,
		minDistinctChars: 1,
		contentOnly: true,
	})
	if (!hit || hit.reps < rule.minRepeats) return null
	return {
		onset: hit.onset,
		evidence: preview(buf.slice(hit.onset, hit.onset + hit.period), 60),
		detail: { period: hit.period, reps: hit.reps },
	}
}

/**
 * 规则：句单元新颖度塌缩。
 * @param {string} buf - 缓冲
 * @param {Record<string, any>} rule - 规则参数
 * @returns {{onset: number, evidence: string, detail: object} | null} 命中
 */
export function detectNovelty(buf, rule) {
	const units = splitSentences(buf).filter((u) => u.text.trim().length >= rule.minUnitChars)
	if (units.length < rule.minSentences) return null
	const seen = new Map()
	let firstRepeat = -1
	for (const u of units) {
		const key = u.text.trim()
		const n = (seen.get(key) ?? 0) + 1
		seen.set(key, n)
		if (n === 2 && firstRepeat < 0) firstRepeat = u.index
	}
	const ratio = seen.size / units.length
	if (ratio > rule.maxNoveltyRatio) return null
	return {
		onset: Math.max(0, firstRepeat),
		evidence: preview(units[units.length - 1]?.text ?? '', 60),
		detail: { units: units.length, distinct: seen.size, ratio: Number(ratio.toFixed(3)) },
	}
}

/**
 * 规则：低信息密度（整段片段重复）。
 * @param {string} buf - 缓冲
 * @param {Record<string, any>} rule - 规则参数
 * @returns {{onset: number, evidence: string, detail: object} | null} 命中
 */
export function detectLowInfoDup(buf, rule) {
	const frag = Math.max(8, rule.fragmentChars)
	const count = Math.floor(buf.length / frag)
	if (count < rule.minFragments) return null
	const seen = new Set()
	let repeats = 0
	let firstRepeat = -1
	for (let i = 0; i < count; i++) {
		const piece = buf.slice(i * frag, (i + 1) * frag)
		if (seen.has(piece)) {
			repeats += 1
			if (firstRepeat < 0) firstRepeat = i * frag
		} else seen.add(piece)
	}
	const ratio = repeats / count
	if (ratio < rule.threshold) return null
	return {
		onset: Math.max(0, firstRepeat),
		evidence: preview(buf.slice(Math.max(0, firstRepeat), Math.max(0, firstRepeat) + frag), 60),
		detail: { fragments: count, repeats, ratio: Number(ratio.toFixed(3)) },
	}
}

/**
 * 规则：n-gram 塌缩。
 * @param {string} buf - 缓冲
 * @param {Record<string, any>} rule - 规则参数
 * @returns {{onset: number, evidence: string, detail: object} | null} 命中
 */
export function detectCollapseGram(buf, rule) {
	const win = buf.slice(Math.max(0, buf.length - rule.collapseWindow))
	if (win.length < rule.collapseMinChars) return null
	const n = rule.gram
	const seen = new Set()
	let repeats = 0
	let firstRepeat = -1
	for (let i = 0; i + n <= win.length; i++) {
		const key = win.slice(i, i + n)
		if (seen.has(key)) {
			repeats += 1
			if (firstRepeat < 0) firstRepeat = i
		} else seen.add(key)
	}
	const total = win.length - n + 1
	const ratio = repeats / total
	if (ratio < rule.threshold) return null
	return {
		onset: buf.length - win.length + Math.max(0, firstRepeat),
		evidence: preview(win.slice(Math.max(0, firstRepeat), Math.max(0, firstRepeat) + n * 3), 60),
		detail: { grams: total, repeats, ratio: Number(ratio.toFixed(3)) },
	}
}

/**
 * 规则：词表多样性塌缩。
 * @param {string} buf - 缓冲
 * @param {Record<string, any>} rule - 规则参数
 * @returns {{onset: number, evidence: string, detail: object} | null} 命中
 */
export function detectCollapseToken(buf, rule) {
	const win = buf.slice(Math.max(0, buf.length - rule.collapseWindow))
	if (win.length < rule.collapseMinChars) return null
	const tokens = win.match(/[\p{L}\p{N}]+/gu) ?? []
	if (tokens.length < rule.minTokens) return null
	const distinct = new Set(tokens).size
	const ratio = distinct / tokens.length
	if (ratio > rule.threshold) return null
	return {
		onset: buf.length - win.length,
		evidence: preview(tokens.slice(0, 8).join(' '), 60),
		detail: { tokens: tokens.length, distinct, ratio: Number(ratio.toFixed(3)) },
	}
}

/** 采样规则表（通道无关的纯函数）。 */
const SAMPLED_RULES = {
	'exact-cycle': detectExactCycle,
	'reasoning-cycle': detectReasoningCycle,
	'phrase-run': detectPhraseRun,
	'unit-run': detectUnitRun,
	'novelty': detectNovelty,
	'low-info-dup': detectLowInfoDup,
	'collapse-gram': detectCollapseGram,
	'collapse-token': detectCollapseToken,
}

/**
 * 退化判定器（每个通道一个实例）。
 *
 * 增量规则（每次 feed 都跑）：`symbol-run`、`identical-chunks`。
 * 采样规则（每 `checkEvery` 字符跑一次）：其余 8 条。
 */
export class DegenerationDetector {
	/**
	 * @param {object} [options] - 选项
	 * @param {string} [options.channel] - 通道名（reasoning / text）
	 * @param {Record<string, any>} [options.rules] - 规则配置
	 * @param {string} [options.symbols] - 符号集
	 * @param {number} [options.windowChars] - 检测窗口
	 * @param {number} [options.checkEvery] - 采样间隔
	 */
	constructor(options = {}) {
		this.channel = options.channel ?? 'text'
		this.rules = normalizeRules(options.rules)
		this.symbols = options.symbols || DEFAULT_SYMBOLS
		this.windowChars = Math.max(512, Number(options.windowChars) || 4096)
		this.checkEvery = Math.max(64, Number(options.checkEvery) || 256)
		this.buffer = ''
		this.base = 0
		this.total = 0
		this.sinceCheck = 0
		this.lastDelta = null
		this.identicalCount = 0
		this.identicalStart = 0
		this.lastOnset = -1
	}

	/**
	 * 判断某条规则在当前通道是否适用。
	 * @param {string} id - 规则 id
	 * @returns {boolean} 是否适用
	 */
	applies(id) {
		const rule = this.rules[id]
		if (!rule || !rule.on) return false
		const channels = rule.channels ?? DEFAULT_RULES[id]?.channels ?? ['reasoning', 'text']
		return channels.includes(this.channel)
	}

	/**
	 * 喂入一段增量文本。
	 * @param {string} text - 增量文本
	 * @returns {object | null} 裁决（无命中为 null）
	 */
	feed(text) {
		if (typeof text !== 'string' || text.length === 0) return null
		const start = this.total
		this.buffer += text
		this.total += text.length
		this.sinceCheck += text.length
		// 复审缺陷 F2：**先判定，再裁剪**。
		// 裁剪会把「还没被判过」的那段游程切出窗口 —— 单段增量比窗口还大的时候，
		// 游程头落在增量开头，裁剪之后整段游程都不在窗口里，
		// 判定器再也看不到它，原始符号就原样进了宿主（delta 与 block-end 都是）。
		const incremental = this._incremental(text, start)
		if (this.buffer.length > this.windowChars) {
			const cut = this.buffer.length - this.windowChars
			// 复审缺陷 D3：不能把游程的头部切出窗口。
			// 被切掉的那段末尾如果还接着一段符号游程，游程的头部就在更早的位置——
			// 切在这里之后算出来的 onset 会指向游程中部，
			// 于是折叠只能清掉尾巴，前面几千个原始符号会原样放行。
			const runStart = trailingRunStart(this.buffer.slice(0, cut), this.symbols)
			const safeCut = runStart >= 0 ? runStart : cut
			this.buffer = this.buffer.slice(safeCut)
			this.base += safeCut
		}
		if (this.sinceCheck >= this.checkEvery) {
			this.sinceCheck = 0
			const sampled = this._sampled()
			if (sampled && (!incremental || compareVerdicts(sampled, incremental) > 0)) return sampled
		}
		return incremental
	}

	/**
	 * 流结束时的收尾评估。
	 * @returns {object | null} 裁决
	 */
	flush() {
		return this._sampled()
	}

	/**
	 * 回退到某个绝对位置（用于「净化」通道折叠掉一段游程后重置窗口）。
	 * @param {number} absoluteIndex - 绝对字符下标
	 */
	rewindTo(absoluteIndex) {
		const cut = Math.max(0, Math.min(this.buffer.length, absoluteIndex - this.base))
		this.buffer = this.buffer.slice(0, cut)
		this.total = this.base + cut
		this.sinceCheck = 0
		this.lastDelta = null
		this.identicalCount = 0
	}

	/**
	 * 把窗口整体重置到某个绝对位置（净化通道折叠掉一段游程后使用）。
	 *
	 * 与 {@link rewindTo} 的区别：这里会**丢弃**窗口里已有内容，让 `base` 直接落到目标位置，
	 * 从而保证 `total` 与调用方的有效文本长度严格对齐（不会因为裁剪钳制产生偏移）。
	 *
	 * @param {number} absoluteIndex - 绝对字符下标
	 */
	resetTo(absoluteIndex) {
		const at = Math.max(0, Math.floor(absoluteIndex))
		this.buffer = ''
		this.base = at
		this.total = at
		this.sinceCheck = 0
		this.lastDelta = null
		this.identicalCount = 0
		this.identicalStart = at
		this.lastOnset = at
	}

	/**
	 * 增量规则。
	 * @param {string} text - 增量文本
	 * @param {number} start - 本段起始绝对下标
	 * @returns {object | null} 裁决
	 */
	_incremental(text, start) {
		if (this.applies('identical-chunks')) {
			const rule = this.rules['identical-chunks']
			if (text === this.lastDelta && text.trim().length > 0) this.identicalCount += 1
			else { this.identicalCount = 1; this.identicalStart = start }
			this.lastDelta = text
			if (this.identicalCount >= rule.maxRepeatedText) {
				const verdict = this._verdict('identical-chunks', {
					onset: this.identicalStart,
					evidence: preview(text, 60),
					detail: { repeats: this.identicalCount, deltaLength: text.length },
				})
				this.lastOnset = verdict.onset
				return verdict
			}
		}
		if (this.applies('symbol-run')) {
			const hit = detectSymbolRun(this.buffer, this.rules['symbol-run'], { chars: this.symbols })
			if (hit) {
				const onset = this.base + hit.onset
				if (onset > this.lastOnset) {
					const verdict = this._verdict('symbol-run', {
						onset,
						evidence: hit.evidence,
						detail: hit.detail,
					})
					this.lastOnset = verdict.onset
					return verdict
				}
			}
		}
		return null
	}

	/**
	 * 采样规则。
	 * @returns {object | null} 裁决
	 */
	_sampled() {
		const buf = this.buffer
		if (buf.length === 0) return null
		const found = []
		for (const [id, fn] of Object.entries(SAMPLED_RULES)) {
			if (!this.applies(id)) continue
			const hit = fn(buf, this.rules[id])
			if (!hit) continue
			found.push(this._verdict(id, {
				onset: this.base + hit.onset,
				evidence: hit.evidence,
				detail: hit.detail,
			}))
		}
		if (found.length === 0) return null
		// 比较函数的约定是「>0 表示 a 更优」（严重度高的优先，同严重度起点更早的优先），
		// 而 `Array.prototype.sort` 要的是「cmp(a,b) < 0 表示 a 排在前面」——
		// 直接把比较函数丢给 sort，排在最前面的会变成**最不严重**的那条。
		// 后果：单元重复（high）会被塌缩类规则（medium）抢走，流式守卫按错误的规则处置。
		found.sort((a, b) => compareVerdicts(b, a))
		const best = found[0]
		this.lastOnset = Math.max(this.lastOnset, best.onset)
		return best
	}

	/**
	 * 构造一条裁决。
	 * @param {string} rule - 规则 id
	 * @param {{onset: number, evidence: string, detail?: object}} payload - 内容
	 * @returns {object} 裁决
	 */
	_verdict(rule, payload) {
		return {
			rule,
			severity: RULE_SEVERITY[rule] ?? 'medium',
			channel: this.channel,
			onset: payload.onset,
			evidence: payload.evidence ?? '',
			detail: payload.detail ?? {},
		}
	}
}

/**
 * 裁决比较：严重度高的优先；同严重度取起点更早的。
 * @param {object} a - 裁决 A
 * @param {object} b - 裁决 B
 * @returns {number} >0 表示 a 更优
 */
export function compareVerdicts(a, b) {
	const sa = a?.severity ?? 'low'
	const sb = b?.severity ?? 'low'
	const order = { high: 3, medium: 2, low: 1 }
	if ((order[sa] ?? 0) !== (order[sb] ?? 0)) return (order[sa] ?? 0) - (order[sb] ?? 0)
	return (b?.onset ?? 0) - (a?.onset ?? 0)
}
