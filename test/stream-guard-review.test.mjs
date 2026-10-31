/**
 * 流式守卫 —— 复审缺陷回归测试。
 *
 * 这一批对应终审复审（stream-guard lens）报出的 8 条确认缺陷：
 *
 * - F1 一段增量里出现**两段**符号游程时，早的那段既没被折叠也没被切断 —— 原始符号进宿主；
 * - F2 单段增量超过检测窗口时，**开头**的游程被裁剪切出窗口 —— 整段游程检不出来；
 * - F3 游程没有收尾增量时，标记的 `×N` 计数不结算 —— 计数比实际少；
 * - F4 结算时按字符串替换，落在**第一个**同名标记上 —— 两段同样长的游程计数互换；
 * - F5 计数未结算的标记被提前释放 —— delta 与权威 block-end 的计数不一致；
 * - F6 切断时没有关闭全部打开的块（reasoning 关闭通道、tool-call 块）；
 * - F7 匹配不上的 block-end 被原样放行 —— 原始符号进权威文本；
 * - F8 同一个守卫实例连续跑两次时，第二次直接被上一次的切断状态废掉。
 * - D1 游程起点已经流出滞留窗口时，只折叠后半段 → 发一个少算了一半的标记。
 *
 * 宿主契约依据：`BlockAssembler` 以 index 为键维护分块，`block-end` 的 `block` 整体覆盖
 * 分块内容（dsh-llm/lib/types/assembler.js:64-72），开放块由 delta 累加装配
 * （assembler.js:94-108）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { StreamGuard, guardStream } from '../lib/stream-guard.js'

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

/** 造一段不重复的填充文本（避免先被 collapse-gram 这条规则拦下）。 */
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

/** 取输出里某个通道的全部 delta 文本。 */
function deltaText(out, type = 'text-delta') {
	return out.filter((c) => c.type === type).map((c) => c.text).join('')
}

/** 取输出里某个 index 的 block-end 权威文本。 */
function blockText(out, index) {
	const chunk = out.find((c) => c.type === 'block-end' && c.index === index)
	return chunk ? chunk.block.text : null
}

/** 取文本里所有标记的计数。 */
function markerCounts(text) {
	return [...String(text).matchAll(/〔退化符号流×(\d+)〕/g)].map((m) => Number(m[1]))
}

test('F1 净化通道：同一段增量里的两段游程都要被清掉', async () => {
	const run = '⇒'.repeat(25)
	const chunks = [
		{ type: 'block-start', index: 0, blockType: 'text' },
		{ type: 'text-delta', index: 0, text: `前面${run}中间${run}后面` },
		{ type: 'block-end', index: 0, block: { type: 'text', text: `前面${run}中间${run}后面` } },
		{ type: 'finish', reason: { kind: 'stop' } },
	]
	const out = await collect(makeStream(chunks), { text: 'sanitize', maxInterventionsPerCall: 3 })
	const texts = deltaText(out)
	assert.ok(!texts.includes('⇒'), `早的那段游程被放行：${texts}`)
	assert.equal((texts.match(/〔退化符号流/g) ?? []).length, 2, `两段游程都要留下标记：${texts}`)
	assert.ok(texts.includes('前面') && texts.includes('后面'), `正文必须保留：${texts}`)
	const authoritative = blockText(out, 0)
	assert.ok(!authoritative.includes('⇒'), `权威文本里仍有原始符号：${authoritative}`)
})

test('F1 干预次数用完时也不放行退化：第二段游程改为截断', async () => {
	const run = '⇒'.repeat(25)
	const chunks = [
		{ type: 'block-start', index: 0, blockType: 'text' },
		{ type: 'text-delta', index: 0, text: `前面${run}中间${run}后面` },
		{ type: 'block-end', index: 0, block: { type: 'text', text: `前面${run}中间${run}后面` } },
		{ type: 'finish', reason: { kind: 'stop' } },
	]
	const out = await collect(makeStream(chunks), { text: 'sanitize' })
	const last = out[out.length - 1]
	assert.equal(last.reason.kind, 'error', '干预次数用完必须以截断收尾')
	const texts = deltaText(out)
	assert.ok(!texts.includes('⇒'), `原始符号被放行：${texts}`)
})

