/**
 * 流式守卫测试 —— T2。
 *
 * 宿主契约（已从 dsh-llm / dsh-agent-loop 源码核对）：
 * - delta 文本在 `chunk.text`，类型是 `text-delta` / `reasoning-delta`
 * - `block-end` 的 `block.text` 是**权威值**：assembler 用它覆盖 delta 累加结果
 * - 合法终止是 `{type:'finish', reason:{kind:'error', failure:{message, code}}}`
 * - 未知 chunk 类型会让 assembler 抛错（`assertNever`），所以守卫只能产出既有类型
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { guardStream } from '../lib/stream-guard.js'

/** 造一个可观测生命周期的上游流。 */
function makeStream(chunks, hooks = {}) {
	return (async function* () {
		try {
			for (const chunk of chunks) {
				hooks.onChunk?.(chunk)
				yield chunk
			}
		} finally {
			hooks.onClose?.()
		}
	})()
}

/** 收集守卫输出。 */
async function collect(upstream, options = {}) {
	const out = []
	for await (const chunk of guardStream(upstream, options)) out.push(chunk)
	return out
}

/** 拼一个 reasoning 块（含 block-start / delta / block-end）。 */
function reasoningBlock(text, { index = 0, deltaSize = 16 } = {}) {
	const chunks = [{ type: 'block-start', index, blockType: 'reasoning' }]
	for (let i = 0; i < text.length; i += deltaSize) {
		chunks.push({ type: 'reasoning-delta', index, text: text.slice(i, i + deltaSize) })
	}
	chunks.push({ type: 'block-end', index, block: { type: 'reasoning', text } })
	return chunks
}

/** 拼一个 text 块。 */
function textBlock(text, { index = 1, deltaSize = 16 } = {}) {
	const chunks = [{ type: 'block-start', index, blockType: 'text' }]
	for (let i = 0; i < text.length; i += deltaSize) {
		chunks.push({ type: 'text-delta', index, text: text.slice(i, i + deltaSize) })
	}
	chunks.push({ type: 'block-end', index, block: { type: 'text', text } })
	return chunks
}

/**
 * 造一段不重复的填充文本。
 *
 * 重复的填充会被 collapse-gram 那条规则先拦下，测不到符号游程这条路径，
 * 所以这里用伪随机序列。
 *
 * @param {number} n - 长度
 * @param {number} seed - 种子
 * @returns {string} 文本
 */
function filler(n, seed) {
	const chars = 'abcdefghijklmnopqrstuvwxyz '
	let s = seed
	let out = ''
	for (let i = 0; i < n; i += 1) {
		s = (s * 1103515245 + 12345) % 2147483648
		out += chars[s % chars.length]
	}
	return out
}

test('正常流：逐块原样透传，不产生裁决', async () => {
	const chunks = [
		...reasoningBlock('我先看一下这个文件。'),
		...textBlock('好的，已经处理完了。'),
		{ type: 'finish', reason: { kind: 'stop' } },
	]
	const verdicts = []
	const out = await collect(makeStream(chunks), { onVerdict: (v) => verdicts.push(v) })
	assert.deepEqual(out, chunks, '正常流必须原样透传')
	assert.equal(verdicts.length, 0)
})

