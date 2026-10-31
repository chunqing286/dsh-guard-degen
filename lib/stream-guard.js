/**
 * 流式守卫 —— 在 `llm/stream` 这一层拦下退化的模型输出。
 *
 * ## 宿主契约（逐条核对自 dsh-llm / dsh-agent-loop 源码）
 *
 * 1. delta 文本在 `chunk.text`，类型是 `text-delta` / `reasoning-delta`；
 * 2. `block-end` 的 `block.text` 是**权威值**：`BlockAssembler.assemble()` 优先用它，
 *    只改 delta 不改 block-end 等于没截断（持久化的会话里仍会留下退化全文）；
 * 3. 结束必须是合法终止：`{type:'finish', reason:{kind:'error', failure:{message, code}}}`。
 *    安静地 `stop` 会留下打开的块，触发「finished with N open block(s)」；
 * 4. chunk 类型是封闭集合，`assertNever` 会对未知类型抛错 —— 本模块只产出既有类型；
 * 5. `finish.kind === 'error'` 时 agent-loop 直接抛 `LlmError`，**不会**执行任何工具调用，
 *    也不会把退化内容写进会话消息（只留 `assistant/attempt` 取证记录）。
 *
 * ## 滞留窗口（holdback）
 *
 * 为了能**改写**已经判定为退化的那一段尾巴，流里最多滞留 `holdback` 个字符。
 * 窗口必须覆盖「退化起点到判定时刻」的距离：符号游程在攒够 `minRun` 个符号时立刻判定，
 * 因此起点最多回溯 `minRun` 个符号（算上符号间空白约 `2 * minRun`）。
 * 窗口之外的旧内容照常实时流出，只滞后一个窗口的长度。
 *
 * ## 处置策略
 *
 * - `truncate`（reasoning 默认）：在退化起点切断整条流，补齐 block-end，给出 error finish，
 *   让 `agent/request-error` 有机会触发同模型重试；
 * - `sanitize`（text 默认）：把符号游程折叠成一句可读标记，流继续；
 * - `off`：完全不干预。
 *
 * @module lib/stream-guard
 */

import { DEFAULT_SYMBOLS, DegenerationDetector, collapseSymbolRuns, collapseUnitRuns, findUnitRuns, normalizeRules } from './detect.js'

/** 默认滞留窗口（字符）。 */
export const DEFAULT_HOLDBACK = 256

/** 默认终止失败码。 */
export const DEFAULT_FAILURE_CODE = 'DEGENERATION_DETECTED'

/** 单个块文本的上限（字符）。 */
export const DEFAULT_MAX_BLOCK_CHARS = 8 * 1024 * 1024

/**
 * 一段增量里最多连续处理几条裁决。
 *
 * 复审缺陷 F1：同一段增量里可能有多段符号游程，
 * 折叠第一段之后判定器会把游程之后的正文喂回去，
 * 于是同一段增量里的第二段游程也会被判定出来 —— 必须继续处理，不能丢。
 */
export const MAX_VERDICTS_PER_CHUNK = 16

/** 策略取值。 */
export const POLICIES = ['off', 'truncate', 'sanitize']

/** 空白字符判定。 */
const WHITESPACE = /\s/

/**
 * 判断字符是否属于符号集。
 * @param {string} char - 字符
 * @param {string} symbols - 符号集
 * @returns {boolean} 是否是符号
 */
function isSymbol(char, symbols) {
	return char !== undefined && symbols.includes(char)
}

/**
 * 流式守卫。
 */
