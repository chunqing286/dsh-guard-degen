/**
 * 历史会话遮蔽测试 —— T8。
 *
 * 约束：所有读写都走注入的 `readFile` / `writeFile` 桩，
 * **绝不读写真实会话目录**。
 *
 * 覆盖的关键行为：
 *   - 只替换退化段，正常文字逐字不变；
 *   - tool-call 块原样保留，tool-call / tool-result 配对不受影响；
 *   - `apply:false` 是只读预览，一个字节都不落盘；
 *   - `replace` 先备份再写，写完回读复核；
 *   - 遮蔽后不再命中 `findSymbolRun`；
 *   - 不足 minRun 的单个符号不算退化；
 *   - 审计旁车记录被遮蔽段的数量与位置；
 *   - 读不到 / 解不开 → `error` 有说明，不抛异常。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'

import { findSymbolRun } from '../lib/detect.js'
import { decodeSession } from '../lib/scan.js'
import { extractSessionTitle, locateMarkers, maskSession, restoreSessionText, scanSessions } from '../lib/sessions.js'
import './helpers/temp-home.mjs'

const RUN = '⇒'.repeat(30)
const MARK = '〔退化内容已遮蔽×'
const FILE = '/sessions/proj-1/session.v4.jsonl.zstd'
const OTHER = '/sessions/proj-2/session.v4.jsonl.zstd'

/** 会话头部行（宿主 v4 存档的第一行）。 */
const SESSION_HEADER = {
	type: 'session',
	version: 4,
	id: 'proj-1',
	createdAt: 1,
	cwd: 'C:/work',
	isSeeded: false,
	delegationDepth: 0,
}

/**
 * 遮蔽的测试入口：固定允许的根目录为 `/sessions`。
 *
 * 复审缺陷 N4 之后，遮蔽目标必须落在允许的根目录之内，
 * 所以这组用例显式给出根目录（根目录策略本身由安全用例覆盖）。
 *
 * @param {object} options - 选项
 * @returns {object} 结果
 */
function mask(options) {
	return maskSession({ roots: ['/sessions'], ...options })
}

/**
 * 造一条宿主形状的 `assistant/message` 事件。
 *
 * 字段照抄宿主自己写出来的行：`turn` / `step` 是正整数，消息带 `id`
 * 和生产者自己的 `source`（`kind` 非空且不是 plugin）。
 *
 * @param {number} seq - 事件序号
 * @param {Array<object>} content - 消息内容块
 * @param {object} [extra] - 额外字段（覆盖默认值）
 * @returns {object} 事件行
 */
function assistantEvent(seq, content, extra = {}) {
	return {
		type: 'assistant/message',
		seq,
		time: 1000 + seq,
		surfaceOp: 'append',
		data: {
			turn: 1,
			step: 1,
			message: {
				role: 'assistant',
				content,
				source: { kind: 'model', provider: 'test', model: 'test-model' },
				id: `msg-${seq}`,
			},
			stream: [],
		},
		...extra,
	}
}

/**
 * 造一条宿主形状的 `tool/result` 事件。
 * @param {number} seq - 事件序号
 * @param {object} [extra] - data 的额外字段
 * @returns {object} 事件行
 */
function toolResultEvent(seq, extra = {}) {
	return {
		type: 'tool/result',
		seq,
		time: 1000 + seq,
		surfaceOp: 'append',
		data: {
			turn: 1,
			step: 1,
			callId: `call_${seq}`,
			ok: true,
			content: '工具结果',
			message: { role: 'tool', source: { kind: 'tool', callId: `call_${seq}` }, id: `msg-${seq}` },
			...extra,
		},
	}
}

/**
 * 造一条宿主形状的 `user/message` 事件。
 * @param {number} seq - 事件序号
 * @param {string} text - 消息正文
 * @returns {object} 事件行
 */
function userEvent(seq, text) {
	return {
		type: 'user/message',
		seq,
		time: 1000 + seq,
		surfaceOp: 'append',
		data: {
			turn: 1,
			source: { kind: 'user' },
			message: { role: 'user', content: text },
		},
	}
}

/**
 * 构造一个带 tool-call 的会话事件序列（JSONL 文本）。
 *
 * 形状必须和宿主写出来的 v4 存档一致：第 1 行是**头部行**，后面每行是一条事件
 * （`type` / `seq` / `time` / `data`，表面事件还要带 `surfaceOp`）。
 * 插件现在会按宿主的验收规则检查产物，形状不对的存档一律拒写。
 *
 * @returns {string} JSONL 文本
 */
function buildSessionText() {
	const events = [
		{
			type: 'user/message',
			seq: 0,
			time: 1,
			surfaceOp: 'append',
			data: {
				turn: 1,
				source: { kind: 'user' },
				message: { role: 'user', content: '请帮我看看这个文件' },
			},
		},
		{
			type: 'assistant/message',
			seq: 1,
			time: 2,
			surfaceOp: 'append',
			data: {
				turn: 1,
				step: 1,
				message: {
					role: 'assistant',
					content: [
						{ type: 'reasoning', text: `先读文件再判断。${RUN}后面的推理还在。` },
						{ type: 'text', text: `读取完成，结论如下。${RUN}` },
						{ type: 'tool-call', id: 'call_1', name: 'read', arguments: { path: 'a.md' } },
					],
					source: { kind: 'model', provider: 'test', model: 'test-model' },
					id: 'msg-1',
				},
				stream: [],
			},
		},
		{
			type: 'tool/result',
			seq: 2,
			time: 3,
			surfaceOp: 'append',
			data: {
				turn: 1,
				step: 1,
				callId: 'call_1',
				ok: true,
				content: '文件片段内容',
				message: { role: 'tool', source: { kind: 'tool', callId: 'call_1' }, id: 'msg-2' },
			},
		},
	]
	return `${[SESSION_HEADER, ...events].map((e) => JSON.stringify(e)).join('\n')}\n`
}

/**
 * 把文本切成两帧 zstd（模拟 DSH 的多帧存档）。
 *
 * 第 0 帧**只放头部行** —— 宿主要求第 0 帧恰好是一行头部，
 * 头部和事件混在一帧里，宿主会直接判这份存档损坏。
 *
 * @param {string} text - 文本
 * @returns {Buffer} 多帧 zstd 字节
 */
function framePack(text) {
	const lines = text.split('\n')
	const head = `${lines[0]}\n`
	const tail = lines.slice(1).join('\n')
	return Buffer.concat([
		zlib.zstdCompressSync(Buffer.from(head, 'utf8')),
		zlib.zstdCompressSync(Buffer.from(tail, 'utf8')),
	])
}

/**
 * 造一个内存文件系统桩。
 * @param {Record<string, string | Buffer>} entries - 初始文件
 * @returns {object} 桩
 */