test('reasoning 退化：截断内容并以合法终止 finish 收尾', async () => {
	const run = '⇒'.repeat(64)
	const chunks = [
		{ type: 'block-start', index: 0, blockType: 'reasoning' },
		{ type: 'reasoning-delta', index: 0, text: '先确认一下现状：' },
		{ type: 'reasoning-delta', index: 0, text: run },
		{ type: 'block-end', index: 0, block: { type: 'reasoning', text: `先确认一下现状：${run}` } },
		{ type: 'finish', reason: { kind: 'stop' } },
	]
	const verdicts = []
	const out = await collect(makeStream(chunks), {
		reasoning: 'truncate',
		onVerdict: (v) => verdicts.push(v),
	})

	const last = out[out.length - 1]
	assert.equal(last.type, 'finish')
	assert.equal(last.reason.kind, 'error')
	assert.equal(last.reason.failure.code, 'DEGENERATION_DETECTED')
	assert.ok(last.reason.failure.message.includes('symbol-run'), '终止原因要写明命中的规则')

	const texts = out.filter((c) => c.type === 'reasoning-delta').map((c) => c.text).join('')
	assert.ok(!texts.includes('⇒'), '退化内容不得出现在输出流里')
	assert.ok(texts.includes('先确认一下现状：'), '退化前的正常内容必须保留')

	const blockEnd = out.filter((c) => c.type === 'block-end').at(-1)
	assert.ok(blockEnd, '必须补一个 block-end 关闭打开的块')
	assert.ok(!blockEnd.block.text.includes('⇒'), 'block-end 的权威文本也必须截断')
	assert.ok(blockEnd.block.text.includes('先确认一下现状：'))

	assert.equal(verdicts.length, 1)
	assert.equal(verdicts[0].rule, 'symbol-run')
})

test('截断后上游被关闭（请求不再继续消耗）', async () => {
	let closed = false
	const chunks = [
		{ type: 'block-start', index: 0, blockType: 'reasoning' },
		{ type: 'reasoning-delta', index: 0, text: '⇒'.repeat(64) },
		{ type: 'reasoning-delta', index: 0, text: '后面还有更多内容' },
		{ type: 'block-end', index: 0, block: { type: 'reasoning', text: 'x' } },
	]
	await collect(makeStream(chunks, { onClose: () => { closed = true } }), { reasoning: 'truncate' })
	assert.equal(closed, true, '上游必须在切断时被关闭')
})

test('text 通道净化：把符号游程换成标记，流继续', async () => {
	const run = '⇒'.repeat(64)
	const chunks = [
		{ type: 'block-start', index: 0, blockType: 'text' },
		{ type: 'text-delta', index: 0, text: '结论如下：' },
		{ type: 'text-delta', index: 0, text: run },
		{ type: 'text-delta', index: 0, text: '以上。' },
		{ type: 'block-end', index: 0, block: { type: 'text', text: `结论如下：${run}以上。` } },
		{ type: 'finish', reason: { kind: 'stop' } },
	]
	const out = await collect(makeStream(chunks), { text: 'sanitize' })
	const last = out[out.length - 1]
	assert.equal(last.type, 'finish')
	assert.equal(last.reason.kind, 'stop', '净化不改变终止方式')

	const texts = out.filter((c) => c.type === 'text-delta').map((c) => c.text).join('')
	assert.ok(!texts.includes('⇒'), '符号噪声必须被清掉')
	assert.ok(texts.includes('结论如下：'))
	assert.ok(texts.includes('以上。'), '噪声之后的内容必须保留')
	assert.ok(texts.includes('〔退化符号流'), '应当留下可读标记')

	const blockEnd = out.filter((c) => c.type === 'block-end').at(-1)
	assert.ok(blockEnd.block.text.includes('〔退化符号流'))
	assert.ok(!blockEnd.block.text.includes('⇒'))
})

test('净化：把折叠现场（标记与原文）一并上报，供界面预览与回退', async () => {
	const run = '⇒'.repeat(64)
	const chunks = [
		{ type: 'block-start', index: 0, blockType: 'text' },
		{ type: 'text-delta', index: 0, text: '结论如下：' },
		{ type: 'text-delta', index: 0, text: run },
		{ type: 'text-delta', index: 0, text: '以上。' },
		{ type: 'block-end', index: 0, block: { type: 'text', text: `结论如下：${run}以上。` } },
		{ type: 'finish', reason: { kind: 'stop' } },
	]
	const verdicts = []
	await collect(makeStream(chunks), { text: 'sanitize', onVerdict: (verdict, info) => verdicts.push({ verdict, info }) })
	assert.equal(verdicts.length, 1, `实际 ${verdicts.length} 条裁决`)
	const { verdict, info } = verdicts[0]
	assert.equal(info.action, 'sanitize')
	assert.equal(info.channel, 'text')
	assert.equal(typeof info.marker, 'string', '上报里必须有折叠标记')
	assert.ok(info.marker.includes('〔退化符号流'), `标记不对：${info.marker}`)
	assert.equal(typeof info.original, 'string', '上报里必须有被折叠的原文')
	assert.equal(info.original, run, '原文必须是被折叠掉的那一段游程')
	assert.equal(typeof info.offset, 'number', '上报里必须有通道偏移')
	assert.equal(verdict.rule, 'symbol-run')
})