export class StreamGuard {
	/**
	 * @param {object} [options] - 选项
	 * @param {'off'|'truncate'|'sanitize'} [options.reasoning] - reasoning 通道策略
	 * @param {'off'|'truncate'|'sanitize'} [options.text] - text 通道策略
	 * @param {Record<string, any>} [options.rules] - 规则配置
	 * @param {string} [options.symbols] - 符号集
	 * @param {number} [options.holdbackChars] - 滞留窗口
	 * @param {number} [options.windowChars] - 检测窗口
	 * @param {number} [options.maxInterventionsPerCall] - 单次调用最多干预几次（0 = 不限，默认 1）
	 * @param {boolean} [options.unitRun] - 是否治理「多字符单元重复」（默认 true）
	 * @param {number} [options.unitRepeats] - 「多字符单元重复」的份数阈值（默认取规则表里的 minRepeats）
	 * @param {(verdict: object, info: object) => void} [options.onVerdict] - 裁决回调
	 * @param {string} [options.failureCode] - 终止失败码
	 * @param {string} [options.model] - 模型名（写进裁决信息）
	 * @param {string} [options.provider] - 提供方
	 */
	constructor(options = {}) {
		this.options = options
		this.rules = normalizeRules(options.rules)
		// 「多字符单元治理」的本守卫开关：关掉就把 unit-run 规则整个停掉，
		// 判定器根本不会再报这条 —— 而不是报了再放过（那样日志里会留下一堆没被处理的命中）。
		this.unitRun = options.unitRun !== false
		if (!this.unitRun && this.rules['unit-run']) {
			this.rules['unit-run'] = { ...this.rules['unit-run'], on: false }
		}
		// 份数阈值：配置里给了一个值就覆盖规则表里的 minRepeats，
		// 让「流式守卫」的重复份数能单独调（工件、会话治理各自有一份）。
		const unitRepeats = Number(options.unitRepeats)
		if (this.unitRun && Number.isFinite(unitRepeats) && unitRepeats >= 2 && this.rules['unit-run']) {
			this.rules['unit-run'] = { ...this.rules['unit-run'], minRepeats: Math.floor(unitRepeats) }
		}
		this.symbols = options.symbols || DEFAULT_SYMBOLS
		this.holdback = Math.max(64, Number(options.holdbackChars) || DEFAULT_HOLDBACK)
		this.windowChars = Math.max(1024, Number(options.windowChars) || 4096)
		this.reasoningPolicy = POLICIES.includes(options.reasoning) ? options.reasoning : 'truncate'
		this.textPolicy = POLICIES.includes(options.text) ? options.text : 'sanitize'
		this.onVerdict = options.onVerdict
		this.failureCode = options.failureCode || DEFAULT_FAILURE_CODE
		this.model = options.model
		this.provider = options.provider
		this.cut = false
		this.states = null
		/** 单次调用的干预上限（0 = 不限）。 */
		this.maxInterventions = Math.max(0, Number(options.maxInterventionsPerCall ?? 1))
		/** 本次调用已经干预的次数。 */
		this.interventions = 0
		/** 全局滞留队列（保持跨通道的原始先后顺序）。 */
		this.pending = []
		this.pendingLen = 0
		/**
		 * 打开的块登记表（按 index）。
		 *
		 * 复审缺陷 F6/F7：宿主 assembler 以 **index 为键**维护分块，
		 * 同一时刻可能有多个块打开（两个 text 块、或一个 text + 一个 tool-call）。
		 * 只记「每通道一个当前块」会漏掉先结束的那个块 ——
		 * 它的 block-end 被原样放行，原始符号直接进权威文本。
		 */
		this.blocks = new Map()
		/** 单个块文本的上限（字符）—— 复审缺陷 S4 的护栏。 */
		this.maxBlockChars = Math.max(256, Number(options.maxBlockChars) || DEFAULT_MAX_BLOCK_CHARS)
	}

	/**
	 * 新建一个通道状态。
	 * @param {string} channel - 通道名
	 * @param {'off'|'truncate'|'sanitize'} policy - 策略
	 * @returns {object} 通道状态
	 */
	newState(channel, policy) {
		return {
			channel,
			policy,
			detector: new DegenerationDetector({
				channel,
				rules: this.rules,
				symbols: this.symbols,
				windowChars: this.windowChars,
			}),
			offset: 0,
			suppress: false,
			runSymbols: 0,
			marker: null,
		}
	}

	/**
	 * 守卫入口。
	 * @param {AsyncIterable<object>} upstream - 上游流
	 * @returns {AsyncGenerator<object>} 守卫后的流
	 */
	async *run(upstream) {
		// 复审缺陷 F8：每次 run 都从干净状态开始。
		// 上一次调用留下的 cut / interventions / pending 会让第二次调用
		// 只吐出第一个 chunk 就停掉（守卫实例被复用时）。
		this.cut = false
		this.interventions = 0
		this.pending = []
		this.pendingLen = 0
		this.blocks.clear()
		this.states = {
			reasoning: this.newState('reasoning', this.reasoningPolicy),
			text: this.newState('text', this.textPolicy),
		}
		const states = this.states
		for await (const chunk of upstream) {
			for (const out of this.handleChunk(chunk, states)) yield out
			if (this.cut) return
		}
		for (const out of this.releaseAll()) yield out
	}

