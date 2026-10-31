/**
 * 日志与旁证文件写入。
 *
 * 三条独立的记录线：
 *   1. 判定日志（JSONL）：每次命中写一行，含模型、通道、游程长度、截断点。
 *   2. 旁证副本（纯文本）：被丢弃/折叠掉的原文片段。
 *   3. 误报白名单（JSON）：`/degen-ack` 登记的误报，后续同类判定不再拦截。
 *
 * 旁证副本**只写不读**——它永远不会被读回请求上下文，因此不可能二次污染。
 *
 * @module dsh-guard-degen/log
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { ensureDir } from './paths.js'

/**
 * 追加一行 JSON。
 * @param {string | null} file - 目标文件（绝对路径）
 * @param {object} payload - 要记录的对象
 * @returns {boolean} 是否写入成功
 */
export function appendJsonl(file, payload) {
	if (!file) return false
	try {
		ensureDir(path.dirname(file))
		fs.appendFileSync(file, `${JSON.stringify(payload)}\n`, 'utf8')
		return true
	} catch {
		return false
	}
}

/**
 * 写一份旁证副本。
 * @param {string | null} dir - 目标目录（绝对路径）
 * @param {string} baseName - 文件名前缀
 * @param {string} text - 原文
 * @param {number} [maxChars] - 单文件最大字符数
 * @returns {string | null} 写入的文件路径
 */
export function writeSidecar(dir, baseName, text, maxChars = 262144) {
	if (!dir) return null
	try {
		ensureDir(dir)
		const stamp = new Date().toISOString().replace(/[:.]/g, '-')
		// 复审缺陷 F7：文件名里的 `..` 会被 path.join 折叠掉，
		// 于是旁证副本能落到日志目录之外（模型名里带 `/` 就能构造出来）。
		// 这里把文件名成分洗成安全字符。
		const safeBase = String(baseName ?? 'verdict').replace(/[^A-Za-z0-9._-]/g, '_')
		const file = path.join(dir, `${stamp}-${safeBase}.txt`)
		const body = text.length > maxChars
			? `${text.slice(0, maxChars)}\n…[已截断，原始长度 ${text.length} 字符]`
			: text
		fs.writeFileSync(file, body, 'utf8')
		return file
	} catch {
		return null
	}
}

/**
 * 样本哈希：把一段文本折成稳定短串，用于白名单比对。
 * @param {unknown} text - 文本
 * @returns {string} 哈希（16 位十六进制）
 */
export function sampleHash(text) {
	const s = String(text ?? '')
	return crypto.createHash('sha256').update(s).digest('hex').slice(0, 16)
}

/**
 * 判定日志：每次命中写一行 JSONL，另存一份旁证副本。
 */
export class VerdictLog {
	/**
	 * @param {object} [options] - 选项
	 * @param {string} [options.dir] - 日志目录
	 * @param {string} [options.file] - 日志文件（默认 `<dir>/verdicts.jsonl`）
	 * @param {boolean} [options.sidecar] - 是否写旁证副本（默认 true）
	 */
	constructor(options = {}) {
		this.dir = options.dir ?? null
		this.file = options.file ?? (this.dir ? path.join(this.dir, 'verdicts.jsonl') : null)
		this.writeSidecar = options.sidecar !== false
		this.sequence = 0
	}

	/**
	 * 记录一条判定。
	 * @param {object} verdict - 裁决
	 * @param {object} [context] - 上下文（会话、模型、动作等）
	 * @returns {object} 写入的日志条目
	 */
	record(verdict, context = {}) {
		this.sequence += 1
		const entry = {
			id: `${Date.now().toString(36)}-${this.sequence.toString(36)}`,
			ts: new Date().toISOString(),
			sessionId: context.sessionId ?? null,
			agentId: context.agentId ?? null,
			model: context.model ?? null,
			provider: context.provider ?? null,
			channel: verdict.channel ?? context.channel ?? null,
			rule: verdict.rule ?? null,
			severity: verdict.severity ?? null,
			action: context.action ?? null,
			onset: verdict.onset ?? null,
			count: verdict.detail?.count ?? verdict.detail?.repeats ?? 0,
			// 退化特征：多字符单元重复时把「重复的单元」与「重复了几份」单独记下来，
			// 界面上「日志」页签要据此说明命中了什么，而不只是「命中了 unit-run」。
			repeats: verdict.detail?.repeats ?? 0,
			unit: verdict.detail?.unit ?? null,
			unitChars: verdict.detail?.unitChars ?? null,
			evidence: verdict.evidence ?? null,
			sampleHash: sampleHash(context.sample ?? verdict.evidence ?? ''),
			source: context.source ?? 'stream',
			// 折叠现场：净化时写进会话的标记 + 被折叠掉的原文。
			// 界面上「改前/改后」对照与「回退」都要靠这两项。
			marker: context.marker ?? null,
			original: context.original ?? null,
			offset: context.offset ?? null,
		}
		if (this.file) appendJsonl(this.file, entry)
		if (this.writeSidecar && this.dir && context.sample) {
			const sidecar = writeSidecar(this.dir, `${entry.rule ?? 'verdict'}-${entry.model ?? 'unknown'}`, String(context.sample))
			if (sidecar) entry.sidecar = sidecar
		}
		// 净化掉的原文另存一份旁证：日志行是 JSON，原文带退化字符，
		// 放进去既难读也可能被别处二次消费，单独存更干净。
		if (this.writeSidecar && this.dir && context.original) {
			const sidecar = writeSidecar(this.dir, `${entry.rule ?? 'verdict'}-${entry.model ?? 'unknown'}-original`, String(context.original))
			if (sidecar) entry.originalSidecar = sidecar
		}
		return entry
	}