test('净化：游程延续到后续 delta 时整段都被清掉', async () => {	const chunks = [
		{ type: 'block-start', index: 0, blockType: 'text' },
		{ type: 'text-delta', index: 0, text: '⇒'.repeat(30) },
		{ type: 'text-delta', index: 0, text: '⇒'.repeat(30) },
		{ type: 'text-delta', index: 0, text: ' 结束' },
		{ type: 'block-end', index: 0, block: { type: 'text', text: 'x' } },
	]
	const out = await collect(makeStream(chunks), { text: 'sanitize' })
	const texts = out.filter((c) => c.type === 'text-delta').map((c) => c.text).join('')
	assert.ok(!texts.includes('⇒'))
	assert.ok(texts.includes('结束'))
	assert.ok(texts.includes('〔退化符号流×60〕'), `实际：${texts}`)
})

test('净化：游程跨越多个 delta 时整段折叠成一条标记', async () => {
	// 三个 delta 拼成一段游程：前两段都还没到判定阈值（10 / 19 < 20），第三段补齐第 20 个符号。
	// 这条测试专门验证「滞留窗口」：游程起点所在的 delta 必须仍在可改写范围内，
	// 否则已经流出去的符号就再也收不回来了（会退化成整流切断）。
	const chunks = [
		{ type: 'block-start', index: 0, blockType: 'text' },
		{ type: 'text-delta', index: 0, text: '⇒'.repeat(10) },
		{ type: 'text-delta', index: 0, text: '⇒'.repeat(9) },
		{ type: 'text-delta', index: 0, text: '⇒后续内容' },
		{ type: 'block-end', index: 0, block: { type: 'text', text: 'x' } },
		{ type: 'finish', reason: { kind: 'stop' } },
	]
	const out = await collect(makeStream(chunks), { text: 'sanitize' })
	const last = out[out.length - 1]
	assert.equal(last.type, 'finish')
	assert.equal(last.reason.kind, 'stop', '应当折叠而不是切断')
	const texts = out.filter((c) => c.type === 'text-delta').map((c) => c.text).join('')
	assert.ok(!texts.includes('⇒'), `实际：${texts}`)
	assert.ok(texts.includes('〔退化符号流×20〕'), `实际：${texts}`)
	assert.ok(texts.includes('后续内容'), `实际：${texts}`)
	const blockEnd = out.filter((c) => c.type === 'block-end').at(-1)
	assert.ok(blockEnd.block.text.includes('后续内容'), `block-end 丢了后续正文：${blockEnd.block.text}`)
	assert.ok(!blockEnd.block.text.includes('⇒'), `block-end 仍有符号：${blockEnd.block.text}`)
})

test('复审 D1：游程跨两个块时，要么整段清掉，要么整段截断，不许只清一半', async () => {
	// 20 个符号被拆成两个块（10 + 10）：前 10 个在第一个块结束时已经流出去，
	// 后 10 个到第二个块才凑够判定阈值。
	// 原先的做法是把后 10 个折叠成「×10」的标记 —— 真实游程是 20，计数是错的，
	// 而且前 10 个原始符号已经进了会话存档。
	const run = '⇒'.repeat(20)
	const chunks = [
		...reasoningBlock(run.slice(0, 10), { index: 0, deltaSize: 10 }),
		...reasoningBlock(run.slice(10), { index: 1, deltaSize: 10 }),
		{ type: 'finish', reason: { kind: 'stop' } },
	]
	const out = await collect(makeStream(chunks), { reasoning: 'sanitize' })
	const last = out[out.length - 1]
	assert.equal(last.type, 'finish')
	const deltas = out.filter((c) => c.type === 'reasoning-delta').map((c) => c.text).join('')
	const blockEnds = out.filter((c) => c.type === 'block-end').map((c) => c.block.text).join('')
	// 不许出现「只清了一半」的标记：标记里的计数必须等于真实游程长度。
	for (const text of [deltas, blockEnds]) {
		const match = /〔退化符号流×(\d+)〕/.exec(text)
		if (match) assert.equal(Number(match[1]), 20, `标记计数与真实游程不符：${text}`)
	}
	// 覆盖不了整段就必须切断，不许发出半净化的内容。
	if (last.reason.kind === 'stop') {
		assert.ok(!deltas.includes('⇒'), `仍有原始符号：${deltas}`)
		assert.ok(!blockEnds.includes('⇒'), `仍有原始符号：${blockEnds}`)
	} else {
		assert.equal(last.reason.kind, 'error')
		assert.equal(last.reason.failure.code, 'DEGENERATION_DETECTED')
	}
})

