/**
 * 会话存档「宿主能不能打开」的校验。
 *
 * ## 为什么要有这个模块
 *
 * 插件会**就地重写**会话存档（`session.v4.jsonl.zstd`）。以前写完就报成功，
 * 没人检查产物是不是宿主能打开的样子：坏存档被重写一遍还是坏存档，
 * 用户点开会话只看到宿主一句没头没尾的「stored log is corrupt」。
 *
 * 这里把宿主的验收规则原样抄了一份：写盘之前先验一遍，不通过就不落盘。
 *
 * ## 规则（对着宿主源码抄的）
 *
 * 帧级：
 *   1. 第 0 帧必须**恰好**是一行头部 —— 明文非空、含 `\n`、且 `\n` 是最后一个字节；
 *   2. 后面的每一帧都要能干净解开；
 *   3. 拼起来的事件文本必须以 `\n` 结尾（不能留半截记录）。
 *
 * 行级（v4 物理行准入）：
 *   4. 顶层键只能是 `type` / `seq` / `time` / `data`，外加可选的
 *      `ignorable` / `sourceEventSeqs` / `surfaceOp`；多一个键就拒；
 *   5. `type` / `seq` / `time` / `data` 缺一不可，`type` 是字符串、
 *      `time` 是安全整数、`data` 是对象；
 *   6. `seq` 必须稠密：第 n 条事件行的 `seq` 就是 n-1；
 *   7. `ignorable` 出现时必须正好是 `true`；
 *   8. 表面事件（`system/message` 等 5 种）必须带 `surfaceOp`。
 *
 * 消息级（宿主关系校验里那几条会「整份拒收」的规则）：
 *   9. 消息行必须带生产者自己的 `source`：`source.kind` 是非空字符串，
 *      且不能是 `plugin`（宿主：`format v4 message requires a producer-owned source kind`）；
 *  10. `assistant/message` 的 `turn` / `step` 必须是正整数
 *      （宿主：`assistant/message does not match an open turn and step`）；
 *  11. `assistant/message` 的 `message.content` 必须是数组
 *      （宿主：`assistant content requires an array`）。
 *
 * @module dsh-guard-degen/archive-validate
 */

import zlib from 'node:zlib'
import { scanZstdFrames } from './scan.js'

/** zstd 帧魔数（小端 4 字节）。 */
const ZSTD_MAGIC_BYTES = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/** 物理行必须有的顶层键。 */
const REQUIRED_ROW_KEYS = ['type', 'seq', 'time', 'data']

/** 物理行允许的顶层键（必填 + 可选）。 */
const ALLOWED_ROW_KEYS = new Set([...REQUIRED_ROW_KEYS, 'ignorable', 'sourceEventSeqs', 'surfaceOp'])

/** 表面事件：没有 `surfaceOp` 宿主读不了。 */
const SURFACE_TYPES = new Set([
	'system/message',
	'user/message',
	'developer/message',
	'assistant/message',
	'tool/result',
])

/**
 * 消息行：宿主要求它们带上「生产者自己的」source。
 * `user/message` 的 source 在 data 上，其余在 data.message 上。
 */
const MESSAGE_SOURCE_ROWS = new Map([
	['user/message', (data) => data],
	['assistant/message', (data) => data?.message],
	['tool/result', (data) => data?.message],
])

/** 最多报多少个问题（坏存档可能有很多行都坏，别刷屏）。 */
const MAX_PROBLEMS = 50

/**
 * 校验一份会话存档的原始字节。
 *
 * zstd 容器按帧级 + 行级规则查；纯文本存档没有帧的概念，
 * 直接按「头部行 + 事件行」查。
 *
 * @param {Buffer | Uint8Array} bytes - 存档字节
 * @returns {{ok: boolean, problems: Array<{row: number | null, reason: string}>}} 校验结果
 */
