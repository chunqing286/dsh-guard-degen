/**
 * 历史会话遮蔽 —— 把**已经落盘**的退化内容从会话存档里清掉。
 *
 * ## 要解决的问题
 *
 * DSH 的会话存档会把模型的 thinking 与正文原样写进
 * `~/.dsh/sessions/<归一化工作目录名>/<会话id>/session.v4.jsonl.zstd`。
 * 模型退化时（连续重复符号 `⇒⇒⇒…`），这些噪声会跟着落盘，于是：
 *   - 用户点「继续」时上下文已被污染，模型被自己的噪声带进沟里；
 *   - 工具写出的文件工件被噪声污染，事后分不清哪部分是真实产物。
 *
 * 本模块负责**事后清理**：扫描存档 → 定位退化段 → 用标记替换。
 *
 * ## 与 `dsh-guard-repeat-output` 的关键区别
 *
 * `repeat-output` 清理落盘内容时会**跳过带 tool-call 的 assistant 消息**——
 * 把 reasoning 整段删掉会让 tool-call 变成孤儿，破坏 tool-call / tool-result
 * 的配对，续跑时工具上下文直接断链。
 *
 * 本模块的做法不同：**只替换退化 reasoning/text 块里的字符串内容，
 * tool-call 块本身原封不动**，于是既不产生孤儿、又能清掉污染。
 *
 * ## 实现要点
 *
 * - 存档是**拼接的多帧 zstd**：复用 `lib/scan.js` 的 `decodeSession()` 解码，
 *   写回时逐帧重新压缩，帧数与帧边界保持不变（JSON 行可以跨帧，写回时按
 *   替换长度校正帧起点；校正不出单调边界才退化成「头部一帧 + 事件一帧」兜底，
 *   兜底时第 0 帧仍然**只有头部行**——宿主要求第 0 帧恰好是一行头部）。
 * - 落盘前先验一遍：源存档与产物都要过 `lib/archive-validate.js` 的宿主验收规则，
 *   验不过就不动用户的文件，只把原因报回去。
 * - 真实事件字段名可能出入（`message.content` / `blocks` …），所以这里**容错**：
 *   遍历事件 JSON 里的所有字符串，用「事件序号 + 字段路径」定位退化段，
 *   回写时按路径精确替换（按字符偏移切片，不重新序列化整行，
 *   因此退化段前后的正常文字逐字不变）。
 * - 判定口径统一走 `lib/detect.js` 的 `findSymbolRun()`，与流式侧、工具闸门一致。
 *
 * @module lib/sessions
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

import { DEFAULT_SYMBOLS, UNIT_RUN_DEFAULTS, findSymbolRun, findUnitRunsInResidue } from './detect.js'
import { decodeSession, scanZstdFrames } from './scan.js'
import { isInsideRoots, isSymlinked, unitMarker } from './artifacts.js'
import { ensureDir, harnessHome } from './paths.js'
import { validateArchiveBytes } from './archive-validate.js'

/** 默认遮蔽标记模板（`N` 会被真实符号个数替换）。 */
export const DEFAULT_MASK_MARKER = '〔退化内容已遮蔽×N〕'

/** 默认退化游程阈值（与 `lib/detect.js` 一致）。 */
export const DEFAULT_MIN_RUN = 20

/** 未解析成 JSON 的行的字段路径占位。 */
const RAW_PATH = '(raw)'

/** 遮蔽预览里保留的上下文长度（退化段前后各这么多字符）。 */
const PREVIEW_CONTEXT_CHARS = 80

/** 遮蔽预览里单段退化原文的最大长度。 */
const PREVIEW_SEGMENT_CHARS = 160

/** 遮蔽预览里最多返回的段数（超出部分只报计数）。 */
const PREVIEW_MAX_SEGMENTS = 200

/**
 * 截短退化段原文（预览用）。太长的游程整段贴上来会把对照视图撑爆。
 * @param {string} text - 游程原文
 * @returns {string} 截短后的文本
 */
function clipRunText(text) {
	const source = typeof text === 'string' ? text : ''
	return source.length > PREVIEW_SEGMENT_CHARS ? `${source.slice(0, PREVIEW_SEGMENT_CHARS)}…` : source
}

/** 会话标题事件的事件名。 */
const TITLE_EVENT_TYPE = 'session/title'

/** zstd 帧魔数（小端字节序）。 */
const ZSTD_MAGIC_BYTES = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/** zstd 压缩失败时错误对象上的标记（用来把「压不出来」和「解析失败」分开报）。 */
const ZSTD_ERROR_CODE = 'DSH_GUARD_DEGEN_ZSTD'

/** 视为 tool-call 块的类型名（归一化后比较）。 */
const TOOL_CALL_TYPES = new Set(['toolcall', 'tooluse', 'functioncall', 'toolinvocation', 'toolcallchunks', 'toolcallchunk'])

/** 事件里代表「工具调用参数」的成员名。 */
const TOOL_CALL_ARG_KEYS = ['arguments', 'args']

/**
 * 允许遮蔽的事件类型（归一化后比较）。
 *
 * 只有**模型自己产出**的内容才允许被改：
 * 用户提问、系统提示、工具结果都是「别人给的内容」，
 * 改掉它们等于篡改存档里的原始对话，下一次续跑时上下文就对不上了。
 */
const MASKABLE_EVENT_TYPES = new Set(['assistant', 'assistantmessage', 'compactionsummary'])

/**
 * 归一化事件类型名。
 * @param {unknown} value - 类型值
 * @returns {string} 归一化结果
 */
function normalizeEventType(value) {
	return String(value ?? '').toLowerCase().replace(/[^a-z0-9]/g, '')
}

/**
 * 判断这个事件是否允许遮蔽。
 * @param {string | undefined} type - 事件类型
 * @returns {boolean} 是否可遮蔽
 */
function isMaskableEvent(type) {
	if (type === undefined) return true
	return MASKABLE_EVENT_TYPES.has(normalizeEventType(type))
}

/**
 * 归一化类型名：小写并去掉分隔符。
 * @param {unknown} value - 类型值
 * @returns {string} 归一化结果
 */
function normalizeType(value) {
	return String(value ?? '').toLowerCase().replace(/[^a-z0-9]/g, '')
}

/**
 * 判断一个对象是不是 tool-call 块。
 *
 * 优先看 `type` 字段；没有 `type` 时用「同时具备 arguments + name + id」的
 * 启发式兜底（content block 的常见形状）。
 *
 * @param {object} node - 解析出的对象节点
 * @returns {boolean} 是否 tool-call 块
 */
function isToolCallObject(node) {
	if (!node || node.kind !== 'object') return false
	const typeNode = node.members.get('type')
	if (typeNode && typeNode.kind === 'string' && TOOL_CALL_TYPES.has(normalizeType(typeNode.value))) return true
	// 真实的流式记录是 `{type:'tool-call-chunks', id, name, args:[...]}`：
	// 参数在 `args` 里，不在 `arguments` 里，两种都得认。
	const hasArgs = TOOL_CALL_ARG_KEYS.some((key) => node.members.has(key))
	const hasName = node.members.has('name')
	const hasId = node.members.has('id') || node.members.has('toolCallId') || node.members.has('tool_call_id')
	return hasArgs && hasName && hasId
}

/**
 * 把文本切成行（保留空行），并记录每行的字符区间。
 * @param {string} text - 文本
 * @returns {Array<{index: number, text: string, start: number, end: number}>} 行列表
 */
function splitLines(text) {
	const parts = text.split('\n')
	let offset = 0
	return parts.map((t, index) => {
		const start = offset
		offset += t.length + 1
		return { index, text: t, start, end: start + t.length }
	})
}

/**
 * 找出一段文本里的**全部**符号游程。
 *
 * 阈值口径与 `lib/detect.js` 的 `findSymbolRun()` 完全一致（同一个正则）；
 * 区别只在这里返回全部游程，而不只是最后一段——遮蔽要把每一段都清掉。
 *
 * @param {string} text - 文本
 * @param {{minRun?: number, chars?: string}} [options] - 阈值
 * @returns {Array<{start: number, end: number, count: number, text: string}>} 游程列表
 */
function findSymbolRuns(text, options = {}) {
	const minRun = Math.max(2, Number(options.minRun) || DEFAULT_MIN_RUN)
	const chars = options.chars || DEFAULT_SYMBOLS
	if (typeof text !== 'string' || text.length < minRun) return []
	// 与 detect.js 同口径：先用共享判定器把关，确认这段确实退化。
	if (!findSymbolRun(text, { minRun, chars })) return []
	const className = [...new Set([...chars])].map((c) => c.replace(/[\\\]^\-]/g, '\\$&')).join('')
	const re = new RegExp(`([${className}](?:[ \\t\\r\\n]*[${className}]){${minRun - 1},})`, 'gu')
	const runs = []
	let m
	while ((m = re.exec(text)) !== null) {
		const body = m[0]
		const count = [...body].filter((c) => chars.includes(c)).length
		runs.push({ start: m.index, end: m.index + body.length, count, text: body })
		if (m.index === re.lastIndex) re.lastIndex++
	}
	return runs
}

/**
 * 找出一段文本里的**全部**多字符单元重复。
 *
 * 与工件治理、流式守卫同一套判定口径（`lib/detect.js` 的 `findUnitRuns()`）：
 * 一个多字符单元反复出现（≥ `unitRepeats` 份）就算退化。
 *
 * 判定在**残渣**上做：先把符号游程摘掉，再在剩下的碎片里找单元重复。
 * 不这么做的话，治理完游程碎片会拼出一个新的单元重复，
 * 落盘前的复核就通不过（会话治理会拒绝落盘）。
 *
 * @param {string} text - 文本
 * @param {{unitRepeats?: number, symbolRuns?: Array<{start: number, end: number}>}} [options] - 阈值
 * @returns {Array<{start: number, end: number, count: number, text: string,
 *                  repeats: number, unit: string, rule: string}>} 重复段列表
 */
