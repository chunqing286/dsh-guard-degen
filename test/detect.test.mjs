/**
 * 判定器测试 —— T1。
 *
 * 样本分三类：
 * 1. 真实退化（本机 corpus 里实测到的形态）
 * 2. 真实正常（本机仓库里的真实文件片段，最容易误报的那些）
 * 3. 边界（阈值两侧）
 *
 * 规则之间允许重叠（整句重复会同时命中 exact-cycle 与 novelty），所以
 * 每条规则既做「单规则单测」，也做「整流集成测试」。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
	DegenerationDetector,
	DEFAULT_RULES,
	RULE_IDS,
	RULE_SEVERITY,
	UNIT_RUN_DEFAULTS,
	collapseSymbolRuns,
	collapseUnitRuns,
	detectCollapseGram,
	detectCollapseToken,
	detectCycle,
	detectExactCycle,
	detectLowInfoDup,
	detectNovelty,
	detectPhraseRun,
	detectReasoningCycle,
	detectSymbolRun,
	findSymbolRun,
	findUnitRuns,
	findUnitRunsInResidue,
	normalizeRules,
	preview,
	splitSentences,
	trailingRunStart,
} from '../lib/detect.js'

/** 只启用指定规则的配置。 */
function onlyRules(ids) {
	const rules = {}
	for (const id of RULE_IDS) rules[id] = { on: ids.includes(id) }
	return rules
}

/** 喂一段文本并收尾，返回首个裁决。 */
function judge(text, options = {}) {
	const det = new DegenerationDetector(options)
	return det.feed(text) ?? det.flush()
}

/** 逐段喂（用于 delta 连击场景）。 */
function judgeChunks(chunks, options = {}) {
	const det = new DegenerationDetector(options)
	let first = null
	for (const chunk of chunks) {
		const v = det.feed(chunk)
		if (v && !first) first = v
	}
	return first ?? det.flush()
}

// ── symbol-run ────────────────────────────────────────────────────────────

test('symbol-run：命中真实退化样本（⇒ × 93）', () => {
	const verdict = judge('⇒'.repeat(93))
	assert.ok(verdict, '应当命中')
	assert.equal(verdict.rule, 'symbol-run')
	assert.equal(verdict.onset, 0)
	assert.equal(verdict.detail.count, 93)
	assert.equal(verdict.severity, 'high')
})

test('symbol-run：允许符号之间夹空白', () => {
	const verdict = judge('⇒ ⇒ ⇒ ⇒ ⇒ ⇒ ⇒ ⇒ ⇒ ⇒ ⇒ ⇒ ⇒ ⇒ ⇒ ⇒ ⇒ ⇒ ⇒ ⇒')
	assert.ok(verdict)
	assert.equal(verdict.rule, 'symbol-run')
	assert.equal(verdict.detail.count, 20)
})

test('symbol-run：起点定位到游程第一个符号', () => {
	const prefix = '前面是一段正常的推理内容。'.repeat(4)
	const verdict = judge(`${prefix}${'·'.repeat(40)}`)
	assert.ok(verdict)
	assert.equal(verdict.rule, 'symbol-run')
	assert.equal(verdict.onset, prefix.length)
})

test('symbol-run：单个符号与少量标记不命中（★ 是合法标记）', () => {
	const text = '标记 ★ 已写入 tmp_traj4.txt\n结论 ★ 通过\n'
	assert.equal(judge(text), null)
})

test('symbol-run：阈值两侧（19 不命中 / 20 命中）', () => {
	assert.equal(judge('⇒'.repeat(19)), null)
	assert.ok(judge('⇒'.repeat(20)))
})

test('findSymbolRun：返回游程统计', () => {
	const hit = findSymbolRun('abc⇒⇒⇒', { minRun: 3 })
	assert.ok(hit)
	assert.equal(hit.count, 3)
	assert.equal(hit.index, 3)
	assert.equal(findSymbolRun('abc⇒⇒', { minRun: 3 }), null)
})

test('detectSymbolRun：单规则命中时返回相对起点', () => {
	const rule = { ...DEFAULT_RULES['symbol-run'], minRun: 3 }
	const hit = detectSymbolRun('xx⇒⇒⇒⇒', rule)
	assert.ok(hit)
	assert.equal(hit.onset, 2)
	assert.equal(hit.detail.count, 4)
	assert.equal(detectSymbolRun('xx⇒⇒', rule), null, '低于 minRun 不命中')
})