export function validateArchiveBytes(bytes) {
	const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes ?? [])
	if (buf.length === 0) return { ok: false, problems: [{ row: null, reason: 'empty-archive' }] }
	if (!buf.subarray(0, 4).equals(ZSTD_MAGIC_BYTES)) {
		return validateArchiveText(buf.toString('utf8'))
	}
	let frames = []
	let tornStart = null
	try {
		const scanned = scanZstdFrames(buf)
		frames = scanned.frames
		tornStart = scanned.tornStart
	} catch {
		return { ok: false, problems: [{ row: null, reason: 'bad-frame' }] }
	}
	const problems = []
	if (tornStart !== null) problems.push({ row: null, reason: 'torn-frame' })
	if (frames.length === 0) {
		problems.push({ row: null, reason: 'no-frames' })
		return { ok: false, problems }
	}
	// 规则 1：第 0 帧必须恰好是一行头部。
	const header = decompressFrame(buf, frames[0])
	if (header === null) {
		problems.push({ row: null, reason: 'frame-decode-error' })
	} else {
		const headerProblem = checkHeaderFrame(header)
		if (headerProblem) problems.push(headerProblem)
	}
	// 规则 2：后面的每一帧都要能干净解开。
	const parts = []
	for (let i = 1; i < frames.length; i += 1) {
		const text = decompressFrame(buf, frames[i])
		if (text === null) problems.push({ row: null, reason: 'frame-decode-error' })
		else parts.push(text)
	}
	// 规则 3：拼起来的事件文本必须以 \n 结尾。
	const eventText = parts.join('')
	if (eventText.length > 0 && !eventText.endsWith('\n')) {
		problems.push({ row: null, reason: 'torn-trailing-record' })
	}
	// 行级规则 4-8。
	problems.push(...checkRows(eventText))
	return { ok: problems.length === 0, problems: problems.slice(0, MAX_PROBLEMS) }
}

/**
 * 校验已经解开成文本的存档（头部行 + 事件行）。
 *
 * @param {string} text - 存档文本
 * @param {{strict?: boolean}} [options] - 选项；`strict: false` 时只查最基础的完整性
 * @returns {{ok: boolean, problems: Array<{row: number | null, reason: string}>}} 校验结果
 */
export function validateArchiveText(text, options = {}) {
	const strict = options.strict !== false
	const value = typeof text === 'string' ? text : ''
	if (value.length === 0) return { ok: false, problems: [{ row: null, reason: 'empty-archive' }] }
	const problems = []
	const index = value.indexOf('\n')
	if (index === -1) {
		// 连头部行都没结束：没有换行，宿主读不了。
		return { ok: false, problems: [{ row: null, reason: 'no-header-line' }] }
	}
	if (value.slice(0, index).trim() === '') problems.push({ row: null, reason: 'empty-header' })
	const body = value.slice(index + 1)
	if (body.length > 0 && !body.endsWith('\n')) problems.push({ row: null, reason: 'torn-trailing-record' })
	if (strict) problems.push(...checkRows(body))
	return { ok: problems.length === 0, problems: problems.slice(0, MAX_PROBLEMS) }
}

/**
 * 解开一帧 zstd；解不开返回 null。
 * @param {Buffer} buffer - 存档字节
 * @param {{start: number, end: number}} frame - 帧区间
 * @returns {string | null} 明文
 */
function decompressFrame(buffer, frame) {
	try {
		return zlib.zstdDecompressSync(buffer.subarray(frame.start, frame.end)).toString('utf8')
	} catch {
		return null
	}
}

/**
 * 查头部帧：必须恰好是一行。
 * @param {string} text - 头部帧明文
 * @returns {{row: null, reason: string} | null} 问题（没有就返回 null）
 */
function checkHeaderFrame(text) {
	if (text.length === 0) return { row: null, reason: 'empty-header' }
	const index = text.indexOf('\n')
	if (index === -1) return { row: null, reason: 'no-header-line' }
	if (index !== text.length - 1) return { row: null, reason: 'header-frame-not-single-line' }
	if (text.slice(0, index).trim() === '') return { row: null, reason: 'empty-header' }
	return null
}

/**
 * 查事件行（规则 4-8）。
 * @param {string} body - 事件文本（不含头部行）
 * @returns {Array<{row: number, reason: string}>} 问题列表
 */
