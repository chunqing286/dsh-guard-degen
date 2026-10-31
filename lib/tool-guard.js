/**
 * 工具参数闸门 —— 在 `tools/execute` 之前检查工具入参里有没有退化内容。
 *
 * 与流式侧共用同一套判定器与规则（口径一致是这一层的价值所在：
 * `dsh-guard-hooks` 是通用钩子框架，退化规则要用户自己写正则；
 * 这里把规则内置，且和 `lib/detect.js` 完全一致）。
 *
 * 三档模式：
 * - `off`：只检测不拦（默认）；
 * - `warn`：放行，但记录判定并在执行后把警示回灌给模型；
 * - `refuse`：直接拒绝执行，回一条模型能读懂的原因。
 *
 * 三档作用范围：
 * - `all`：所有工具；
 * - `write-only`：只管写文件类工具（write/edit/patch/apply…）；
 * - `oversized-only`：只管参数长度超过阈值的调用。
 *
 * @module lib/tool-guard
 */

import { DEFAULT_SYMBOLS, DegenerationDetector, normalizeRules } from './detect.js'

/** 闸门模式。 */
export const TOOL_GUARD_MODES = ['off', 'warn', 'refuse']

/** 闸门作用范围。 */
export const TOOL_GUARD_SCOPES = ['all', 'write-only', 'oversized-only']

/** 写类工具名匹配（按名字前缀/片段判断）。 */
const WRITE_TOOL_PATTERNS = [
	/^write/,
	/^edit/,
	/^patch/,
	/^apply/,
	/^append/,
	/^create/,
	/^insert/,
	/^replace/,
	/^str_?replace/,
	/^multi_?edit/,
	/^update_?file/,
	/^save/,
	/^overwrite/,
]

/**
 * 名字长得像写工具、实际并不落盘的工具。
 *
 * `create_goal` / `update_goal` 只是改会话里的目标状态，
 * 被当成写类会让 `write-only` 范围把它们也纳入闸门（复审的次要缺陷）。
 */
const NON_WRITE_TOOL_NAMES = new Set(['create_goal', 'update_goal', 'get_goal'])

/** 读类工具名匹配。 */
const READ_TOOL_PATTERNS = [
	/^read/,
	/^view/,
	/^cat/,
	/^list/,
	/^search/,
	/^grep/,
	/^glob/,
	/^find/,
	/^show/,
	/^get_/,
	/^inspect/,
	/^stat/,
]

/** 默认的参数长度阈值（`oversized-only` 范围用）。 */
export const DEFAULT_MAX_ARGS_CHARS = 2048

/** 单次扫描的最大参数文本长度。 */
const MAX_SCAN_CHARS = 1_000_000

/** 喂给判定器的分片大小。 */
const FEED_CHUNK = 1024

/**
 * 判断工具是写类、读类还是其它。
 * @param {string} name - 工具名
 * @returns {'write'|'read'|'other'} 分类
 */
export function classifyTool(name) {
	const text = String(name ?? '').toLowerCase()
	if (!text) return 'other'
	if (NON_WRITE_TOOL_NAMES.has(text)) return 'other'
	if (WRITE_TOOL_PATTERNS.some((re) => re.test(text))) return 'write'
	if (READ_TOOL_PATTERNS.some((re) => re.test(text))) return 'read'
	return 'other'
}

/**
 * 递归收集参数里的所有字符串值。
 * @param {unknown} value - 参数值
 * @param {string[]} [out] - 收集容器
 * @returns {string[]} 文本片段
 */
export function collectArgText(value, out = []) {
	if (typeof value === 'string') {
		out.push(value)
		return out
	}
	if (Array.isArray(value)) {
		for (const item of value) collectArgText(item, out)
		return out
	}
	if (value && typeof value === 'object') {
		for (const item of Object.values(value)) collectArgText(item, out)
	}
	return out
}

/**
 * 在文本里跑一遍判定，返回第一条命中的裁决。
 * @param {string} text - 文本
 * @param {object} options - 选项
 * @returns {object | null} 裁决
 */
export function detectText(text, options = {}) {
	const rules = applyUnitRunOption(normalizeRules(options.rules), options.unitRun, options.unitRepeats)
	const detector = new DegenerationDetector({
		channel: options.channel ?? 'text',
		rules,
		symbols: options.symbols ?? DEFAULT_SYMBOLS,
		windowChars: options.windowChars,
	})
	const limit = Math.min(text.length, MAX_SCAN_CHARS)
	for (let i = 0; i < limit; i += FEED_CHUNK) {
		const verdict = detector.feed(text.slice(i, i + FEED_CHUNK))
		if (verdict) return verdict
	}
	return detector.flush()
}

