/**
 * 会话存档校验测试 —— 宿主验收规则的回归。
 *
 * 插件会**就地重写**会话存档。写进去的东西宿主打不开，用户只看到一句
 * 「stored log is corrupt」。这里把宿主那套验收规则钉死：
 *
 *   - 帧级：第 0 帧恰好一行头部、每帧都能解开、事件文本以 `\n` 结尾；
 *   - 行级：顶层键不多不少、必填字段一个不缺、`seq` 稠密、表面事件带 `surfaceOp`；
 *   - 落盘：源存档或产物过不了校验就**一个字节都不许写**。
 *
 * 所有读写都走注入的 `readFile` / `writeFile` / `rename` / `stat` / `existsFile` 桩，
 * **绝不读写真实会话目录**。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import zlib from 'node:zlib'

import { validateArchiveBytes, validateArchiveText } from '../lib/archive-validate.js'
import { compressFrame, encodeFrames, maskSession, restoreSessionText } from '../lib/sessions.js'
import { scanZstdFrames } from '../lib/scan.js'
import './helpers/temp-home.mjs'

const RUN = '⇒'.repeat(30)
const MARK = '〔退化内容已遮蔽〕'
const FILE = '/sessions/proj-1/session.v4.jsonl.zstd'

/** 会话头部行（宿主 v4 存档的第一行）。 */
const HEADER = {
	type: 'session',
	version: 4,
	id: 'proj-1',
	createdAt: 1,
	cwd: 'C:/work',
	isSeeded: false,
	delegationDepth: 0,
}

/**
 * 造一条合法的事件行。
 *
 * 字段形状照抄宿主自己写出来的 `assistant/message`：`turn` / `step` 是正整数，
 * 消息带 `id` 和生产者自己的 `source`（`kind` 非空且不是 plugin）。
 *
 * @param {number} seq - 事件序号（必须稠密）
 * @param {object} [extra] - 额外字段（覆盖默认值）
 * @returns {object} 事件行
 */
function row(seq, extra = {}) {
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
				content: [{ type: 'text', text: `第 ${seq} 条` }],
				source: { kind: 'model', provider: 'test', model: 'test-model' },
				id: `msg-${seq}`,
			},
			stream: [],
		},
		...extra,
	}
}

/**
 * 造一个存档文本（头部行 + 事件行）。
 * @param {object[]} rows - 事件行
 * @returns {string} 存档文本
 */
function archiveText(rows) {
	return `${[HEADER, ...rows].map((r) => JSON.stringify(r)).join('\n')}\n`
}

/**
 * 把存档文本打包成多帧 zstd（第 0 帧只有头部行）。
 * @param {string} text - 存档文本
 * @returns {Buffer} 存档字节
 */
function pack(text) {
	const index = text.indexOf('\n')
	return Buffer.concat([
		compressFrame(text.slice(0, index + 1)),
		compressFrame(text.slice(index + 1)),
	])
}

/**
 * 解开一帧，返回明文。
 * @param {Buffer} bytes - 存档字节
 * @param {number} index - 帧序号
 * @returns {string} 明文
 */
function frameText(bytes, index) {
	const frame = scanZstdFrames(bytes).frames[index]
	return zlib.zstdDecompressSync(bytes.subarray(frame.start, frame.end)).toString('utf8')
}

/**
 * 造一个内存文件系统桩。
 * @param {Record<string, string | Buffer>} entries - 初始文件
 * @returns {object} 桩
 */
function makeStore(entries) {
	const store = new Map()
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
		stat(p) {
			if (!store.has(p)) {
				const err = new Error(`ENOENT: no such file or directory, stat '${p}'`)
				err.code = 'ENOENT'
				throw err
			}
			return { size: store.get(p).length }
		},
		existsFile(p) {
			return store.has(p)
		},
	}
}

// ── 校验器本身 ──────────────────────────────────────────────────────────

test('validateArchiveBytes：形状正确的多帧存档通过', () => {
	const text = archiveText([row(0), row(1)])
	const bytes = pack(text)
	const result = validateArchiveBytes(bytes)
	assert.equal(result.ok, true, JSON.stringify(result.problems))
	assert.deepEqual(result.problems, [])
})

