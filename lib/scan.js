/**
 * 会话日志扫描：读取 harness 的会话存档，找出被符号流污染的记录。
 *
 * 关键点：DSH 的会话日志是**拼接的 zstd 帧**（每批次一帧），Node 的一次性
 * `zlib.zstdDecompressSync()` 只解第一帧——直接拿它扫描会得到"0 命中"的假象。
 * 这里移植了 dsh-session-persistence-jsonl 的帧扫描算法，逐帧解码再拼接。
 *
 * @module dsh-guard-degen/scan
 */

import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { findSymbolRun } from './detect.js'

/** zstd 帧魔数（小端） */
export const ZSTD_MAGIC = 4247762216

/**
 * 扫描 zstd 帧边界（移植自 dsh-session-persistence-jsonl/lib/index.js）。
 * @param {Buffer} buffer - 文件内容
 * @returns {{frames: Array<{start: number, end: number}>, tornStart: number | null}} 帧区间
 */
export function scanZstdFrames(buffer) {
	const frames = []
	let offset = 0
	while (offset < buffer.length) {
		const start = offset
		if (buffer.length - offset < 4) return { frames, tornStart: start }
		if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) throw new Error(`坏帧 magic @${offset}`)
		offset += 4
		if (offset === buffer.length) return { frames, tornStart: start }
		const descriptor = buffer.readUInt8(offset)
		offset += 1
		const contentSizeFlag = descriptor >>> 6
		const singleSegment = (descriptor & 32) !== 0
		const checksum = (descriptor & 4) !== 0
		const dictionaryFlag = descriptor & 3
		const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
		const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
		const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
		if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start }
		offset += remainingHeaderBytes
		for (;;) {
			if (buffer.length - offset < 3) return { frames, tornStart: start }
			const blockHeader = buffer.readUIntLE(offset, 3)
			offset += 3
			const lastBlock = (blockHeader & 1) !== 0
			const blockType = (blockHeader >>> 1) & 3
			const blockSize = blockHeader >>> 3
			if (blockType === 3) throw new Error(`保留块类型 @${offset - 3}`)
			const payloadBytes = blockType === 1 ? 1 : blockSize
			if (buffer.length - offset < payloadBytes) return { frames, tornStart: start }
			offset += payloadBytes
			if (lastBlock) break
		}
		if (checksum) {
			if (buffer.length - offset < 4) return { frames, tornStart: start }
			offset += 4
		}
		frames.push({ start, end: offset })
	}
	return { frames, tornStart: null }
}

/**
 * 解码整个会话文件（逐帧）。
 * @param {Buffer} raw - 文件内容
 * @returns {{text: string, frames: number}} 解码文本
 */
export function decodeSession(raw) {
	if (!raw.subarray(0, 4).equals(Buffer.from([0x28, 0xb5, 0x2f, 0xfd]))) {
		return { text: raw.toString('utf8'), frames: 1 }
	}
	const { frames } = scanZstdFrames(raw)
	const parts = []
	for (const f of frames) {
		try {
			parts.push(zlib.zstdDecompressSync(raw.subarray(f.start, f.end)).toString('utf8'))
		} catch (err) {
			parts.push(`\n<<frame ${f.start}-${f.end} decode error: ${err.message}>>\n`)
		}
	}
	return { text: parts.join(''), frames: frames.length }
}

/**
 * 递归收集 JSON 值里的所有字符串。
 * @param {unknown} value - 任意 JSON 值
 * @param {string[]} [out] - 收集容器
 * @returns {string[]} 字符串列表
 */
export function collectStrings(value, out = []) {
	if (typeof value === 'string') out.push(value)
	else if (Array.isArray(value)) for (const v of value) collectStrings(v, out)
	else if (value && typeof value === 'object') for (const k of Object.keys(value)) collectStrings(value[k], out)
	return out
}

/**
 * 扫描单个会话文件。
 * @param {string} file - 会话文件路径
 * @param {{minRun?: number, chars?: string}} [options] - 阈值
 * @returns {{file: string, ok: boolean, error?: string, events: number, polluted: number, runs: number, symbols: number, maxRun: number, byType: Record<string, number>}} 扫描结果
 */
export function scanSessionFile(file, options = {}) {
	const { minRun = 20, chars } = options
	const result = { file, ok: false, events: 0, polluted: 0, runs: 0, symbols: 0, maxRun: 0, byType: {} }
	let text
	try {
		text = decodeSession(fs.readFileSync(file)).text
	} catch (err) {
		result.error = err.message
		return result
	}
	result.ok = true
	const lines = text.split('\n')
	for (const line of lines) {
		if (!line) continue
		result.events += 1
		if (!line.includes('⇒') && !line.includes('★') && !line.includes('·') && !line.includes('…')) continue
		let type = 'raw'
		try {
			const obj = JSON.parse(line)
			type = obj?.type ?? obj?.kind ?? 'raw'
		} catch {
			/* 保留 raw */
		}
		let hits = 0
		let symbols = 0
		let maxRun = 0
		for (const s of collectStrings(safeParse(line))) {
			const run = findSymbolRun(s, { minRun, chars })
			if (!run) continue
			hits += 1
			symbols += run.count
			if (run.count > maxRun) maxRun = run.count
		}
		if (hits === 0) continue
		result.polluted += 1
		result.runs += hits
		result.symbols += symbols
		if (maxRun > result.maxRun) result.maxRun = maxRun
		result.byType[type] = (result.byType[type] ?? 0) + hits
	}
	return result
}

/**
 * 解析一行 JSON，失败返回 null。
 * @param {string} line - 文本行
 * @returns {unknown} 解析结果
 */
function safeParse(line) {
	try {
		return JSON.parse(line)
	} catch {
		return null
	}
}

/**
 * 递归收集文件路径。
 * @param {string} dir - 目录
 * @param {string[]} [out] - 收集容器
 * @returns {string[]} 文件路径
 */
function walk(dir, out = []) {
	let entries = []
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true })
	} catch {
		return out
	}
	for (const e of entries) {
		const p = path.join(dir, e.name)
		if (e.isDirectory()) walk(p, out)
		else out.push(p)
	}
	return out
}

/**
 * 扫描整个会话目录树。
 * @param {string} root - sessions 根目录
 * @param {{minRun?: number, chars?: string, maxFiles?: number}} [options] - 阈值与上限
 * @returns {{root: string, scanned: number, failed: number, pollutedSessions: number, runs: number, symbols: number, byType: Record<string, number>, files: Array<object>}} 汇总
 */
export function scanSessionTree(root, options = {}) {
	const { maxFiles = 500 } = options
	const summary = {
		root,
		scanned: 0,
		failed: 0,
		pollutedSessions: 0,
		runs: 0,
		symbols: 0,
		byType: {},
		files: [],
	}
	if (!root) return summary
	const files = walk(root)
		.filter((f) => f.includes('session.v4.jsonl'))
		.slice(0, maxFiles)
	for (const file of files) {
		const r = scanSessionFile(file, options)
		if (!r.ok) {
			summary.failed += 1
			continue
		}
		summary.scanned += 1
		if (r.polluted === 0) continue
		summary.pollutedSessions += 1
		summary.runs += r.runs
		summary.symbols += r.symbols
		for (const [k, v] of Object.entries(r.byType)) summary.byType[k] = (summary.byType[k] ?? 0) + v
		summary.files.push({ file: path.relative(root, file), polluted: r.polluted, runs: r.runs, symbols: r.symbols, maxRun: r.maxRun })
	}
	summary.files.sort((a, b) => b.maxRun - a.maxRun || b.symbols - a.symbols)
	return summary
}