test('collapseSymbolRuns：折叠后不再有游程', () => {
	const { text, runs } = collapseSymbolRuns('前⇒⇒⇒⇒⇒⇒⇒⇒⇒⇒⇒⇒⇒⇒⇒⇒⇒⇒⇒⇒⇒后', { minRun: 20 })
	assert.equal(runs.length, 1)
	assert.equal(runs[0].count, 21)
	assert.equal(findSymbolRun(text, { minRun: 20 }), null)
	assert.ok(text.includes('〔退化符号流×21〕'))
})

// ── unit-run ──────────────────────────────────────────────────────────────

test('unit-run：命中用户给的退化形态（⇒⇒§ ⇒⇒§ § 整段重复）', () => {
	const block = '⇒⇒§ ⇒⇒§ §'
	const text = Array.from({ length: 12 }, () => block).join('\n\n')
	const verdict = judge(text)
	assert.ok(verdict, '应当命中')
	assert.equal(verdict.rule, 'unit-run')
	assert.equal(verdict.detail.repeats, 12)
	assert.equal(verdict.detail.unitChars, 11)
})

test('unit-run：末尾只有分隔符时不算多一份', () => {
	const block = '⇒⇒§ ⇒⇒§ §'
	const text = `${Array.from({ length: 12 }, () => block).join('\n\n')}\n\n结尾`
	const hit = findUnitRuns(text, { minRepeats: 4, minUnitChars: 3, maxUnitChars: 64, minSpanChars: 12, minDistinctChars: 2, requireExotic: true })
	assert.equal(hit.length, 1)
	assert.equal(hit[0].repeats, 12, '末尾的空白分隔符不该算第 13 份')
})

test('unit-run：单元不重复时（只有一次）不命中', () => {
	const text = '⇒⇒§ ⇒⇒§ § 只出现一次，不构成退化。'
	const hit = findUnitRuns(text, { minRepeats: 4, minUnitChars: 3, maxUnitChars: 64, minSpanChars: 12, minDistinctChars: 2, requireExotic: true })
	assert.equal(hit.length, 0)
})

test('unit-run：单个符号连成一片交给 symbol-run（不重复上报）', () => {
	const text = '⇒'.repeat(30)
	const hits = findUnitRuns(text, { minRepeats: 4, minUnitChars: 3, maxUnitChars: 64, minSpanChars: 12, minDistinctChars: 2, requireExotic: true })
	assert.equal(hits.length, 0, '单元至少要有两个不同的字符')
	const verdict = judge(text)
	assert.equal(verdict.rule, 'symbol-run')
})

test('unit-run：代码与表格结构不误报', () => {
	const samples = [
		'const f = () => { return { a: 1 } };\n})();',
		'| --- | --- |\n| a | b |',
		'---- 分割线 ----',
		'这是一段普通的中文说明文字，重复了同样的意思，但里面有字有词。',
	]
	for (const text of samples) {
		const hits = findUnitRuns(text, { minRepeats: 4, minUnitChars: 3, maxUnitChars: 64, minSpanChars: 12, minDistinctChars: 2, requireExotic: true })
		assert.equal(hits.length, 0, `不该命中：${text.slice(0, 20)}`)
	}
})

test('unit-run：份数阈值两侧（3 份不命中 / 4 份命中）', () => {
	const opts = { minUnitChars: 3, maxUnitChars: 64, minSpanChars: 12, minDistinctChars: 2, requireExotic: true }
	const three = '⇒⇒§ ⇒⇒§ §\n\n⇒⇒§ ⇒⇒§ §\n\n⇒⇒§ ⇒⇒§ §'
	assert.equal(findUnitRuns(three, { ...opts, minRepeats: 4 }).length, 0)
	assert.equal(findUnitRuns(three, { ...opts, minRepeats: 3 }).length, 1)
})

test('unit-run：规则默认开启且属于高危级别', () => {
	assert.equal(DEFAULT_RULES['unit-run'].on, true)
	assert.equal(RULE_SEVERITY['unit-run'], 'high')
})