test('validateArchiveBytes：纯文本存档同样按头部行 + 事件行查', () => {
	const text = archiveText([row(0)])
	const result = validateArchiveBytes(Buffer.from(text, 'utf8'))
	assert.equal(result.ok, true, JSON.stringify(result.problems))
})

test('validateArchiveBytes：第 0 帧塞了头部和事件，判成帧级问题', () => {
	const text = archiveText([row(0)])
	// 头部和事件挤在同一帧里 —— 宿主会直接判这份存档损坏。
	const bytes = compressFrame(text)
	const result = validateArchiveBytes(bytes)
	assert.equal(result.ok, false)
	assert.equal(result.problems[0].row, null, '帧级问题的 row 必须是 null')
	assert.equal(result.problems[0].reason, 'header-frame-not-single-line')
})

test('validateArchiveText：事件行缺字段，报出正确的行号', () => {
	const text = archiveText([
		{ type: 'assistant/message', time: 1, surfaceOp: 'append', data: {} },
		{ type: 'assistant/message', seq: 1, surfaceOp: 'append', data: {} },
		{ type: 'assistant/message', seq: 2, time: 3, surfaceOp: 'append' },
	])
	const result = validateArchiveText(text)
	assert.equal(result.ok, false)
	const missing = result.problems.filter((p) => p.reason.startsWith('missing-field:'))
	assert.deepEqual(missing.map((p) => p.row), [1, 2, 3])
	assert.deepEqual(missing.map((p) => p.reason), [
		'missing-field:seq',
		'missing-field:time',
		'missing-field:data',
	])
})

test('validateArchiveText：seq 不稠密，报出期望值与实际值', () => {
	const text = archiveText([row(0), row(5)])
	const result = validateArchiveText(text)
	assert.equal(result.ok, false)
	const gap = result.problems.find((p) => p.reason.startsWith('seq-gap:'))
	assert.ok(gap, JSON.stringify(result.problems))
	assert.equal(gap.row, 2)
	assert.equal(gap.reason, 'seq-gap:expected-1-got-5')
})

test('validateArchiveText：多出来的顶层键被拒', () => {
	const text = archiveText([row(0, { 额外字段: 1 })])
	const result = validateArchiveText(text)
	assert.equal(result.ok, false)
	assert.deepEqual(result.problems, [{ row: 1, reason: 'unexpected-field:额外字段' }])
})

test('validateArchiveText：表面事件缺 surfaceOp 被拒', () => {
	const text = archiveText([{ ...row(0), surfaceOp: undefined }])
	const result = validateArchiveText(text)
	assert.equal(result.ok, false)
	assert.deepEqual(result.problems, [{ row: 1, reason: 'missing-surface-op' }])
})

test('validateArchiveText：消息没有生产者自己的 source 被拒', () => {
	// 宿主原话：format v4 message requires a producer-owned source kind
	const noSource = row(0)
	delete noSource.data.message.source
	const result = validateArchiveText(archiveText([noSource]))
	assert.equal(result.ok, false)
	assert.ok(
		result.problems.some((p) => p.reason === 'missing-message-source' && p.row === 1),
		JSON.stringify(result.problems),
	)

	const pluginSource = row(0)
	pluginSource.data.message.source = { kind: 'plugin', plugin: 'x' }
	const pluginResult = validateArchiveText(archiveText([pluginSource]))
	assert.ok(
		pluginResult.problems.some((p) => p.reason === 'missing-message-source'),
		JSON.stringify(pluginResult.problems),
	)

	const emptyKind = row(0)
	emptyKind.data.message.source = { kind: '' }
	const emptyResult = validateArchiveText(archiveText([emptyKind]))
	assert.ok(
		emptyResult.problems.some((p) => p.reason === 'missing-message-source'),
		JSON.stringify(emptyResult.problems),
	)
})

test('validateArchiveText：assistant/message 的 turn / step / content 不对被拒', () => {
	// 宿主原话：assistant/message does not match an open turn and step
	const noTurn = row(0)
	delete noTurn.data.turn
	const turnResult = validateArchiveText(archiveText([noTurn]))
	assert.ok(
		turnResult.problems.some((p) => p.reason === 'invalid-turn'),
		JSON.stringify(turnResult.problems),
	)

	const zeroStep = row(0)
	zeroStep.data.step = 0
	const stepResult = validateArchiveText(archiveText([zeroStep]))
	assert.ok(
		stepResult.problems.some((p) => p.reason === 'invalid-step'),
		JSON.stringify(stepResult.problems),
	)

	// 宿主原话：assistant content requires an array
	const badContent = row(0)
	badContent.data.message.content = '不是数组'
	const contentResult = validateArchiveText(archiveText([badContent]))
	assert.ok(
		contentResult.problems.some((p) => p.reason === 'invalid-content'),
		JSON.stringify(contentResult.problems),
	)
})