	/**
	 * 处理一个上游 chunk。
	 * @param {object} chunk - 上游 chunk
	 * @param {Record<string, object>} states - 通道状态
	 * @returns {object[]} 产出 chunk
	 */
	handleChunk(chunk, states) {
		const out = []
		switch (chunk?.type) {
			case 'text-delta':
			case 'reasoning-delta': {
				const channel = chunk.type === 'text-delta' ? 'text' : 'reasoning'
				const state = states[channel]
				const block = this.blocks.get(chunk.index)
				if (state.policy === 'off') {
					// 策略关闭：原样透传。但仍然要记下块文本 ——
					// 复审缺陷 F6：切断时要补 block-end，权威文本不能因为
					// 守卫没管这个通道就丢了（宿主 assembler 用 block-end 覆盖 delta 累加结果）。
					if (block) block.text += chunk.text ?? ''
					out.push(chunk)
					break
				}
				let text = chunk.text ?? ''
				if (state.suppress) {
					const filtered = this.filterSuppressed(text)
					text = filtered.kept
					state.runSymbols += filtered.symbols
					if (filtered.ended) {
						this.finalizeMarker(state)
						state.suppress = false
						state.runSymbols = 0
					}
				}
				if (text.length > 0) {
					state.offset += text.length
					if (block) {
						block.text += text
						// 复审缺陷 S4：当前块的文本必须有上限。
						// 退化模型能吐几兆字符，没有上限的话这里会一直涨。
						if (block.text.length > this.maxBlockChars) {
							block.text = block.text.slice(0, this.maxBlockChars)
							block.truncated = true
						}
					}
					this.pending.push({
						kind: 'chunk',
						chunk,
						text,
						channel,
						index: chunk.index,
					})
					this.pendingLen += text.length
					// 复审缺陷 F1：同一段增量里可能有多段游程，
					// 必须按时间顺序一段一段处理 —— 只处理最后一段的话，
					// 前面那段既没被折叠也没被切断，原始符号直接进宿主。
					let verdict = state.detector.feed(text)
					let rounds = 0
					while (verdict && rounds < MAX_VERDICTS_PER_CHUNK) {
						const action = this.applyVerdict(state, verdict, states, out)
						if (action.cut) {
							this.cut = true
							return out
						}
						verdict = action.next ?? null
						rounds += 1
					}
				}
				for (const released of this.release()) out.push(released)
				break
			}
			case 'tool-call-delta': {
				// 复审缺陷 F6：tool-call 块也要登记 ——
				// 切断时补的 block-end 必须带上完整的工具参数，
				// 否则宿主 assembler 会把工具调用装配成空参数。
				const block = this.blocks.get(chunk.index)
				if (block) {
					if (chunk.id) block.toolCallId = chunk.id
					if (chunk.name) block.toolCallName = chunk.name
					block.toolCallArguments += chunk.argumentsDelta ?? ''
				}
				out.push(chunk)
				break
			}
			case 'block-start': {
				const channel = chunk.blockType === 'reasoning' ? 'reasoning' : chunk.blockType === 'text' ? 'text' : null
				const state = channel ? states[channel] : null
				this.blocks.set(chunk.index, {
					index: chunk.index,
					blockType: chunk.blockType,
					channel,
					text: '',
					start: state ? state.offset : 0,
					toolCallId: '',
					toolCallName: '',
					toolCallArguments: '',
				})
				out.push(chunk)
				break
			}
			case 'block-end': {
				const channel = chunk.block?.type === 'reasoning' ? 'reasoning' : chunk.block?.type === 'text' ? 'text' : null
				let rewritten = chunk
				const block = this.blocks.get(chunk.index)
				if (channel && states[channel].policy !== 'off') {
					const state = states[channel]
					// 复审缺陷 S3：块结束前先做收尾判定 ——
					// 判定器只在窗口里看内容，不 flush 的话这一块最后不足窗口长度的尾巴永远不算数。
					let verdict = state.detector.flush()
					let rounds = 0
					while (verdict && rounds < MAX_VERDICTS_PER_CHUNK) {
						const action = this.applyVerdict(state, verdict, states, out)
						if (action.cut) {
							this.cut = true
							return out
						}
						verdict = action.next ?? null
						rounds += 1
					}
					// 复审缺陷 F3：块在这里结束，游程也就在这里结束 ——
					// 标记的计数必须在这里结算，否则存档里写的是初始计数（少算）。
					this.finalizeMarker(state)
					// 该块结束前，先把本通道滞留的内容放出去，保证 block-end 是这块的最后一个 chunk
					for (const released of this.releaseChannel(channel)) out.push(released)
					if (block) {
						rewritten = { ...chunk, block: { ...chunk.block, text: block.text } }
					} else {
						// 复审缺陷 F7：匹配不上的 block-end 不能原样放行 ——
						// 宿主 assembler 用 block-end 覆盖 delta 累加结果，
						// 原样放行等于把原始符号写进权威文本（等于没截断）。
						rewritten = { ...chunk, block: { ...chunk.block, text: this.sanitizeText(chunk.block?.text ?? '') } }
					}
				} else if (channel) {
					// 策略关闭的通道：delta 已经原样透传，block-end 也原样透传。
					// 这里仍然用登记的文本覆盖，保证与 delta 累加结果一致。
					if (block) rewritten = { ...chunk, block: { ...chunk.block, text: block.text } }
				} else {
					rewritten = { ...chunk, block: { ...chunk.block, ...this.closeToolCall(block) } }
				}
				this.blocks.delete(chunk.index)
				out.push(rewritten)
				break
			}
			case 'finish': {
				// 同样要收尾判定：有些流没有 block-end（或最后一个块在 finish 之前就到了）。
				for (const channel of ['reasoning', 'text']) {
					const state = states[channel]
					if (!state || state.policy === 'off') continue
					let verdict = state.detector.flush()
					let rounds = 0
					while (verdict && rounds < MAX_VERDICTS_PER_CHUNK) {
						const action = this.applyVerdict(state, verdict, states, out)
						if (action.cut) {
							this.cut = true
							return out
						}
						verdict = action.next ?? null
						rounds += 1
					}
					// 复审缺陷 F3：流结束也要结算标记计数。
					this.finalizeMarker(state)
				}
				for (const released of this.releaseAll()) out.push(released)
				out.push(chunk)
				break
			}
			default:
				out.push(chunk)
				break
		}
		return out
	}