/**
 * 把「是否治理多字符单元重复」这个开关落到规则表上。
 *
 * 关掉就把 `unit-run` 规则整个停掉 —— 判定器根本不会再报这条，
 * 而不是报了再放过（那样日志里会留下一堆没被处理的命中）。
 *
 * 给了 `unitRepeats` 就顺带覆盖规则表里的 `minRepeats`：
 * 「工具参数守卫」的重复份数因此能单独调（工件、会话治理各自有一份）。
 *
 * @param {Record<string, any>} rules - 规则表
 * @param {boolean} [unitRun] - 是否启用多字符单元治理
 * @param {number} [unitRepeats] - 份数阈值（不合法时忽略）
 * @returns {Record<string, any>} 生效的规则表
 */
export function applyUnitRunOption(rules, unitRun, unitRepeats) {
	const repeats = Number(unitRepeats)
	const hasRepeats = Number.isFinite(repeats) && repeats >= 2
	if (unitRun === false) {
		if (!rules['unit-run']) return rules
		return { ...rules, 'unit-run': { ...rules['unit-run'], on: false } }
	}
	if (!hasRepeats || !rules['unit-run']) return rules
	return { ...rules, 'unit-run': { ...rules['unit-run'], minRepeats: Math.floor(repeats) } }
}

/**
 * 检查工具参数。
 * @param {unknown} args - 工具参数
 * @param {object} [options] - 选项
 * @param {'off'|'warn'|'refuse'} [options.mode] - 模式（默认 off）
 * @param {'all'|'write-only'|'oversized-only'} [options.scope] - 作用范围
 * @param {string} [options.toolName] - 工具名
 * @param {number} [options.maxArgsChars] - 超长阈值
 * @param {Record<string, any>} [options.rules] - 规则配置
 * @param {string} [options.symbols] - 符号集
 * @param {boolean} [options.unitRun] - 是否治理多字符单元重复（默认 true）
 * @param {number} [options.unitRepeats] - 多字符单元重复的份数阈值
 * @returns {{action: 'allow'|'warn'|'refuse', reason?: string, detail?: object}} 判定结果
 */
export function checkToolArgs(args, options = {}) {
	const mode = TOOL_GUARD_MODES.includes(options.mode) ? options.mode : 'off'
	if (mode === 'off') return { action: 'allow' }
	const scope = TOOL_GUARD_SCOPES.includes(options.scope) ? options.scope : 'all'
	const toolName = options.toolName ?? ''
	const fragments = collectArgText(args)
	const text = fragments.join('\n')
	if (scope === 'write-only' && classifyTool(toolName) !== 'write') return { action: 'allow' }
	const maxArgsChars = Math.max(0, Number(options.maxArgsChars) || DEFAULT_MAX_ARGS_CHARS)
	if (scope === 'oversized-only' && text.length <= maxArgsChars) return { action: 'allow' }
	if (text.length === 0) return { action: 'allow' }
	const verdict = detectText(text, {
		rules: normalizeRules(options.rules),
		symbols: options.symbols ?? DEFAULT_SYMBOLS,
		windowChars: options.windowChars,
		unitRun: options.unitRun,
		unitRepeats: options.unitRepeats,
	})
	if (!verdict) return { action: 'allow' }
	const detail = {
		rule: verdict.rule,
		severity: verdict.severity,
		onset: verdict.onset,
		count: verdict.detail?.count ?? verdict.detail?.repeats ?? 0,
		repeats: verdict.detail?.repeats ?? 0,
		unit: verdict.detail?.unit ?? '',
		evidence: verdict.evidence,
		toolName,
		argsChars: text.length,
	}
	const reason = buildReason(verdict, detail, toolName)
	return { action: mode, reason, detail }
}

/**
 * 生成一条模型能读懂的原因。
 *
 * 两种退化形态给两套说法：
 * - symbol-run：同**一个符号**连成一片 → 说「多少个符号」；
 * - unit-run：同一个**多字符单元**反复出现 → 说「重复了几份」，并把单元本身点出来。
 *
 * @param {object} verdict - 裁决
 * @param {object} detail - 细节
 * @param {string} toolName - 工具名
 * @returns {string} 原因文本
 */
export function buildReason(verdict, detail, toolName) {
	const where = toolName ? `工具 ${toolName} 的参数` : '工具参数'
	if (verdict.rule === 'unit-run') {
		const repeats = Number(detail.repeats ?? detail.count ?? 0)
		// 单元本身可能带换行（`⇒⇒§ ⇒⇒§ §\n\n` 这种），写进原因里要压成一行。
		const unit = String(detail.unit || detail.evidence || '').replace(/\s+/g, ' ').trim()
		const shape = repeats > 0 ? `包含 ${repeats} 份重复的多字符单元` : '包含重复的多字符单元'
		const which = unit ? `（单元「${unit}」）` : ''
		return `检测到退化内容：${where}${shape}${which}（规则 ${verdict.rule}）。请改用正常内容重试，不要重复发送同一段内容。`
	}
	const count = detail.count ? `包含 ${detail.count} 个连续相同符号` : '包含退化重复片段'
	return `检测到退化内容：${where}${count}（规则 ${verdict.rule}）。请改用正常内容重试，不要重复发送同一段符号。`
}