function findUnitRunSpans(text, options = {}) {
	if (typeof text !== 'string' || text.length === 0) return []
	const minRepeats = Math.max(2, Number(options.unitRepeats) || UNIT_RUN_DEFAULTS.minRepeats)
	const hits = findUnitRunsInResidue(text, options.symbolRuns, { ...UNIT_RUN_DEFAULTS, minRepeats })
	return hits.map((hit) => ({
		start: hit.start,
		end: hit.end,
		count: hit.count,
		text: text.slice(hit.start, hit.end),
		repeats: hit.repeats,
		unit: hit.unit,
		rule: 'unit-run',
	}))
}

/**
 * 找出一段文本里**所有**要治理的退化段（两种形态）。
 *
 * - `symbol-run`：同一个符号连成一片（≥ `minRun` 个）；
 * - `unit-run`：一个多字符单元反复出现（≥ `unitRepeats` 份）。
 *
 * 重叠的段只留一段（留最长的）：同一处退化不重复上报，也不重复改写。
 *
 * @param {string} text - 文本
 * @param {{minRun?: number, chars?: string, unitRun?: boolean, unitRepeats?: number}} [options] - 阈值
 * @returns {Array<{start: number, end: number, count: number, text: string,
 *                  rule: string, repeats: number | null, unit: string}>} 退化段列表
 */
function findRuns(text, options = {}) {
	const symbolRuns = findSymbolRuns(text, options)
	const runs = symbolRuns.map((run) => ({
		...run,
		rule: 'symbol-run',
		repeats: null,
		unit: run.text,
	}))
	if (options.unitRun !== false) {
		for (const run of findUnitRunSpans(text, { ...options, symbolRuns })) runs.push(run)
	}
	runs.sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start))
	const merged = []
	for (const run of runs) {
		const last = merged[merged.length - 1]
		if (last && run.start < last.end) {
			if ((run.end - run.start) > (last.end - last.start)) merged[merged.length - 1] = run
			continue
		}
		merged.push(run)
	}
	return merged
}

/**
 * 一段退化被替换成什么（折叠模式）。
 *
 * 两种形态两套标记：符号游程写「多少个符号」，单元重复写「重复了几份」。
 *
 * @param {{rule?: string, count: number, repeats?: number | null}} run - 退化段
 * @param {{marker?: string | ((n: number) => string)}} opts - 标记模板
 * @returns {string} 标记文本
 */
function runMarkerFor(run, opts) {
	if (run?.rule === 'unit-run') return unitMarker(run.repeats ?? 1)
	return renderMarker(opts?.marker, run?.count ?? 0)
}

/**
 * 生成遮蔽标记。
 * @param {string | ((count: number) => string)} marker - 标记模板或工厂
 * @param {number} count - 真实符号个数
 * @returns {string} 标记文本
 */
function renderMarker(marker, count) {
	if (typeof marker === 'function') return String(marker(count))
	const tpl = typeof marker === 'string' && marker.length > 0 ? marker : DEFAULT_MASK_MARKER
	return tpl
		.replace(/\{(?:N|n|count)\}/g, String(count))
		.replace(/(?<![\p{L}\p{N}])N(?![\p{L}\p{N}])/gu, String(count))
}

/**
 * 解析一行 JSON，返回带字符区间的节点树。
 *
 * 只求「每个字符串字面量在原始行里的位置」，不做语义校验；
 * 解析失败时返回 `null`，由调用方退回整行文本兜底。
 *
 * @param {string} text - 原始行
 * @returns {object | null} 节点树
 */
function parseJsonTree(text) {
	let i = 0
	const n = text.length
	/** 跳过空白。 */
	const skipWs = () => {
		while (i < n && (text[i] === ' ' || text[i] === '\t' || text[i] === '\n' || text[i] === '\r')) i++
	}
	/**
	 * 解析字符串字面量。
	 * @returns {object} 字符串节点
	 */
	const parseString = () => {
		const quoteStart = i
		i++
		const contentStart = i
		let value = ''
		/** 每个解码字符对应的原始字符区间（相对 contentStart）。 */
		const spans = []
		while (i < n) {
			const c = text[i]
			if (c === '\\') {
				const escStart = i
				const esc = text[i + 1]
				i += 2
				let decoded = ''
				if (esc === 'n') decoded = '\n'
				else if (esc === 't') decoded = '\t'
				else if (esc === 'r') decoded = '\r'
				else if (esc === 'b') decoded = '\b'
				else if (esc === 'f') decoded = '\f'
				else if (esc === 'u') {
					const hex = text.slice(i, i + 4)
					i += 4
					const code = Number.parseInt(hex, 16)
					decoded = Number.isNaN(code) ? '' : String.fromCharCode(code)
				} else decoded = esc
				value += decoded
				spans.push([escStart - contentStart, i - contentStart])
			} else if (c === '"') {
				i++
				break
			} else {
				value += c
				spans.push([i - contentStart, i + 1 - contentStart])
				i++
			}
		}
		return { kind: 'string', start: quoteStart, end: i, value, spans, contentStart }
	}
	/**
	 * 解析对象。
	 * @returns {object} 对象节点
	 */
	const parseObject = () => {
		const node = { kind: 'object', members: new Map() }
		i++
		skipWs()
		if (text[i] === '}') {
			i++
			return node
		}
		for (;;) {
			skipWs()
			if (text[i] !== '"') break
			const key = parseString()
			skipWs()
			if (text[i] === ':') i++
			const value = parseValue()
			node.members.set(key.value, value)
			skipWs()
			if (text[i] === ',') {
				i++
				continue
			}
			if (text[i] === '}') i++
			break
		}
		return node
	}
	/**
	 * 解析数组。
	 * @returns {object} 数组节点
	 */
	const parseArray = () => {
		const node = { kind: 'array', items: [] }
		i++
		skipWs()
		if (text[i] === ']') {
			i++
			return node
		}
		for (;;) {
			node.items.push(parseValue())
			skipWs()
			if (text[i] === ',') {
				i++
				continue
			}
			if (text[i] === ']') i++
			break
		}
		return node
	}
	/**
	 * 解析任意值。
	 * @returns {object} 值节点
	 */
	const parseValue = () => {
		skipWs()
		if (i >= n) return { kind: 'other' }
		const c = text[i]
		if (c === '"') return parseString()
		if (c === '{') return parseObject()
		if (c === '[') return parseArray()
		const start = i
		while (i < n && !',}]"\t\r\n '.includes(text[i])) i++
		return { kind: 'other', start, end: i }
	}
	const root = parseValue()
	return root
}

/**
 * 遍历节点树，收集**可遮蔽**的字符串（tool-call 块内的字符串跳过）。
 * @param {object} node - 节点
 * @param {string} prefix - 字段路径前缀
 * @param {{strings: Array<object>, toolCalls: number}} ctx - 收集容器
 * @param {boolean} [skip] - 是否位于 tool-call 块内部
 */
function walkTree(node, prefix, ctx, skip = false) {
	if (!node) return
	if (node.kind === 'string') {
		if (!skip) ctx.strings.push({ path: prefix, node })
		return
	}
	if (node.kind === 'object') {
		const isToolCall = isToolCallObject(node)
		if (isToolCall) ctx.toolCalls += 1
		const childSkip = skip || isToolCall
		for (const [key, child] of node.members) {
			const childPath = prefix ? `${prefix}.${key}` : key
			walkTree(child, childPath, ctx, childSkip)
		}
		return
	}
	if (node.kind === 'array') {
		node.items.forEach((child, index) => {
			walkTree(child, `${prefix}[${index}]`, ctx, skip)
		})
	}
}

/**
 * 把一条字符串按遮蔽方式处理掉，返回遮蔽后的内容与每段替换在结果里的位置。
 *
 * remove 方式：退化段整段消失（`''`）。
 * collapse 方式：退化段换成带计数的标记。
 *
 * @param {string} value - 字符串原文
 * @param {Array<{start: number, end: number, count: number}>} runs - 游程（按 start 升序、互不重叠）
 * @param {{maskMode?: string, marker?: string | ((n: number) => string)}} opts - 遮蔽选项
 * @returns {{value: string, spans: Array<{start: number, end: number}>}} 遮蔽后的内容与替换区间
 */
function maskStringValue(value, runs, opts) {
	const remove = opts.maskMode === 'remove'
	const pieces = []
	const spans = []
	let cursor = 0
	let pos = 0
	for (const run of runs) {
		const gap = value.slice(cursor, run.start)
		pieces.push(gap)
		pos += gap.length
		const start = pos
		const replacement = remove ? '' : runMarkerFor(run, opts)
		pieces.push(replacement)
		pos += replacement.length
		spans.push({ start, end: pos })
		cursor = run.end
	}
	pieces.push(value.slice(cursor))
	return { value: pieces.join(''), spans }
}

/**
 * 收集一行里的全部退化游程（带原始行内的字符区间）。
 *
 * 每个游程还带「遮蔽前 / 遮蔽后」两段**字符串级**的上下文：
 * 界面要拿它们当对照视图的两行。上下文必须从字符串值本身取——
 * 直接切原始行会串到同一条消息里的别的退化段上（一条消息里常有好几段）。
 *
 * @param {string} line - 原始行
 * @param {{minRun: number, chars: string, maskMode?: string, marker?: string}} opts - 阈值与遮蔽方式
 * @returns {{runs: Array<object>, toolCalls: number}} 游程与 tool-call 计数
 */
