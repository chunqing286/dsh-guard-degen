/**
 * 重试策略测试 —— T5（B3 复发感知 + 换模型重试）。
 *
 * 宿主契约：`agent/request-error` 水位的返回值里 `kind !== 'retry'` 就直接抛 LlmError；
 * 返回 `{kind:'retry'}` 则用**同一个**模型重来一轮（dsh-agent-loop/lib/index.js:1130-1147）。
 * 换模型只能靠 `agent/request` 水位改写 provider/model —— 宿主不读 retry 动作里的模型字段。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { DEGENERATION_FAILURE_CODE, RetryController } from '../lib/retry.js'

/** 造一个退化失败负载。 */
function degenPayload(code = DEGENERATION_FAILURE_CODE) {
	return { turn: 1, step: 2, provider: 'minimax-cn', failure: { message: '退化', code } }
}

test('非退化错误不重试', () => {
	const controller = new RetryController({ maxSameModelRetries: 2 })
	const action = controller.decide({ ...degenPayload('RATE_LIMIT') }, { sessionId: 's1', agentId: 'a1' })
	assert.equal(action, undefined)
})

test('没有记录过退化就不重试（不认识的失败码）', () => {
	const controller = new RetryController({ maxSameModelRetries: 2 })
	const action = controller.decide({ failure: { message: 'x', code: 'UNKNOWN' } }, { sessionId: 's1', agentId: 'a1' })
	assert.equal(action, undefined)
})

test('同模型重试在额度内放行', () => {
	const controller = new RetryController({ maxSameModelRetries: 2 })
	const action = controller.decide(degenPayload(), { sessionId: 's1', agentId: 'a1' })
	assert.equal(action.kind, 'retry')
	assert.equal(action.action, 'same-model')
})

test('同模型重试超限后交还控制权', () => {
	const controller = new RetryController({ maxSameModelRetries: 2 })
	const ctx = { sessionId: 's1', agentId: 'a1' }
	controller.decide(degenPayload(), ctx)
	controller.decide(degenPayload(), ctx)
	const third = controller.decide(degenPayload(), ctx)
	assert.equal(third, undefined)
})

test('换模型开关打开：超限后改为换模型重试', () => {
	const controller = new RetryController({
		maxSameModelRetries: 1,
		switchModel: { enabled: true, provider: 'deepseek', model: 'deepseek-chat' },
	})
	const ctx = { sessionId: 's1', agentId: 'a1' }
	const first = controller.decide(degenPayload(), ctx)
	assert.equal(first.action, 'same-model')
	const second = controller.decide(degenPayload(), ctx)
	assert.equal(second.kind, 'retry')
	assert.equal(second.action, 'switch-model')
	assert.equal(second.provider, 'deepseek')
	assert.equal(second.model, 'deepseek-chat')
})

test('换模型开关关闭：超限后不重试', () => {
	const controller = new RetryController({ maxSameModelRetries: 1 })
	const ctx = { sessionId: 's1', agentId: 'a1' }
	controller.decide(degenPayload(), ctx)
	assert.equal(controller.decide(degenPayload(), ctx), undefined)
})

test('换模型最多切一次', () => {
	const controller = new RetryController({
		maxSameModelRetries: 1,
		switchModel: { enabled: true, provider: 'deepseek', model: 'deepseek-chat' },
	})
	const ctx = { sessionId: 's1', agentId: 'a1' }
	controller.decide(degenPayload(), ctx)
	controller.decide(degenPayload(), ctx)
	const third = controller.decide(degenPayload(), ctx)
	assert.equal(third, undefined, '切过一次之后不该再重试')
})

test('复发感知：同一模型同一规则重复命中后不再同模型重试', () => {
	const controller = new RetryController({ maxSameModelRetries: 3, recurrenceLimit: 2 })
	const ctx = { sessionId: 's1', agentId: 'a1' }
	controller.noteDegeneration({ ...ctx, model: 'MiniMax-M3.1-Flash', rule: 'symbol-run' })
	// 第一次命中：复发计数 1，未到上限，可以重试
	assert.equal(controller.decide(degenPayload(), ctx)?.action, 'same-model')
	// 同一模型同一规则再次命中：复发计数达到上限，不再同模型重试
	controller.noteDegeneration({ ...ctx, model: 'MiniMax-M3.1-Flash', rule: 'symbol-run' })
	assert.equal(controller.decide(degenPayload(), ctx), undefined)
})

test('复发计数按模型隔离', () => {
	const controller = new RetryController({ maxSameModelRetries: 3, recurrenceLimit: 2 })
	const ctx = { sessionId: 's1', agentId: 'a1' }
	controller.noteDegeneration({ ...ctx, model: 'MiniMax-M3.1-Flash', rule: 'symbol-run' })
	controller.noteDegeneration({ ...ctx, model: 'MiniMax-M3.1-Flash', rule: 'symbol-run' })
	// 换个模型，退化率不该继承
	controller.noteDegeneration({ ...ctx, model: 'deepseek-chat', rule: 'symbol-run' })
	assert.equal(controller.decide(degenPayload(), ctx)?.action, 'same-model')
})

test('复发计数按会话隔离', () => {
	const controller = new RetryController({ maxSameModelRetries: 3, recurrenceLimit: 2 })
	controller.noteDegeneration({ sessionId: 's1', agentId: 'a1', model: 'm', rule: 'symbol-run' })
	controller.noteDegeneration({ sessionId: 's1', agentId: 'a1', model: 'm', rule: 'symbol-run' })
	const other = controller.decide(degenPayload(), { sessionId: 's2', agentId: 'a1' })
	assert.equal(other?.action, 'same-model')
})

test('模型覆盖只生效一次', () => {
	const controller = new RetryController({
		maxSameModelRetries: 1,
		switchModel: { enabled: true, provider: 'deepseek', model: 'deepseek-chat' },
	})
	const ctx = { sessionId: 's1', agentId: 'a1' }
	controller.decide(degenPayload(), ctx)
	controller.decide(degenPayload(), ctx)
	assert.deepEqual(controller.takePendingModelOverride(ctx), { provider: 'deepseek', model: 'deepseek-chat' })
	assert.equal(controller.takePendingModelOverride(ctx), undefined)
})

test('重试动作带上失败码，便于上层记录', () => {
	const controller = new RetryController({ maxSameModelRetries: 1 })
	const action = controller.decide(degenPayload(), { sessionId: 's1', agentId: 'a1' })
	assert.equal(action.failureCode, DEGENERATION_FAILURE_CODE)
	assert.equal(action.retry, 1)
})