function checkRows(body) {
	const problems = []
	if (body.length === 0) return problems
	const lines = body.split('\n')
	// 结尾的 \n 会多切出一个空串，那不是一行记录。
	if (lines[lines.length - 1] === '') lines.pop()
	let row = 0
	for (const line of lines) {
		row += 1
		problems.push(...checkRow(line, row))
		if (problems.length >= MAX_PROBLEMS) break
	}
	return problems
}

/**
 * 查一行事件。
 * @param {string} line - 一行 JSONL
 * @param {number} row - 行号（事件行里的 1-based 序号）
 * @returns {Array<{row: number, reason: string}>} 问题列表
 */
function checkRow(line, row) {
	const problems = []
	if (line.trim() === '') {
		problems.push({ row, reason: 'empty-row' })
		return problems
	}
	let value = null
	try {
		value = JSON.parse(line)
	} catch {
		problems.push({ row, reason: 'invalid-json' })
		return problems
	}
	if (value === null || typeof value !== 'object' || Array.isArray(value)) {
		problems.push({ row, reason: 'not-an-object' })
		return problems
	}
	// 规则 4：顶层键不多不少。
	const unexpected = Object.keys(value).find((key) => !ALLOWED_ROW_KEYS.has(key))
	if (unexpected !== undefined) problems.push({ row, reason: `unexpected-field:${unexpected}` })
	// 规则 5：必填键一个都不能少，字段类型也要对。
	for (const key of REQUIRED_ROW_KEYS) {
		if (!Object.hasOwn(value, key)) problems.push({ row, reason: `missing-field:${key}` })
	}
	if (typeof value.type !== 'string') problems.push({ row, reason: 'invalid-type' })
	if (!Number.isSafeInteger(value.time)) problems.push({ row, reason: 'invalid-time' })
	if (value.data === null || typeof value.data !== 'object' || Array.isArray(value.data)) {
		problems.push({ row, reason: 'invalid-data' })
	}
	// 规则 6：seq 必须稠密 —— 第 n 条事件行的 seq 就是 n-1。
	const expected = row - 1
	if (!Number.isSafeInteger(value.seq)) problems.push({ row, reason: 'invalid-seq' })
	else if (value.seq !== expected) problems.push({ row, reason: `seq-gap:expected-${expected}-got-${value.seq}` })
	// 规则 7：ignorable 出现时必须正好是 true。
	if (Object.hasOwn(value, 'ignorable') && value.ignorable !== true) {
		problems.push({ row, reason: 'invalid-ignorable' })
	}
	// 规则 8：表面事件必须带 surfaceOp。
	if (SURFACE_TYPES.has(value.type)) {
		const op = value.surfaceOp
		if (op === undefined) problems.push({ row, reason: 'missing-surface-op' })
		else if (op !== 'append' && (op === null || typeof op !== 'object' || Array.isArray(op))) {
			problems.push({ row, reason: 'invalid-surface-op' })
		}
	}
	// 规则 9：消息行必须带生产者自己的 source。
	const sourceOf = MESSAGE_SOURCE_ROWS.get(value.type)
	if (sourceOf !== undefined && isPlainObject(value.data)) {
		const source = sourceOf(value.data)?.source
		if (!isPlainObject(source) || typeof source.kind !== 'string' || source.kind.length === 0 || source.kind === 'plugin') {
			problems.push({ row, reason: 'missing-message-source' })
		}
	}
	// 规则 10-11：assistant/message 的 turn / step 与 content。
	if (value.type === 'assistant/message' && isPlainObject(value.data)) {
		for (const key of ['turn', 'step']) {
			const coordinate = value.data[key]
			if (!Number.isSafeInteger(coordinate) || coordinate <= 0) problems.push({ row, reason: `invalid-${key}` })
		}
		if (isPlainObject(value.data.message) && !Array.isArray(value.data.message.content)) {
			problems.push({ row, reason: 'invalid-content' })
		}
	}
	return problems
}

/**
 * 判断一个值是不是普通对象（不是数组也不是 null）。
 * @param {unknown} value - 待判断的值
 * @returns {boolean} 是不是普通对象
 */
function isPlainObject(value) {
	return value !== null && typeof value === 'object' && !Array.isArray(value)
}