function collectLineRuns(line, opts) {
	let parsed = null
	try {
		parsed = JSON.parse(line)
	} catch {
		parsed = null
	}
	if (!parsed) {
		// 不是合法 JSON：退化成整行文本处理，保证噪声仍能被清掉。
		const rawRuns = findRuns(line, opts)
		const masked = maskStringValue(line, rawRuns, opts)
		const runs = rawRuns.map((run, index) => {
			const span = masked.spans[index]
			return {
				...run,
				path: RAW_PATH,
				originalWindow: `${line.slice(Math.max(0, run.start - PREVIEW_CONTEXT_CHARS), run.start)}${clipRunText(run.text)}${line.slice(run.end, run.end + PREVIEW_CONTEXT_CHARS)}`,
				originalTruncatedBefore: run.start > PREVIEW_CONTEXT_CHARS,
				originalTruncatedAfter: run.end + PREVIEW_CONTEXT_CHARS < line.length,
				maskedWindow: masked.value.slice(Math.max(0, span.start - PREVIEW_CONTEXT_CHARS), span.end + PREVIEW_CONTEXT_CHARS),
				maskedTruncatedBefore: span.start > PREVIEW_CONTEXT_CHARS,
				maskedTruncatedAfter: span.end + PREVIEW_CONTEXT_CHARS < masked.value.length,
			}
		})
		return { runs, toolCalls: 0 }
	}
	// 只有模型自己产出的事件才允许改写：用户提问、系统提示、工具结果原样保留。
	if (!isMaskableEvent(parsed?.type)) return { runs: [], toolCalls: 0 }
	const tree = parseJsonTree(line)
	const ctx = { strings: [], toolCalls: 0 }
	walkTree(tree, '', ctx)
	const runs = []
	for (const item of ctx.strings) {
		const node = item.node
		const nodeRuns = findRuns(node.value, opts)
		if (nodeRuns.length === 0) continue
		// 先算出这条字符串遮蔽之后的样子，再据此取上下文窗口。
		const masked = maskStringValue(node.value, nodeRuns, opts)
		for (const [index, run] of nodeRuns.entries()) {
			const first = node.spans[run.start]
			const last = node.spans[run.end - 1]
			if (!first || !last) continue
			const span = masked.spans[index]
			runs.push({
				path: item.path,
				start: node.contentStart + first[0],
				end: node.contentStart + last[1],
				count: run.count,
				text: run.text,
				rule: run.rule,
				repeats: run.repeats ?? null,
				unit: run.unit ?? '',
				// 遮蔽前：原文里这一段连同上下文。
				originalWindow: `${node.value.slice(Math.max(0, run.start - PREVIEW_CONTEXT_CHARS), run.start)}${clipRunText(run.text)}${node.value.slice(run.end, run.end + PREVIEW_CONTEXT_CHARS)}`,
				originalTruncatedBefore: run.start > PREVIEW_CONTEXT_CHARS,
				originalTruncatedAfter: run.end + PREVIEW_CONTEXT_CHARS < node.value.length,
				// 遮蔽后：同一处遮蔽完的样子。remove 方式下退化段整段消失，
				// 这里显示的就是「符号真的没了」之后剩下的文字；
				// collapse 方式下退化段变成标记，标记也在窗口里。
				maskedWindow: masked.value.slice(Math.max(0, span.start - PREVIEW_CONTEXT_CHARS), span.end + PREVIEW_CONTEXT_CHARS),
				maskedTruncatedBefore: span.start > PREVIEW_CONTEXT_CHARS,
				maskedTruncatedAfter: span.end + PREVIEW_CONTEXT_CHARS < masked.value.length,
			})
		}
	}
	return { runs, toolCalls: ctx.toolCalls }
}

/**
 * 分析整段文本：找出所有退化段、生成遮蔽后的行、并复核残留。
 *
 * `maskMode` 决定退化段被改成什么：
 * - `collapse`（默认）：换成标记 `〔退化内容已遮蔽×N〕`，原文位置还看得出来；
 * - `remove`：整段删掉，不留痕迹。
 *
 * @param {string} text - 解码后的文本
 * @param {{minRun: number, chars: string, marker: string | ((n: number) => string), maskMode?: 'collapse' | 'remove'}} opts - 选项
 * @returns {{lines: string[], hits: Array<object>, events: number, toolCallsKept: number,
 *            masked: number, symbols: number, maxRun: number, remaining: number,
 *            edits: Array<{start: number, end: number, newLen: number}>}} 分析结果
 */
function analyzeText(text, opts) {
	const lines = splitLines(text)
	const maskMode = opts.maskMode === 'remove' ? 'remove' : 'collapse'
	const masked = new Array(lines.length)
	const hits = []
	const edits = []
	let event = 0
	let events = 0
	let toolCallsKept = 0
	let maskedCount = 0
	let symbols = 0
	let maxRun = 0
	for (const line of lines) {
		if (line.text === '') {
			masked[line.index] = line.text
			continue
		}
		events += 1
		const info = collectLineRuns(line.text, opts)
		toolCallsKept += info.toolCalls
		let out = line.text
		for (let i = info.runs.length - 1; i >= 0; i--) {
			const run = info.runs[i]
			// remove 模式：整段删掉；collapse 模式：换成带计数的标记。
			const replacement = maskMode === 'remove' ? '' : runMarkerFor(run, opts)
			out = `${out.slice(0, run.start)}${replacement}${out.slice(run.end)}`
			edits.push({
				start: line.start + run.start,
				end: line.start + run.end,
				newLen: replacement.length,
			})
		}
		edits.sort((a, b) => a.start - b.start)
		masked[line.index] = out
		for (const run of info.runs) {
			maskedCount += 1
			symbols += run.count
			if (run.count > maxRun) maxRun = run.count
			// 上下文各取前后 PREVIEW_CONTEXT_CHARS 个字，并记住是不是被截断了——
			// 界面要据此告诉用户「这里只显示了片段」，不能让人以为整行就这么长。
			const beforeStart = Math.max(0, run.start - PREVIEW_CONTEXT_CHARS)
			const afterEnd = Math.min(line.text.length, run.end + PREVIEW_CONTEXT_CHARS)
			hits.push({
				event,
				path: run.path,
				rule: run.rule ?? 'symbol-run',
				repeats: run.repeats ?? null,
				unit: run.unit ?? '',
				count: run.count,
				action: maskMode,
				preview: run.text.slice(0, 40),
				original: run.text,
				before: line.text.slice(beforeStart, run.start),
				after: line.text.slice(run.end, afterEnd),
				beforeTruncated: beforeStart > 0,
				afterTruncated: afterEnd < line.text.length,
				// 对照视图的两行：「遮蔽前」和「遮蔽后」，都是字符串级的真实内容。
				originalWindow: run.originalWindow ?? '',
				originalTruncatedBefore: run.originalTruncatedBefore === true,
				originalTruncatedAfter: run.originalTruncatedAfter === true,
				maskedWindow: run.maskedWindow ?? '',
				maskedTruncatedBefore: run.maskedTruncatedBefore === true,
				maskedTruncatedAfter: run.maskedTruncatedAfter === true,
			})
		}
		event += 1
	}
	// 复核：遮蔽后还剩多少游程（正常应为 0）。只统计**可遮蔽**的字符串——
	// tool-call 块按设计整块保留，里面的残留不算漏网。
	let remaining = 0
	if (!opts.skipRemaining) {
		for (const line of lines) {
			if (line.text === '') continue
			remaining += collectLineRuns(masked[line.index], opts).runs.length
		}
	}
	return { lines: masked, hits, events, toolCallsKept, masked: maskedCount, symbols, maxRun, remaining, edits }
}

/**
 * 把「原文偏移」映射到「遮蔽后文本的偏移」。
 *
 * 帧边界可能落在被替换的区间里（一个 JSON 行可以跨帧），所以写回时要把
 * 帧起点按替换长度做一次偏移校正，才能保持原来的帧划分。
 *
 * @param {Array<{start: number, end: number, newLen: number}>} edits - 替换列表（按 start 升序）
 * @param {number} offset - 原文偏移
 * @returns {number} 遮蔽后文本的偏移
 */
function mapOffset(edits, offset) {
	let delta = 0
	for (const edit of edits) {
		if (offset <= edit.start) break
		if (offset >= edit.end) {
			delta += edit.newLen - (edit.end - edit.start)
			continue
		}
		return edit.start + delta
	}
	return offset + delta
}

/**
 * 把一段文本压成一帧 zstd。
 *
 * 宿主写存档用的是**带校验和**的 zstd 帧（`ZSTD_c_checksumFlag = 1`），
 * 这里必须对齐：帧描述符里少了校验和位，宿主的帧扫描就对不上这份存档。
 *
 * 压不出来就**抛错**，不再退回纯文本 —— 退回纯文本等于往存档里塞一段
 * 不是 zstd 的字节，宿主读的时候只会报一句「corrupt session log」。
 *
 * @param {string} text - 文本
 * @returns {Buffer} 字节
 */
export function compressFrame(text) {
	const buf = Buffer.from(text, 'utf8')
	if (typeof zlib.zstdCompressSync !== 'function') {
		throw zstdError('当前 Node 不支持 zstd 压缩，无法写入会话存档')
	}
	let frame = null
	try {
		frame = zlib.zstdCompressSync(buf, { params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 } })
	} catch (err) {
		throw zstdError(`zstd 压缩失败：${err.message}`)
	}
	// 回读校验：压出来的帧必须能原样解开，否则写出去的就是坏存档。
	let back = null
	try {
		back = zlib.zstdDecompressSync(frame)
	} catch (err) {
		throw zstdError(`zstd 帧回读失败：${err.message}`)
	}
	if (!back.equals(buf)) throw zstdError('zstd 帧回读内容与输入不一致')
	return frame
}

