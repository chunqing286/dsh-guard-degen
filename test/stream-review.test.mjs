/**
 * 流式守卫复审缺陷的回归测试。
 *
 * 这些用例来自第二轮独立复审（复审代理逐条执行真实模块复现出来的）：
 * - S1 抑制态把 `ended` 写死为 true → 跨多个 delta 的游程只折叠了第一段；
 * - S2 `collapseRun` 里 `end`（pendingText 相对下标）与 `current.start`（通道偏移）
 *   混用了两套下标空间 → 权威的 `block-end.block.text` 里留下原始符号并重复了正文；
 * - S3 流结束时不调用 `detector.flush()` → 每条流最后不足窗口长度的尾巴永远不被判定；
 * - S4 `state.current.text` 无上限 → 退化流会无限增长；
 * - S5 `findSymbolRun` 的 `detail.char` 返回整段游程而不是那个符号。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { guardStream } from '../lib/stream-guard.js'
import { findSymbolRun, collapseSymbolRuns } from '../lib/detect.js'

/** 收集守卫输出。 */
async function collect(upstream, options = {}) {
	const out = []
	for await (const chunk of guardStream(upstream, options)) out.push(chunk)
	return out
}

/** 造一个流。 */
function makeStream(chunks) {
	return (async function* () {
		for (const chunk of chunks) yield chunk
	})()
}

/** 把输出里某个通道的 delta 文本拼起来。 */
function deltaText(out, type) {
	return out.filter((c) => c.type === type).map((c) => c.text).join('')
}

test('S1：净化通道里跨多个 delta 的符号游程要整段折叠成一个标记', async () => {
	// 复审复现：⇒×20 / ⇒×20 / ⇒×20 / " end" —— 期望输出 "〔退化符号流×60〕 end"。
	const chunks = [
		{ type: 'block-start', index: 0, blockType: 'text' },
		{ type: 'text-delta', index: 0, text: '⇒'.repeat(20) },
		{ type: 'text-delta', index: 0, text: '⇒'.repeat(20) },
		{ type: 'text-delta', index: 0, text: '⇒'.repeat(20) },
		{ type: 'text-delta', index: 0, text: ' end' },
		{ type: 'block-end', index: 0, block: { type: 'text', text: '' } },
		{ type: 'finish', reason: { kind: 'stop' } },
	]
	const out = await collect(makeStream(chunks), { text: 'sanitize' })
	const text = deltaText(out, 'text-delta')

	assert.ok(!text.includes('⇒'), `退化符号必须全部被折叠，实际输出：${JSON.stringify(text)}`)
	assert.equal(text, '〔退化符号流×60〕 end')
})

test('S2：block-end 的权威文本与净化后的 delta 一致，不留原始符号也不重复正文', async () => {
	// 复审复现条件：退化游程出现在**块的中后段**（块文本比滞留窗口长），
	// 此时 `end`（pendingText 相对下标）与 `current.start`（通道偏移）不再同一坐标系。
	const preamble = Array.from({ length: 120 }, (_, i) => `第${i}段说明`).join('')
	const run = '⇒'.repeat(40)
	const suffix = '结尾正文。'
	const chunks = [
		{ type: 'block-start', index: 0, blockType: 'text' },
		{ type: 'text-delta', index: 0, text: preamble },
		{ type: 'text-delta', index: 0, text: run },
		{ type: 'text-delta', index: 0, text: suffix },
		{ type: 'block-end', index: 0, block: { type: 'text', text: `${preamble}${run}${suffix}` } },
		{ type: 'finish', reason: { kind: 'stop' } },
	]
	const out = await collect(makeStream(chunks), { text: 'sanitize' })
	const blockEnd = out.find((c) => c.type === 'block-end')
	const deltas = deltaText(out, 'text-delta')

	assert.ok(blockEnd, '必须产出 block-end')
	assert.ok(!blockEnd.block.text.includes('⇒'), `block-end 文本里不得残留退化符号：${blockEnd.block.text}`)
	assert.ok(blockEnd.block.text.startsWith(preamble.slice(0, 40)), blockEnd.block.text.slice(0, 80))
	assert.ok(blockEnd.block.text.endsWith(suffix), blockEnd.block.text.slice(-80))
	assert.equal(blockEnd.block.text, deltas, 'block-end 的权威文本必须等于净化后的 delta 拼接')
	assert.ok(!blockEnd.block.text.includes('结尾正文。结尾正文。'), '正文不得被重复拼接')
})