function makeStore(entries) {	const store = new Map()
	for (const [k, v] of Object.entries(entries)) {
		store.set(k, Buffer.isBuffer(v) ? v : Buffer.from(String(v), 'utf8'))
	}
	const writes = []
	const renames = []
	return {
		store,
		writes,
		renames,
		readFile(p) {
			if (!store.has(p)) {
				const err = new Error(`ENOENT: no such file or directory, open '${p}'`)
				err.code = 'ENOENT'
				throw err
			}
			return store.get(p)
		},
		writeFile(p, data) {
			const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8')
			writes.push({ path: p, data: buf })
			store.set(p, buf)
		},
		// replace 模式是「写临时文件 + 改名」，桩里要把这一步也记下来。
		rename(from, to) {
			if (!store.has(from)) {
				const err = new Error(`ENOENT: no such file or directory, rename '${from}'`)
				err.code = 'ENOENT'
				throw err
			}
			renames.push({ from, to })
			store.set(to, store.get(from))
			store.delete(from)
		},
		existsFile(p) {
			return store.has(p)
		},
	}
}

/**
 * 从解码后的 JSONL 里取出某个事件的 JSON。
 * @param {string} text - 解码文本
 * @param {number} index - 事件序号
 * @returns {any} 事件对象
 */
function eventAt(text, index) {
	const lines = text.split('\n').filter((l) => l !== '')
	return JSON.parse(lines[index])
}

test('scanSessions：报告退化命中与字段路径', () => {
	const fs = makeStore({ [FILE]: framePack(buildSessionText()) })
	const report = scanSessions({
		root: '/sessions',
		files: [FILE],
		readFile: fs.readFile,
		listFiles: () => [FILE],
	})

	assert.equal(report.root, '/sessions')
	assert.ok(report.scannedAt, '要有扫描时间')
	assert.equal(report.summary.filesScanned, 1)
	assert.equal(report.summary.filesFailed, 0)
	assert.equal(report.summary.sessionsWithHits, 1)
	assert.equal(report.summary.totalRuns, 2)
	assert.equal(report.summary.totalSymbols, 60)
	assert.equal(report.summary.maxRun, 30)

	assert.equal(report.sessions.length, 1)
	const session = report.sessions[0]
	assert.equal(session.path, FILE)
	assert.equal(session.id, 'proj-1')
	assert.equal(session.frames, 2)
	assert.equal(session.events, 4)
	assert.equal(session.runCount, 2)
	assert.equal(session.symbolCount, 60)
	assert.equal(session.maxRun, 30)
	assert.equal(session.hits.length, 2)
	assert.equal(session.hits[0].event, 2)
	assert.equal(session.hits[0].path, 'data.message.content[0].text')
	assert.equal(session.hits[0].rule, 'symbol-run')
	assert.equal(session.hits[0].count, 30)
	assert.ok(session.hits[0].preview.length <= 40)
})

test('scanSessions：可注入 listFiles 并统计失败文件', () => {
	const fs = makeStore({ [OTHER]: framePack(buildSessionText()) })
	const report = scanSessions({
		root: '/sessions',
		listFiles: () => [OTHER, '/sessions/missing/session.v4.jsonl.zstd'],
		readFile: fs.readFile,
	})

	assert.equal(report.summary.filesScanned, 1)
	assert.equal(report.summary.filesFailed, 1)
	assert.equal(report.sessions.length, 2)
	const failed = report.sessions.find((s) => s.path.includes('missing'))
	assert.ok(failed.error, '失败文件要有 error 说明')
	assert.equal(failed.runCount, 0)
})

test('scanSessions：干净会话不报命中', () => {
	const cleanEvent = {
		type: 'assistant/message',
		message: { role: 'assistant', content: [{ type: 'text', text: '一切正常，★ 单个标记不算退化。' }] },
	}
	const clean = `${JSON.stringify(cleanEvent)}\n`
	const fs = makeStore({ [FILE]: framePack(clean) })
	const report = scanSessions({ root: '/sessions', files: [FILE], readFile: fs.readFile })
	assert.equal(report.summary.sessionsWithHits, 0)
	assert.equal(report.summary.totalRuns, 0)
	assert.equal(report.sessions[0].hits.length, 0)
})

test('maskSession：apply=false 是只读预览，一个字节都不写', () => {
	const fs = makeStore({ [FILE]: framePack(buildSessionText()) })
	const result = mask({ file: FILE, apply: false, readFile: fs.readFile, writeFile: fs.writeFile })

	assert.equal(result.applied, false)
	assert.equal(result.mode, 'copy')
	assert.equal(result.file, FILE)
	assert.equal(result.masked, 2)
	assert.equal(result.symbols, 60)
	assert.equal(result.toolCallsKept, 1)
	assert.equal(result.remaining, 0)
	assert.equal(fs.writes.length, 0, '预览模式不得写盘')
	assert.equal(result.error, undefined)
})

test('maskSession：tool-call 块里的退化内容也原样保留（不产生孤儿）', () => {
	// tool-call 块按设计整块保留：块里的噪声不动（否则 tool-call 变孤儿），
	// 但同一条消息里的 reasoning / text 照常遮蔽。
	const events = [
		assistantEvent(0, [
			{ type: 'reasoning', text: `先看看文件。${RUN}推理继续。` },
			{ type: 'tool-call', id: 'call_9', name: 'write', arguments: { path: 'a.md', note: `写进去的内容${RUN}噪声` } },
		]),
		toolResultEvent(1, { callId: 'call_9', content: '写完了' }),
	]
	const text = `${[SESSION_HEADER, ...events].map((e) => JSON.stringify(e)).join('\n')}\n`
	const fs = makeStore({ [FILE]: framePack(text) })
	const result = mask({ file: FILE, apply: true, mode: 'copy', outFile: `${FILE}.masked`, readFile: fs.readFile, writeFile: fs.writeFile })

	assert.equal(result.masked, 1, '只有 reasoning 里的游程被遮蔽')
	assert.equal(result.toolCallsKept, 1)
	const outText = decodeSession(fs.store.get(`${FILE}.masked`)).text
	const before = eventAt(text, 1).data.message.content[1]
	const after = eventAt(outText, 1).data.message.content[1]
	assert.deepEqual(after, before, 'tool-call 块必须逐字一致')
	assert.ok(after.arguments.note.includes('⇒'), '块内噪声按设计保留')
	assert.ok(!eventAt(outText, 1).data.message.content[0].text.includes('⇒'), 'reasoning 里的噪声要清掉')
})

test('maskSession：回读复核——写出去的内容还有残留时要报出来', () => {
	// 模拟「写入没生效」：writeFile 把原始（仍有噪声）的内容写回去。
	// 回读复核必须发现残留，而不是无脑报 0。
	const original = framePack(buildSessionText())
	const fs = makeStore({ [FILE]: original })
	const result = mask({
		file: FILE,
		apply: true,
		mode: 'copy',
		readFile: fs.readFile,
		writeFile(p, data) {
			fs.writes.push({ path: p, data })
			fs.store.set(p, original)
		},
	})

	assert.equal(result.applied, true)
	assert.ok(result.remaining > 0, `残留必须被复核报出来，实际 remaining=${result.remaining}`)
	assert.equal(result.remaining, 2, '两段退化都还在')
})

