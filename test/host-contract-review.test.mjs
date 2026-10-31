/**
 * 宿主契约复核（复审第 6 轮）——把宿主契约的四个缺陷钉住。
 *
 * 覆盖：
 * - C1 浏览器半边的模块级 inject 不能依赖「只有自己 apply 才会创建」的命名空间
 *      （否则 cordis 把 fiber 置为 INACTIVE，apply 不执行，整个 Web 外壳起不来）；
 * - C2 agent/pre-step 的模型名在 `payload.agent.options.model`，不在 `payload.agent.model`；
 * - C3 agent/request-error 载荷里只有 provider，模型名要从 agent 上取；
 * - C4 tools/execute 的载荷上根本没有 model 字段。
 */

import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

// 导入顺序有讲究：必须在被测模块之前导入 —— 本模块把 DSH_HOME 指到临时目录，
// 否则判定日志会写进用户真实的 ~/.dsh/guard-degen/。
import './helpers/temp-home.mjs'

import GuardDegenController from '../lib/index.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))

/** bundle 缓存：模块只会被注册一次，重复 import 拿不到 registration。 */
let bundleCache = null

/**
 * 装载浏览器半边的 bundle。
 * @returns {Promise<object>} bundle
 */
async function loadBrowserBundle() {
	if (bundleCache) return bundleCache
	let registration = null
	globalThis.window = {
		__ModuleLoader__: {
			load(input) {
				registration = input
			},
		},
	}
	await import(pathToFileURL(path.join(HERE, '..', 'lib', 'client.js')).href)
	bundleCache = registration.factory((id) => {
		if (id === 'react') return { createElement: () => null }
		throw new Error(`插件 bundle 请求了意外模块 ${id}`)
	})
	return bundleCache
}

/**
 * 造一个假的 cordis 上下文。
 * @param {object} [options] - 选项
 * @returns {object} 上下文
 */
function makeCtx(options = {}) {
	return {
		effect: (fn) => { fn() },
		logger: { warn: () => {}, info: () => {}, error: () => {} },
		locale: { register: () => {}, bind: () => (key) => key },
		remote: {
			$mount: async () => {
				options.onMount?.()
				return async () => {}
			},
		},
		inject: (deps, fn) => {
			options.onInject?.(deps)
			return Promise.resolve({ dispose: async () => {} })
		},
		slots: { inject: () => {}, register: () => ({}) },
	}
}

// ── C1：模块级 inject 不能自锁 ─────────────────────────────────────────

test('C1 模块级 inject 不含只有自己 $mount 才创建的命名空间', async () => {
	const bundle = await loadBrowserBundle()
	assert.ok(Array.isArray(bundle.inject), 'bundle 必须导出 inject')
	assert.ok(
		!bundle.inject.includes('remote.guardDegen'),
		`模块级 inject 不能依赖 remote.guardDegen：${JSON.stringify(bundle.inject)}`,
	)
	for (const dep of bundle.inject) {
		assert.ok(
			!dep.startsWith('remote.'),
			`模块级 inject 不能依赖任何插件自建的远程命名空间：${dep}`,
		)
	}
})

test('C1 命名空间在 apply 里先挂载再注入', async () => {
	const bundle = await loadBrowserBundle()
	const events = []
	await bundle.apply(makeCtx({
		onMount: () => events.push('mount'),
		onInject: (deps) => events.push(['inject', deps]),
	}))
	assert.equal(events[0], 'mount', '必须先 $mount 再 inject')
	assert.deepEqual(events[1][1], ['remote.guardDegen', 'slots', 'locale'])
})

// ── C2/C3/C4：载荷字段取法 ────────────────────────────────────────────

/**
 * 造一个控制器实例。
 * @returns {Promise<object>} 控制器
 */
async function makeController() {
	const { Context } = await import('@deepseek-ai/cordis')
	const ctx = new Context()
	return new GuardDegenController(ctx, {})
}

test('C2 早期检测从 agent.options 上取模型名', async () => {
	const controller = await makeController()
	try {
		await controller.guardHistory({
			messages: [{ role: 'assistant', content: '⇒'.repeat(40) }],
			agent: { id: 'a1', session: { id: 's1' }, options: { model: 'minimax-cn/MiniMax-M3.1-Flash' } },
		}, async () => ({}))
		const verdicts = controller.impl.getVerdicts(10).entries
		assert.ok(verdicts.length > 0, '应当记下一条历史退化裁决')
		// 取最后一条：判定日志是追加写的，前面可能还有别的记录
		const latest = verdicts[verdicts.length - 1]
		assert.equal(latest.model, 'minimax-cn/MiniMax-M3.1-Flash')
	} finally {
		await controller.ctx.stop?.()
	}
})

test('C3 失败重试记的是 agent 的模型名，不是 provider', async () => {
	const controller = await makeController()
	try {
		await controller.handleRequestError({
			agent: { id: 'a1', session: { id: 's1' }, options: { model: 'minimax-cn/MiniMax-M3.1-Flash' } },
			provider: 'minimax-cn',
			failure: { message: '退化', code: 'DEGENERATION_DETECTED' },
		}, async () => undefined)
		const hits = [...controller.retry.lastHit.values()]
		assert.equal(hits.length, 1, '应当记下一次退化命中')
		assert.equal(hits[0].model, 'minimax-cn/MiniMax-M3.1-Flash')
	} finally {
		await controller.ctx.stop?.()
	}
})

test('C4 工具入参裁决不拿 exec.model 当模型', async () => {
	const controller = await makeController()
	try {
		controller.onToolVerdict(
			{ action: 'refuse', detail: { rule: 'symbol-run', severity: 'high', count: 30, evidence: '⇒⇒⇒' } },
			{ name: 'write_file', model: '假模型名' },
		)
		const verdicts = controller.impl.getVerdicts(10).entries
		const toolVerdict = verdicts.find((item) => item.source === 'tool-args')
		assert.ok(toolVerdict, '应当记下工具入参裁决')
		assert.equal(toolVerdict.model, null, '工具载荷上没有模型，必须记 null')
	} finally {
		await controller.ctx.stop?.()
	}
})