/**
 * 造一个带标记的 zstd 错误（用来把「压不出来」和「解析失败」分开报）。
 * @param {string} message - 错误说明
 * @returns {Error} 错误对象
 */
function zstdError(message) {
	const err = new Error(message)
	err.code = ZSTD_ERROR_CODE
	return err
}

/**
 * 判断缓冲区是不是 zstd 帧。
 * @param {Buffer} raw - 字节
 * @returns {boolean} 是否 zstd
 */
function isZstd(raw) {
	return Buffer.isBuffer(raw) && raw.length >= 4 && raw.subarray(0, 4).equals(ZSTD_MAGIC_BYTES)
}

/**
 * 按原帧边界重新压缩遮蔽后的文本。
 *
 * 帧数与帧边界保持不变：一个 JSON 行可以跨帧，所以帧起点要按替换长度做
 * 偏移校正（见 {@link mapOffset}）；万一校正不出单调边界，退化成
 * 「头部一帧 + 事件一帧」兜底，保证产出的文件一定还是合法的 zstd 存档。
 *
 * 兜底时**第 0 帧只放头部行**：宿主要求第 0 帧恰好是一行头部，
 * 头部和事件混在一帧里，整个会话宿主都读不了。
 *
 * @param {Buffer} raw - 原文件字节
 * @param {string} originalText - 原文本（用于定位帧边界）
 * @param {string} maskedText - 遮蔽后的完整文本
 * @param {Array<{start: number, end: number, newLen: number}>} edits - 替换列表
 * @returns {Buffer} 新文件字节
 */
export function encodeFrames(raw, originalText, maskedText, edits) {
	if (typeof zlib.zstdCompressSync !== 'function') {
		throw zstdError('当前 Node 不支持 zstd 压缩，无法写入会话存档')
	}
	let ranges = []
	try {
		ranges = scanZstdFrames(raw).frames
	} catch {
		ranges = []
	}
	if (ranges.length === 0) return compressHeaderAndEvents(maskedText)
	const parts = []
	let offset = 0
	for (const range of ranges) {
		let text = ''
		try {
			text = zlib.zstdDecompressSync(raw.subarray(range.start, range.end)).toString('utf8')
		} catch (err) {
			text = `\n<<frame ${range.start}-${range.end} decode error: ${err.message}>>\n`
		}
		parts.push({ start: offset, end: offset + text.length })
		offset += text.length
	}
	// 帧起点：原文偏移 → 遮蔽后偏移
	const boundaries = parts.map((p) => mapOffset(edits, p.start))
	for (let i = 1; i < boundaries.length; i++) {
		if (boundaries[i] < boundaries[i - 1] || boundaries[i] > maskedText.length) {
			return compressHeaderAndEvents(maskedText)
		}
	}
	const chunks = []
	for (let i = 0; i < boundaries.length; i++) {
		const start = boundaries[i]
		const end = i + 1 < boundaries.length ? boundaries[i + 1] : maskedText.length
		chunks.push(compressFrame(maskedText.slice(start, end)))
	}
	return Buffer.concat(chunks)
}

/**
 * 把整段文本压成「第 0 帧只有头部行 + 后面一帧事件」。
 *
 * 宿主的帧级规则：第 0 帧必须**恰好**是一行头部。头部和事件混在一帧里，
 * 宿主会直接判这份存档损坏。
 *
 * @param {string} text - 完整文本（头部行 + 事件行）
 * @returns {Buffer} 新文件字节
 */
function compressHeaderAndEvents(text) {
	const index = text.indexOf('\n')
	const header = index === -1 ? text : text.slice(0, index + 1)
	const events = index === -1 ? '' : text.slice(index + 1)
	const chunks = [compressFrame(header)]
	if (events.length > 0) chunks.push(compressFrame(events))
	return Buffer.concat(chunks)
}

/**
 * 校验一份存档字节，返回问题列表（空数组 = 通过）。
 * @param {Buffer} bytes - 存档字节
 * @returns {Array<{row: number | null, reason: string}>} 问题列表
 */
function archiveProblems(bytes) {
	const check = validateArchiveBytes(bytes)
	return check.ok ? [] : check.problems
}

/**
 * 校验源存档；不通过就把原因写进结果对象。
 * @param {object} result - 结果对象
 * @param {Buffer} bytes - 源存档字节
 * @returns {boolean} 是否通过
 */
function checkSource(result, bytes) {
	const problems = archiveProblems(bytes)
	if (problems.length === 0) return true
	result.sourceProblem = problems[0]
	result.sourceProblems = problems
	result.error = `源存档不可加载：${describeProblem(problems[0])}；原文件未被改动。`
	return false
}

/**
 * 校验产物；不通过就把原因写进结果对象。
 * @param {object} result - 结果对象
 * @param {Buffer} bytes - 产物字节
 * @returns {boolean} 是否通过
 */
function checkOutput(result, bytes) {
	const problems = archiveProblems(bytes)
	if (problems.length === 0) return true
	result.problem = problems[0]
	result.problems = problems
	result.error = `产物不可加载：${describeProblem(problems[0])}；原文件未被改动。`
	return false
}

/**
 * 把校验问题说成人话。
 * @param {{row: number | null, reason: string} | undefined | null} problem - 问题
 * @returns {string} 说明
 */
function describeProblem(problem) {
	if (!problem) return '未知问题'
	const where = problem.row === null || problem.row === undefined ? '存档级' : `第 ${problem.row} 行`
	return `${where}：${problem.reason}`
}

/**
 * 数一数一段存档里**还剩**多少游程（按原样数，不再遮蔽）。
 *
 * 只统计**可遮蔽**的字符串：tool-call 块按设计整块保留，里面的残留不算漏网。
 *
 * @param {Buffer} raw - 文件字节
 * @param {{minRun?: number, chars?: string}} [options] - 阈值
 * @returns {number} 残留游程数
 */
function countResidualRuns(raw, options = {}) {
	const { text } = decodeSession(raw)
	let count = 0
	for (const line of splitLines(text)) {
		if (line.text === '') continue
		count += collectLineRuns(line.text, options).runs.length
	}
	return count
}

/**
 * 为一个会话文件算出遮蔽方案。
 * @param {Buffer} raw - 文件字节
 * @param {{minRun: number, chars: string, marker: string | ((n: number) => string)}} opts - 选项
 * @returns {{output: Buffer, hits: Array<object>, events: number, toolCallsKept: number,
 *            masked: number, symbols: number, maxRun: number, remaining: number, frames: number}} 方案
 */
function planMask(raw, opts) {
	const { text, frames } = decodeSession(raw)
	const analysis = analyzeText(text, opts)
	const maskedText = analysis.lines.join('\n')
	const output = isZstd(raw) ? encodeFrames(raw, text, maskedText, analysis.edits) : Buffer.from(maskedText, 'utf8')
	return { output, frames, ...analysis }
}

/**
 * 把遮蔽计划整理成「原文 / 改写后」的对照，供界面直接渲染。
 *
 * 会话存档是几 MB 的 JSONL，整份贴到界面上没有意义；
 * 真正有用的是「哪一段退化内容被换成了什么」，所以这里只给每一段退化
 * 准备：前后少量上下文 + 退化原文 + 替换后的标记。
 *
 * @param {object} plan - 遮蔽计划
 * @param {string | ((count: number) => string)} marker - 遮蔽标记模板
 * @param {'collapse' | 'remove'} [maskMode] - 遮蔽方式（默认 collapse）
 * @returns {{segments: object[], totalSegments: number, truncated: boolean,
 *            masked: number, symbols: number, toolCallsKept: number, mode: string}} 预览数据
 */
function buildMaskPreview(plan, marker, maskMode = 'collapse') {
	const mode = maskMode === 'remove' ? 'remove' : 'collapse'
	const hits = Array.isArray(plan?.hits) ? plan.hits : []
	const segments = []
	for (const hit of hits) {
		if (segments.length >= PREVIEW_MAX_SEGMENTS) break
		const original = typeof hit?.original === 'string' ? hit.original : ''
		const count = hit?.count ?? 0
		const before = typeof hit?.before === 'string' ? hit.before : ''
		const after = typeof hit?.after === 'string' ? hit.after : ''
		segments.push({
			event: hit?.event ?? 0,
			path: hit?.path ?? '',
			rule: hit?.rule ?? 'symbol-run',
			kind: hit?.rule ?? 'symbol-run',
			repeats: hit?.repeats ?? null,
			unit: hit?.unit ?? '',
			count,
			action: mode,
			before,
			after,
			beforeTruncated: hit?.beforeTruncated === true,
			afterTruncated: hit?.afterTruncated === true,
			removed: original.slice(0, PREVIEW_SEGMENT_CHARS),
			removedTruncated: original.length > PREVIEW_SEGMENT_CHARS,
			// collapse 方式插入一个标记，所以「改后」就是那个标记。
			// 两种退化形态两套标记：符号游程写「多少个符号」，单元重复写「重复了几份」。
			added: mode === 'remove' ? '' : runMarkerFor({ rule: hit?.rule, count, repeats: hit?.repeats }, { marker }),
			// remove 方式**没有替换文本**：退化段被整段删掉。
			// 界面直接显示「遮蔽前 / 遮蔽后」两段真实内容——用户看到的是
			// 符号真的没了，而不是「被换成了某一句话」。
			originalWindow: typeof hit?.originalWindow === 'string' ? hit.originalWindow : '',
			originalTruncatedBefore: hit?.originalTruncatedBefore === true,
			originalTruncatedAfter: hit?.originalTruncatedAfter === true,
			maskedWindow: typeof hit?.maskedWindow === 'string' ? hit.maskedWindow : '',
			maskedTruncatedBefore: hit?.maskedTruncatedBefore === true,
			maskedTruncatedAfter: hit?.maskedTruncatedAfter === true,
		})
	}
	return {
		segments,
		totalSegments: hits.length,
		truncated: hits.length > segments.length,
		masked: plan?.masked ?? 0,
		symbols: plan?.symbols ?? 0,
		toolCallsKept: plan?.toolCallsKept ?? 0,
		mode,
	}
}