test('maskSession：copy 模式原文件字节不变，新文件不再命中退化', () => {
	const original = framePack(buildSessionText())
	const fs = makeStore({ [FILE]: original })
	const result = mask({ file: FILE, apply: true, mode: 'copy', outFile: `${FILE}.masked`, readFile: fs.readFile, writeFile: fs.writeFile })

	assert.equal(result.applied, true)
	assert.equal(result.mode, 'copy')
	assert.equal(result.output, `${FILE}.masked`)
	assert.equal(result.masked, 2)
	assert.equal(result.symbols, 60)
	assert.equal(result.remaining, 0)

	assert.ok(fs.store.get(FILE).equals(original), '原文件字节必须不变')
	const outText = decodeSession(fs.store.get(`${FILE}.masked`)).text
	assert.equal(findSymbolRun(outText, { minRun: 20 }), null, '遮蔽后不再命中 findSymbolRun')
	assert.equal(decodeSession(fs.store.get(`${FILE}.masked`)).frames, 2, 'zstd 帧数要保持不变')
})

test('maskSession：跨帧的 JSON 行也能遮蔽，帧边界仍然保持', () => {
	// 真实存档里一个 JSON 行可以跨帧（DSH 每次追加一帧，行可能被截断）。
	// 这里手工把一行劈成两帧，验证遮蔽后帧数不变、内容仍然正确。
	const events = [
		assistantEvent(0, [{ type: 'reasoning', text: `前缀${RUN}后缀` }]),
	]
	const line = JSON.stringify(events[0])
	const cut = Math.floor(line.length / 2)
	const frames = Buffer.concat([
		zlib.zstdCompressSync(Buffer.from(`${JSON.stringify(SESSION_HEADER)}\n`, 'utf8')),
		zlib.zstdCompressSync(Buffer.from(line.slice(0, cut), 'utf8')),
		zlib.zstdCompressSync(Buffer.from(`${line.slice(cut)}\n`, 'utf8')),
	])
	const fs = makeStore({ [FILE]: frames })
	const result = mask({ file: FILE, apply: true, mode: 'copy', outFile: `${FILE}.masked`, readFile: fs.readFile, writeFile: fs.writeFile })

	assert.equal(result.masked, 1)
	assert.equal(result.remaining, 0)
	const out = fs.store.get(`${FILE}.masked`)
	assert.equal(decodeSession(out).frames, 3, '帧数要保持 3')
	const outText = decodeSession(out).text
	assert.equal(findSymbolRun(outText, { minRun: 20 }), null)
	assert.ok(outText.includes('前缀'), outText)
	assert.ok(outText.includes('后缀'), outText)
	const parsed = JSON.parse(outText.split('\n').filter((l) => l !== '')[1])
	assert.ok(parsed.data.message.content[0].text.startsWith('前缀'))
	assert.ok(parsed.data.message.content[0].text.endsWith('后缀'))
})

test('maskSession：只替换退化段，正常文字逐字不变', () => {
	const fs = makeStore({ [FILE]: framePack(buildSessionText()) })
	mask({ file: FILE, apply: true, mode: 'copy', outFile: `${FILE}.masked`, readFile: fs.readFile, writeFile: fs.writeFile })

	const outText = decodeSession(fs.store.get(`${FILE}.masked`)).text
	const reasoning = eventAt(outText, 2).data.message.content[0]
	assert.ok(reasoning.text.startsWith('先读文件再判断。'), reasoning.text)
	assert.ok(reasoning.text.endsWith('后面的推理还在。'), reasoning.text)
	assert.ok(reasoning.text.includes(`${MARK}30〕`), reasoning.text)
	assert.ok(!reasoning.text.includes('⇒'), '退化符号必须被清掉')

	const body = eventAt(outText, 2).data.message.content[1]
	assert.ok(body.text.startsWith('读取完成，结论如下。'), body.text)
	assert.ok(body.text.includes(`${MARK}30〕`), body.text)
})

test('maskSession：tool-call 块原样保留，tool-call / tool-result 配对不受影响', () => {
	const fs = makeStore({ [FILE]: framePack(buildSessionText()) })
	const result = mask({ file: FILE, apply: true, mode: 'copy', outFile: `${FILE}.masked`, readFile: fs.readFile, writeFile: fs.writeFile })

	const before = eventAt(buildSessionText(), 2).data.message.content[2]
	const after = eventAt(decodeSession(fs.store.get(`${FILE}.masked`)).text, 2).data.message.content[2]
	assert.deepEqual(after, before, 'tool-call 块必须完全一致')
	assert.equal(after.type, 'tool-call')
	assert.equal(after.id, 'call_1')
	assert.equal(after.arguments.path, 'a.md')
	assert.equal(result.toolCallsKept, 1, '要报告保留的 tool-call 块数')

	const toolResult = eventAt(decodeSession(fs.store.get(`${FILE}.masked`)).text, 3)
	assert.equal(toolResult.type, 'tool/result')
	assert.equal(toolResult.data.callId, 'call_1', 'tool/result 的 callId 必须还在')
})

test('maskSession：replace 模式先备份再写，写完回读复核', () => {
	const original = framePack(buildSessionText())
	const fs = makeStore({ [FILE]: original })
	const result = mask({
		file: FILE,
		apply: true,
		mode: 'replace',
		backupFile: `${FILE}.bak`,
		readFile: fs.readFile,
		writeFile: fs.writeFile,
		rename: fs.rename,
		existsFile: fs.existsFile,
	})

	assert.equal(result.applied, true)
	assert.equal(result.mode, 'replace')
	assert.equal(result.output, FILE)
	assert.equal(result.backup, `${FILE}.bak`)
	assert.equal(result.remaining, 0, '写完要回读复核')

	const backup = fs.store.get(`${FILE}.bak`)
	assert.ok(backup, '要有备份文件')
	assert.ok(backup.equals(original), '备份内容必须等于原内容')

	const written = fs.store.get(FILE)
	assert.ok(!written.equals(original), '原文件应被遮蔽后的内容覆盖')
	assert.equal(findSymbolRun(decodeSession(written).text, { minRun: 20 }), null)

	const backupIndex = fs.writes.findIndex((w) => w.path === `${FILE}.bak`)
	const writeIndex = fs.writes.findIndex((w) => w.path === `${FILE}.guard-degen-tmp`)
	assert.ok(backupIndex >= 0 && writeIndex >= 0)
	assert.ok(backupIndex < writeIndex, '必须先备份再写')
	// replace 是原子替换：写临时文件 → 改名盖掉原文件。
	assert.deepEqual(fs.renames, [{ from: `${FILE}.guard-degen-tmp`, to: FILE }])
})