	/**
	 * 处置一条裁决。
	 * @param {object} state - 通道状态
	 * @param {object} verdict - 裁决
	 * @param {Record<string, object>} states - 通道状态
	 * @param {object[]} out - 产出收集器
	 * @returns {{cut: boolean, next: object|null}} 处置结果（next 是同一段增量里的下一条裁决）
	 */
	applyVerdict(state, verdict, states, out) {
		if (this.maxInterventions > 0 && this.interventions >= this.maxInterventions) {
			// 已达单次调用的干预上限：不再改写内容。
			// 复审缺陷 N2：但「不再改写」不等于「放行退化」——
			// 原样放行会让原始符号直接落进会话（这正是插件要拦的事）。
			// 上限的作用是限制**改写次数**（防止反复改写打转），
			// 所以这里改成截断：退化内容不落到会话，由重试策略接手。
			this.report(verdict, 'truncate', state)
			this.cutStream(state, verdict, states, out)
			return { cut: true, next: null }
		}
		const canCollapse = state.policy === 'sanitize' && (verdict.rule === 'symbol-run' || verdict.rule === 'unit-run')
		if (canCollapse) {
			const collapsed = this.collapseRun(state, verdict)
			if (collapsed.ok) {
				this.interventions += 1
				// 把折叠现场一并上报：标记与原文都带上，
				// 界面上才能给出「改前/改后」对照，回退时也才有原文可写回去。
				this.report(verdict, 'sanitize', state, {
					marker: collapsed.marker,
					original: collapsed.original,
				})
				return { cut: false, next: collapsed.next }
			}
		}
		this.interventions += 1
		this.report(verdict, 'truncate', state)
		this.cutStream(state, verdict, states, out)
		return { cut: true, next: null }
	}

	/**
	 * 上报裁决。
	 * @param {object} verdict - 裁决
	 * @param {string} action - 处置动作
	 * @param {object} state - 通道状态
	 * @param {object} [extra] - 附加信息（折叠标记与原文）
	 */
	report(verdict, action, state, extra) {
		if (typeof this.onVerdict !== 'function') return
		try {
			this.onVerdict(verdict, {
				channel: state.channel,
				action,
				model: this.model,
				provider: this.provider,
				offset: state.offset,
				...(extra ?? {}),
			})
		} catch {
			// 取证回调失败不能影响主流程
		}
	}