test('F1 截断通道：切点落在最早的那段游程上，早的游程不得放行', async () => {
	const run = '⇒'.repeat(25)
	const chunks = [
		{ type: 'block-start', index: 0, blockType: 'text' },
		{ type: 'text-delta', index: 0, text: `前面${run}中间${run}后面` },
		{ type: 'block-end', index: 0, block: { type: 'text', text: 'x' } },
		{ type: 'finish', reason: { kind: 'stop' } },
	]
	const out = await collect(makeStream(chunks), { text: 'truncate' })
	const last = out[out.length - 1]
	assert.equal(last.type, 'finish')
	assert.equal(last.reason.kind, 'error', '退化必须以错误终止')
	const texts = deltaText(out)
	assert.ok(!texts.includes('⇒'), `原始符号被放行：${texts}`)
})

test('F2 超长增量开头的游程必须被检出（默认规则与默认窗口）', async () => {
	const chunks = [
		{ type: 'block-start', index: 0, blockType: 'text' },
		{ type: 'text-delta', index: 0, text: '⇒'.repeat(30) + filler(5000, 3) },
		{ type: 'block-end', index: 0, block: { type: 'text', text: 'x' } },
		{ type: 'finish', reason: { kind: 'stop' } },
	]
	const verdicts = []
	const out = await collect(makeStream(chunks), {
		text: 'sanitize',
		onVerdict: (v) => verdicts.push(v),
	})
	assert.ok(
		verdicts.some((v) => v.rule === 'symbol-run'),
		`开头的游程必须被判出来：${JSON.stringify(verdicts.map((v) => v.rule))}`,
	)
	const texts = deltaText(out)
	assert.ok(!texts.includes('⇒'), `原始符号被放行：${texts.length} 字`)
})

test('F3 游程没有收尾增量时标记计数必须结算', async () => {
	const chunks = [
		{ type: 'block-start', index: 0, blockType: 'text' },
		{ type: 'text-delta', index: 0, text: '⇒'.repeat(20) },
		{ type: 'text-delta', index: 0, text: '⇒'.repeat(30) },
		{ type: 'block-end', index: 0, block: { type: 'text', text: 'x' } },
		{ type: 'finish', reason: { kind: 'stop' } },
	]
	const out = await collect(makeStream(chunks), { text: 'sanitize' })
	const texts = deltaText(out)
	assert.deepEqual(markerCounts(texts), [50], `delta 计数不对：${texts}`)
	assert.deepEqual(markerCounts(blockText(out, 0)), [50], `权威文本计数不对：${blockText(out, 0)}`)
})

test('F4 两段同样长的游程：结算必须落在各自标记上', async () => {
	const run = '⇒'.repeat(20)
	const chunks = [
		{ type: 'block-start', index: 0, blockType: 'text' },
		{ type: 'text-delta', index: 0, text: `A${run}B${run}C` },
		{ type: 'text-delta', index: 0, text: '⇒'.repeat(30) },
		{ type: 'block-end', index: 0, block: { type: 'text', text: 'x' } },
		{ type: 'finish', reason: { kind: 'stop' } },
	]
	const out = await collect(makeStream(chunks), { text: 'sanitize', maxInterventionsPerCall: 5 })
	const counts = markerCounts(blockText(out, 0))
	assert.deepEqual(counts, [20, 50], `权威文本的两个标记计数不对：${blockText(out, 0)}`)
	assert.deepEqual(markerCounts(deltaText(out)), [20, 50], `delta 的两个标记计数不对：${deltaText(out)}`)
})

