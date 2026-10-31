/**
 * 宿主装载校验：插件在真实 cordis 里能不能被装载起来。
 *
 * 宿主（dsh-app-boot/lib/index.js:3400）装载插件后：
 *   const exports = await loader.import(row.name, baseUrl, {})
 *   const plugin  = Loader.prototype.unwrapExports(exports)
 *   const Config  = Reflect.get(plugin, 'Config')      // 必须是原生 Schemastery schema
 * 远程方法由 dsh-typert-protocol 的 remoteMethods() 按字符串键收集，
 * 标记在实例化时写进原型（所以必须真的 new 一次）。
 *
 * 这一项抓出过真实缺陷：REMOTE_METHODS 里列了 scanSessions，
 * 宿主类却没实现它，构造函数里的 markRemoteMethods 直接抛错 → 宿主装载失败。
 */

import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { Context } from '@deepseek-ai/cordis'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PLUGIN = path.join(HERE, '..')

const mod = await import(pathToFileURL(path.join(PLUGIN, 'lib', 'index.js')).href)
const HostClass = mod.default

assert.equal(mod.name, 'guard-degen', '插件导出的名字不对')
assert.equal(typeof HostClass, 'function', '没有默认导出的宿主类')

// Config 必须是原生 Schemastery schema：带 kSchema 标记、有标准校验入口。
assert.ok(HostClass.Config[Symbol.for('schemastery')], 'Config 缺少 schemastery 标记')
const validated = HostClass.Config['~standard'].validate({})
assert.equal(validated?.issues, undefined, `Config schema 拒绝了空配置：${JSON.stringify(validated?.issues)}`)

// 真实实例化：构造函数里会 markRemoteMethods，方法缺失就会在这里抛错。
const ctx = new Context()
const instance = new HostClass(ctx, {})
try {
	const markers = remoteMethods(instance)
	assert.deepEqual(
		markers.map((marker) => marker.exportName ?? marker.method).sort(),
		[...mod.REMOTE_METHODS].sort(),
		'协议包收集到的远程方法与声明不一致',
	)
	console.log(`OK: 宿主类可实例化，远程方法 ${markers.length} 个：${markers.map((m) => m.exportName ?? m.method).sort().join(', ')}`)
} finally {
	await ctx.stop?.()
}

console.log('全部校验通过。')