test('复审 D2：截断路径用的是同一套坐标，退化的尾巴必须真的被剪掉', async () => {
	// 滞留窗口已经滑过（前面的正文分两段进来，第一段被放出去）之后再检测到退化：
	// 截断点算的是通道绝对偏移，而条目坐标是窗口相对偏移，两套坐标混用会让退化尾巴原样放行。
	// 填充文本必须是不重复的，否则会先被 collapse-gram 这条规则拦下，测不到符号游程这条路径。
	const chunks = [
		{ type: 'block-start', index: 0, blockType: 'reasoning' },
		{ type: 'reasoning-delta', index: 0, text: filler(540, 7) },
		{ type: 'reasoning-delta', index: 0, text: filler(102, 99) },
		{ type: 'reasoning-delta', index: 0, text: '⇒'.repeat(30) },
		{ type: 'block-end', index: 0, block: { type: 'reasoning', text: 'x' } },
	]
	const out = await collect(makeStream(chunks), { reasoning: 'truncate' })
	const last = out[out.length - 1]
	assert.equal(last.type, 'finish')
	assert.equal(last.reason.kind, 'error', '退化必须以错误终止')
	const texts = out.filter((c) => c.type === 'reasoning-delta').map((c) => c.text).join('')
	assert.ok(!texts.includes('⇒'), `原始符号被放行：${texts.slice(-120)}`)
})

test('复审 D3：单个增量超过检测窗口时，游程的头部不能被切出窗口', async () => {
	const chunks = [
		{ type: 'block-start', index: 0, blockType: 'text' },
		{ type: 'text-delta', index: 0, text: '⇒'.repeat(5000) },
		{ type: 'block-end', index: 0, block: { type: 'text', text: 'x' } },
		{ type: 'finish', reason: { kind: 'stop' } },
	]
	const out = await collect(makeStream(chunks), { text: 'sanitize' })
	const texts = out.filter((c) => c.type === 'text-delta').map((c) => c.text).join('')
	const blockEnds = out.filter((c) => c.type === 'block-end').map((c) => c.block.text).join('')
	assert.ok(!texts.includes('⇒'), `原始符号被放行：${texts.length} 字`)
	assert.ok(!blockEnds.includes('⇒'), `原始符号被放行：${blockEnds.length} 字`)
})

test('复审 D4：block-end 权威文本里的标记计数必须和 delta 一致', async () => {
	// 游程延续到后续 delta 时，标记的计数会累加；权威文本必须同步，
	// 否则存档里写的是 ×30，界面上显示的是 ×60。
	const chunks = [
		{ type: 'block-start', index: 0, blockType: 'text' },
		{ type: 'text-delta', index: 0, text: 'hello ' },
		{ type: 'text-delta', index: 0, text: '⇒'.repeat(30) },
		{ type: 'text-delta', index: 0, text: '⇒'.repeat(30) },
		{ type: 'text-delta', index: 0, text: ' world' },
		{ type: 'block-end', index: 0, block: { type: 'text', text: 'x' } },
		{ type: 'finish', reason: { kind: 'stop' } },
	]
	const out = await collect(makeStream(chunks), { text: 'sanitize' })
	const deltas = out.filter((c) => c.type === 'text-delta').map((c) => c.text).join('')
	const blockEnd = out.filter((c) => c.type === 'block-end').at(-1)
	const deltaMatch = /〔退化符号流×(\d+)〕/.exec(deltas)
	const blockMatch = /〔退化符号流×(\d+)〕/.exec(blockEnd.block.text)
	assert.ok(deltaMatch, `delta 里没有标记：${deltas}`)
	assert.ok(blockMatch, `block-end 里没有标记：${blockEnd.block.text}`)
	assert.equal(blockMatch[1], deltaMatch[1], '两处计数不一致')
	assert.equal(Number(deltaMatch[1]), 60, `计数不对：${deltas}`)
})