	/**
	 * 折叠一段符号游程（净化通道）。
	 * @param {object} state - 通道状态
	 * @param {object} verdict - 裁决
	 * @returns {{ok: boolean, next: object|null, marker?: string, original?: string}} 折叠结果
	 */
	collapseRun(state, verdict) {
		const slots = []
		for (let i = 0; i < this.pending.length; i += 1) {
			if (this.pending[i].channel === state.channel) slots.push(i)
		}
		const entries = slots.map((i) => this.pending[i])
		const pendingText = entries.map((entry) => entry.text).join('')
		const pendingStart = state.offset - pendingText.length
		// 复审缺陷 D1：游程的起点已经在滞留窗口之外——前半段在更早的时候就已经流出去了，
		// 收不回来。这时候折叠只会清掉后半段，标记里的计数也会少算前半段，
		// 等于发一个「只清了一半」的标记出去。与其这样，不如整段截断，让重试策略接手。
		if (verdict.onset < pendingStart) return { ok: false, next: null }
		const start = verdict.onset - pendingStart
		if (start >= pendingText.length) return { ok: false, next: null }
		// 两种退化形态，两套折叠口径：
		// - symbol-run：一个符号连成一片 → 标记写「多少个符号」；
		// - unit-run：一个多字符单元反复出现 → 标记写「重复了几份」。
		const span = verdict.rule === 'unit-run'
			? this.unitRunSpan(pendingText, start, verdict)
			: this.symbolRunSpan(pendingText, start)
		if (!span) return { ok: false, next: null }
		const { end, markerText, count } = span
		// 复审缺陷 F1/F6/F7：游程可能横跨多个块 ——
		// 标记要放在**游程起点所在的那个块**里，权威文本按块分别改写。
		const host = this.blockHolding(state.channel, verdict.onset)
		const marker = {
			kind: 'marker',
			rule: verdict.rule,
			text: markerText,
			count,
			channel: state.channel,
			index: host?.index ?? 0,
			blockIndex: host?.index ?? -1,
			blockPos: -1,
		}
		// 重写该通道的滞留条目：挖掉游程、插入标记
		// 每个原条目对应一组替换（0/1/2 项），保证槽位与条目一一对应
		const groups = []
		let pos = 0
		let inserted = false
		for (const entry of entries) {
			const entryStart = pos
			const entryEnd = pos + entry.text.length
			pos = entryEnd
			if (entryEnd <= start || entryStart >= end) {
				groups.push([entry])
				continue
			}
			const group = []
			const head = entry.text.slice(0, Math.max(0, start - entryStart))
			const tail = entry.text.slice(Math.max(0, end - entryStart))
			if (head) group.push({ ...entry, text: head })
			if (!inserted) {
				group.push(marker)
				inserted = true
				state.marker = marker
			}
			if (tail) group.push({ ...entry, text: tail })
			groups.push(group)
		}
		const next = []
		let cursor = 0
		for (let i = 0; i < this.pending.length; i += 1) {
			if (slots.includes(i)) {
				next.push(...groups[cursor])
				cursor += 1
				continue
			}
			next.push(this.pending[i])
		}
		this.pending = next
		this.pendingLen = this.pending.reduce((sum, entry) => sum + entry.text.length, 0)
		// 有效长度：挖掉 (end-start)，插入 marker 长度
		state.offset = state.offset - (end - start) + markerText.length
		// 当前块的文本同步改写：前缀 + 标记 + 游程之后的正文
		//
		// 复审缺陷 S2：`end` 是 **pendingText 相对下标**，`block.start` 是**通道偏移**，
		// 两套坐标系不能直接相减 —— 游程结束位置要先换算回通道坐标。
		// 复审缺陷 F1/F6：游程可能横跨多个块，逐块改写；
		// 标记只插在**游程起点所在的那个块**里（插两次会出现两个标记）。
		const runStartCh = verdict.onset
		const runEndCh = pendingStart + end
		for (const block of this.blocks.values()) {
			if (block.channel !== state.channel) continue
			const blockStart = block.start
			const blockEnd = blockStart + block.text.length
			if (blockEnd <= runStartCh || blockStart >= runEndCh) continue
			const headLen = Math.max(0, Math.min(block.text.length, runStartCh - blockStart))
			const tailLen = Math.max(0, Math.min(block.text.length, blockEnd - runEndCh))
			const holdsOnset = blockStart <= runStartCh && runStartCh < blockEnd
			const insert = holdsOnset ? markerText : ''
			if (holdsOnset) marker.blockPos = headLen
			block.text = block.text.slice(0, headLen) + insert + block.text.slice(block.text.length - tailLen)
		}
		// 判定器同步：回退到游程起点，再喂入标记，保持索引空间一致
		state.detector.resetTo(verdict.onset)
		state.detector.feed(markerText)
		// 游程之后的正文要一并喂回去：判定器被回退到游程起点后，
		// 少了这段正文就会与通道的字符空间错位（后续游程的下标对不上）。
		// 复审缺陷 F1：这一段正文里可能还有**另一段**游程，
		// 它的裁决必须交回给调用方继续处理，不能丢。
		const tail = pendingText.slice(end)
		let nextVerdict = null
		if (tail) nextVerdict = state.detector.feed(tail)
		// 游程可能继续：进入抑制态。
		// 注意：已折叠的这批符号已经计入 marker.count，抑制期只累加**新增**的符号。
		//
		// 多字符单元重复**不进符号抑制态**：抑制器认的是「符号连成一片」，
		// 拿它去滤「⇒⇒§ ⇒⇒§ §」会把单元拆碎（只留下非符号的残片）。
		// 单元重复的续写交给判定器：它会把它当成**新的一段**再判一次。
		state.suppress = verdict.rule !== 'unit-run'
		state.runSymbols = 0
		return {
			ok: true,
			next: nextVerdict,
			// 折叠现场：标记（写进会话的样子）与原文（被折叠掉的那一段）。
			marker: markerText,
			original: pendingText.slice(start, end),
		}
	}

