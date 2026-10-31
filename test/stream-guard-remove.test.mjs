/**
 * 流式守卫的「删除方式」（remove）测试。
 *
 * 与 `sanitize`（净化）只有一处不同：**退化段被整段删掉，一个标记都不留**。
 * 所以这里盯的是三件事：
 * - 输出里既没有退化符号，也没有任何替代标记（`〔退化符号流×N〕`）；
 * - 流继续走完（终止方式不变，不是截断）；
 * - 判定上报里 action 是 `remove`，原文仍然留档作为证据。
 *
 * 另外兜底路径（匹配不上的 block-end）也走同一套口径。
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

/** 拼一个 text 块（含 block-start / delta / block-end）。 */
function textBlock(text, { index = 0, deltaSize = 16 } = {}) {
	const chunks = [{ type: 'block-start', index, blockType: 'text' }]
	for (let i = 0; i < text.length; i += deltaSize) {
		chunks.push({ type: 'text-delta', index, text: text.slice(i, i + deltaSize) })
	}
	chunks.push({ type: 'block-end', index, block: { type: 'text', text } })
	return chunks
}

/** 拼一个 reasoning 块。 */
function reasoningBlock(text, { index = 0, deltaSize = 16 } = {}) {
	const chunks = [{ type: 'block-start', index, blockType: 'reasoning' }]
	for (let i = 0; i < text.length; i += deltaSize) {
		chunks.push({ type: 'reasoning-delta', index, text: text.slice(i, i + deltaSize) })
	}
	chunks.push({ type: 'block-end', index, block: { type: 'reasoning', text } })
	return chunks
}

/** 把一段输出里的 delta 文本拼起来。 */
function deltaText(out, type = 'text-delta') {
	return out.filter((c) => c.type === type).map((c) => c.text).join('')
}

test('remove 方式：退化游程整段删掉，一个标记都不留，流继续', async () => {
	const run = '⇒'.repeat(64)
	const chunks = [
		{ type: 'block-start', index: 0, blockType: 'text' },
		{ type: 'text-delta', index: 0, text: '结论如下：' },
		{ type: 'text-delta', index: 0, text: run },
		{ type: 'text-delta', index: 0, text: '以上。' },
		{ type: 'block-end', index: 0, block: { type: 'text', text: `结论如下：${run}以上。` } },
		{ type: 'finish', reason: { kind: 'stop' } },
	]
	const out = await collect(makeStream(chunks), { text: 'remove' })

	const last = out[out.length - 1]
	assert.equal(last.type, 'finish')
	assert.equal(last.reason.kind, 'stop', '删除方式不改变终止方式（不是截断）')

	const texts = deltaText(out)
	assert.ok(!texts.includes('⇒'), `退化符号必须被删掉：${texts}`)
	assert.ok(!texts.includes('〔'), `不许留下任何替代标记：${texts}`)
	assert.ok(!texts.includes('退化'), `不许留下任何替代标记：${texts}`)
	assert.ok(texts.includes('结论如下：'), '退化前的正常内容必须保留')
	assert.ok(texts.includes('以上。'), '退化之后的内容必须保留')
})

test('remove 方式：block-end 的权威文本里也没有退化符号、没有标记', async () => {
	const run = '⇒'.repeat(64)
	const chunks = [
		{ type: 'block-start', index: 0, blockType: 'text' },
		{ type: 'text-delta', index: 0, text: '结论如下：' },
		{ type: 'text-delta', index: 0, text: run },
		{ type: 'text-delta', index: 0, text: '以上。' },
		{ type: 'block-end', index: 0, block: { type: 'text', text: `结论如下：${run}以上。` } },
		{ type: 'finish', reason: { kind: 'stop' } },
	]
	const out = await collect(makeStream(chunks), { text: 'remove' })

	const blockEnd = out.filter((c) => c.type === 'block-end').at(-1)
	assert.ok(blockEnd, '必须有 block-end')
	assert.ok(!blockEnd.block.text.includes('⇒'), `权威文本里不许有退化符号：${blockEnd.block.text}`)
	assert.ok(!blockEnd.block.text.includes('〔'), `权威文本里不许有替代标记：${blockEnd.block.text}`)
	assert.ok(blockEnd.block.text.includes('结论如下：'), blockEnd.block.text)
	assert.ok(blockEnd.block.text.includes('以上。'), blockEnd.block.text)
})

test('remove 方式：上报里 action 是 remove，标记为空串，原文留档', async () => {
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
	await collect(makeStream(chunks), {
		text: 'remove',
		onVerdict: (verdict, info) => verdicts.push({ verdict, info }),
	})

	assert.equal(verdicts.length, 1, `实际 ${verdicts.length} 条裁决`)
	const { verdict, info } = verdicts[0]
	assert.equal(info.action, 'remove')
	assert.equal(info.channel, 'text')
	assert.equal(info.marker, '', '删除方式没有标记')
	assert.equal(info.original, run, '原文仍然留档作为证据')
	assert.equal(typeof info.offset, 'number', '上报里必须有通道偏移')
	assert.equal(verdict.rule, 'symbol-run')
})