	/**
	 * 回读全部日志条目（坏行跳过）。
	 * @returns {object[]} 条目
	 */
	list() {
		if (!this.file) return []
		try {
			const text = fs.readFileSync(this.file, 'utf8')
			const out = []
			for (const line of text.split('\n')) {
				if (!line.trim()) continue
				try {
					out.push(JSON.parse(line))
				} catch {
					/* 坏行跳过 */
				}
			}
			return out
		} catch {
			return []
		}
	}

	/**
	 * 最近一条判定。
	 * @returns {object | undefined} 条目
	 */
	last() {
		const entries = this.list()
		return entries.length > 0 ? entries[entries.length - 1] : undefined
	}
}

/**
 * 误报白名单：`/degen-ack` 把一次判定登记为误报，之后同类判定不再拦截。
 */
export class Whitelist {
	/**
	 * @param {object} [options] - 选项
	 * @param {string} [options.file] - 白名单文件
	 */
	constructor(options = {}) {
		this.file = options.file ?? null
		this.entries = []
		this.loaded = false
	}

	/**
	 * 读入白名单。
	 * @returns {object[]} 条目
	 */
	load() {
		this.entries = []
		this.loaded = true
		if (!this.file) return this.entries
		try {
			const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'))
			if (Array.isArray(parsed)) this.entries = parsed.filter((item) => item && typeof item === 'object')
		} catch {
			/* 文件不存在或坏了：当作空表 */
		}
		return this.entries
	}

	/**
	 * 落盘白名单。
	 * @returns {boolean} 是否成功
	 */
	save() {
		if (!this.file) return false
		try {
			ensureDir(path.dirname(this.file))
			fs.writeFileSync(this.file, `${JSON.stringify(this.entries, null, 2)}\n`, 'utf8')
			return true
		} catch {
			return false
		}
	}

	/**
	 * 登记一条误报。
	 * @param {{model?: string, rule?: string, sample?: string, note?: string}} item - 误报信息
	 * @returns {object} 登记的条目
	 */
	add(item = {}) {
		if (!this.loaded) this.load()
		const entry = {
			id: `wl-${Date.now().toString(36)}-${(this.entries.length + 1).toString(36)}`,
			ts: new Date().toISOString(),
			model: item.model ?? '*',
			rule: item.rule ?? '*',
			sampleHash: item.sampleHash ?? sampleHash(item.sample ?? ''),
			note: item.note ?? '',
		}
		this.entries.push(entry)
		this.save()
		return entry
	}

	/**
	 * 移除一条误报登记。
	 * @param {string} id - 条目 id
	 * @returns {boolean} 是否移除
	 */
	remove(id) {
		if (!this.loaded) this.load()
		const before = this.entries.length
		this.entries = this.entries.filter((entry) => entry.id !== id)
		if (this.entries.length === before) return false
		this.save()
		return true
	}

	/**
	 * 列出全部登记。
	 * @returns {object[]} 条目
	 */
	list() {
		if (!this.loaded) this.load()
		return this.entries
	}

	/**
	 * 判断一次判定是否命中白名单。
	 * @param {{model?: string, rule?: string, sample?: string}} probe - 判定特征
	 * @returns {boolean} 是否命中
	 */
	matches(probe = {}) {
		const hash = probe.sampleHash ?? sampleHash(probe.sample ?? '')
		return this.list().some((entry) => {
			if (entry.rule !== '*' && entry.rule !== probe.rule) return false
			if (entry.model !== '*' && entry.model !== probe.model) return false
			if (entry.sampleHash !== '*' && entry.sampleHash !== hash) return false
			return true
		})
	}
}

/**
 * 判断一次判定是否应当被白名单抑制。
 * @param {{model?: string, rule?: string, sample?: string}} probe - 判定特征
 * @param {Whitelist | null} whitelist - 白名单
 * @returns {boolean} 是否抑制
 */
export function shouldSuppress(probe, whitelist) {
	if (!whitelist || typeof whitelist.matches !== 'function') return false
	return whitelist.matches(probe)
}