test('maskSession：replace 模式落盘前重读最新内容，不抹掉预览之后新写入的消息', () => {
	// 会话是活的：预览之后宿主可能又追加了新消息。
	// 落盘时必须以「此刻的文件」为准，否则那些新消息会被旧快照覆盖掉。
	// 这里用未压缩的 JSONL（追加一行就是真实的新消息）。
	const original = Buffer.from(buildSessionText(), 'utf8')
	const extra = `${JSON.stringify(userEvent(3, '刚刚又问了一句'))}\n`
	const grown = Buffer.concat([original, Buffer.from(extra, 'utf8')])
	const fs = makeStore({ [FILE]: original })
	let reads = 0
	const result = mask({
		file: FILE,
		apply: true,
		mode: 'replace',
		backupFile: `${FILE}.bak`,
		readFile: (p) => {
			reads += 1
			// 第一次读是预览用的快照，第二次读（落盘前）已经是追加过的新内容。
			return reads === 1 ? original : grown
		},
		writeFile: fs.writeFile,
		rename: fs.rename,
		existsFile: fs.existsFile,
	})

	assert.equal(result.applied, true)
	assert.equal(result.replanned, true, '内容变了要重新算方案')
	assert.ok(reads >= 2, '落盘前必须再读一次')
	const written = decodeSession(fs.store.get(FILE)).text
	assert.ok(written.includes('刚刚又问了一句'), '新写入的消息不能被抹掉')
	// 备份也必须是「被替换掉的那份」内容，也就是追加过的新内容。
	assert.ok(fs.store.get(`${FILE}.bak`).includes('刚刚又问了一句'))
})

test('maskSession：replace 模式发现会话被并发追加时重算一次再落盘', () => {
	// 会话是活的：写临时文件这会儿，宿主可能又追加了一条消息。
	// 尺寸对不上就要重算一次重来，别把那条新消息抹掉。
	const original = Buffer.from(buildSessionText(), 'utf8')
	const extra = `${JSON.stringify(userEvent(3, '并发追加的一句'))}\n`
	const grown = Buffer.concat([original, Buffer.from(extra, 'utf8')])
	const fs = makeStore({ [FILE]: original })
	let reads = 0
	let stats = 0
	const result = mask({
		file: FILE,
		apply: true,
		mode: 'replace',
		backupFile: `${FILE}.bak`,
		readFile: () => {
			reads += 1
			return reads === 1 ? original : grown
		},
		// 第一次查到的尺寸是「又长了一点」：说明有人在追加，必须重来一次。
		stat: () => {
			stats += 1
			return { size: stats === 1 ? grown.length + 16 : grown.length }
		},
		writeFile: fs.writeFile,
		rename: fs.rename,
		existsFile: fs.existsFile,
	})

	assert.equal(result.applied, true)
	assert.equal(result.replanned, true)
	assert.equal(fs.renames.length, 1, '重试之后只改名一次')
	const written = decodeSession(fs.store.get(FILE)).text
	assert.ok(written.includes('并发追加的一句'), '并发追加的消息不能被抹掉')
})

test('maskSession：copy 模式不碰原文件，也不做改名', () => {
	const original = framePack(buildSessionText())
	const fs = makeStore({ [FILE]: original })
	const result = mask({
		file: FILE,
		apply: true,
		mode: 'copy',
		outFile: `${FILE}.masked`,
		readFile: fs.readFile,
		writeFile: fs.writeFile,
		rename: fs.rename,
		existsFile: fs.existsFile,
	})

	assert.equal(result.applied, true)
	assert.equal(result.output, `${FILE}.masked`)
	assert.equal(fs.renames.length, 0, 'copy 模式不该有改名')
	assert.ok(fs.store.get(FILE).equals(original), '原文件不能被改')
})

test('maskSession：备份已存在时自动加序号', () => {
	// 复审缺陷 N6：备份不再落在源文件旁边，而是写在插件自己的目录下，
	// 所以「已存在」要按默认备份路径来造。
	const fs = makeStore({ [FILE]: framePack(buildSessionText()) })
	const first = mask({
		file: FILE,
		apply: true,
		mode: 'replace',
		readFile: fs.readFile,
		writeFile: fs.writeFile,
		rename: fs.rename,
		existsFile: fs.existsFile,
	})
	assert.ok(first.backup, '要有备份路径')
	assert.ok(first.backup.includes(`${path.sep}guard-degen${path.sep}backups${path.sep}`), `备份要写在插件目录下：${first.backup}`)

	const fs2 = makeStore({ [FILE]: framePack(buildSessionText()), [first.backup]: Buffer.from('旧的备份') })
	const second = mask({
		file: FILE,
		apply: true,
		mode: 'replace',
		readFile: fs2.readFile,
		writeFile: fs2.writeFile,
		rename: fs2.rename,
		existsFile: fs2.existsFile,
	})
	assert.equal(second.backup, `${first.backup}.1`, '备份已存在时要自动加序号')
	assert.ok(fs2.store.get(`${first.backup}.1`))
})

test('maskSession：单个 ★ 不足 minRun，不算退化', () => {
	// 样本必须比 minRun 长，否则会被「文本太短」提前短路，测不到阈值本身。
	const long = '这是一段足够长的正常文字，里面只有一个 ★ 符号，不足 minRun，所以不算退化，也不该被遮蔽。'
	assert.ok(long.length > 20, '样本长度必须超过 minRun')
	const single = {
		type: 'assistant/message',
		message: { role: 'assistant', content: [{ type: 'text', text: long }] },
	}
	const text = `${JSON.stringify(single)}\n`
	const fs = makeStore({ [FILE]: framePack(text) })
	const result = mask({ file: FILE, apply: true, mode: 'copy', outFile: `${FILE}.masked`, readFile: fs.readFile, writeFile: fs.writeFile })

	assert.equal(result.masked, 0)
	assert.equal(result.symbols, 0)
	// 复审缺陷 N5：没有可遮蔽的内容就不该落盘（源文件保持原样）。
	assert.equal(result.applied, false, '没有退化可遮时不应落盘')
	assert.equal(fs.store.has(`${FILE}.masked`), false, '没有退化就不该写出遮蔽副本')
	assert.ok(decodeSession(fs.store.get(FILE)).text.includes('★'), '★ 必须原样保留')

	// 同一个样本把 minRun 降到 2 → 两个连着的符号就算退化（证明阈值真的在起作用）。
	const pair = '这是一段足够长的正常文字，里面只有两个 ★★ 符号，阈值调到 2 时就该被遮蔽。'
	const pairText = `${JSON.stringify({
		type: 'assistant/message',
		message: { role: 'assistant', content: [{ type: 'text', text: pair }] },
	})}\n`
	const fs2 = makeStore({ [FILE]: framePack(pairText) })
	const result2 = mask({ file: FILE, apply: true, mode: 'copy', outFile: `${FILE}.masked`, minRun: 2, readFile: fs2.readFile, writeFile: fs2.writeFile })
	assert.equal(result2.masked, 1, 'minRun=2 时两个连着的符号必须被遮蔽')
	assert.ok(!decodeSession(fs2.store.get(`${FILE}.masked`)).text.includes('★'))
	// 同样的两个符号，在默认 minRun=20 下不该被遮蔽
	const fs3 = makeStore({ [FILE]: framePack(pairText) })
	const result3 = mask({ file: FILE, apply: true, mode: 'copy', outFile: `${FILE}.masked`, readFile: fs3.readFile, writeFile: fs3.writeFile })
	assert.equal(result3.masked, 0, '默认 minRun=20 时两个符号不算退化')
	assert.equal(result3.applied, false, '没有退化就不该落盘')
	assert.ok(decodeSession(fs3.store.get(FILE)).text.includes('★★'), '源文件里的 ★★ 必须原样保留')
})