test('remove 方式：reasoning 通道同样生效', async () => {
	const run = '⇒'.repeat(64)
	const chunks = [
		...reasoningBlock(`先确认一下现状：${run}后面的推理还在。`),
		{ type: 'finish', reason: { kind: 'stop' } },
	]
	const out = await collect(makeStream(chunks), { reasoning: 'remove' })

	const last = out[out.length - 1]
	assert.equal(last.type, 'finish')
	assert.equal(last.reason.kind, 'stop', '删除方式不改变终止方式')

	const texts = deltaText(out, 'reasoning-delta')
	assert.ok(!texts.includes('⇒'), `退化符号必须被删掉：${texts}`)
	assert.ok(!texts.includes('〔'), `不许留下任何替代标记：${texts}`)
	assert.ok(texts.includes('先确认一下现状：'), '退化前的正常内容必须保留')
	assert.ok(texts.includes('后面的推理还在。'), '退化之后的内容必须保留')
})

test('remove 方式：游程延续到后续 delta 时整段都被删掉', async () => {
	const chunks = [
		{ type: 'block-start', index: 0, blockType: 'text' },
		{ type: 'text-delta', index: 0, text: '⇒'.repeat(30) },
		{ type: 'text-delta', index: 0, text: '⇒'.repeat(30) },
		{ type: 'text-delta', index: 0, text: ' 结束' },
		{ type: 'block-end', index: 0, block: { type: 'text', text: 'x' } },
		{ type: 'finish', reason: { kind: 'stop' } },
	]
	const out = await collect(makeStream(chunks), { text: 'remove' })
	const texts = deltaText(out)
	assert.ok(!texts.includes('⇒'), `退化符号必须被删掉：${texts}`)
	assert.ok(!texts.includes('〔'), `不许留下任何替代标记：${texts}`)
	assert.ok(texts.includes('结束'), '游程之后的内容必须保留')
})

test('remove 方式：匹配不上的 block-end 兜底改写也是删除，不折叠成标记', async () => {
	// 守卫没有登记过这个块（block-start 缺失）—— 兜底路径必须把退化段摘掉，
	// 而不是折叠成标记，更不是原样放行。
	const run = '⇒'.repeat(64)
	const chunks = [
		{ type: 'block-end', index: 7, block: { type: 'text', text: `结论如下：${run}以上。` } },
		{ type: 'finish', reason: { kind: 'stop' } },
	]
	const out = await collect(makeStream(chunks), { text: 'remove' })

	const blockEnd = out.filter((c) => c.type === 'block-end').at(-1)
	assert.ok(blockEnd, '必须有 block-end')
	assert.ok(!blockEnd.block.text.includes('⇒'), `权威文本里不许有退化符号：${blockEnd.block.text}`)
	assert.ok(!blockEnd.block.text.includes('〔'), `权威文本里不许有替代标记：${blockEnd.block.text}`)
	assert.ok(blockEnd.block.text.includes('结论如下：'), blockEnd.block.text)
	assert.ok(blockEnd.block.text.includes('以上。'), blockEnd.block.text)
})

test('remove 方式：多字符单元重复也整段删掉', async () => {
	const unit = '⇒⇒§ '
	const chunks = [
		{ type: 'block-start', index: 0, blockType: 'text' },
		{ type: 'text-delta', index: 0, text: `前置说明。${unit.repeat(12)}后置说明。` },
		{ type: 'block-end', index: 0, block: { type: 'text', text: `前置说明。${unit.repeat(12)}后置说明。` } },
		{ type: 'finish', reason: { kind: 'stop' } },
	]
	const out = await collect(makeStream(chunks), { text: 'remove' })

	const texts = deltaText(out)
	assert.ok(!texts.includes('⇒⇒§'), `单元重复必须被删掉：${texts}`)
	assert.ok(!texts.includes('〔'), `不许留下任何替代标记：${texts}`)
	assert.ok(texts.includes('前置说明。'), '前文要保留')
	assert.ok(texts.includes('后置说明。'), '后文要保留')
})

test('remove 方式：删掉之后不再命中退化判定', async () => {
	const run = '⇒'.repeat(64)
	const chunks = [
		{ type: 'block-start', index: 0, blockType: 'text' },
		{ type: 'text-delta', index: 0, text: `结论如下：${run}以上。` },
		{ type: 'block-end', index: 0, block: { type: 'text', text: `结论如下：${run}以上。` } },
		{ type: 'finish', reason: { kind: 'stop' } },
	]
	const verdicts = []
	const out = await collect(makeStream(chunks), {
		text: 'remove',
		onVerdict: (verdict, info) => verdicts.push({ verdict, info }),
	})

	assert.equal(verdicts.length, 1, `只该有一次处置，实际 ${verdicts.length} 次`)
	const texts = deltaText(out)
	assert.ok(!texts.includes('⇒'), `退化符号必须被删掉：${texts}`)
	// 删掉之后剩下的正文里不该再有第二段游程，也就不该再有第二次处置。
	assert.ok(!texts.includes('〔'), `不许留下任何替代标记：${texts}`)
})

test('默认处置方式是 truncate（两个通道都是）', async () => {
	const run = '⇒'.repeat(64)
	const chunks = [
		{ type: 'block-start', index: 0, blockType: 'text' },
		{ type: 'text-delta', index: 0, text: run },
		{ type: 'block-end', index: 0, block: { type: 'text', text: run } },
		{ type: 'finish', reason: { kind: 'stop' } },
	]
	const out = await collect(makeStream(chunks))

	const last = out[out.length - 1]
	assert.equal(last.type, 'finish')
	assert.equal(last.reason.kind, 'error', '默认策略是截断')
	assert.equal(last.reason.failure.code, 'DEGENERATION_DETECTED')
	const texts = deltaText(out)
	assert.ok(!texts.includes('⇒'), '退化内容不得出现在输出流里')
	assert.ok(!texts.includes('〔'), '截断不留标记')
})
