#!/usr/bin/env node
/**
 * 集成校验：用真实的 cordis + typert 协议包实例化插件的宿主半边，
 * 检查 Cordis 能不能接住这个插件类、配置 schema 在不在、远程方法有没有挂上。
 */
import { Context } from '@deepseek-ai/cordis'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import GuardDegenController, { REMOTE_METHODS } from '../lib/index.js'

const ctx = new Context()
const plugin = new GuardDegenController(ctx, {})

console.log('service key:', plugin.name)
console.log('ctx.guardDegen === plugin:', ctx.guardDegen === plugin)

const methods = remoteMethods(plugin).map((m) => m.method)
console.log('remote methods:', methods.join(', '))
if (methods.join(',') !== REMOTE_METHODS.join(',')) {
	throw new Error(`远程方法不匹配：期望 ${REMOTE_METHODS.join(',')}，实际 ${methods.join(',')}`)
}

const schema = GuardDegenController.Config
console.log('Config schema kind:', schema?.kind)
if (!schema) throw new Error('缺少静态 Config schema')
const parsed = schema(undefined)
console.log('默认配置 stream:', JSON.stringify(parsed.stream))
console.log('默认配置 toolGuard:', JSON.stringify(parsed.toolGuard))

// 宿主缝监听器已挂上
const listeners = ctx.events.getEventListeners?.('llm/stream')
console.log('llm/stream 监听器数量:', Array.isArray(listeners) ? listeners.length : '(未公开)')

console.log('OK: 宿主半边能在真实 cordis 上实例化')