test('maskSession：审计旁车记录被遮蔽段的数量与位置', () => {
	const fs = makeStore({ [FILE]: framePack(buildSessionText()) })
	const result = mask({ file: FILE, apply: true, mode: 'copy', outFile: `${FILE}.masked`, readFile: fs.readFile, writeFile: fs.writeFile })

	assert.ok(result.audit, '要有审计文件路径')
	const audit = JSON.parse(fs.store.get(result.audit).toString('utf8'))
	assert.equal(audit.segments.length, 2)
	assert.equal(audit.masked, 2)
	assert.equal(audit.symbols, 60)
	assert.equal(audit.segments[0].event, 2)
	assert.equal(audit.segments[0].path, 'data.message.content[0].text')
	assert.equal(audit.segments[0].count, 30)
	assert.equal(audit.segments[0].rule, 'symbol-run')
	assert.ok(audit.segments[0].preview.length <= 40)
	assert.ok(audit.segments[0].original.includes('⇒'), '原文要保留供审计')
})

test('maskSession：落点必须在允许的根目录之内（复审 F3）', () => {
	const fs = makeStore({ [FILE]: framePack(buildSessionText()) })
	// 落在允许范围之外 → 拒绝，不写任何文件
	const outside = mask({
		file: FILE,
		apply: true,
		mode: 'copy',
		outFile: '/tmp/out.zstd',
		auditFile: '/tmp/out.audit.json',
		readFile: fs.readFile,
		writeFile: fs.writeFile,
	})
	assert.match(String(outside.error ?? ''), /不在允许的范围内/)
	assert.equal(fs.store.get('/tmp/out.zstd'), undefined, '越界的输出路径不得写入')
	assert.equal(fs.store.get('/tmp/out.audit.json'), undefined, '越界的审计路径不得写入')

	// 落在允许范围之内 → 正常写出
	const inside = mask({
		file: FILE,
		apply: true,
		mode: 'copy',
		outFile: '/sessions/proj-1/out.zstd',
		auditFile: '/sessions/proj-1/out.audit.json',
		readFile: fs.readFile,
		writeFile: fs.writeFile,
	})
	assert.equal(inside.error, undefined)
	assert.equal(inside.output, '/sessions/proj-1/out.zstd')
	assert.equal(inside.audit, '/sessions/proj-1/out.audit.json')
	assert.ok(fs.store.get('/sessions/proj-1/out.zstd'))
	assert.ok(fs.store.get('/sessions/proj-1/out.audit.json'))
})

test('maskSession：读不到文件 → error 有说明，不抛异常', () => {
	const fs = makeStore({})
	const result = mask({ file: '/sessions/nope/session.v4.jsonl.zstd', apply: true, readFile: fs.readFile, writeFile: fs.writeFile })
	assert.ok(result.error, '要有 error 说明')
	assert.match(result.error, /读取/)
	assert.equal(result.applied, false)
	assert.equal(fs.writes.length, 0)
})

test('maskSession：坏帧 / 解析失败 → error 有说明，不抛异常', () => {
	// 一帧合法 zstd 后面接 4 个坏字节：帧扫描会在第二帧的 magic 上报错。
	const broken = Buffer.concat([
		zlib.zstdCompressSync(Buffer.from('{}\n', 'utf8')),
		Buffer.from([0x00, 0x00, 0x00, 0x00]),
	])
	const fs = makeStore({ [FILE]: broken })
	const result = mask({ file: FILE, apply: true, readFile: fs.readFile, writeFile: fs.writeFile })
	assert.ok(result.error, '要有 error 说明')
	assert.equal(result.applied, false)
	assert.equal(fs.writes.length, 0, '失败时不得写盘')
})

test('maskSession：缺少 file 参数 → error 有说明', () => {
	const result = mask({ apply: true })
	assert.ok(result.error)
	assert.equal(result.applied, false)
})

test('maskSession：会话根目录里的符号链接不许把根目录外的文件改掉', () => {
	// 复审缺陷 D5：闸门用的是「解析路径」判定，符号链接指向哪里就写到哪里，
	// 会话根目录里的一个链接可以把根目录外的文件整个改写掉。
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'degen-link-'))
	const sessionsRoot = path.join(tmp, 'sessions')
	const sessionDir = path.join(sessionsRoot, 'proj-1')
	fs.mkdirSync(sessionDir, { recursive: true })
	const outside = path.join(tmp, 'outside-archive.v4.jsonl.zstd')
	fs.writeFileSync(outside, framePack(buildSessionText()), 'utf8')
	const before = fs.readFileSync(outside)
	const link = path.join(sessionDir, 'session.v4.jsonl.zstd')
	try {
		fs.symlinkSync(outside, link, 'file')
	} catch {
		fs.rmSync(tmp, { recursive: true, force: true })
		return // 没有符号链接权限的环境跳过
	}
	try {
		const result = maskSession({ file: link, mode: 'replace', apply: true, roots: [sessionsRoot] })
		const after = fs.readFileSync(outside)
		assert.deepEqual(after, before, '根目录外的文件必须一个字节都没变')
		assert.equal(result.applied, false, '不许把链接当普通会话文件遮蔽')
		assert.ok(result.error, '要给出拒绝原因')
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true })
	}
})

test('maskSession：指向根目录内部的符号链接同样不许遮蔽', () => {
	// 复审缺陷 D5 的另一半：真实路径落在根目录之内时，根目录闸门是放行的，
	// 这时必须由「不许处理符号链接」这条规则兜住 ——
	// 否则写出去的是链接本身，链接与目标的关系会被破坏。
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'degen-link-'))
	const sessionsRoot = path.join(tmp, 'sessions')
	const sessionDir = path.join(sessionsRoot, 'proj-1')
	fs.mkdirSync(sessionDir, { recursive: true })
	const target = path.join(sessionDir, 'real.v4.jsonl.zstd')
	fs.writeFileSync(target, framePack(buildSessionText()), 'utf8')
	const before = fs.readFileSync(target)
	const link = path.join(sessionDir, 'link.v4.jsonl.zstd')
	try {
		fs.symlinkSync(target, link, 'file')
	} catch {
		fs.rmSync(tmp, { recursive: true, force: true })
		return // 没有符号链接权限的环境跳过
	}
	try {
		const result = maskSession({ file: link, mode: 'replace', apply: true, roots: [sessionsRoot] })
		assert.equal(result.applied, false, '符号链接不许被当成会话文件遮蔽')
		assert.match(String(result.error ?? ''), /符号链接/)
		assert.deepEqual(fs.readFileSync(target), before, '目标文件必须一个字节都没变')
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true })
	}
})