test('切断时不会留下打开的块（每个 block-start 都有 block-end）', async () => {
	const chunks = [
		{ type: 'block-start', index: 0, blockType: 'reasoning' },
		{ type: 'reasoning-delta', index: 0, text: '思考中' },
		{ type: 'block-start', index: 1, blockType: 'text' },
		{ type: 'text-delta', index: 1, text: '答案' },
		{ type: 'reasoning-delta', index: 0, text: '⇒'.repeat(64) },
	]
	const out = await collect(makeStream(chunks), { reasoning: 'truncate' })
	const starts = out.filter((c) => c.type === 'block-start').map((c) => c.index)
	const ends = out.filter((c) => c.type === 'block-end').map((c) => c.index)
	for (const index of starts) assert.ok(ends.includes(index), `块 ${index} 没有被关闭`)
	assert.equal(out[out.length - 1].type, 'finish')
})

test('策略关闭时完全不干预', async () => {
	const run = '⇒'.repeat(64)
	const chunks = [
		{ type: 'block-start', index: 0, blockType: 'text' },
		{ type: 'text-delta', index: 0, text: run },
		{ type: 'block-end', index: 0, block: { type: 'text', text: run } },
		{ type: 'finish', reason: { kind: 'stop' } },
	]
	const out = await collect(makeStream(chunks), { text: 'off', reasoning: 'off' })
	assert.deepEqual(out, chunks)
})

test('只产出宿主认识的 chunk 类型', async () => {
	const allowed = new Set(['block-start', 'block-end', 'text-delta', 'reasoning-delta', 'tool-call-delta', 'usage', 'finish'])
	const chunks = [
		{ type: 'block-start', index: 0, blockType: 'reasoning' },
		{ type: 'reasoning-delta', index: 0, text: '⇒'.repeat(64) },
		{ type: 'block-start', index: 1, blockType: 'text' },
		{ type: 'text-delta', index: 1, text: '部分答案' },
	]
	const out = await collect(makeStream(chunks), { reasoning: 'truncate' })
	for (const chunk of out) assert.ok(allowed.has(chunk.type), `未知 chunk 类型 ${chunk.type}`)
})

test('单次调用的干预次数达到上限后不再改写，但也不放行退化', async () => {
	const run = '⇒'.repeat(40)
	const chunks = [
		{ type: 'block-start', index: 1, blockType: 'text' },
		{ type: 'text-delta', index: 1, text: `第一段${run}中间内容` },
		{ type: 'text-delta', index: 1, text: `第二段${run}结束` },
		{ type: 'block-end', index: 1, block: { type: 'text', text: `第一段${run}中间内容第二段${run}结束` } },
		{ type: 'finish', reason: { kind: 'stop' } },
	]
	const verdicts = []
	const out = await collect(makeStream(chunks), {
		text: 'sanitize',
		maxInterventionsPerCall: 1,
		onVerdict: (v, info) => verdicts.push({ v, info }),
	})
	const texts = out.filter((c) => c.type === 'text-delta').map((c) => c.text).join('')
	assert.ok(texts.includes('〔退化符号流'), '第一段退化应当被折叠')
	assert.ok(!texts.includes('⇒'), '达到干预上限后，第二段退化不得被原样放行')
	assert.equal(verdicts.length, 2, '两段退化都要留下裁决记录')
	assert.equal(verdicts[1].info.action, 'truncate', '超限的裁决动作是截断')
	const last = out[out.length - 1]
	assert.equal(last.type, 'finish')
	assert.equal(last.reason.kind, 'error', '截断必须以 error 收尾')
})