/**
 * 会话根目录（默认 `~/.dsh/sessions`）。
 * @returns {string} 根目录
 */
function defaultSessionRoot() {
	return path.join(harnessHome(), 'sessions')
}

/**
 * 递归收集目录下的文件。
 * @param {string} dir - 目录
 * @param {string[]} out - 收集容器
 * @returns {string[]} 文件列表
 */
function walkFiles(dir, out = []) {
	let entries = []
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true })
	} catch {
		return out
	}
	for (const entry of entries) {
		const full = path.join(dir, entry.name)
		if (entry.isDirectory()) walkFiles(full, out)
		else out.push(full)
	}
	return out
}

/**
 * 默认的会话文件遍历：递归找 `session.v4.jsonl.zstd`。
 * @param {string} root - 会话根目录
 * @returns {string[]} 文件列表
 */
function defaultListFiles(root) {
	if (!root) return []
	return walkFiles(root).filter((f) => /session\.v4\.jsonl(\.zstd)?$/.test(path.basename(f)))
}

/**
 * 从会话文件路径推断会话 id（父目录名）。
 * @param {string} file - 文件路径
 * @returns {string} 会话 id
 */
function sessionIdOf(file) {
	try {
		return path.basename(path.dirname(file))
	} catch {
		return ''
	}
}

/**
 * 从解码后的会话文本里取**最新一条**会话标题。
 *
 * 标题是会话日志里的 `session/title` 事件（`data.title`）：
 * 可以是用户重命名，也可以是从首条合格消息折叠出来的兜底标题。
 * 同一条会话可能有多次修订，取最后一条。
 *
 * 只做字符串预筛再解析 JSON：会话动辄几 MB、几百行，
 * 逐行 `JSON.parse` 会把扫描拖慢两个数量级。
 *
 * @param {string} text - 解码后的会话文本
 * @returns {string} 标题（没有则空串）
 */
export function extractSessionTitle(text) {
	if (typeof text !== 'string' || text.length === 0) return ''
	let title = ''
	for (const line of text.split('\n')) {
		if (!line.includes(TITLE_EVENT_TYPE)) continue
		let event
		try {
			event = JSON.parse(line)
		} catch {
			continue
		}
		if (event?.type !== TITLE_EVENT_TYPE) continue
		const value = event?.data?.title
		if (typeof value === 'string' && value.trim().length > 0) title = value.trim()
	}
	return title
}

/**
 * 解析会话存档的**头部行**。
 *
 * 存档第一行是会话头（`{"type":"session","id":…,"cwd":…}`），
 * 里面记着这个会话是在哪个工作目录里开的 —— 会话视图要按它来定位工件目录。
 *
 * @param {string} text - 解码后的会话文本
 * @returns {{id: string, cwd: string, createdAt: number | undefined}} 头部字段
 */
export function parseSessionHeader(text) {
	const header = { id: '', cwd: '', createdAt: undefined }
	if (typeof text !== 'string' || text.length === 0) return header
	for (const line of text.split('\n')) {
		if (!line.includes('"type"')) continue
		let event
		try {
			event = JSON.parse(line)
		} catch {
			continue
		}
		if (event?.type !== 'session') continue
		if (typeof event.id === 'string') header.id = event.id
		if (typeof event.cwd === 'string') header.cwd = event.cwd
		if (typeof event.createdAt === 'number') header.createdAt = event.createdAt
		break
	}
	return header
}

/**
 * 读一个会话存档的元信息（会话 id、工作目录、标题）。
 *
 * @param {string} file - 会话文件路径
 * @param {{readFile?: (path: string) => Buffer}} [options] - 选项
 * @returns {{ok: boolean, id?: string, cwd?: string, createdAt?: number, title?: string, frames?: number, error?: string}} 元信息
 */
export function readSessionMeta(file, options = {}) {
	const readFile = typeof options.readFile === 'function' ? options.readFile : fs.readFileSync
	try {
		const decoded = decodeSession(readFile(file))
		const header = parseSessionHeader(decoded.text)
		return {
			ok: true,
			id: header.id,
			cwd: header.cwd,
			createdAt: header.createdAt,
			title: extractSessionTitle(decoded.text),
			frames: decoded.frames,
		}
	} catch (err) {
		return { ok: false, error: `读取失败：${err.message}` }
	}
}

/**
 * 读一个会话存档的元信息**与**它自己的退化统计（一次解码）。
 *
 * @param {string} file - 会话文件路径
 * @param {{minRun?: number, chars?: string, unitRun?: boolean, unitRepeats?: number,
 *          readFile?: (path: string) => Buffer}} [options] - 选项
 * @returns {{ok: boolean, id?: string, cwd?: string, createdAt?: number, title?: string, frames?: number,
 *            events?: number, runCount?: number, symbolCount?: number, maxRun?: number, error?: string}} 结果
 */
export function inspectSession(file, options = {}) {
	const readFile = typeof options.readFile === 'function' ? options.readFile : fs.readFileSync
	const minRun = Math.max(2, Number(options.minRun) || DEFAULT_MIN_RUN)
	const chars = options.chars || DEFAULT_SYMBOLS
	try {
		const decoded = decodeSession(readFile(file))
		const header = parseSessionHeader(decoded.text)
		const analysis = analyzeText(decoded.text, {
			minRun,
			chars,
			marker: DEFAULT_MASK_MARKER,
			skipRemaining: true,
			unitRun: options.unitRun,
			unitRepeats: options.unitRepeats,
		})
		return {
			ok: true,
			id: header.id,
			cwd: header.cwd,
			createdAt: header.createdAt,
			title: extractSessionTitle(decoded.text),
			frames: decoded.frames,
			events: analysis.events,
			runCount: analysis.masked,
			symbolCount: analysis.symbols,
			maxRun: analysis.maxRun,
		}
	} catch (err) {
		return { ok: false, error: `读取失败：${err.message}` }
	}
}

/**
 * 插件自己的工作目录（`~/.dsh/guard-degen`）。
 * @returns {string} 目录路径
 */
function pluginWorkDir() {
	return path.join(harnessHome(), 'guard-degen')
}

/**
 * 遮蔽结果的落盘位置是否被允许。
 *
 * 复审缺陷 F3：`maskSession` 原本直接采用调用方给的 `outFile` / `auditFile` / `backupFile`，
 * 三个路径都不做根目录判定——库这一层等于给了「往任意路径写文件」的能力。
 * 现在只允许两种落点：会话根目录之内，或者插件自己的工作目录（默认落点就在那儿）。
 *
 * @param {string} target - 目标路径
 * @param {string[]} roots - 允许的会话根目录
 * @returns {boolean} 是否允许
 */
function isAllowedMaskTarget(target, roots) {
	if (typeof target !== 'string' || target.trim() === '') return false
	return isInsideRoots(target, roots) || isInsideRoots(target, [pluginWorkDir()])
}

/**
 * 遮蔽副本的默认路径：放在插件自己的工作目录里（`~/.dsh/guard-degen/masked`）。
 *
 * 复审缺陷 N6：副本原先落在源文件旁边，也就是会话目录里 ——
 * 审计旁车已经搬到插件目录了，副本与备份也一起搬，别往宿主目录里丢文件。
 *
 * @param {string} file - 源会话文件
 * @returns {string} 副本路径
 */
function defaultMaskedPath(file) {
	const base = path.basename(file)
	return path.join(pluginWorkDir(), 'masked', `${base}.${shortHash(file)}.masked`)
}

/**
 * 审计旁车文件的默认路径：同样放在插件自己的工作目录里。
 * @param {string} file - 源会话文件
 * @returns {string} 审计文件路径
 */
function defaultAuditPath(file) {
	const base = path.basename(file)
	return path.join(pluginWorkDir(), 'audit', `${base}.${shortHash(file)}.mask-audit.json`)
}

/**
 * 回退审计旁车的默认路径：放在插件目录里，和遮蔽审计分开命名。
 * @param {string} file - 源会话文件
 * @returns {string} 审计文件路径
 */
function defaultRevertAuditPath(file) {
	const base = path.basename(file)
	return path.join(pluginWorkDir(), 'audit', `${base}.${shortHash(file)}.revert-audit.json`)
}

/**
 * 路径的短哈希（用于给同名文件区分命名空间）。
 * @param {string} file - 文件路径
 * @returns {string} 8 位十六进制串
 */
function shortHash(file) {
	try {
		return crypto.createHash('sha1').update(path.resolve(file)).digest('hex').slice(0, 8)
	} catch {
		return '00000000'
	}
}

/**
 * 备份文件默认路径：`~/.dsh/guard-degen/backups/<name>.<hash>.bak`，已存在则加序号。
 *
 * 复审缺陷 N6：备份原先落在源文件旁边（会话目录里），同样搬到插件目录。
 *
 * @param {string} file - 文件路径
 * @param {(p: string) => boolean} existsFile - 存在性判断
 * @returns {string} 备份文件路径
 */