test('maskSession：marker 可自定义', () => {
	const fs = makeStore({ [FILE]: framePack(buildSessionText()) })
	mask({
		file: FILE,
		apply: true,
		mode: 'copy',
		outFile: `${FILE}.masked`,
		marker: '[遮蔽{N}]',
		readFile: fs.readFile,
		writeFile: fs.writeFile,
	})
	const outText = decodeSession(fs.store.get(`${FILE}.masked`)).text
	assert.ok(outText.includes('[遮蔽30]'), outText.slice(0, 400))
})

test('maskSession：非 zstd 的纯文本存档也能遮蔽', () => {
	const text = buildSessionText()
	const fs = makeStore({ [FILE]: text })
	const result = mask({ file: FILE, apply: true, mode: 'copy', outFile: `${FILE}.masked`, readFile: fs.readFile, writeFile: fs.writeFile })
	assert.equal(result.masked, 2)
	const outText = fs.store.get(`${FILE}.masked`).toString('utf8')
	assert.equal(findSymbolRun(outText, { minRun: 20 }), null)
	assert.ok(outText.includes('tool-call'))
})

test('extractSessionTitle：取最新一条 session/title 事件', () => {
	const lines = [
		JSON.stringify({ type: 'session', seq: 0, time: 1 }),
		JSON.stringify({ type: 'session/title', seq: 1, time: 2, data: { title: '第一条标题' } }),
		JSON.stringify({ type: 'assistant/message', seq: 2, time: 3, message: { role: 'assistant' } }),
		JSON.stringify({ type: 'session/title', seq: 3, time: 4, data: { title: '改过的标题' } }),
	].join('\n')
	assert.equal(extractSessionTitle(lines), '改过的标题')
	assert.equal(extractSessionTitle(''), '')
	assert.equal(extractSessionTitle('{"type":"assistant/message"}'), '')
	// 坏行不许把整段文本带崩。
	assert.equal(extractSessionTitle('{"type":"session/title" 不是 JSON'), '')
})

test('scanSessions：报告里带上会话标题', () => {
	const text = [
		JSON.stringify({ type: 'session/title', seq: 0, time: 1, data: { title: '修复配置页的排版' } }),
		JSON.stringify({
			type: 'assistant/message',
			turn: 1,
			message: { role: 'assistant', content: [{ type: 'text', text: `结论如下。${RUN}` }] },
		}),
	].join('\n')
	const fs = makeStore({ [FILE]: text })
	const report = scanSessions({ root: '/sessions', files: [FILE], readFile: fs.readFile })
	const session = report.sessions[0]
	assert.equal(session.title, '修复配置页的排版')
	assert.equal(session.runCount, 1)
})

test('maskSession：给出「原文 / 改写后」的对照预览（预览与落盘同一份）', () => {
	const fs = makeStore({ [FILE]: buildSessionText() })
	const preview = mask({
		file: FILE,
		apply: false,
		mode: 'copy',
		readFile: fs.readFile,
		writeFile: fs.writeFile,
	})
	assert.equal(preview.preview.totalSegments, preview.masked)
	assert.ok(preview.preview.segments.length >= 1)
	const segment = preview.preview.segments[0]
	assert.ok(segment.removed.includes('⇒'), '预览要给出被遮掉的原文')
	assert.ok(segment.added.includes('〔退化内容已遮蔽'), '预览要给出替换后的标记')
	assert.ok(segment.before.length > 0, '预览要带上退化段之前的上下文')
	assert.ok(segment.after.length > 0, '预览要带上退化段之后的上下文')
	assert.ok(segment.path.length > 0, '预览要说明退化段在哪个字段')
	// 预览不许写盘。
	assert.equal(fs.writes.length, 0)

	const applied = mask({
		file: FILE,
		apply: true,
		mode: 'copy',
		outFile: `${FILE}.masked`,
		readFile: fs.readFile,
		writeFile: fs.writeFile,
	})
	assert.deepEqual(applied.preview, preview.preview, '落盘与预览必须是同一份对照')
})

test('maskSession：退化原文过长时截断，但仍然标明截断', () => {
	const long = '⇒'.repeat(400)
	const text = JSON.stringify({
		type: 'assistant/message',
		turn: 1,
		message: { role: 'assistant', content: [{ type: 'text', text: long }] },
	})
	const fs = makeStore({ [FILE]: text })
	const result = mask({ file: FILE, apply: false, mode: 'copy', readFile: fs.readFile, writeFile: fs.writeFile })
	const segment = result.preview.segments[0]
	assert.equal(segment.removedTruncated, true)
	assert.ok(segment.removed.length < 400)
	assert.equal(segment.count, 400)
})

test('maskSession：collapse 方式换成带计数的标记（默认）', () => {
	const fs = makeStore({ [FILE]: buildSessionText() })
	const result = mask({
		file: FILE,
		apply: true,
		mode: 'copy',
		outFile: `${FILE}.masked`,
		readFile: fs.readFile,
		writeFile: fs.writeFile,
	})
	assert.equal(result.maskMode, 'collapse')
	assert.equal(result.preview.mode, 'collapse')
	assert.ok(result.preview.segments[0].added.includes('〔退化内容已遮蔽'))
	// 对照视图的「遮蔽后」是遮蔽完的字符串：退化段换成了标记，前后文还在。
	for (const segment of result.preview.segments) {
		assert.ok(segment.maskedWindow.includes('〔退化内容已遮蔽'), '「遮蔽后」里要有折叠标记')
		assert.ok(!segment.maskedWindow.includes('⇒'.repeat(30)), '「遮蔽后」里不许还有退化游程')
	}
	const written = fs.writes.find((item) => item.path === `${FILE}.masked`)
	assert.ok(written, '必须写出遮蔽后的文件')
	assert.ok(String(written.data).includes('〔退化内容已遮蔽'), 'collapse 必须留下标记')
})

test('maskSession：remove 方式整段删掉，不留痕迹', () => {
	const fs = makeStore({ [FILE]: buildSessionText() })
	const result = mask({
		file: FILE,
		apply: true,
		mode: 'copy',
		maskMode: 'remove',
		outFile: `${FILE}.masked`,
		readFile: fs.readFile,
		writeFile: fs.writeFile,
	})
	assert.equal(result.maskMode, 'remove')
	assert.equal(result.preview.mode, 'remove')
	assert.equal(result.preview.segments[0].added, '', 'remove 没有替换文本')
	assert.equal(result.preview.segments[0].action, 'remove')
	// 「遮蔽前 / 遮蔽后」两行都是字符串级的真实内容：
	// 前一行是原文，后一行是删完剩下的文字 —— 符号真的没了。
	for (const segment of result.preview.segments) {
		assert.ok(segment.originalWindow.includes('⇒'.repeat(30)), '「遮蔽前」要带原文里的退化段')
		assert.ok(!segment.maskedWindow.includes('⇒'.repeat(30)), '「遮蔽后」里不许还有退化游程')
		assert.ok(!segment.maskedWindow.includes('〔退化内容已遮蔽'), '「遮蔽后」里不许有标记')
	}
	assert.ok(
		result.preview.segments.some((segment) => segment.maskedWindow.includes('读取完成，结论如下。')),
		'正常文字要留在「遮蔽后」里',
	)
	assert.ok(
		result.preview.segments.some((segment) => segment.maskedWindow.includes('先读文件再判断。')),
		'正常文字要留在「遮蔽后」里',
	)
	const written = fs.writes.find((item) => item.path === `${FILE}.masked`)
	const content = String(written.data)
	assert.ok(!content.includes('〔退化内容已遮蔽'), 'remove 不该留下标记')
	assert.ok(!content.includes('⇒'.repeat(30)), '退化段必须真的被删掉')
	// 上下文文字还在：只删退化段，不动别的。
	assert.ok(content.includes('读取完成，结论如下。'))
})

