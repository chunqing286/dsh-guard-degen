#!/usr/bin/env node
/**
 * 集成校验：用**真实的** `@deepseek-ai/dsh-typert-protocol` 检查 `markRemoteMethods`
 * 打出的标记与宿主读取到的一致。
 *
 * 依赖：本目录 node_modules 下装好的 cordis / cosmokit / dsh-typert-protocol。
 */
import { Remote, remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import { markRemoteMethods } from '../lib/remote.js'

/** 被校验的服务类。 */
class DemoService {
	/** 配置。 */
	async getConfig() {
		return { ok: true }
	}

	/** 写配置。 */
	async setConfig(patch) {
		return { ok: true, patch }
	}

	/** 不远程的方法。 */
	async internalOnly() {
		return 1
	}
}

const marked = markRemoteMethods(DemoService.prototype, ['getConfig', 'setConfig'], Remote)
console.log('marked:', marked)

const instance = Object.create(DemoService.prototype)
const methods = remoteMethods(instance)
console.log('remoteMethods:', JSON.stringify(methods, null, 1))

if (methods.length !== 2) throw new Error(`期望 2 个远程方法，实际 ${methods.length}`)
const names = methods.map((m) => m.method).sort()
if (names.join(',') !== 'getConfig,setConfig') throw new Error(`方法名不对：${names.join(',')}`)
for (const method of methods) {
	if (method.invocation?.kind !== 'direct') throw new Error(`${method.method} 的调用方式不对`)
	if (method.exportName !== undefined) throw new Error(`${method.method} 不该带 exportName`)
}

// 幂等：再打一次同样的标记不应抛错
markRemoteMethods(DemoService.prototype, ['getConfig', 'setConfig'], Remote)
if (remoteMethods(instance).length !== 2) throw new Error('重复打标记后方法数变了')

// 缺方法要报错
try {
	markRemoteMethods(DemoService.prototype, ['nope'], Remote)
	throw new Error('缺少方法时应当抛错')
} catch (error) {
	if (!String(error.message).includes('找不到方法')) throw error
	console.log('missing method guard ok:', error.message)
}

console.log('OK: 真实协议包确认 Remote 标记可用')