test('把干预上限调大就能折叠更多段落', async () => {
	const run = '⇒'.repeat(40)
	const chunks = [
		{ type: 'block-start', index: 1, blockType: 'text' },
		{ type: 'text-delta', index: 1, text: `第一段${run}中间内容` },
		{ type: 'text-delta', index: 1, text: `第二段${run}结束` },
		{ type: 'block-end', index: 1, block: { type: 'text', text: `第一段${run}中间内容第二段${run}结束` } },
		{ type: 'finish', reason: { kind: 'stop' } },
	]
	const out = await collect(makeStream(chunks), {
		text: 'sanitize',
		maxInterventionsPerCall: 3,
	})
	const texts = out.filter((c) => c.type === 'text-delta').map((c) => c.text).join('')
	assert.ok(!texts.includes('⇒'), '上限放宽后两段都应当被折叠')
	assert.equal((texts.match(/〔退化符号流/g) ?? []).length, 2)
})

test('干预上限设为 0 表示不限次数：发现的退化都会尝试干预', async () => {
	const run = '⇒'.repeat(40)
	const chunks = [
		{ type: 'block-start', index: 1, blockType: 'text' },
		{ type: 'text-delta', index: 1, text: `第一段${run}中间内容` },
		{ type: 'text-delta', index: 1, text: `第二段${run}结束` },
		{ type: 'block-end', index: 1, block: { type: 'text', text: `第一段${run}中间内容第二段${run}结束` } },
		{ type: 'finish', reason: { kind: 'stop' } },
	]
	const verdicts = []
	const out = await collect(makeStream(chunks), {
		text: 'sanitize',
		maxInterventionsPerCall: 0,
		onVerdict: (v, info) => verdicts.push(info),
	})
	const texts = out.filter((c) => c.type === 'text-delta').map((c) => c.text).join('')
	assert.equal((texts.match(/〔退化符号流/g) ?? []).length, 2, '0 = 不限次数：两段都要折叠')
	assert.ok(!texts.includes('⇒'), '退化内容不得原样放行')
	assert.deepEqual(verdicts.map((item) => item.action), ['sanitize', 'sanitize'])
	const last = out[out.length - 1]
	assert.equal(last.type, 'finish')
	assert.equal(last.reason.kind, 'stop', '不限次数时不该被截断收尾')
})

test('裁决回调拿到通道与规则', async () => {
	const seen = []
	await collect(
		makeStream([
			{ type: 'block-start', index: 0, blockType: 'reasoning' },
			{ type: 'reasoning-delta', index: 0, text: '⇒'.repeat(64) },
		]),
		{ reasoning: 'truncate', model: 'test-model', onVerdict: (v, info) => seen.push({ v, info }) },
	)
	assert.equal(seen.length, 1)
	assert.equal(seen[0].v.rule, 'symbol-run')
	assert.equal(seen[0].v.channel, 'reasoning')
	assert.equal(seen[0].info.model, 'test-model')
	assert.equal(seen[0].info.action, 'truncate')
})

// ── unit-run（多字符单元重复）──────────────────────────────────────────────

/** 用户给的那种退化：同一个多字符单元整段整段地重复。 */
const UNIT_BLOCK = '⇒⇒§ ⇒⇒§ §'

/** 造一段含 12 份单元重复的正文。 */
function unitRunText(times = 12) {
	return `前置说明。\n\n${Array.from({ length: times }, () => UNIT_BLOCK).join('\n\n')}\n\n后置说明。`
}