test('S3：流结束时也要判定，尾巴里的退化不会被漏掉', async () => {
	// 'ab' 重复 100 次：判定器在流结束时 flush() 才能看到「塌缩」这个退化模式。
	const tail = 'ab'.repeat(100)
	const chunks = [
		{ type: 'block-start', index: 0, blockType: 'reasoning' },
		{ type: 'reasoning-delta', index: 0, text: tail },
		{ type: 'block-end', index: 0, block: { type: 'reasoning', text: tail } },
		{ type: 'finish', reason: { kind: 'stop' } },
	]
	const verdicts = []
	const out = await collect(makeStream(chunks), {
		reasoning: 'truncate',
		onVerdict: (v) => verdicts.push(v),
	})

	assert.ok(verdicts.length > 0, '流结束时也要给出裁决')
	const last = out[out.length - 1]
	assert.equal(last.type, 'finish')
	assert.equal(last.reason.kind, 'error', '退化必须以 error 收尾，不能安静地 stop')
	assert.equal(last.reason.failure.code, 'DEGENERATION_DETECTED')
})

test('S4：当前块的文本有上限，不会被退化流无限撑大', async () => {
	// 用「每段都不一样」的正文，避免被判定器当成塌缩而提前干预。
	const body = Array.from({ length: 600 }, (_, i) => `段落${i}`).join('')
	const chunks = [
		{ type: 'block-start', index: 0, blockType: 'text' },
		{ type: 'text-delta', index: 0, text: body },
		{ type: 'block-end', index: 0, block: { type: 'text', text: body } },
		{ type: 'finish', reason: { kind: 'stop' } },
	]
	const out = await collect(makeStream(chunks), { text: 'sanitize', maxBlockChars: 1000 })
	const blockEnd = out.find((c) => c.type === 'block-end')

	assert.ok(blockEnd, '必须产出 block-end')
	assert.ok(body.length > 1000, '样本本身要超过上限')
	assert.ok(blockEnd.block.text.length <= 1000, `块文本必须被上限截断，实际 ${blockEnd.block.text.length}`)
})

test('S5：游程详情里的 char 是那个符号本身，不是整段游程', () => {
	const run = findSymbolRun(`${'⇒'.repeat(30)}后面`, { minRun: 20 })
	assert.ok(run, '必须命中这段游程')
	assert.equal(run.char, '⇒')
	assert.equal(run.count, 30)
})

// ── 终审复审（第三轮）新增的用例 ─────────────────────────────────────
// 复审代理用真实模块执行复现出来的：
// - N1 纯空白增量把符号游程截成两段 → 第二段原始符号漏进正文与 block-end；
// - N2 单次调用的干预上限用尽后，第二段退化被「原样放行」→ 原始符号直接落进会话；
// - 覆盖缺口 A2/A3/A5：修好了但没有用例钉住，回退不会被测出来。

test('N1：被纯空白增量拆开的符号游程仍算同一段，整体折叠成一个标记', async () => {
	// 复审复现：⇒×25 / " " / ⇒×25 / " end"
	// 检测器的正则允许游程内部含空白（findSymbolRun 的 [ \t\r\n]*），
	// 所以守卫也必须把纯空白增量当成「游程还在继续」，而不是「游程结束」。
	const chunks = [
		{ type: 'block-start', index: 0, blockType: 'text' },
		{ type: 'text-delta', index: 0, text: '⇒'.repeat(25) },
		{ type: 'text-delta', index: 0, text: ' ' },
		{ type: 'text-delta', index: 0, text: '⇒'.repeat(25) },
		{ type: 'text-delta', index: 0, text: ' end' },
		{ type: 'block-end', index: 0, block: { type: 'text', text: '' } },
		{ type: 'finish', reason: { kind: 'stop' } },
	]
	const out = await collect(makeStream(chunks), { text: 'sanitize' })
	const text = deltaText(out, 'text-delta')

	assert.ok(!text.includes('⇒'), `退化符号必须全部被折叠，实际输出：${JSON.stringify(text)}`)
	assert.equal(text, '〔退化符号流×50〕 end', '整段游程只能折成一个标记，符号数按 50 计')
})

test('N2：干预上限用尽后再遇到退化，不许把原始符号原样放行', async () => {
	// 两段互不相连的退化游程：第一段被净化，第二段撞上单次调用的干预上限。
	// 上限的作用是「别反复改写」，不是「放行退化」——放行会让原始符号直接落进会话。
	const chunks = [
		{ type: 'block-start', index: 0, blockType: 'text' },
		{ type: 'text-delta', index: 0, text: '⇒'.repeat(30) },
		{ type: 'text-delta', index: 0, text: '中间正文。' },
		{ type: 'text-delta', index: 0, text: '⇒'.repeat(30) },
		{ type: 'text-delta', index: 0, text: '结尾。' },
		{ type: 'block-end', index: 0, block: { type: 'text', text: '' } },
		{ type: 'finish', reason: { kind: 'stop' } },
	]
	const out = await collect(makeStream(chunks), { text: 'sanitize', maxInterventionsPerCall: 1 })
	const text = deltaText(out, 'text-delta')

	assert.ok(!text.includes('⇒'), `原始退化符号不许被放行，实际输出：${JSON.stringify(text)}`)
	const blockEnd = out.find((c) => c.type === 'block-end')
	if (blockEnd) {
		assert.ok(!blockEnd.block.text.includes('⇒'), 'block-end 的权威文本里也不许残留原始符号')
	}
})