test('unit-run：只在符号区域里找（正文里的重复短语归 phrase-run）', () => {
	const phrase = '这是一个会被重复很多次的短语'
	const text = Array.from({ length: 12 }, () => phrase).join('\n')
	const hits = findUnitRuns(text, { minRepeats: 4, minUnitChars: 3, maxUnitChars: 64, minSpanChars: 12, minDistinctChars: 2, requireExotic: true })
	assert.equal(hits.length, 0)
})

test('unit-run：共享阈值常量与规则表默认值一致', () => {
	// 工件、流式、工具、会话四处治理共用同一套口径：改一处就都改了。
	assert.equal(DEFAULT_RULES['unit-run'].minRepeats, UNIT_RUN_DEFAULTS.minRepeats)
	assert.equal(DEFAULT_RULES['unit-run'].minUnitChars, UNIT_RUN_DEFAULTS.minUnitChars)
	assert.equal(DEFAULT_RULES['unit-run'].maxUnitChars, UNIT_RUN_DEFAULTS.maxUnitChars)
	assert.equal(DEFAULT_RULES['unit-run'].minSpanChars, UNIT_RUN_DEFAULTS.minSpanChars)
	assert.equal(DEFAULT_RULES['unit-run'].minDistinctChars, UNIT_RUN_DEFAULTS.minDistinctChars)
	assert.equal(DEFAULT_RULES['unit-run'].requireExotic, UNIT_RUN_DEFAULTS.requireExotic)
})

test('findUnitRuns：fromIndex 只看它之后的段（流式守卫按滞留窗口改写时要用）', () => {
	const block = '⇒⇒§ ⇒⇒§ §'
	const text = `前置。\n\n${Array.from({ length: 12 }, () => block).join('\n\n')}`
	const all = findUnitRuns(text, { ...UNIT_RUN_DEFAULTS })
	assert.equal(all.length, 1)
	// fromIndex 是「从这里往后扫」：扫到的段起点不会早于它。
	const from = all[0].start + 1
	for (const hit of findUnitRuns(text, { ...UNIT_RUN_DEFAULTS, fromIndex: from })) {
		assert.ok(hit.start >= from, `扫到的段起点不该早于 fromIndex：${hit.start} < ${from}`)
	}
	assert.equal(findUnitRuns(text, { ...UNIT_RUN_DEFAULTS, fromIndex: text.length }).length, 0)
	assert.equal(findUnitRuns(text, { ...UNIT_RUN_DEFAULTS, fromIndex: 0 }).length, 1)
})

test('collapseUnitRuns：把整段单元重复折叠成〔退化单元×N〕', () => {
	const block = '⇒⇒§ ⇒⇒§ §'
	const text = `前置说明。\n\n${Array.from({ length: 12 }, () => block).join('\n\n')}\n\n后置说明。`
	const result = collapseUnitRuns(text, { ...UNIT_RUN_DEFAULTS })
	assert.equal(result.runs.length, 1)
	assert.equal(result.runs[0].repeats, 12)
	assert.ok(result.text.includes('〔退化单元×12〕'), result.text)
	assert.ok(result.text.includes('前置说明。'))
	assert.ok(result.text.includes('后置说明。'))
	assert.equal(findUnitRuns(result.text, { ...UNIT_RUN_DEFAULTS }).length, 0, '折叠后不该还有残留')
})

test('findUnitRunsInResidue：摘掉游程之后碎片拼出的重复也要算退化', () => {
	// 退化内容常常是「长游程 + 碎片」交替的样子：游程被摘掉后碎片会贴到一起，
	// 拼出一个**新的**多字符单元重复。只看原文就会漏掉它 ——
	// 治理完第一轮才发现残渣也在重复，落盘前的复核就通不过。
	const lengths = [25, 30, 27, 31]
	const parts = lengths.map((n) => `${'⇒'.repeat(n)} **⇒⇒ **`)
	const text = parts.join('')
	assert.equal(findUnitRuns(text, { ...UNIT_RUN_DEFAULTS }).length, 0, '原文里不是整段重复')
	const symbolRuns = []
	let cursor = 0
	for (const [index, n] of lengths.entries()) {
		symbolRuns.push({ start: cursor, end: cursor + n })
		cursor += parts[index].length
	}
	const hits = findUnitRunsInResidue(text, symbolRuns, { ...UNIT_RUN_DEFAULTS })
	assert.equal(hits.length, 1, '残渣拼出来的重复也要算退化')
	assert.equal(hits[0].repeats, 4)
	// 区间要映射回原文：起点是残渣第一个字符在原文里的位置，
	// 终点要盖住残渣最后一个字符（中间被摘掉的游程自然落在区间里）。
	assert.equal(hits[0].start, lengths[0], '区间要映射回原文')
	assert.equal(hits[0].end, text.length, '区间要盖到残渣的末尾')
})