function pickBackupPath(file, existsFile) {
	const base = path.basename(file)
	const dir = path.join(pluginWorkDir(), 'backups')
	const stem = `${base}.${shortHash(file)}.bak`
	if (!existsFile(path.join(dir, stem))) return path.join(dir, stem)
	for (let i = 1; i < 1000; i++) {
		const candidate = path.join(dir, `${stem}.${i}`)
		if (!existsFile(candidate)) return candidate
	}
	return path.join(dir, `${stem}.${Date.now()}`)
}

/**
 * 扫描会话目录，产出退化报告。
 *
 * @param {object} [options] - 选项
 * @param {string} [options.root] - 会话根目录（默认 `~/.dsh/sessions`）
 * @param {string[]} [options.files] - 显式文件列表（给了就只扫这些）
 * @param {(root: string) => string[]} [options.listFiles] - 可注入的遍历函数
 * @param {(path: string) => Buffer} [options.readFile] - 可注入的读取函数
 * @param {number} [options.minRun] - 退化游程阈值（默认 20）
 * @param {number} [options.maxFiles] - 最多扫描多少个文件（默认 500）
 * @param {string} [options.chars] - 符号集（默认 `lib/detect.js` 的 `DEFAULT_SYMBOLS`）
 * @param {boolean} [options.unitRun] - 是否治理多字符单元重复（默认 true）
 * @param {number} [options.unitRepeats] - 单元重复份数阈值（默认 4）
 * @returns {{root: string, scannedAt: string, sessions: Array<object>, summary: object}} 报告
 */
export function scanSessions(options = {}) {
	const root = options.root || defaultSessionRoot()
	const listFiles = typeof options.listFiles === 'function' ? options.listFiles : defaultListFiles
	const readFile = typeof options.readFile === 'function' ? options.readFile : fs.readFileSync
	const minRun = Math.max(2, Number(options.minRun) || DEFAULT_MIN_RUN)
	const maxFiles = Math.max(1, Number(options.maxFiles) || 500)
	const chars = options.chars || DEFAULT_SYMBOLS
	const unitRun = options.unitRun !== false
	const unitRepeats = Math.max(2, Number(options.unitRepeats) || UNIT_RUN_DEFAULTS.minRepeats)
	const candidates = Array.isArray(options.files) ? options.files.slice() : listFiles(root)
	// 复审缺陷 F3：显式文件列表原本整条绕过根目录判定，
	// 传一个根目录外的路径就能让它被扫描。列表只保留根目录之内的。
	const inside = candidates.filter((file) => typeof file === 'string' && isInsideRoots(file, [root]))
	const files = inside.slice(0, maxFiles)
	const sessions = []
	const summary = {
		filesScanned: 0,
		filesFailed: 0,
		sessionsWithHits: 0,
		totalRuns: 0,
		totalSymbols: 0,
		maxRun: 0,
	}
	for (const file of files) {
		const session = {
			path: file,
			id: sessionIdOf(file),
			title: '',
			frames: 0,
			events: 0,
			runCount: 0,
			symbolCount: 0,
			maxRun: 0,
			hits: [],
		}
		let raw
		try {
			raw = readFile(file)
		} catch (err) {
			session.error = `读取失败：${err.message}`
			summary.filesFailed += 1
			sessions.push(session)
			continue
		}
		let analysis
		let frames = 0
		let title = ''
		try {
			const decoded = decodeSession(raw)
			frames = decoded.frames
			title = extractSessionTitle(decoded.text)
			analysis = analyzeText(decoded.text, {
				minRun,
				chars,
				marker: DEFAULT_MASK_MARKER,
				skipRemaining: true,
				unitRun,
				unitRepeats,
			})
		} catch (err) {
			session.error = `解析失败：${err.message}`
			summary.filesFailed += 1
			sessions.push(session)
			continue
		}
		session.title = title
		session.frames = frames
		session.events = analysis.events
		session.runCount = analysis.masked
		session.symbolCount = analysis.symbols
		session.maxRun = analysis.maxRun
		session.hits = analysis.hits.map((hit) => ({
			event: hit.event,
			path: hit.path,
			rule: hit.rule,
			count: hit.count,
			preview: hit.preview,
		}))
		summary.filesScanned += 1
		if (session.runCount > 0) summary.sessionsWithHits += 1
		summary.totalRuns += session.runCount
		summary.totalSymbols += session.symbolCount
		if (session.maxRun > summary.maxRun) summary.maxRun = session.maxRun
		sessions.push(session)
	}
	return { root, scannedAt: new Date().toISOString(), sessions, summary }
}

/**
 * 遮蔽**一个**会话文件里的退化内容。
 *
 * `apply` 默认 false —— 只读预览，不写任何文件。
 *
 * @param {object} options - 选项
 * @param {string} options.file - 会话文件路径（必填）
 * @param {'copy' | 'replace'} [options.mode] - 输出模式（默认 replace：就地改写存档）
 * @param {boolean} [options.apply] - 是否真正落盘（默认 false = 只读预览）
 * @param {string} [options.outFile] - copy 模式的输出路径（默认写到插件目录）
 * @param {string} [options.backupFile] - replace 模式的备份路径（默认写到插件目录）
 * @param {string} [options.auditFile] - 审计旁车路径（默认与输出同名 `.mask-audit.json`）
 * @param {string[]} [options.roots] - 允许遮蔽的根目录（默认：会话根目录）
 * @param {(path: string) => Buffer} [options.readFile] - 可注入的读取函数
 * @param {(path: string, data: Buffer) => void} [options.writeFile] - 可注入的写入函数
 * @param {(from: string, to: string) => void} [options.rename] - 可注入的重命名函数（replace 模式原子替换用）
 * @param {(path: string) => {size: number}} [options.stat] - 可注入的文件状态查询（replace 模式检查并发追加用）
 * @param {(path: string) => boolean} [options.existsFile] - 可注入的存在性判断
 * @param {number} [options.minRun] - 退化游程阈值（默认 20）
 * @param {string | ((count: number) => string)} [options.marker] - 遮蔽标记模板
 * @param {'collapse' | 'remove'} [options.maskMode] - 遮蔽方式：整段删除（默认）或折叠成标记
 * @param {boolean} [options.unitRun] - 是否治理多字符单元重复（默认 true）
 * @param {number} [options.unitRepeats] - 单元重复份数阈值（默认 4）
 * @returns {{applied: boolean, mode: string, maskMode: string, file: string, output?: string, backup?: string,
 *            audit?: string, masked: number, symbols: number, toolCallsKept: number,
 *            remaining: number, preview?: object, replanned?: boolean, error?: string,
 *            problem?: {row: number | null, reason: string},
 *            problems?: Array<{row: number | null, reason: string}>,
 *            sourceProblem?: {row: number | null, reason: string},
 *            sourceProblems?: Array<{row: number | null, reason: string}>}} 结果
 */