test('A2（覆盖）：滞留窗口滑动过之后，block-end 的权威文本仍等于净化后的 delta', async () => {
	// 两段互不相同的正文把滞留窗口顶出去（pendingStart > 0），退化游程落在窗口中后段。
	// 这时 `end`（pendingText 相对下标）与 `current.start`（通道偏移）不在同一坐标系，
	// 回退 `runEndInChannel` 就会让 block-end 少一截正文、多出一段原始符号。
	const preamble1 = Array.from({ length: 200 }, (_, i) => String.fromCharCode(0x4e00 + i)).join('')
	const preamble2 = Array.from({ length: 100 }, (_, i) => String.fromCharCode(0x4e00 + 200 + i)).join('')
	const run = '⇒'.repeat(40)
	const chunks = [
		{ type: 'block-start', index: 0, blockType: 'text' },
		{ type: 'text-delta', index: 0, text: preamble1 },
		{ type: 'text-delta', index: 0, text: preamble2 },
		{ type: 'text-delta', index: 0, text: run },
		{ type: 'text-delta', index: 0, text: '结尾正文。' },
		{ type: 'block-end', index: 0, block: { type: 'text', text: '' } },
		{ type: 'finish', reason: { kind: 'stop' } },
	]
	const out = await collect(makeStream(chunks), { text: 'sanitize' })
	const blockEnd = out.find((c) => c.type === 'block-end')
	const deltas = deltaText(out, 'text-delta')

	assert.ok(blockEnd, '必须产出 block-end')
	assert.ok(!blockEnd.block.text.includes('⇒'), 'block-end 文本里不得残留退化符号')
	assert.equal(blockEnd.block.text, deltas, 'block-end 的权威文本必须等于净化后的 delta 拼接')
	assert.ok(blockEnd.block.text.endsWith('结尾正文。'), '正文不得丢失')
	assert.ok(blockEnd.block.text.startsWith(preamble1), '窗口滑动过的正文也不得丢失')
})

test('A3（覆盖）：块结束时的收尾判定能拦住退化，后面的块不再发出', async () => {
	// 「塌缩」是采样规则：feed 时每 256 字符才采样一次，
	// 所以 200 字符的塌缩尾巴只有 block-end 的 flush() 才能看到。
	const tail = 'ab'.repeat(100)
	const chunks = [
		{ type: 'block-start', index: 0, blockType: 'reasoning' },
		{ type: 'reasoning-delta', index: 0, text: tail },
		{ type: 'block-end', index: 0, block: { type: 'reasoning', text: tail } },
		{ type: 'block-start', index: 1, blockType: 'reasoning' },
		{ type: 'reasoning-delta', index: 1, text: '后面的块不该发出来' },
		{ type: 'block-end', index: 1, block: { type: 'reasoning', text: '后面的块不该发出来' } },
		{ type: 'finish', reason: { kind: 'stop' } },
	]
	const out = await collect(makeStream(chunks), { reasoning: 'truncate' })
	const blockEnds = out.filter((c) => c.type === 'block-end')
	const last = out[out.length - 1]

	assert.equal(blockEnds.length, 1, '退化被拦下后，后面的块不该再发出来')
	assert.equal(last.type, 'finish')
	assert.equal(last.reason.kind, 'error')
	assert.equal(last.reason.failure.code, 'DEGENERATION_DETECTED')
})

test('A3（覆盖）：没有 block-end 的流，finish 时也要做收尾判定', async () => {
	const tail = 'ab'.repeat(100)
	const chunks = [
		{ type: 'block-start', index: 0, blockType: 'reasoning' },
		{ type: 'reasoning-delta', index: 0, text: tail },
		{ type: 'finish', reason: { kind: 'stop' } },
	]
	const out = await collect(makeStream(chunks), { reasoning: 'truncate' })
	const last = out[out.length - 1]

	assert.equal(last.type, 'finish')
	assert.equal(last.reason.kind, 'error', '退化必须以 error 收尾')
	assert.equal(last.reason.failure.code, 'DEGENERATION_DETECTED')
})

test('A5（覆盖）：collapseSymbolRuns 直接折叠符号游程并回报符号数', () => {
	const result = collapseSymbolRuns(`前面⇒⇒⇒ ⇒⇒⇒后面`, { minRun: 3 })
	assert.ok(!result.text.includes('⇒'), '折叠后不应残留原始符号')
	assert.equal(result.runs.length, 1, '游程内部含空白时仍算一段')
	assert.equal(result.runs[0].count, 6)
	assert.equal(result.runs[0].char, '⇒')
})