// ── identical-chunks ──────────────────────────────────────────────────────

test('identical-chunks：连续相同 delta 命中', () => {
	const verdict = judgeChunks(Array.from({ length: 60 }, () => 'let me write '), {
		rules: onlyRules(['identical-chunks']),
	})
	assert.ok(verdict)
	assert.equal(verdict.rule, 'identical-chunks')
	assert.equal(verdict.detail.repeats, 60)
	assert.equal(verdict.onset, 0)
})

test('identical-chunks：59 次不命中（阈值边界）', () => {
	assert.equal(judgeChunks(Array.from({ length: 59 }, () => 'let me write '), {
		rules: onlyRules(['identical-chunks']),
	}), null)
})

test('identical-chunks：内容不同的 delta 不命中', () => {
	assert.equal(judgeChunks(Array.from({ length: 200 }, (_, i) => `第 ${i} 行内容`), {
		rules: onlyRules(['identical-chunks']),
	}), null)
})

test('identical-chunks：起点落在连击的第一段', () => {
	const chunks = ['a', 'b', ...Array.from({ length: 60 }, () => 'same ')]
	const verdict = judgeChunks(chunks, { rules: onlyRules(['identical-chunks']) })
	assert.ok(verdict)
	assert.equal(verdict.onset, 2, '连击从第三段开始，前两段各 1 字符')
})

// ── exact-cycle / reasoning-cycle ─────────────────────────────────────────

test('exact-cycle：精确周期命中', () => {
	const verdict = judge('abc'.repeat(200), { rules: onlyRules(['exact-cycle']) })
	assert.ok(verdict)
	assert.equal(verdict.rule, 'exact-cycle')
	assert.equal(verdict.detail.period, 3)
	assert.equal(verdict.onset, 0)
})

test('exact-cycle：纯分隔线（=====）不命中', () => {
	assert.equal(judge('='.repeat(600)), null)
})

test('detectExactCycle：单规则命中', () => {
	const hit = detectExactCycle('abc'.repeat(100), DEFAULT_RULES['exact-cycle'])
	assert.ok(hit)
	assert.equal(hit.detail.period, 3)
})

test('reasoning-cycle：reasoning 通道单字符内容重复命中', () => {
	const verdict = judge('嗯'.repeat(400), {
		channel: 'reasoning',
		rules: onlyRules(['reasoning-cycle']),
	})
	assert.ok(verdict)
	assert.equal(verdict.rule, 'reasoning-cycle')
	assert.equal(verdict.detail.period, 1)
})

test('reasoning-cycle：text 通道不产出 reasoning-cycle 裁决', () => {
	const verdict = judge('嗯'.repeat(400), { channel: 'text', rules: onlyRules(['reasoning-cycle']) })
	assert.equal(verdict, null)
})

test('detectReasoningCycle：分隔线类单字符不命中', () => {
	assert.equal(detectReasoningCycle('='.repeat(400), DEFAULT_RULES['reasoning-cycle']), null)
})

test('detectCycle：回溯到的起点覆盖整段周期', () => {
	const buf = 'zz' + 'ab'.repeat(20)
	const hit = detectCycle(buf, { maxPeriod: 64, minSpan: 20 })
	assert.ok(hit)
	assert.equal(hit.period, 2)
	assert.equal(hit.onset, 2, '前缀 zz 不属于周期，起点应是 2')
})

// ── phrase-run ────────────────────────────────────────────────────────────

test('detectPhraseRun：内容短语连击命中', () => {
	const hit = detectPhraseRun('开始写代码'.repeat(12), DEFAULT_RULES['phrase-run'])
	assert.ok(hit)
	assert.ok(hit.detail.reps >= 8)
})

test('detectPhraseRun：分隔线不命中（没有内容字符）', () => {
	assert.equal(detectPhraseRun('-'.repeat(200), DEFAULT_RULES['phrase-run']), null)
})