	/**
	 * 算出一段符号游程的折叠区间与标记。
	 * @param {string} text - 滞留文本
	 * @param {number} start - 游程起点（相对下标）
	 * @returns {{end: number, markerText: string, count: number}|null} 折叠区间
	 */
	symbolRunSpan(text, start) {
		const end = this.findRunEnd(text, start)
		if (end <= start) return null
		const symbols = [...text.slice(start, end)].filter((c) => isSymbol(c, this.symbols)).length
		return { end, count: symbols, markerText: `〔退化符号流×${symbols}〕` }
	}

	/**
	 * 算出一段多字符单元重复的折叠区间与标记。
	 *
	 * 只有**整段都在滞留窗口里**时才折叠：
	 * 判定器看的是检测窗口（比滞留窗口大），滞留窗口里往往只有这一段的后半截。
	 * 折一半等于发一个「只清了一半」的标记出去 —— 与其这样，不如整段截断。
	 *
	 * @param {string} text - 滞留文本
	 * @param {number} start - 重复段起点（相对下标）
	 * @param {object} verdict - 裁决（带判定器看到的份数）
	 * @returns {{end: number, markerText: string, count: number}|null} 折叠区间
	 */
	unitRunSpan(text, start, verdict) {
		const rule = this.rules['unit-run'] ?? {}
		const hits = findUnitRuns(text, {
			minRepeats: rule.minRepeats,
			minUnitChars: rule.minUnitChars,
			maxUnitChars: rule.maxUnitChars,
			minSpanChars: rule.minSpanChars,
			minDistinctChars: rule.minDistinctChars,
			requireExotic: rule.requireExotic,
			fromIndex: start,
		})
		const hit = hits.find((item) => item.start === start)
		if (!hit) return null
		// 判定器看到的份数比这里多 → 滞留窗口装不下整段 → 交给截断处理。
		const seen = Number(verdict?.detail?.repeats ?? 0)
		if (seen > 0 && hit.repeats < seen) return null
		return { end: hit.end, count: hit.repeats, markerText: `〔退化单元×${hit.repeats}〕` }
	}

	/**
	 * 找出某个通道上包含指定绝对偏移的块。
	 * @param {string} channel - 通道名
	 * @param {number} offset - 通道绝对偏移
	 * @returns {object|null} 块记录
	 */
	blockHolding(channel, offset) {
		for (const block of this.blocks.values()) {
			if (block.channel !== channel) continue
			if (block.start <= offset && offset < block.start + block.text.length) return block
		}
		return null
	}

	/**
	 * 把一段文本里的符号游程折叠成标记（用于兜底改写）。
	 * @param {string} text - 文本
	 * @returns {string} 改写后的文本
	 */
	sanitizeText(text) {
		if (typeof text !== 'string' || text.length === 0) return text ?? ''
		let out = text
		const symbolRule = this.rules['symbol-run']
		if (symbolRule && symbolRule.on !== false) {
			out = collapseSymbolRuns(out, {
				minRun: symbolRule.minRun,
				chars: this.symbols,
			}).text
		}
		// 多字符单元重复同样要收进兜底改写：
		// 兜底走的是「块结束时的权威文本」，delta 里的折叠不一定覆盖得到它。
		const unitRule = this.rules['unit-run']
		if (this.unitRun && unitRule && unitRule.on !== false) {
			out = collapseUnitRuns(out, {
				minRepeats: unitRule.minRepeats,
				minUnitChars: unitRule.minUnitChars,
				maxUnitChars: unitRule.maxUnitChars,
				minSpanChars: unitRule.minSpanChars,
				minDistinctChars: unitRule.minDistinctChars,
				requireExotic: unitRule.requireExotic,
			}).text
		}
		return out
	}

	/**
	 * 构造 tool-call 块的结束体（带上累积的工具参数）。
	 * @param {object|null} block - 块记录
	 * @returns {object} 结束体
	 */
	closeToolCall(block) {
		if (!block || block.blockType !== 'tool-call') return {}
		return {
			type: 'tool-call',
			id: block.toolCallId || `call-${block.index}`,
			name: block.toolCallName ?? '',
			arguments: block.toolCallArguments,
		}
	}

	/**
	 * 找出从 start 开始的符号游程结束位置。
	 * @param {string} text - 文本
	 * @param {number} start - 起点
	 * @returns {number} 结束位置（不含）
	 */
	findRunEnd(text, start) {
		let i = start
		let end = start
		while (i < text.length) {
			const char = text[i]
			if (isSymbol(char, this.symbols)) {
				i += 1
				end = i
				continue
			}
			if (WHITESPACE.test(char)) {
				let j = i
				while (j < text.length && WHITESPACE.test(text[j])) j += 1
				if (j < text.length && isSymbol(text[j], this.symbols)) {
					i = j
					continue
				}
			}
			break
		}
		return end
	}