test('maskSession：remove 方式落盘后文件里也没有退化残留', () => {
	const fs = makeStore({ [FILE]: buildSessionText() })
	const result = mask({
		file: FILE,
		apply: true,
		mode: 'copy',
		maskMode: 'remove',
		outFile: `${FILE}.masked`,
		readFile: fs.readFile,
		writeFile: fs.writeFile,
	})
	assert.equal(result.applied, true)
	const written = fs.writes.find((item) => item.path === `${FILE}.masked`)
	assert.ok(written, '必须写出遮蔽后的文件')
	assert.ok(!String(written.data).includes('⇒'.repeat(30)), '落盘文件里不许还有退化游程')
})

test('parseSessionHeader：读出会话头里的 id 与工作目录', async () => {
	const { parseSessionHeader } = await import('../lib/sessions.js')
	const header = parseSessionHeader(`${JSON.stringify({ type: 'session', version: 4, id: 'abc', cwd: 'C:/work', createdAt: 123 })}\n${JSON.stringify({ type: 'user/message' })}\n`)
	assert.equal(header.id, 'abc')
	assert.equal(header.cwd, 'C:/work')
	assert.equal(header.createdAt, 123)
	const empty = parseSessionHeader('不是 json\n')
	assert.equal(empty.cwd, '')
})

/** 净化折叠标记（与流式守卫写进会话的一样）。 */
const STREAM_MARKER = '〔退化符号流×30〕'

/**
 * 构造一个带折叠标记的会话：用户提问、工具结果里也有同样的标记，
 * 只有模型自己的产出里有两处——回退只能动后者。
 * @returns {string} JSONL 文本
 */
function buildMarkedSessionText() {
	const events = [
		userEvent(0, `提问里也有${STREAM_MARKER}`),
		assistantEvent(1, [
			{ type: 'text', text: `第一处${STREAM_MARKER}后面还有话` },
			{ type: 'text', text: `第二处${STREAM_MARKER}` },
		]),
		toolResultEvent(2, { callId: 'call_1', content: `工具结果里也有${STREAM_MARKER}` }),
	]
	return `${[SESSION_HEADER, ...events].map((e) => JSON.stringify(e)).join('\n')}\n`
}

test('locateMarkers：只定位模型产出里的标记，并给出事件与字段路径', () => {
	const fs = makeStore({ [FILE]: buildMarkedSessionText() })
	const result = locateMarkers({ file: FILE, marker: STREAM_MARKER, roots: ['/sessions'], readFile: fs.readFile })
	assert.equal(result.ok, true, result.error)
	assert.equal(result.hits.length, 2, `实际 ${result.hits.length} 处`)
	assert.equal(result.hits[0].event, 2, '命中在第二个事件（assistant）上')
	assert.equal(result.hits[0].path, 'data.message.content[0].text')
	assert.equal(result.hits[1].path, 'data.message.content[1].text')
	assert.ok(result.hits[0].context.includes('第一处'), '要带上下文片段')
})

test('locateMarkers：越界路径与符号链接一律拒绝', () => {
	const fs = makeStore({ '/elsewhere/session.v4.jsonl.zstd': buildMarkedSessionText() })
	const outside = locateMarkers({ file: '/elsewhere/session.v4.jsonl.zstd', marker: STREAM_MARKER, roots: ['/sessions'], readFile: fs.readFile })
	assert.equal(outside.ok, false)
	assert.ok(outside.error.includes('根目录'), outside.error)
})

test('restoreSessionText：把第 N 处标记换回原文，且只动模型产出', () => {
	const fs = makeStore({ [FILE]: framePack(buildMarkedSessionText()) })
	const result = restoreSessionText({
		file: FILE,
		from: STREAM_MARKER,
		to: '⇒'.repeat(30),
		hitIndex: 1,
		apply: true,
		roots: ['/sessions'],
		readFile: fs.readFile,
		writeFile: fs.writeFile,
		rename: fs.rename,
		existsFile: fs.existsFile,
	})
	assert.equal(result.applied, true, result.error)
	assert.equal(result.restored, true, result.error)
	assert.equal(result.remaining, 1, '另一处标记应当还在')
	const text = decodeSession(fs.store.get(FILE)).text
	const events = text.split('\n').filter((l) => l !== '').map((l) => JSON.parse(l))
	assert.ok(events[1].data.message.content.includes(STREAM_MARKER), '用户提问不能被改')
	assert.ok(events[3].data.content.includes(STREAM_MARKER), '工具结果不能被改')
	assert.ok(events[2].data.message.content[0].text.includes(STREAM_MARKER), '第一处不该被改（回退的是第二处）')
	assert.ok(events[2].data.message.content[1].text.includes('⇒'.repeat(30)), '第二处应当被换回原文')
})

test('restoreSessionText：命中序号不存在时不写盘', () => {
	const fs = makeStore({ [FILE]: buildMarkedSessionText() })
	const result = restoreSessionText({
		file: FILE,
		from: STREAM_MARKER,
		to: 'x',
		hitIndex: 5,
		apply: true,
		roots: ['/sessions'],
		readFile: fs.readFile,
		writeFile: fs.writeFile,
		rename: fs.rename,
		existsFile: fs.existsFile,
	})
	assert.equal(result.applied, false)
	assert.ok(result.error)
	assert.equal(fs.writes.length, 0, '没命中就不该写任何文件')
})

test('restoreSessionText：回退走临时文件 + 改名，并留备份', () => {
	const fs = makeStore({ [FILE]: framePack(buildMarkedSessionText()) })
	const result = restoreSessionText({
		file: FILE,
		from: STREAM_MARKER,
		to: '⇒'.repeat(30),
		hitIndex: 0,
		apply: true,
		roots: ['/sessions'],
		readFile: fs.readFile,
		writeFile: fs.writeFile,
		rename: fs.rename,
		existsFile: fs.existsFile,
	})
	assert.equal(result.applied, true, result.error)
	assert.ok(result.backup, '要有备份')
	assert.ok(fs.renames.some((item) => item.to === FILE), '最终必须改名盖掉原文件')
	assert.ok(fs.writes.some((item) => item.path.endsWith('.guard-degen-revert-tmp')), '要先写临时文件')
	const text = decodeSession(fs.store.get(FILE)).text
	assert.ok(text.includes('第一处⇒'.repeat(1) + '⇒'.repeat(29)), '第一处应当被换回原文')
	assert.ok(text.includes(STREAM_MARKER), '第二处标记应当保留')
})