test('F5 未结算的标记不得被提前释放：delta 与权威文本计数必须一致', async () => {
	const chunks = [
		{ type: 'block-start', index: 0, blockType: 'text' },
		{ type: 'text-delta', index: 0, text: '⇒'.repeat(20) },
		{ type: 'block-start', index: 1, blockType: 'reasoning' },
		{ type: 'reasoning-delta', index: 1, text: filler(400, 5) },
		{ type: 'text-delta', index: 0, text: '⇒'.repeat(30) },
		{ type: 'block-end', index: 0, block: { type: 'text', text: 'x' } },
		{ type: 'block-end', index: 1, block: { type: 'reasoning', text: 'x' } },
		{ type: 'finish', reason: { kind: 'stop' } },
	]
	const out = await collect(makeStream(chunks), { text: 'sanitize', reasoning: 'truncate' })
	const deltaCounts = markerCounts(deltaText(out))
	const blockCounts = markerCounts(blockText(out, 0))
	assert.ok(deltaCounts.length > 0, `delta 里没有标记：${deltaText(out)}`)
	assert.deepEqual(deltaCounts, blockCounts, `两处计数不一致：delta=${deltaCounts} block=${blockCounts}`)
	assert.deepEqual(deltaCounts, [50], `计数不对：${deltaCounts}`)
})

test('F6 切断时 reasoning 关闭通道留下的打开块也要关闭', async () => {
	const chunks = [
		{ type: 'block-start', index: 0, blockType: 'reasoning' },
		{ type: 'reasoning-delta', index: 0, text: '思考' },
		{ type: 'block-start', index: 1, blockType: 'text' },
		{ type: 'text-delta', index: 1, text: '⇒'.repeat(64) },
	]
	const out = await collect(makeStream(chunks), { reasoning: 'off', text: 'truncate' })
	const starts = out.filter((c) => c.type === 'block-start').map((c) => c.index)
	const ends = out.filter((c) => c.type === 'block-end').map((c) => c.index)
	for (const index of starts) assert.ok(ends.includes(index), `块 ${index} 没有被关闭`)
	assert.equal(out[out.length - 1].reason.kind, 'error')
})

test('F6 切断时 tool-call 块也要关闭', async () => {
	const chunks = [
		{ type: 'block-start', index: 0, blockType: 'tool-call' },
		{ type: 'tool-call-delta', index: 0, id: 'call-1', name: 'bash', argumentsDelta: '{"cmd":"ls"}' },
		{ type: 'block-start', index: 1, blockType: 'text' },
		{ type: 'text-delta', index: 1, text: '⇒'.repeat(64) },
	]
	const out = await collect(makeStream(chunks), { text: 'truncate' })
	const starts = out.filter((c) => c.type === 'block-start').map((c) => c.index)
	const ends = out.filter((c) => c.type === 'block-end').map((c) => c.index)
	for (const index of starts) assert.ok(ends.includes(index), `块 ${index} 没有被关闭`)
	const toolEnd = out.find((c) => c.type === 'block-end' && c.index === 0)
	assert.ok(toolEnd, 'tool-call 块必须被关闭')
	assert.equal(toolEnd.block.type, 'tool-call')
	assert.equal(toolEnd.block.arguments, '{"cmd":"ls"}', '关闭时不得丢掉工具参数')
})

test('F7 匹配不上的 block-end 不得原样放行原始符号', async () => {
	const run = '⇒'.repeat(40)
	const chunks = [
		{ type: 'block-start', index: 0, blockType: 'text' },
		{ type: 'text-delta', index: 0, text: run },
		{ type: 'block-end', index: 1, block: { type: 'text', text: run } },
		{ type: 'finish', reason: { kind: 'stop' } },
	]
	const out = await collect(makeStream(chunks), { text: 'sanitize' })
	const authoritative = blockText(out, 1)
	assert.ok(authoritative !== null, 'block-end 必须被转发')
	assert.ok(!authoritative.includes('⇒'), `未匹配的 block-end 原样放行了原始符号：${authoritative}`)
})