	/**
	 * 过滤仍在延续的符号游程。
	 * @param {string} text - 增量文本
	 * @returns {{kept: string, symbols: number, ended: boolean}} 过滤结果
	 */
	filterSuppressed(text) {
		let i = 0
		let symbols = 0
		while (i < text.length) {
			const char = text[i]
			if (isSymbol(char, this.symbols)) {
				symbols += 1
				i += 1
				continue
			}
			if (WHITESPACE.test(char)) {
				let j = i
				while (j < text.length && WHITESPACE.test(text[j])) j += 1
				if (j < text.length && isSymbol(text[j], this.symbols)) {
					i = j
					continue
				}
				// 复审缺陷 N1：这一段只剩空白，后面可能接着符号。
				// 检测器的游程正则允许空白出现在游程内部（findSymbolRun 的 [ \t\r\n]*），
				// 所以这里不能判定「游程结束」——否则纯空白增量会把游程截成两段，
				// 后一段的原始符号就会漏进正文与 block-end。
				if (j >= text.length) {
					// 空白属于游程的一部分：抑制掉，游程继续。
					return { kept: '', symbols, ended: false }
				}
			}
			break
		}
		// 复审缺陷 S1：`ended` 不能写死。
		// 这一段全是符号 → 游程**可能继续**（下一段还是符号）→ 不能在这里结算标记；
		// 只有遇到非符号内容才算游程结束。
		return { kept: text.slice(i), symbols, ended: i < text.length }
	}

	/**
	 * 结算标记里的符号计数。
	 * @param {object} state - 通道状态
	 */
	finalizeMarker(state) {
		const marker = state.marker
		if (!marker) return
		// 多字符单元的标记本身就是定稿的（写的是「重复了几份」，
		// 跟符号游程的「多少个符号」不是一套计数），不需要结算。
		if (marker.rule === 'unit-run') {
			state.marker = null
			return
		}
		const total = marker.count + state.runSymbols
		const oldText = marker.text
		const newText = `〔退化符号流×${total}〕`
		marker.text = newText
		marker.count = total
		state.marker = null
		// 复审缺陷 D4：权威文本里还是旧的标记串（×30），delta 里却已经是新的（×60）。
		// 存档用的是权威文本（assembler 用 block-end 的 text 覆盖 delta 累加结果），
		// 两处不一致就等于存档里的计数是错的。
		//
		// 复审缺陷 F4：按字符串替换会落到**第一个**同名标记上 ——
		// 一次回答里出现两段同样长的游程时（两个 ×20），
		// 结算第二个标记的计数会写进第一个标记，两处计数互换。
		// 所以这里按**位置**改写：标记插入时记住了自己在块文本里的位置。
		const block = marker.blockIndex >= 0 ? this.blocks.get(marker.blockIndex) : null
		if (!block || !oldText) return
		const at = marker.blockPos
		if (at >= 0 && block.text.slice(at, at + oldText.length) === oldText) {
			block.text = block.text.slice(0, at) + newText + block.text.slice(at + oldText.length)
			return
		}
		// 位置对不上（块文本被裁剪过）：退回按内容替换**最后一次**出现。
		const last = block.text.lastIndexOf(oldText)
		if (last >= 0) {
			block.text = block.text.slice(0, last) + newText + block.text.slice(last + oldText.length)
		}
	}

	/**
	 * 切断整条流：释放内容、关闭块、给出合法终止。
	 * @param {object} state - 触发裁决的通道状态
	 * @param {object} verdict - 裁决
	 * @param {Record<string, object>} states - 通道状态
	 * @param {object[]} out - 产出收集器
	 */
	cutStream(state, verdict, states, out) {
		const cut = Math.max(this.channelPendingStart(state), Math.min(verdict.onset, state.offset))
		this.trimState(state, cut)
		for (const released of this.releaseAll()) out.push(released)
		// 关闭所有仍然打开的块。
		//
		// 复审缺陷 F6：不能只关「每通道一个当前块」——
		// 策略关闭的通道（reasoning='off'）根本不登记当前块，
		// tool-call 块也不属于任何文本通道，
		// 这两类块会留在打开状态，宿主会报「finished with N open block(s)」。
		for (const block of [...this.blocks.values()]) {
			const closed = block.blockType === 'tool-call'
				? { type: 'tool-call', ...this.closeToolCall(block) }
				: { type: block.blockType === 'reasoning' ? 'reasoning' : 'text', text: block.text }
			out.push({ type: 'block-end', index: block.index, block: closed })
		}
		this.blocks.clear()
		const message = `检测到模型输出退化（规则：${verdict.rule}，通道：${state.channel}），已截断并请求重试。`
		out.push({
			type: 'finish',
			reason: {
				kind: 'error',
				failure: { message, code: this.failureCode },
			},
		})
	}