test('restoreSessionText：回退后仍是合法的多帧 zstd 存档', () => {
	const fs = makeStore({ [FILE]: framePack(buildMarkedSessionText()) })
	restoreSessionText({
		file: FILE,
		from: STREAM_MARKER,
		to: '⇒'.repeat(30),
		hitIndex: 0,
		apply: true,
		roots: ['/sessions'],
		readFile: fs.readFile,
		writeFile: fs.writeFile,
		rename: fs.rename,
		existsFile: fs.existsFile,
	})
	const decoded = decodeSession(fs.store.get(FILE))
	assert.equal(typeof decoded.text, 'string')
	assert.ok(decoded.text.includes('⇒'.repeat(30)), '原文要真的写回去')
	for (const line of decoded.text.split('\n')) {
		if (line === '') continue
		JSON.parse(line)
	}
})

// ── 多字符单元重复 ────────────────────────────────────────────────────────

/** 用户给的那种退化：同一个多字符单元整段整段地重复。 */
const UNIT_BLOCK = '⇒⇒§ ⇒⇒§ §'

/**
 * 造一个含多字符单元重复的会话存档（12 份单元重复）。
 * @returns {string} JSONL 文本
 */
function buildUnitSessionText() {
	const unitText = `前置说明。\n\n${Array.from({ length: 12 }, () => UNIT_BLOCK).join('\n\n')}\n\n后置说明。`
	const events = [
		{
			type: 'user/message',
			seq: 0,
			time: 1,
			surfaceOp: 'append',
			data: { turn: 1, source: { kind: 'user' }, message: { role: 'user', content: '请继续' } },
		},
		assistantEvent(1, [{ type: 'text', text: unitText }]),
	]
	return `${[SESSION_HEADER, ...events].map((e) => JSON.stringify(e)).join('\n')}\n`
}

test('会话治理：多字符单元重复按退化遮蔽（折叠成〔退化单元×12〕）', () => {
	const fs = makeStore({ [FILE]: framePack(buildUnitSessionText()) })
	const result = mask({
		file: FILE,
		apply: true,
		mode: 'copy',
		outFile: `${FILE}.masked`,
		readFile: fs.readFile,
		writeFile: fs.writeFile,
	})
	assert.ok(result.masked > 0, '多字符单元重复应当算退化')
	const segment = result.preview.segments[0]
	assert.equal(segment.kind, 'unit-run')
	assert.equal(segment.repeats, 12)
	assert.ok(segment.unit.includes(UNIT_BLOCK), `片段要说明是哪个单元：${segment.unit}`)
	assert.ok(segment.added.includes('〔退化单元×12〕'), `折叠标记不对：${segment.added}`)
	const written = fs.writes.find((item) => item.path === `${FILE}.masked`)
	assert.ok(written, '必须写出遮蔽后的文件')
	const content = decodeSession(written.data).text
	assert.ok(content.includes('〔退化单元×12〕'), '落盘文件里要有折叠标记')
	assert.ok(!content.includes(UNIT_BLOCK.repeat(4)), '重复的单元必须被清掉')
	assert.ok(content.includes('前置说明。'), '前文要保留')
	assert.ok(content.includes('后置说明。'), '后文要保留')
})

test('会话治理：remove 方式把多字符单元重复整段删掉', () => {
	const fs = makeStore({ [FILE]: framePack(buildUnitSessionText()) })
	const result = mask({
		file: FILE,
		apply: true,
		mode: 'copy',
		maskMode: 'remove',
		outFile: `${FILE}.masked`,
		readFile: fs.readFile,
		writeFile: fs.writeFile,
	})
	const written = fs.writes.find((item) => item.path === `${FILE}.masked`)
	const content = decodeSession(written.data).text
	assert.ok(!content.includes(UNIT_BLOCK), 'remove 方式要把重复的单元删掉')
	assert.ok(!content.includes('〔退化单元'), 'remove 方式不留标记')
	assert.ok(content.includes('前置说明。'), '前文要保留')
})

test('会话治理：关掉多字符单元治理后这形态不再遮蔽', () => {
	const fs = makeStore({ [FILE]: framePack(buildUnitSessionText()) })
	const result = mask({
		file: FILE,
		apply: true,
		mode: 'copy',
		outFile: `${FILE}.masked`,
		unitRun: false,
		readFile: fs.readFile,
		writeFile: fs.writeFile,
	})
	assert.equal(result.masked, 0, '关掉之后不该遮蔽')
	assert.equal(result.applied, false, '没有退化就不该落盘')
})

test('会话治理：多字符单元重复的份数阈值可调', () => {
	const fs = makeStore({ [FILE]: framePack(buildUnitSessionText()) })
	const strict = mask({
		file: FILE,
		apply: false,
		mode: 'copy',
		unitRepeats: 20,
		readFile: fs.readFile,
		writeFile: fs.writeFile,
	})
	assert.equal(strict.masked, 0, '12 份不该达到 20 份的阈值')
	const loose = mask({
		file: FILE,
		apply: false,
		mode: 'copy',
		unitRepeats: 4,
		readFile: fs.readFile,
		writeFile: fs.writeFile,
	})
	assert.ok(loose.masked > 0, '12 份应当达到 4 份的阈值')
})

test('会话治理：摘掉长游程后碎片拼出的重复也要一次清干净（复核要通过）', () => {
	// 退化内容常常是「长游程 + 碎片」交替：游程被摘掉后碎片会贴到一起，
	// 拼出一个**新的**多字符单元重复。只看原文就会漏掉它 ——
	// 第一轮清完才发现残渣也在重复，落盘前的复核直接拒绝（用户什么都拿不到）。
	const lengths = [25, 30, 27, 31]
	const body = `前言。${lengths.map((n) => `${'⇒'.repeat(n)} **⇒⇒ **`).join('')}后记。`
	const events = [userEvent(0, '请继续'), assistantEvent(1, [{ type: 'text', text: body }])]
	const text = `${[SESSION_HEADER, ...events].map((e) => JSON.stringify(e)).join('\n')}\n`
	const fs = makeStore({ [FILE]: framePack(text) })
	const result = mask({
		file: FILE,
		apply: true,
		mode: 'copy',
		outFile: `${FILE}.masked`,
		readFile: fs.readFile,
		writeFile: fs.writeFile,
	})
	assert.equal(result.remaining, 0, `复核必须通过：${result.error ?? ''}`)
	assert.ok(result.masked > 0, '退化要被治理')
	const written = fs.writes.find((item) => item.path === `${FILE}.masked`)
	const content = decodeSession(written.data).text
	assert.ok(!content.includes('**⇒⇒ **'), '碎片拼出来的重复也要清掉')
	assert.ok(content.includes('前言。'), '前文要保留')
	assert.ok(content.includes('后记。'), '后文要保留')
})