export function maskSession(options = {}) {
	const file = typeof options.file === 'string' ? options.file : ''
	const mode = options.mode === 'copy' ? 'copy' : 'replace'
	const maskMode = options.maskMode === 'collapse' ? 'collapse' : 'remove'
	const apply = options.apply === true
	const readFile = typeof options.readFile === 'function' ? options.readFile : fs.readFileSync
	const writeFile = typeof options.writeFile === 'function' ? options.writeFile : fs.writeFileSync
	const renameFile = typeof options.rename === 'function' ? options.rename : fs.renameSync
	const statFile = typeof options.stat === 'function' ? options.stat : fs.statSync
	const existsFile = typeof options.existsFile === 'function' ? options.existsFile : fs.existsSync
	const minRun = Math.max(2, Number(options.minRun) || DEFAULT_MIN_RUN)
	const chars = options.chars || DEFAULT_SYMBOLS
	const marker = options.marker ?? DEFAULT_MASK_MARKER
	const unitRun = options.unitRun !== false
	const unitRepeats = Math.max(2, Number(options.unitRepeats) || UNIT_RUN_DEFAULTS.minRepeats)
	const roots = Array.isArray(options.roots) && options.roots.length > 0
		? options.roots
		: [path.join(harnessHome(), 'sessions')]
	const result = {
		applied: false,
		mode,
		maskMode,
		file,
		masked: 0,
		symbols: 0,
		toolCallsKept: 0,
		remaining: 0,
	}
	if (!file) {
		result.error = '缺少 file 参数'
		return result
	}
	// 复审缺陷 N4：遮蔽目标必须在允许的根目录之内。
	// 没有这道闸门，浏览器端传一个任意路径就能让宿主改写磁盘上的任意文件。
	// 复审缺陷 D5：这里的判定必须按**真实路径**算——只看解析后的字面路径，
	// 会话根目录里的一个符号链接能把根目录外的文件整个改写掉。
	if (!isInsideRoots(file, roots)) {
		result.error = '文件不在允许的会话根目录之内，已跳过。'
		return result
	}
	// 复审缺陷 D5：会话存档不该是符号链接——顺着链接写会写坏根目录之外的文件，
	// 而备份与审计还留在插件目录里，看起来「成功」了。
	if (isSymlinked(file)) {
		result.error = '目标是符号链接，不予处理。'
		return result
	}
	let raw
	try {
		raw = readFile(file)
	} catch (err) {
		result.error = `读取失败：${err.message}`
		return result
	}
	let plan
	try {
		plan = planMask(raw, { minRun, chars, marker, maskMode, unitRun, unitRepeats })
	} catch (err) {
		result.error = err?.code === ZSTD_ERROR_CODE ? `压缩失败：${err.message}` : `解析失败：${err.message}`
		return result
	}
	// 源存档本身要先验一遍：坏存档被重写一遍还是坏存档，
	// 而插件会报「成功」——用户点开会话只看到宿主一句没头没尾的损坏提示。
	const sourceCheck = validateArchiveBytes(raw)
	if (!sourceCheck.ok) {
		result.sourceProblem = sourceCheck.problems[0]
		result.sourceProblems = sourceCheck.problems
	}
	const output = mode === 'replace' ? file : (options.outFile || defaultMaskedPath(file))
	const audit = options.auditFile || defaultAuditPath(file)
	const backupTarget = mode === 'replace' ? (options.backupFile || pickBackupPath(file, existsFile)) : null
	// 复审缺陷 F3：副本、审计旁车、备份三个落点都要在允许的范围里。
	// 源文件已经在上面查过了，这里查的是「写到哪儿去」。
	if (!isAllowedMaskTarget(output, roots)) {
		result.error = '输出路径不在允许的范围内，已跳过。'
		return result
	}
	if (!isAllowedMaskTarget(audit, roots)) {
		result.error = '审计路径不在允许的范围内，已跳过。'
		return result
	}
	if (backupTarget && !isAllowedMaskTarget(backupTarget, roots)) {
		result.error = '备份路径不在允许的范围内，已跳过。'
		return result
	}
	result.output = output
	result.audit = audit
	result.masked = plan.masked
	result.symbols = plan.symbols
	result.toolCallsKept = plan.toolCallsKept
	result.remaining = plan.remaining
	// 界面要用：把每一段退化整理成「原文 / 改写后」的对照，
	// 预览（apply=false）和真正落盘（apply=true）都给同一份。
	result.preview = buildMaskPreview(plan, marker, maskMode)
	if (!apply) return result
	// 源存档不合格 → 拒绝动它：原文件必须一个字节都不变。
	if (!checkSource(result, raw)) return result
	// 复审缺陷 N5：没有任何退化可遮时，什么都不要写。
	// 原来仍会改写源文件（.zstd 存档会被重新编码）并留下 .bak ——
	// 没东西可修就不该动用户的文件。
	if (plan.masked === 0) {
		result.applied = false
		return result
	}
	// 产物也要验一遍：宁可不动，也不要写出一份宿主读不了的存档。
	if (!checkOutput(result, plan.output)) return result
	const usingDefaultWriter = typeof options.writeFile !== 'function'
	const backup = backupTarget
	/**
	 * 取文件当前字节数；取不到就返回 null（不检查，不拦）。
	 * @param {string} p - 路径
	 * @returns {number | null} 字节数
	 */
	const sizeOfFile = (p) => {
		try {
			return statFile(p).size
		} catch {
			return null
		}
	}
	try {
		if (usingDefaultWriter) {
			ensureDir(path.dirname(output))
			ensureDir(path.dirname(audit))
			if (backup) ensureDir(path.dirname(backup))
		}
		if (mode === 'replace') {
			// 就地改写：会话存档是**活的**，宿主随时可能又往里追加。
			// 所以落盘前以「此刻的文件」为准重算方案，写之前再确认一次
			// 没人刚追加过，免得把新写入的消息抹掉。
			// 替换本身是原子的：先写同目录临时文件，再改名盖掉原文件——
			// 写一半崩掉也不会把用户的会话存档变成半截文件。
			const tmp = `${output}.guard-degen-tmp`
			if (!isAllowedMaskTarget(tmp, roots)) {
				result.error = '临时路径不在允许的范围内，已跳过。'
				return result
			}
			let renamed = false
			for (let attempt = 0; attempt < 3 && !renamed; attempt += 1) {
				// 1) 以此刻的文件为准重算方案。
				let grown = null
				try {
					grown = readFile(file)
				} catch {
					grown = null
				}
				if (grown && !grown.equals(raw)) {
					try {
						plan = planMask(grown, { minRun, chars, marker, maskMode, unitRun, unitRepeats })
					} catch (err) {
						result.error = err?.code === ZSTD_ERROR_CODE ? `压缩失败：${err.message}` : `解析失败：${err.message}`
						return result
					}
					raw = grown
					result.masked = plan.masked
					result.symbols = plan.symbols
					result.toolCallsKept = plan.toolCallsKept
					result.remaining = plan.remaining
					result.preview = buildMaskPreview(plan, marker, maskMode)
					result.replanned = true
					// 重算过的源文件也要验：它可能已经被人写坏了。
					if (!checkSource(result, raw)) return result
					if (!checkOutput(result, plan.output)) return result
				}
				// 2) 备份「即将被替换掉的那一份」。
				if (backup) {
					writeFile(backup, raw)
					result.backup = backup
				}
				// 3) 写临时文件 → 确认这期间没人追加 → 改名盖掉原文件。
				writeFile(tmp, plan.output)
				const size = sizeOfFile(file)
				if (size !== null && size !== raw.length) continue
				renameFile(tmp, output)
				renamed = true
			}
			if (!renamed) {
				try {
					fs.rmSync(tmp, { force: true })
				} catch {
					/* 临时文件清不掉也不影响主流程 */
				}
				result.error = '写入失败：会话正在被写入，请稍后重试；原文件未被改动。'
				return result
			}
		} else {
			if (backup) {
				writeFile(backup, raw)
				result.backup = backup
			}
			writeFile(output, plan.output)
		}
		writeFile(audit, Buffer.from(`${JSON.stringify({
			file,
			mode,
			maskMode,
			appliedAt: new Date().toISOString(),
			minRun,
			marker: typeof marker === 'function' ? '[function]' : marker,
			masked: plan.masked,
			symbols: plan.symbols,
			toolCallsKept: plan.toolCallsKept,
			segments: plan.hits,
		}, null, 2)}\n`, 'utf8'))
		result.applied = true
	} catch (err) {
		result.error = `写入失败：${err.message}`
		return result
	}
	// 回读复核：把**写出去的文件**解回来，数一数还剩多少游程。
	// 注意是「数文件里的残留」，不能再走一遍遮蔽（那样永远是 0，等于没复核）。
	// 回读失败时退回内存里的产物复核（注入式 readFile 看不到 writeFile 的写入时属正常）。
	try {
		let verifyBuf
		try {
			verifyBuf = readFile(output)
		} catch {
			verifyBuf = plan.output
		}
		result.remaining = countResidualRuns(verifyBuf, { minRun, chars, unitRun, unitRepeats })
		// 残留必须报错：否则界面显示「成功」，实际污染还在文件里。
		if (result.remaining > 0) result.error = `复核未通过：仍有 ${result.remaining} 段退化游程`
	} catch (err) {
		result.error = `复核失败：${err.message}`
	}
	return result
}

/**
 * 扫描存档里**可遮蔽事件**中某个字面量的出现位置。
 *
 * 只看模型自己产出的事件（assistant / assistantmessage / compactionsummary）：
 * 用户提问、系统提示、工具结果里的同名字面量不算数——回退只该改模型产物。
 *
 * @param {string} text - 解码后的会话文本
 * @param {string} needle - 要找的字面量
 * @returns {Array<object>} 命中列表（按文档顺序）
 */
function findLiteralHits(text, needle) {
	const hits = []
	if (typeof needle !== 'string' || needle.length === 0) return hits
	const lines = splitLines(text)
	let event = 0
	for (const line of lines) {
		if (line.text === '') continue
		let parsed = null
		try {
			parsed = JSON.parse(line.text)
		} catch {
			parsed = null
		}
		// 非模型产出的事件整行跳过（事件序号照常前进，与遮蔽分析的口径一致）。
		if (parsed && !isMaskableEvent(parsed?.type)) {
			event += 1
			continue
		}
		const tree = parseJsonTree(line.text)
		const ctx = { strings: [], toolCalls: 0 }
		walkTree(tree, '', ctx)
		for (const item of ctx.strings) {
			const node = item.node
			let idx = node.value.indexOf(needle)
			while (idx >= 0) {
				const first = node.spans[idx]
				const last = node.spans[idx + needle.length - 1]
				if (first && last) {
					const rawStart = node.contentStart + first[0]
					const rawEnd = node.contentStart + last[1]
					hits.push({
						event,
						lineIndex: line.index,
						path: item.path,
						start: rawStart,
						end: rawEnd,
						offset: line.start + rawStart,
						text: needle,
						contextBefore: node.value.slice(Math.max(0, idx - PREVIEW_CONTEXT_CHARS), idx),
						contextAfter: node.value.slice(idx + needle.length, idx + needle.length + PREVIEW_CONTEXT_CHARS),
						context: `${node.value.slice(Math.max(0, idx - PREVIEW_CONTEXT_CHARS), idx)}【${needle}】${node.value.slice(idx + needle.length, idx + needle.length + PREVIEW_CONTEXT_CHARS)}`,
					})
				}
				idx = node.value.indexOf(needle, idx + needle.length)
			}
		}
		event += 1
	}
	return hits
}

/**
 * 在会话存档里定位字面量（折叠标记）的位置。
 *
 * 用途：判定日志里记的是「第几次折叠、折叠了哪一段」，但日志本身不知道
 * 这段话落在存档的哪个事件、哪个字段。这里把两者对上号，界面上才能
 * 给出上下文片段，并支持「回退这一条」。
 *
 * @param {object} options - 选项
 * @param {string} options.file - 会话文件路径（必填）
 * @param {string} options.marker - 要定位的字面量（必填）
 * @param {string[]} [options.roots] - 允许的会话根目录（默认 `~/.dsh/sessions`）
 * @param {(path: string) => Buffer} [options.readFile] - 可注入的读取函数
 * @returns {{ok: boolean, file: string, hits: object[], error?: string}} 定位结果
 */