test('F7 同时打开的两个 text 块：先结束的块也要被改写', async () => {
	const run = '⇒'.repeat(40)
	const chunks = [
		{ type: 'block-start', index: 0, blockType: 'text' },
		{ type: 'text-delta', index: 0, text: run },
		{ type: 'block-start', index: 1, blockType: 'text' },
		{ type: 'text-delta', index: 1, text: '正常内容' },
		{ type: 'block-end', index: 0, block: { type: 'text', text: run } },
		{ type: 'block-end', index: 1, block: { type: 'text', text: '正常内容' } },
		{ type: 'finish', reason: { kind: 'stop' } },
	]
	const out = await collect(makeStream(chunks), { text: 'sanitize' })
	const first = blockText(out, 0)
	assert.ok(first !== null, '块 0 必须被关闭')
	assert.ok(!first.includes('⇒'), `块 0 的权威文本里仍有原始符号：${first}`)
})

test('F8 同一个守卫实例连续跑两次，第二次必须正常工作', async () => {
	const guard = new StreamGuard({ text: 'truncate' })
	const degenerate = [
		{ type: 'block-start', index: 0, blockType: 'text' },
		{ type: 'text-delta', index: 0, text: '⇒'.repeat(64) },
	]
	const normal = [
		{ type: 'block-start', index: 0, blockType: 'text' },
		{ type: 'text-delta', index: 0, text: '正常内容' },
		{ type: 'block-end', index: 0, block: { type: 'text', text: '正常内容' } },
		{ type: 'finish', reason: { kind: 'stop' } },
	]
	const first = []
	for await (const chunk of guard.run(makeStream(degenerate))) first.push(chunk)
	const second = []
	for await (const chunk of guard.run(makeStream(normal))) second.push(chunk)
	assert.equal(first[first.length - 1].reason.kind, 'error', '第一次应当切断')
	assert.deepEqual(second, normal, '第二次必须原样透传')
})

test('D1 游程起点已流出滞留窗口时必须整段截断，不许只折叠后半段', async () => {
	// 复审缺陷 D1 的复现条件：
	// 游程的前半段在**更早的增量**里就已经放出去了（滞留窗口滑过它），
	// 等判定器凑够 minRun 个符号时，游程的起点已经落在滞留窗口之外。
	// 这时候折叠只会清掉后半段，还发一个「少算了前半段」的标记出去 ——
	// 等于告诉宿主「这里清干净了」，实际没清。
	// 处理方式只能是整段截断：宁可少一段正文，也不发少算的标记。
	//
	// 构造：
	// - 块 0 的第一个增量 = 10 个符号 + 200 个换行（游程头部在这里，尚未凑够 20 个符号）；
	// - 第二个增量 = 100 个换行 → 滞留窗口滑过，把上面的头部放出去了；
	// - 块 1 的增量 = 10 个符号 → 判定器这时才凑够 20 个符号，起点已经落在窗口之外。
	const head = '⇒'.repeat(10)
	const chunks = [
		{ type: 'block-start', index: 0, blockType: 'text' },
		{ type: 'text-delta', index: 0, text: head + '\n'.repeat(200) },
		{ type: 'text-delta', index: 0, text: '\n'.repeat(100) },
		{ type: 'block-end', index: 0, block: { type: 'text', text: '' } },
		{ type: 'block-start', index: 1, blockType: 'text' },
		{ type: 'text-delta', index: 1, text: '⇒'.repeat(10) },
		{ type: 'block-end', index: 1, block: { type: 'text', text: '' } },
		{ type: 'finish', reason: { kind: 'stop' } },
	]
	const out = await collect(makeStream(chunks), { text: 'sanitize' })
	const last = out[out.length - 1]
	const texts = deltaText(out)

	assert.equal(last.type, 'finish', '退化之后必须以 finish 收尾')
	assert.equal(last.reason.kind, 'error', '游程起点已流出窗口时必须整段截断，不能只折叠后半段')
	assert.equal(last.reason.failure.code, 'DEGENERATION_DETECTED')
	assert.deepEqual(markerCounts(texts), [], `截断之前不许发出任何标记（会少算一半）：${texts}`)
	assert.ok(
		!texts.includes('〔退化符号流×10〕'),
		`不许发出只数到 10 个符号的标记（真实游程是 20 个）：${texts}`,
	)
})