test('validateArchiveText：事件文本没有以换行结尾，判成半截记录', () => {
	const text = archiveText([row(0)]).replace(/\n$/, '')
	const result = validateArchiveText(text)
	assert.equal(result.ok, false)
	assert.ok(
		result.problems.some((p) => p.reason === 'torn-trailing-record'),
		JSON.stringify(result.problems),
	)
})

test('validateArchiveBytes：zstd 容器里的半截记录同样被拒', () => {
	const text = archiveText([row(0)]).replace(/\n$/, '')
	const index = text.indexOf('\n')
	const bytes = Buffer.concat([
		compressFrame(text.slice(0, index + 1)),
		compressFrame(text.slice(index + 1)),
	])
	const result = validateArchiveBytes(bytes)
	assert.equal(result.ok, false)
	assert.ok(
		result.problems.some((p) => p.reason === 'torn-trailing-record'),
		JSON.stringify(result.problems),
	)
})

test('validateArchiveBytes：空存档与坏帧都被拒', () => {
	const empty = validateArchiveBytes(Buffer.alloc(0))
	assert.equal(empty.ok, false)
	assert.equal(empty.problems[0].reason, 'empty-archive')
	const broken = validateArchiveBytes(Buffer.from('这不是 zstd 也不是合法存档', 'utf8'))
	assert.equal(broken.ok, false)
	assert.ok(broken.problems.length > 0)
})

// ── 压缩与编码 ──────────────────────────────────────────────────────────

test('compressFrame：产出的帧带校验和位（帧描述符的 0x04）', () => {
	const frame = compressFrame('一行文本\n')
	assert.equal(frame[4] & 0x04, 0x04, '帧描述符的校验和位必须置上')
	assert.equal(zlib.zstdDecompressSync(frame).toString('utf8'), '一行文本\n')
})

test('compressFrame：没有 zstd 能力时报错，而不是退回原始字节', () => {
	const original = zlib.zstdCompressSync
	zlib.zstdCompressSync = undefined
	try {
		assert.throws(() => compressFrame('一行文本\n'), /zstd/)
	} finally {
		zlib.zstdCompressSync = original
	}
})

test('encodeFrames：第 0 帧永远只有头部行', () => {
	const text = archiveText([row(0), row(1)])
	const raw = pack(text)
	// 正常路径：按原帧边界逐帧重压。
	const normal = encodeFrames(raw, text, text, [])
	const normalFrames = scanZstdFrames(normal).frames
	assert.equal(normalFrames.length, 2)
	assert.equal(frameText(normal, 0), `${JSON.stringify(HEADER)}\n`, '第 0 帧只能有头部行')
	// 兜底路径：原文件扫不出帧时退回「头部一帧 + 事件一帧」。
	const fallback = encodeFrames(Buffer.from(text, 'utf8'), text, text, [])
	const fallbackFrames = scanZstdFrames(fallback).frames
	assert.equal(fallbackFrames.length, 2)
	assert.equal(frameText(fallback, 0), `${JSON.stringify(HEADER)}\n`, '兜底时第 0 帧也只能有头部行')
})

test('encodeFrames：产物一定是宿主能打开的存档', () => {
	const text = archiveText([row(0), row(1)])
	const bytes = encodeFrames(Buffer.from(text, 'utf8'), text, text, [])
	const result = validateArchiveBytes(bytes)
	assert.equal(result.ok, true, JSON.stringify(result.problems))
})

// ── 落盘闸门 ────────────────────────────────────────────────────────────