export function locateMarkers(options = {}) {
	const file = typeof options.file === 'string' ? options.file : ''
	const marker = typeof options.marker === 'string' ? options.marker : ''
	const readFile = typeof options.readFile === 'function' ? options.readFile : fs.readFileSync
	const roots = Array.isArray(options.roots) && options.roots.length > 0 ? options.roots : [defaultSessionRoot()]
	const result = { ok: false, file, hits: [] }
	if (!file) {
		result.error = '缺少 file 参数'
		return result
	}
	if (!marker) {
		result.error = '缺少 marker 参数'
		return result
	}
	if (!isInsideRoots(file, roots)) {
		result.error = '文件不在允许的会话根目录之内，已跳过。'
		return result
	}
	if (isSymlinked(file)) {
		result.error = '目标是符号链接，不予处理。'
		return result
	}
	let raw
	try {
		raw = readFile(file)
	} catch (err) {
		result.error = `读取失败：${err.message}`
		return result
	}
	try {
		const { text } = decodeSession(raw)
		result.hits = findLiteralHits(text, marker)
		result.ok = true
	} catch (err) {
		result.error = `解析失败：${err.message}`
	}
	return result
}

/**
 * 回退一次净化：把存档里第 N 处字面量换回原文。
 *
 * 与遮蔽互为逆操作：遮蔽把一段退化折叠成标记，回退把标记还原成那一段文字。
 * 只改模型自己产出的事件，用户提问与工具结果原样保留。
 *
 * @param {object} options - 选项
 * @param {string} options.file - 会话文件路径（必填）
 * @param {string} options.from - 要被替换的字面量（折叠标记，必填）
 * @param {string} options.to - 换回的原文（必填）
 * @param {number} [options.hitIndex] - 命中序号（第几处，从 0 开始，默认 0）
 * @param {boolean} [options.apply] - 是否真正落盘（默认 false = 只算不改）
 * @param {string[]} [options.roots] - 允许的会话根目录（默认 `~/.dsh/sessions`）
 * @param {string} [options.backupFile] - 备份路径（默认写到插件目录）
 * @param {string} [options.auditFile] - 审计旁车路径（默认与输出同名 `.revert-audit.json`）
 * @param {(path: string) => Buffer} [options.readFile] - 可注入的读取函数
 * @param {(path: string, data: Buffer) => void} [options.writeFile] - 可注入的写入函数
 * @param {(from: string, to: string) => void} [options.rename] - 可注入的重命名函数
 * @param {(path: string) => {size: number}} [options.stat] - 可注入的文件状态查询
 * @param {(path: string) => boolean} [options.existsFile] - 可注入的存在性判断
 * @returns {{applied: boolean, restored: boolean, file: string, output?: string, backup?: string,
 *            audit?: string, hit?: object, remaining?: number, error?: string,
 *            problem?: {row: number | null, reason: string},
 *            problems?: Array<{row: number | null, reason: string}>,
 *            sourceProblem?: {row: number | null, reason: string},
 *            sourceProblems?: Array<{row: number | null, reason: string}>}} 结果
 */
export function restoreSessionText(options = {}) {
	const file = typeof options.file === 'string' ? options.file : ''
	const from = typeof options.from === 'string' ? options.from : ''
	const to = typeof options.to === 'string' ? options.to : ''
	const hitIndex = Number.isInteger(options.hitIndex) && options.hitIndex >= 0 ? options.hitIndex : 0
	const apply = options.apply === true
	const readFile = typeof options.readFile === 'function' ? options.readFile : fs.readFileSync
	const writeFile = typeof options.writeFile === 'function' ? options.writeFile : fs.writeFileSync
	const renameFile = typeof options.rename === 'function' ? options.rename : fs.renameSync
	const statFile = typeof options.stat === 'function' ? options.stat : fs.statSync
	const existsFile = typeof options.existsFile === 'function' ? options.existsFile : fs.existsSync
	const roots = Array.isArray(options.roots) && options.roots.length > 0 ? options.roots : [defaultSessionRoot()]
	const result = { applied: false, restored: false, file }
	if (!file) {
		result.error = '缺少 file 参数'
		return result
	}
	if (!from) {
		result.error = '缺少 from 参数'
		return result
	}
	// 与遮蔽同一套闸门：目标必须在会话根目录之内、且不是符号链接。
	if (!isInsideRoots(file, roots)) {
		result.error = '文件不在允许的会话根目录之内，已跳过。'
		return result
	}
	if (isSymlinked(file)) {
		result.error = '目标是符号链接，不予处理。'
		return result
	}
	let raw
	try {
		raw = readFile(file)
	} catch (err) {
		result.error = `读取失败：${err.message}`
		return result
	}
	let decoded
	try {
		decoded = decodeSession(raw)
	} catch (err) {
		result.error = `解析失败：${err.message}`
		return result
	}
	const hits = findLiteralHits(decoded.text, from)
	const hit = hits[hitIndex]
	if (!hit) {
		result.error = hits.length === 0
			? '存档里已经找不到这段标记了（可能已回退或会话已重写）。'
			: `存档里只找到 ${hits.length} 处标记，第 ${hitIndex + 1} 处不存在。`
		result.remaining = hits.length
		return result
	}
	result.hit = hit
	// 原文按 JSON 字符串转义后写回：原文里的引号、反斜杠、换行都不能破坏这一行 JSON。
	const escaped = JSON.stringify(to).slice(1, -1)
	const lines = splitLines(decoded.text)
	const target = lines[hit.lineIndex]
	const newLine = `${target.text.slice(0, hit.start)}${escaped}${target.text.slice(hit.end)}`
	const newText = lines.map((line) => (line.index === hit.lineIndex ? newLine : line.text)).join('\n')
	const edits = [{ start: target.start + hit.start, end: target.start + hit.end, newLen: escaped.length }]
	let output = null
	try {
		output = isZstd(raw) ? encodeFrames(raw, decoded.text, newText, edits) : Buffer.from(newText, 'utf8')
	} catch (err) {
		result.error = err?.code === ZSTD_ERROR_CODE ? `压缩失败：${err.message}` : `生成失败：${err.message}`
		return result
	}
	result.output = file
	result.remaining = hits.length - 1
	if (!apply) return result
	// 源存档不合格 → 拒绝动它：原文件必须一个字节都不变。
	if (!checkSource(result, raw)) return result
	// 产物也要验一遍：宁可不动，也不要写出一份宿主读不了的存档。
	if (!checkOutput(result, output)) return result
	const audit = options.auditFile || defaultRevertAuditPath(file)
	const backupTarget = options.backupFile || pickBackupPath(file, existsFile)
	if (!isAllowedMaskTarget(file, roots)) {
		result.error = '目标路径不在允许的范围内，已跳过。'
		return result
	}
	if (!isAllowedMaskTarget(audit, roots)) {
		result.error = '审计路径不在允许的范围内，已跳过。'
		return result
	}
	if (!isAllowedMaskTarget(backupTarget, roots)) {
		result.error = '备份路径不在允许的范围内，已跳过。'
		return result
	}
	const usingDefaultWriter = typeof options.writeFile !== 'function'
	/**
	 * 取文件当前字节数；取不到就返回 null（不检查，不拦）。
	 * @param {string} p - 路径
	 * @returns {number | null} 字节数
	 */
	const sizeOfFile = (p) => {
		try {
			return statFile(p).size
		} catch {
			return null
		}
	}
	try {
		if (usingDefaultWriter) {
			ensureDir(path.dirname(audit))
			ensureDir(path.dirname(backupTarget))
		}
		writeFile(backupTarget, raw)
		result.backup = backupTarget
		// 原子替换：先写同目录临时文件，再改名盖掉原文件。
		const tmp = `${file}.guard-degen-revert-tmp`
		if (!isAllowedMaskTarget(tmp, roots)) {
			result.error = '临时路径不在允许的范围内，已跳过。'
			return result
		}
		let renamed = false
		for (let attempt = 0; attempt < 3 && !renamed; attempt += 1) {
			// 会话是活的：落盘前确认这期间没人又往里追加。
			let grown = null
			try {
				grown = readFile(file)
			} catch {
				grown = null
			}
			if (grown && !grown.equals(raw)) {
				// 有人追加了内容：放弃这次回退，别把新写入的消息抹掉。
				result.error = '会话正在被写入，请稍后重试；原文件未被改动。'
				return result
			}
			writeFile(tmp, output)
			const size = sizeOfFile(file)
			if (size !== null && size !== raw.length) continue
			renameFile(tmp, file)
			renamed = true
		}
		if (!renamed) {
			try {
				fs.rmSync(tmp, { force: true })
			} catch {
				/* 临时文件清不掉也不影响主流程 */
			}
			result.error = '写入失败：会话正在被写入，请稍后重试；原文件未被改动。'
			return result
		}
		writeFile(audit, Buffer.from(`${JSON.stringify({
			file,
			appliedAt: new Date().toISOString(),
			from,
			hitIndex,
			event: hit.event,
			path: hit.path,
			offset: hit.offset,
		}, null, 2)}\n`, 'utf8'))
		result.audit = audit
		result.applied = true
		result.restored = true
	} catch (err) {
		result.error = `写入失败：${err.message}`
		return result
	}
	// 回读复核：写出去的文件里，这一处标记应该已经不见了。
	try {
		let verifyBuf
		try {
			verifyBuf = readFile(file)
		} catch {
			verifyBuf = output
		}
		const verifyText = decodeSession(verifyBuf).text
		result.remaining = findLiteralHits(verifyText, from).length
		if (result.remaining !== hits.length - 1) {
			result.error = `复核未通过：仍有 ${result.remaining} 处标记（预期 ${hits.length - 1} 处）`
			result.applied = false
			result.restored = false
		}
	} catch (err) {
		result.error = `复核失败：${err.message}`
		result.applied = false
		result.restored = false
	}
	return result
}