// ── novelty ───────────────────────────────────────────────────────────────

test('detectNovelty：句单元高度重复时命中', () => {
	const sentence = '这是一段没有新信息的重复推理内容。'
	const hit = detectNovelty(sentence.repeat(80), DEFAULT_RULES['novelty'])
	assert.ok(hit)
	assert.ok(hit.detail.ratio <= 0.05)
})

test('detectNovelty：正常推理多样性足够时不命中', () => {
	const parts = []
	for (let i = 0; i < 80; i++) parts.push(`第 ${i} 个不同的观察结论，编号 ${i * 7919}。`)
	assert.equal(detectNovelty(parts.join(''), DEFAULT_RULES['novelty']), null)
})

test('detectNovelty：句单元不足时不命中', () => {
	assert.equal(detectNovelty('一二三。'.repeat(5), DEFAULT_RULES['novelty']), null)
})

// ── collapse 类（reasoning 通道专用） ─────────────────────────────────────

test('detectCollapseGram：8-gram 高度重复时命中', () => {
	const hit = detectCollapseGram('abcdefgh'.repeat(40), DEFAULT_RULES['collapse-gram'])
	assert.ok(hit)
	assert.ok(hit.detail.ratio >= 0.8)
})

test('detectCollapseToken：词表多样性塌缩时命中', () => {
	const hit = detectCollapseToken('error '.repeat(40), DEFAULT_RULES['collapse-token'])
	assert.ok(hit)
	assert.ok(hit.detail.ratio <= 0.2)
})

test('detectLowInfoDup：片段高度重复时命中', () => {
	const hit = detectLowInfoDup('x'.repeat(64).repeat(12), DEFAULT_RULES['low-info-dup'])
	assert.ok(hit)
	assert.ok(hit.detail.ratio >= 0.8)
})

test('collapse 类规则默认只作用于 reasoning 通道', () => {
	const doc = '## 验证记录\n\n- 用例 1：通过\n- 用例 2：通过\n- 结论：全部通过。\n'.repeat(6)
	assert.equal(judge(doc, { channel: 'text' }), null, '可见文本通道不应触发塌缩类规则')
	const reasoning = judge(doc, { channel: 'reasoning' })
	assert.ok(reasoning, 'reasoning 通道应触发')
	assert.ok(['collapse-token', 'collapse-gram', 'low-info-dup'].includes(reasoning.rule))
})

// ── 整流行为 ──────────────────────────────────────────────────────────────

test('正常工程文本不命中（JSON / 代码 / 中文文档）', () => {
	const json = JSON.stringify({
		name: 'guard-degen',
		version: '0.1.0',
		tags: ['dsh', 'cordis', 'plugin'],
		config: { enabled: true, minRun: 20, symbols: '⇒★·' },
	}, null, 2)
	assert.equal(judge(json), null)

	const code = [
		'export function guardStream(upstream, ctx, options) {',
		'  const detector = new DegenerationDetector(options)',
		'  for await (const chunk of upstream) {',
		'    const verdict = detector.feed(chunk.text)',
		'    if (verdict) { ctx.logger.warn(verdict.rule); break }',
		'    yield chunk',
		'  }',
		'}',
	].join('\n')
	assert.equal(judge(code), null)

	const doc = '## 验证记录\n\n- 用例 1：通过\n- 用例 2：通过\n- 结论：全部通过。\n'.repeat(6)
	assert.equal(judge(doc), null)
})

test('多规则同时命中时取严重度更高者', () => {
	const text = '⇒'.repeat(200)
	const verdict = judge(text)
	assert.equal(verdict.severity, 'high')
	assert.equal(verdict.rule, 'symbol-run')
})

test('采样规则之间竞争：严重度高的赢（不是最不严重的那条）', () => {
	// 回归：比较函数的约定是「>0 表示 a 更优」，而 `sort` 要的是「<0 表示 a 排在前面」。
	// 直接把比较函数丢给 sort，排在最前面的会变成最不严重的那条 ——
	// 结果 `unit-run`（high）会被 `phrase-run`（medium）抢走，流式守卫按错误的规则处置。
	const text = 'abcd'.repeat(100)
	const verdict = judge(text)
	assert.ok(verdict, '应当命中')
	assert.equal(verdict.severity, 'high', `实际命中的是 ${verdict.rule}（${verdict.severity}）`)
	assert.equal(verdict.rule, 'exact-cycle')
})