	/**
	 * 某通道当前滞留内容的起始有效下标。
	 * @param {object} state - 通道状态
	 * @returns {number} 起始下标
	 */
	channelPendingStart(state) {
		let length = 0
		for (const entry of this.pending) {
			if (entry.channel === state.channel) length += entry.text.length
		}
		return state.offset - length
	}

	/**
	 * 把通道状态裁剪到某个有效长度。
	 * @param {object} state - 通道状态
	 * @param {number} cut - 目标有效长度
	 */
	trimState(state, cut) {
		// 复审缺陷 D2：`cut` 是**通道绝对偏移**，而下面条目的 pos 是**滞留窗口相对偏移**
		//（从 0 开始）。两套坐标直接相比，`entryEnd <= cut` 几乎恒真，
		// 退化条目会被当成「在截断点之前」而原样放行——原始符号直接进了 delta。
		const relCut = cut - this.channelPendingStart(state)
		const keep = []
		let pos = 0
		for (const entry of this.pending) {
			if (entry.channel !== state.channel) {
				keep.push(entry)
				continue
			}
			const entryStart = pos
			const entryEnd = pos + entry.text.length
			pos = entryEnd
			if (entryEnd <= relCut) {
				keep.push(entry)
				continue
			}
			if (entryStart >= relCut) continue
			const head = entry.text.slice(0, relCut - entryStart)
			if (head) keep.push({ ...entry, text: head })
		}
		this.pending = keep
		this.pendingLen = keep.reduce((sum, entry) => sum + entry.text.length, 0)
		state.offset = cut
		// 复审缺陷 F6：同一通道上可能有多个打开的块，逐块裁剪。
		// `block.start` 是块开始时的通道偏移，`cut - block.start`
		// 就是这个块在截断点之前应当保留的字符数。
		for (const block of this.blocks.values()) {
			if (block.channel !== state.channel) continue
			const limit = cut - block.start
			if (limit <= 0) block.text = ''
			else if (block.text.length > limit) block.text = block.text.slice(0, limit)
		}
	}

	/**
	 * 释放超出滞留窗口的内容。
	 * @returns {object[]} 释放的 chunk
	 */
	release() {
		const out = []
		while (this.pendingLen > this.holdback && this.pending.length > 1) {
			const entry = this.pending[0]
			// 复审缺陷 F5：计数还没结算的标记不能提前放出去 ——
			// 结算发生在游程结束的那一刻（收尾增量 / 块结束 / 流结束），
			// 提前放出去的话 delta 里是旧计数、权威 block-end 里是新计数，
			// 同一段退化在两处对不上。
			if (entry.kind === 'marker' && this.isProvisionalMarker(entry)) break
			this.pending.shift()
			this.pendingLen -= entry.text.length
			out.push(this.materialize(entry))
		}
		return out
	}

	/**
	 * 判断一个标记条目是否还在等待结算。
	 * @param {object} entry - 滞留条目
	 * @returns {boolean} 是否等待结算
	 */
	isProvisionalMarker(entry) {
		if (!entry || entry.kind !== 'marker') return false
		const state = this.states?.[entry.channel]
		return Boolean(state && state.marker === entry)
	}

	/**
	 * 释放某个通道的全部滞留内容。
	 * @param {string} channel - 通道名
	 * @returns {object[]} 释放的 chunk
	 */
	releaseChannel(channel) {
		const out = []
		const keep = []
		for (const entry of this.pending) {
			if (entry.channel !== channel) {
				keep.push(entry)
				continue
			}
			this.pendingLen -= entry.text.length
			out.push(this.materialize(entry))
		}
		this.pending = keep
		return out
	}

	/**
	 * 释放全部滞留内容。
	 * @returns {object[]} 释放的 chunk
	 */
	releaseAll() {
		const out = []
		while (this.pending.length > 0) {
			const entry = this.pending.shift()
			this.pendingLen -= entry.text.length
			out.push(this.materialize(entry))
		}
		return out
	}

	/**
	 * 把滞留条目还原成 chunk。
	 * @param {object} entry - 条目
	 * @returns {object} chunk
	 */
	materialize(entry) {
		if (entry.kind === 'marker') {
			return {
				type: entry.channel === 'reasoning' ? 'reasoning-delta' : 'text-delta',
				index: entry.index,
				text: entry.text,
			}
		}
		return { ...entry.chunk, text: entry.text }
	}
}

/**
 * 用守卫包裹一条流。
 * @param {AsyncIterable<object>} upstream - 上游流
 * @param {object} [options] - 选项（见 {@link StreamGuard}）
 * @returns {AsyncGenerator<object>} 守卫后的流
 */
export function guardStream(upstream, options = {}) {
	return new StreamGuard(options).run(upstream)
}
