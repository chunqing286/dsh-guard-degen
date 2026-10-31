/**
 * 复发感知重试 —— 在 `agent/request-error` 水位上决定要不要重来一轮。
 *
 * 宿主契约（dsh-agent-loop/lib/index.js:1130-1147）：
 * - 水位返回 `action?.kind !== 'retry'` → 直接抛 LlmError，轮次结束；
 * - 返回 `{kind:'retry'}` → 用**同一个**模型重来一轮。
 * 因此「换模型」不能靠 retry 动作里的字段（宿主不读），只能靠 `agent/request` 水位改写 provider/model。
 *
 * 设计依据（B3）：`repeat-output` 实测「降 effort 后 67% 复发」，且 7 次降档被服务端拒绝、
 * 其中 3 次直接把轮次打死 —— 盲目重试是有害的。所以这里：
 * - 同模型重试次数可配（默认 1 次）；
 * - 「模型 × 规则」复发计数：同一模型在同一会话里重复命中同一规则 → 不再同模型重试；
 * - 可选换模型重试（默认关闭，因为要额外计费且需要可用凭证）。
 *
 * @module lib/retry
 */

/** 流式守卫写出的退化失败码。 */
export const DEGENERATION_FAILURE_CODE = 'DEGENERATION_DETECTED'

/**
 * 构造重试控制器的键。
 * @param {{sessionId?: string, agentId?: string}} context - 上下文
 * @returns {string} 键
 */
export function retryKey(context) {
	return `${context?.sessionId ?? '-'}:${context?.agentId ?? '-'}`
}

/**
 * 复发感知重试控制器。
 */
export class RetryController {
	/**
	 * @param {object} [options] - 选项
	 * @param {number} [options.maxSameModelRetries] - 同模型重试上限（默认 1）
	 * @param {number} [options.recurrenceLimit] - 同一模型同一规则的复发上限（默认 2；达到后不再同模型重试）
	 * @param {{enabled?: boolean, provider?: string, model?: string}} [options.switchModel] - 换模型重试
	 * @param {string} [options.failureCode] - 认定的退化失败码
	 */
	constructor(options = {}) {
		this.maxSameModelRetries = Math.max(0, Number(options.maxSameModelRetries ?? 1))
		this.recurrenceLimit = Math.max(1, Number(options.recurrenceLimit ?? 2))
		this.switchModel = options.switchModel ?? { enabled: false }
		this.failureCode = options.failureCode ?? DEGENERATION_FAILURE_CODE
		/** 每个键的重试状态。 */
		this.states = new Map()
		/** 复发计数：键 → 模型 × 规则 → 次数。 */
		this.recurrences = new Map()
		/** 每个键最近一次退化的模型与规则。 */
		this.lastHit = new Map()
		/** 待生效的模型覆盖。 */
		this.pendingOverrides = new Map()
	}

	/**
	 * 记录一次退化命中（由流式守卫调用）。
	 * @param {{sessionId?: string, agentId?: string, model?: string, provider?: string, rule?: string}} info - 命中信息
	 */
	noteDegeneration(info) {
		const key = retryKey(info)
		let bucket = this.recurrences.get(key)
		if (!bucket) {
			bucket = new Map()
			this.recurrences.set(key, bucket)
		}
		const model = info?.model ?? info?.provider ?? 'unknown'
		const rule = info?.rule ?? 'unknown'
		const id = `${model}::${rule}`
		bucket.set(id, (bucket.get(id) ?? 0) + 1)
		this.lastHit.set(key, { model, rule })
	}

	/**
	 * 取出某个键的复发次数。
	 * @param {object} context - 上下文
	 * @param {string} model - 模型
	 * @param {string} rule - 规则
	 * @returns {number} 复发次数
	 */
	recurrenceCount(context, model, rule) {
		const bucket = this.recurrences.get(retryKey(context))
		if (!bucket) return 0
		return bucket.get(`${model}::${rule}`) ?? 0
	}

	/**
	 * 决策：要不要重来一轮。
	 * @param {{failure?: {code?: string, message?: string}, provider?: string}} payload - 水位负载
	 * @param {{sessionId?: string, agentId?: string}} context - 上下文
	 * @returns {{kind: 'retry', action: 'same-model'|'switch-model', provider?: string, model?: string, retry: number, failureCode: string} | undefined} 动作
	 */
	decide(payload, context) {
		const code = payload?.failure?.code
		if (code !== this.failureCode) return undefined
		const key = retryKey(context)
		const state = this.states.get(key) ?? { sameModel: 0, total: 0, switched: false }
		if (state.switched) return undefined
		if (state.sameModel < this.maxSameModelRetries) {
			// 复发感知：同一模型同一规则反复命中时，不再用同一模型重试。
			const hit = this.lastHit.get(key)
			if (hit && this.recurrenceCount(context, hit.model, hit.rule) >= this.recurrenceLimit) {
				this.states.set(key, state)
				return undefined
			}
			state.sameModel += 1
			state.total += 1
			this.states.set(key, state)
			return { kind: 'retry', action: 'same-model', retry: state.total, failureCode: code }
		}
		if (this.switchModel?.enabled === true && this.switchModel.provider && this.switchModel.model) {
			state.total += 1
			state.switched = true
			this.states.set(key, state)
			this.pendingOverrides.set(key, { provider: this.switchModel.provider, model: this.switchModel.model })
			return {
				kind: 'retry',
				action: 'switch-model',
				provider: this.switchModel.provider,
				model: this.switchModel.model,
				retry: state.total,
				failureCode: code,
			}
		}
		this.states.set(key, state)
		return undefined
	}

	/**
	 * 取出并消费待生效的模型覆盖。
	 * @param {{sessionId?: string, agentId?: string}} context - 上下文
	 * @returns {{provider: string, model: string} | undefined} 覆盖
	 */
	takePendingModelOverride(context) {
		const key = retryKey(context)
		const override = this.pendingOverrides.get(key)
		if (!override) return undefined
		this.pendingOverrides.delete(key)
		return override
	}

	/**
	 * 重置某个键的状态（会话结束或用户显式重置时调用）。
	 * @param {{sessionId?: string, agentId?: string}} context - 上下文
	 */
	reset(context) {
		const key = retryKey(context)
		this.states.delete(key)
		this.recurrences.delete(key)
		this.pendingOverrides.delete(key)
	}
}