test('normalizeRules：剔除未知规则并补默认值', () => {
	const rules = normalizeRules({ 'symbol-run': { minRun: 30 }, '不存在的规则': { on: true } })
	assert.equal(rules['symbol-run'].minRun, 30)
	assert.equal(rules['symbol-run'].on, true)
	assert.equal(rules['not-a-rule'], undefined)
	for (const id of RULE_IDS) assert.ok(rules[id], `${id} 应当存在`)
	assert.deepEqual(Object.keys(DEFAULT_RULES).sort(), [...RULE_IDS].sort())
})

test('规则可单独关闭', () => {
	const rules = normalizeRules({ 'symbol-run': { on: false } })
	const det = new DegenerationDetector({ rules })
	assert.equal(det.feed('⇒'.repeat(200)), null)
})

test('splitSentences：按中英标点切分', () => {
	const units = splitSentences('第一句。第二句！third?第四句')
	assert.equal(units.length, 4)
})

test('preview：长文本截断且空白折叠', () => {
	assert.equal(preview('a   b\nc'), 'a b c')
	assert.equal(preview('x'.repeat(200)).length, 121)
})

test('增量裁决不会重复上报同一段游程', () => {
	const det = new DegenerationDetector()
	const first = det.feed('⇒'.repeat(30))
	assert.ok(first)
	const second = det.feed('⇒'.repeat(30))
	assert.ok(!second || second.onset > first.onset, '第二次不应重复报告同一起点')
})

test('M16 单个增量超过检测窗口时，游程起点仍然指向第一个符号', () => {
	// 复审缺陷 D3：窗口溢出时把最老的字符切掉，游程的头部跟着被切走，
	// onset 于是指向游程中部——守卫只会折叠尾巴，几千个原始符号原样放行。
	const det = new DegenerationDetector({ windowChars: 1024, checkEvery: 64 })
	const verdict = det.feed('⇒'.repeat(3000))
	assert.ok(verdict, '应当命中符号游程')
	assert.equal(verdict.onset, 0, '游程起点应当是第一个符号的位置')
	assert.equal(verdict.detail.count, 3000, '计数应当是整段游程')
})

test('M16 窗口溢出时不会把游程头部切出窗口', () => {
	const det = new DegenerationDetector({ windowChars: 1024, checkEvery: 64 })
	det.feed('正常正文'.repeat(200))
	const verdict = det.feed('⇒'.repeat(2000))
	assert.ok(verdict)
	assert.equal(verdict.onset, 800, '游程起点应当是游程第一个符号的位置')
})

test('D3 窗口裁剪不得把游程的头切出窗口（同一段游程不能在游程中部再报一次）', () => {
	// 复审缺陷 D3：裁剪窗口时若切点落在游程内部，游程的头会被切走；
	// 下一次判定算出来的 onset 就指向游程中部——守卫只折叠尾巴，
	// 前面几千个原始符号原样放行。只留 symbol-run 一条规则，
	// 免得采样规则掺进来干扰这个断言。
	const det = new DegenerationDetector({
		rules: onlyRules(['symbol-run']),
		windowChars: 512,
		checkEvery: 256,
	})

	const first = det.feed('⇒'.repeat(600))
	assert.ok(first, '应当命中符号游程')
	assert.equal(first.onset, 0, '游程起点应当是第一个符号的位置')

	// 裁剪之后，同一段游程还在窗口里，起点仍然是 0，不该再报一次。
	const second = det.feed('⇒'.repeat(100))
	assert.equal(second, null, '同一段游程不得在游程中部被重新上报')
})

test('trailingRunStart：找出末尾那段游程的起点', () => {
	assert.equal(trailingRunStart('abc⇒⇒⇒'), 3)
	assert.equal(trailingRunStart('abc⇒ ⇒ ⇒'), 3, '游程内部允许有空白')
	assert.equal(trailingRunStart('abc⇒⇒⇒   '), 3, '末尾空白属于游程')
	assert.equal(trailingRunStart('abc'), -1)
	assert.equal(trailingRunStart(''), -1)
})

