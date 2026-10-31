/**
 * 宿主契约测试：插件在真实宿主里的装载契约。
 *
 * 这一组是复审后补上的缺口——之前的「线名与形参名一致」只对着 service.js 检查，
 * 而宿主真正调用的是 lib/index.js 里的宿主类。宿主类少一个方法，
 * 构造函数里的 markRemoteMethods 会直接抛错，宿主装载插件就会失败。
 *
 * 覆盖：
 * - H1 REMOTE_METHODS 里的每个方法都必须在宿主类原型上存在（否则宿主装载即失败）；
 * - H2 形参名必须满足宿主 SRC 回退模式的解析规则（唯一标识符、无解构/默认值/剩余参数）；
 * - H3 客户端线名必须与宿主类形参名一致；
 * - H4 在真实 cordis 里实例化必须不抛错，且远程方法能被协议包收集到。
 */

import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

import GuardDegenController, { REMOTE_METHODS } from '../lib/index.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))

/**
 * 按宿主网关的 SRC 回退规则解析方法形参名。
 *
 * 对应 dsh-api-gateway/lib/index.js:1715 methodParameterNames：
 * 取 Function.prototype.toString，截取第一对括号，按逗号切分，
 * 每一段必须是唯一标识符（不允许解构、默认值、剩余参数）。
 *
 * @param {Function} fn - 方法
 * @returns {string[]} 形参名
 */
function parseParameterNames(fn) {
	const source = Function.prototype.toString.call(fn)
	const open = source.indexOf('(')
	const close = source.indexOf(')', open + 1)
	assert.ok(open >= 0 && close >= 0, '方法源码里找不到形参列表')
	const body = source.slice(open + 1, close).trim()
	if (body.length === 0) return []
	const names = []
	for (const part of body.split(',').map((item) => item.trim())) {
		assert.match(part, /^[$A-Z_a-z][$\w]*$/u, `形参 ${part} 不满足宿主的 SRC 解析规则`)
		assert.ok(!names.includes(part), `形参 ${part} 重复`)
		names.push(part)
	}
	return names
}

// ── H1：宿主类必须实现 REMOTE_METHODS 里的每个方法 ─────────────────────

test('H1 宿主类实现了 REMOTE_METHODS 里的每个方法', () => {
	const prototype = GuardDegenController.prototype
	for (const name of REMOTE_METHODS) {
		assert.equal(typeof prototype[name], 'function', `宿主类缺少远程方法 ${name}`)
	}
})

// ── H2：形参名必须满足宿主的 SRC 解析规则 ─────────────────────────────

test('H2 远程方法的形参名满足宿主 SRC 回退模式的解析规则', () => {
	for (const name of REMOTE_METHODS) {
		const params = parseParameterNames(GuardDegenController.prototype[name])
		assert.ok(!params.includes('signal'), `${name} 不应声明 signal 形参`)
	}
})

// ── H3：客户端线名与宿主类形参名一致 ──────────────────────────────────

test('H3 客户端线名与宿主类形参名一致', async () => {
	let registration = null
	globalThis.window = {
		__ModuleLoader__: {
			load(input) {
				registration = input
			},
		},
	}
	await import(pathToFileURL(path.join(HERE, '..', 'lib', 'client.js')).href)
	const bundle = registration.factory((id) => {
		if (id === 'react') return { createElement: () => null }
		throw new Error(`插件 bundle 请求了意外模块 ${id}`)
	})
	const specs = bundle.__test.REMOTE_METHOD_SPECS
	assert.deepEqual(specs.map((item) => item.name), REMOTE_METHODS, '客户端方法表与宿主不一致')
	for (const spec of specs) {
		const hostParams = parseParameterNames(GuardDegenController.prototype[spec.name])
		const clientParams = spec.params.map((item) => item.name)
		assert.deepEqual(clientParams, hostParams, `${spec.name} 的线名与宿主形参名不一致`)
	}
})

// ── H4：真实 cordis 里实例化不抛错，远程方法可被协议包收集 ─────────────

test('H4 在真实 cordis 里实例化成功且远程方法齐全', async () => {
	const { Context } = await import('@deepseek-ai/cordis')
	const { remoteMethods } = await import('@deepseek-ai/dsh-typert-protocol')
	const ctx = new Context()
	const instance = new GuardDegenController(ctx, {})
	try {
		const markers = remoteMethods(instance)
		assert.deepEqual(
			markers.map((marker) => marker.method).sort(),
			[...REMOTE_METHODS].sort(),
			'协议包收集到的远程方法与声明不一致',
		)
	} finally {
		await ctx.stop?.()
	}
})

// ── 附：宿主类的 Config 必须是原生 Schemastery schema ─────────────────

test('H5 宿主类的 Config 是原生 Schemastery schema 且接受空配置', () => {
	const Config = GuardDegenController.Config
	assert.equal(typeof Config, 'function')
	assert.ok(Config[Symbol.for('schemastery')], 'Config 缺少 schemastery 标记')
	const validated = Config['~standard'].validate({})
	assert.equal(validated?.issues, undefined, JSON.stringify(validated?.issues ?? null))
})