test('maskSession：源存档过不了校验就拒绝落盘，原文件一个字节都不变', () => {
	// 缺 seq 的事件行 —— 宿主读不了这种存档。
	const broken = `${JSON.stringify(HEADER)}\n${JSON.stringify({ type: 'assistant/message', time: 1, data: { text: RUN } })}\n`
	const original = Buffer.from(broken, 'utf8')
	const fs = makeStore({ [FILE]: original })
	const result = maskSession({
		file: FILE,
		apply: true,
		mode: 'replace',
		roots: ['/sessions'],
		backupFile: `${FILE}.bak`,
		auditFile: `${FILE}.audit.json`,
		readFile: fs.readFile,
		writeFile: fs.writeFile,
		rename: fs.rename,
		stat: fs.stat,
		existsFile: fs.existsFile,
	})

	assert.equal(result.applied, false, '不合格的存档不许落盘')
	assert.ok(result.error, '要报出失败原因')
	assert.equal(result.sourceProblem.row, 1)
	assert.equal(result.sourceProblem.reason, 'missing-field:seq')
	assert.deepEqual(fs.store.get(FILE), original, '原文件必须一个字节都不变')
	assert.equal(fs.writes.length, 0, '连备份与审计都不许写')
	assert.equal(fs.renames.length, 0, '不许改名')
})

test('maskSession：产物过不了校验就不落盘，原文件一个字节都不变', () => {
	// 源存档是好的（有退化内容），坏在产物上：标记里塞一个双引号会写坏 JSON。
	const valid = row(0)
	valid.data.message.content = [{ type: 'text', text: `前面${RUN}后面` }]
	const original = Buffer.from(archiveText([valid]), 'utf8')
	const fs = makeStore({ [FILE]: original })
	const result = maskSession({
		file: FILE,
		apply: true,
		mode: 'copy',
		outFile: `${FILE}.masked`,
		roots: ['/sessions'],
		auditFile: `${FILE}.audit.json`,
		readFile: fs.readFile,
		writeFile: fs.writeFile,
		rename: fs.rename,
		stat: fs.stat,
		existsFile: fs.existsFile,
		// 标记里塞一个双引号：写出去的 JSON 直接坏掉 —— 产物必须被拦住。
		marker: () => '"',
	})

	assert.equal(result.applied, false, '不合格的产物不许落盘')
	assert.ok(result.error, '要报出失败原因')
	assert.equal(result.problem.row, 1)
	assert.equal(result.problem.reason, 'invalid-json')
	assert.deepEqual(fs.store.get(FILE), original, '原文件必须一个字节都不变')
	assert.equal(fs.writes.length, 0, '一个字节都不许写')
})

test('maskSession：预览模式不写盘，但仍然报出源存档的问题', () => {
	const broken = `${JSON.stringify(HEADER)}\n${JSON.stringify({ type: 'assistant/message', time: 1, data: { text: RUN } })}\n`
	const original = Buffer.from(broken, 'utf8')
	const fs = makeStore({ [FILE]: original })
	const result = maskSession({
		file: FILE,
		apply: false,
		roots: ['/sessions'],
		readFile: fs.readFile,
		writeFile: fs.writeFile,
	})

	assert.equal(result.applied, false)
	assert.equal(result.sourceProblem.reason, 'missing-field:seq')
	assert.equal(fs.writes.length, 0, '预览不许写盘')
})

test('restoreSessionText：源存档过不了校验就拒绝落盘，原文件一个字节都不变', () => {
	const broken = `${JSON.stringify(HEADER)}\n${JSON.stringify({ type: 'assistant/message', time: 1, data: { text: MARK } })}\n`
	const original = Buffer.from(broken, 'utf8')
	const fs = makeStore({ [FILE]: original })
	const result = restoreSessionText({
		file: FILE,
		from: MARK,
		to: '换回来的原文',
		apply: true,
		roots: ['/sessions'],
		backupFile: `${FILE}.bak`,
		auditFile: `${FILE}.audit.json`,
		readFile: fs.readFile,
		writeFile: fs.writeFile,
		rename: fs.rename,
		stat: fs.stat,
		existsFile: fs.existsFile,
	})

	assert.equal(result.applied, false, '不合格的存档不许落盘')
	assert.equal(result.restored, false)
	assert.ok(result.error, '要报出失败原因')
	assert.equal(result.sourceProblem.row, 1)
	assert.equal(result.sourceProblem.reason, 'missing-field:seq')
	assert.deepEqual(fs.store.get(FILE), original, '原文件必须一个字节都不变')
	assert.equal(fs.writes.length, 0, '连备份与审计都不许写')
	assert.equal(fs.renames.length, 0, '不许改名')
})