test('流式守卫：多字符单元重复被折叠成〔退化单元×N〕', async () => {
	const text = unitRunText()
	const chunks = [
		{ type: 'block-start', index: 0, blockType: 'text' },
		{ type: 'text-delta', index: 0, text },
		{ type: 'block-end', index: 0, block: { type: 'text', text } },
		{ type: 'finish', reason: { kind: 'stop' } },
	]
	const verdicts = []
	const out = await collect(makeStream(chunks), {
		text: 'sanitize',
		onVerdict: (v, info) => verdicts.push({ v, info }),
	})
	const texts = out.filter((c) => c.type === 'text-delta').map((c) => c.text).join('')
	assert.ok(!texts.includes(UNIT_BLOCK), '重复的单元必须被清掉')
	assert.ok(texts.includes('〔退化单元×12〕'), `实际：${texts}`)
	assert.ok(texts.includes('前置说明。'), '前文要保留')
	assert.ok(texts.includes('后置说明。'), '后文要保留')
	assert.equal(verdicts.length, 1)
	assert.equal(verdicts[0].v.rule, 'unit-run')
	assert.equal(verdicts[0].info.action, 'sanitize')
	assert.equal(verdicts[0].v.detail.repeats, 12)
	const blockEnd = out.filter((c) => c.type === 'block-end').at(-1)
	assert.ok(blockEnd.block.text.includes('〔退化单元×12〕'), 'block-end 的权威文本也要折叠')
})

test('流式守卫：关掉多字符单元治理后，这形态不再被判定', async () => {
	const text = unitRunText()
	const chunks = [
		{ type: 'block-start', index: 0, blockType: 'text' },
		{ type: 'text-delta', index: 0, text },
		{ type: 'block-end', index: 0, block: { type: 'text', text } },
		{ type: 'finish', reason: { kind: 'stop' } },
	]
	const verdicts = []
	const out = await collect(makeStream(chunks), {
		text: 'sanitize',
		unitRun: false,
		onVerdict: (v) => verdicts.push(v),
	})
	const texts = out.filter((c) => c.type === 'text-delta').map((c) => c.text).join('')
	assert.equal(verdicts.length, 0, '关掉之后不该有裁决')
	assert.ok(texts.includes(UNIT_BLOCK), '关掉之后内容原样透传')
})

test('流式守卫：多字符单元重复的份数阈值说了算', async () => {
	// 12 份重复：默认阈值（4 份）命中，阈值调到 20 份就不再命中。
	const build = (times) => [
		{ type: 'block-start', index: 0, blockType: 'text' },
		{ type: 'text-delta', index: 0, text: unitRunText(times) },
		{ type: 'block-end', index: 0, block: { type: 'text', text: unitRunText(times) } },
		{ type: 'finish', reason: { kind: 'stop' } },
	]
	const strictVerdicts = []
	await collect(makeStream(build(12)), {
		text: 'sanitize',
		unitRepeats: 20,
		onVerdict: (v) => strictVerdicts.push(v),
	})
	assert.equal(strictVerdicts.length, 0, '阈值调到 20 份，12 份重复不算退化')

	const looseVerdicts = []
	await collect(makeStream(build(12)), {
		text: 'sanitize',
		unitRepeats: 4,
		onVerdict: (v) => looseVerdicts.push(v),
	})
	assert.equal(looseVerdicts.length, 1, '阈值调到 4 份，12 份重复照样命中')
	assert.equal(looseVerdicts[0].rule, 'unit-run')
})

test('流式守卫：多字符单元重复在 reasoning 通道同样可折叠', async () => {
	const text = unitRunText()
	const chunks = [
		{ type: 'block-start', index: 0, blockType: 'reasoning' },
		{ type: 'reasoning-delta', index: 0, text },
		{ type: 'block-end', index: 0, block: { type: 'reasoning', text } },
		{ type: 'finish', reason: { kind: 'stop' } },
	]
	const verdicts = []
	const out = await collect(makeStream(chunks), {
		reasoning: 'sanitize',
		onVerdict: (v) => verdicts.push(v),
	})
	const texts = out.filter((c) => c.type === 'reasoning-delta').map((c) => c.text).join('')
	assert.ok(texts.includes('〔退化单元×12〕'), `实际：${texts}`)
	assert.equal(verdicts.length, 1)
	assert.equal(verdicts[0].rule, 'unit-run')
})

