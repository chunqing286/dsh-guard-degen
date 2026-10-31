/**
 * 宿主半边：把退化守卫接到 DSH 的宿主缝上。
 *
 * 宿主缝（均已对在盒代码核对）：
 * - `llm/stream`：`ctx.waterfall(this, "llm/stream", options, …)`（dsh-llm/lib/index.js:2397），
 *   监听器拿到 `(options, next)`，返回替换后的流即可接管。
 * - `tools/execute`：`ctx.waterfall(carrier, "tools/execute", exec, …)`（dsh-tools/lib/index.js:3434），
 *   返回 `{isError:true, error, content}` 即拒绝这次工具调用。
 * - `tools/post-execute`：`ctx.waterfall(carrier, "tools/post-execute", exec, result, …)`
 *   （dsh-tools/lib/index.js:3600），返回 `{kind:'accept'}` 或 `{kind:'block', feedback}`。
 * - `agent/pre-step` / `agent/request-error` / `agent/request`：agent 事件（dsh-agent-loop/lib/index.js:909/1136/1191），
 *   载荷里带 `agent`，可以拿到会话 id。
 *
 * 远程调用：宿主类继承 `TypertRemoteService`，用协议包的 `Remote` 给方法打标记，
 * 浏览器端就能通过 typert 网关调用（详见 `lib/remote.js`）。
 *
 * @module dsh-guard-degen
 */

import z from '@deepseek-ai/schemastery'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { CONFIG_SPEC, buildSchema } from './config.js'
import { createGuardDegenService } from './service.js'
import { markRemoteMethods } from './remote.js'
import { guardStream } from './stream-guard.js'
import { checkToolArgs } from './tool-guard.js'
import { decidePostExecute } from './post-execute.js'
import { RetryController } from './retry.js'
import { registerCommands } from './commands.js'
import { DegenerationDetector } from './detect.js'

/** 插件标识。 */
export const name = 'guard-degen'

/** 暴露给浏览器的远程方法名。 */
export const REMOTE_METHODS = [
	'getConfig',
	'setConfig',
	'getRules',
	'getStatus',
	'getVerdicts',
	'ackVerdict',
	'scanArtifacts',
	'repairArtifacts',
	'scanSessions',
	'cleanSessions',
	'scanSessionWorkspace',
	'listInterventions',
	'revertIntervention',
]

/** 早期检测时每条消息只检查尾部这么多字符。 */
const HISTORY_TAIL_CHARS = 4096

/**
 * 退化守卫控制器：既是 Cordis 服务，也是 typert 远程方法的宿主。
 */
export default class GuardDegenController extends TypertRemoteService {
	/** 需要的宿主服务。 */
	static inject = ['commands']

	/** 配置 schema：宿主据此渲染设置表单。 */
	static Config = buildSchema(z, CONFIG_SPEC)

	/**
	 * @param {object} ctx - Cordis 上下文
	 * @param {object} config - 宿主给的配置
	 */
	constructor(ctx, config) {
		super(ctx, 'guardDegen', { namespace: 'guardDegen' })
		this.impl = createGuardDegenService({ config })
		this.retry = new RetryController({
			maxSameModelRetries: this.impl.config.retry?.maxSameModelRetries,
			recurrenceLimit: this.impl.config.retry?.recurrenceLimit,
			switchModel: this.impl.config.retry?.switchModel,
		})
		this.disposers = []
		this.install()
		markRemoteMethods(Object.getPrototypeOf(this), REMOTE_METHODS, Remote)
	}

	/**
	 * 读取当前配置。
	 * @returns {object} 配置视图
	 */
	async getConfig() {
		return this.impl.getConfig()
	}

	/**
	 * 写运行时覆盖。
	 * @param {object} patch - 覆盖内容
	 * @returns {object} 结果
	 */
	async setConfig(patch) {
		const result = this.impl.setConfig(patch)
		if (result.ok) {
			this.retry.maxSameModelRetries = result.config.retry?.maxSameModelRetries ?? 1
			this.retry.recurrenceLimit = result.config.retry?.recurrenceLimit ?? 2
			this.retry.switchModel = result.config.retry?.switchModel ?? { enabled: false }
		}
		return result
	}

	/**
	 * 读取规则表。
	 * @returns {object} 规则视图
	 */
	async getRules() {
		return this.impl.getRules()
	}

	/**
	 * 读取状态总览。
	 * @returns {object} 状态
	 */
	async getStatus() {
		return this.impl.getStatus()
	}

	/**
	 * 读取判定流水。
	 * @param {number} limit - 最多返回多少条
	 * @param {string} [sessionId] - 只看这一个会话
	 * @returns {object} 判定流水
	 */
	async getVerdicts(limit, sessionId) {
		return this.impl.getVerdicts(limit, sessionId)
	}

	/**
	 * 把一次判定登记为误报。
	 * @param {string} verdictId - 判定 id
	 * @returns {object} 结果
	 */
	async ackVerdict(verdictId) {
		return this.impl.ackVerdict(verdictId)
	}

	/**
	 * 扫描工程文件里的退化内容（只读）。
	 * @param {object} options - 选项
	 * @returns {object} 扫描报告
	 */
	async scanArtifacts(options) {
		return this.impl.scanArtifacts(options ?? {})
	}

	/**
	 * 修复工程文件里的退化内容（默认只预览）。
	 * @param {object} request - 请求
	 * @returns {object} 修复结果
	 */
	async repairArtifacts(request) {
		return this.impl.repairArtifacts(request ?? {})
	}

	/**
	 * 扫描会话存档里的退化内容（只读）。
	 * @param {object} options - 选项
	 * @returns {object} 扫描报告
	 */
	async scanSessions(options) {
		return this.impl.scanSessions(options ?? {})
	}

	/**
	 * 遮蔽会话存档里的退化内容（默认只预览）。
	 * @param {object} request - 请求
	 * @returns {object} 遮蔽结果
	 */
	async cleanSessions(request) {
		return this.impl.cleanSessions(request ?? {})
	}

	/**
	 * 扫描某个会话的工作区（工件按会话的工作目录扫，会话自身单独统计）。
	 * @param {object} request - 请求
	 * @returns {object} 扫描结果
	 */
	async scanSessionWorkspace(request) {
		return this.impl.scanSessionWorkspace(request ?? {})
	}

	/**
	 * 读取某个会话的流式干预流水（时间、位置、处理动作、上下文）。
	 * @param {object} request - 请求
	 * @returns {object} 干预流水
	 */
	async listInterventions(request) {
		return this.impl.listInterventions(request ?? {})
	}

	/**
	 * 回退一次净化干预（把折叠标记换回原文）。
	 * @param {object} request - 请求
	 * @returns {object} 回退结果
	 */
	async revertIntervention(request) {
		return this.impl.revertIntervention(request ?? {})
	}

	/**
	 * 装上宿主监听器。
	 */
	install() {
		const { ctx } = this
		this.disposers.push(ctx.on('llm/stream', (options, next) => this.guardStream(options, next), { global: true }))
		this.disposers.push(ctx.on('tools/execute', (exec, next) => this.guardToolCall(exec, next)))
		this.disposers.push(ctx.on('tools/post-execute', (exec, result, next) => this.guardWrittenFile(exec, result, next)))
		this.disposers.push(ctx.on('agent/pre-step', (payload, next) => this.guardHistory(payload, next)))
		this.disposers.push(ctx.on('agent/request-error', (payload, next) => this.handleRequestError(payload, next)))
		this.disposers.push(ctx.on('agent/request', (payload, next) => this.applyModelOverride(payload, next)))
		if (ctx.commands && this.impl.config.commands?.enabled !== false) {
			this.disposers.push(registerCommands(ctx.commands, {
				cwd: process.cwd(),
				getStatus: () => this.impl.getStatus(),
				scanArtifacts: (options) => this.impl.scanArtifactsInRoots(options ?? {}),
				// 复审缺陷 D6：命令走「认根目录」的入口，用户点名哪个文件就修哪个；
				// 浏览器那边的 repairArtifacts 仍然只认配置里的根目录。
				repairArtifacts: (request) => this.impl.repairArtifactsInRoots(request ?? {}),
				maskSession: (request) => this.impl.cleanSessions(request ?? {}),
				ackVerdict: (id) => {
					const result = this.impl.ackVerdict(id)
					return result.ok ? result.entry : null
				},
			}))
		}
	}

	/**
	 * 流式守卫：接管模型调用流，检出退化就截断或净化。
	 * @param {object} options - 调用选项
	 * @param {Function} next - 宿主续接
	 * @returns {object} 流
	 */
	guardStream(options, next) {
		const config = this.impl.config
		if (config.enabled === false) return next()
		const model = options?.model ?? ''
		if (!this.impl.shouldGuardModel(model)) return next()
		const upstream = next()
		if (!upstream || typeof upstream[Symbol.asyncIterator] !== 'function') return upstream
		return guardStream(upstream, {
			rules: config.rules,
			reasoning: config.stream?.reasoning,
			text: config.stream?.text,
			holdbackChars: config.stream?.holdbackChars,
			windowChars: config.stream?.windowChars,
			maxInterventionsPerCall: config.stream?.maxInterventionsPerCall,
			unitRun: config.stream?.unitRun !== false,
			unitRepeats: config.stream?.unitRepeats,
			model,
			provider: options?.provider,
			onVerdict: (verdict, info) => this.onVerdict(verdict, info, options),
		})
	}

	/**
	 * 工具入参闸门：参数里出现退化内容时按配置告警或拒绝。
	 * @param {object} exec - 工具执行上下文
	 * @param {Function} next - 宿主续接
	 * @returns {object} 工具结果
	 */
	async guardToolCall(exec, next) {
		const config = this.impl.config
		const mode = config.toolGuard?.mode ?? 'off'
		if (config.enabled === false || mode === 'off') return next()
		const verdict = checkToolArgs(exec?.arguments, {
			mode,
			scope: config.toolGuard.scope,
			minRun: config.toolGuard.minRun,
			maxArgsChars: config.toolGuard.maxArgsChars,
			rules: config.rules,
			unitRun: config.toolGuard?.unitRun !== false,
			unitRepeats: config.toolGuard?.unitRepeats,
			toolName: exec?.name,
		})
		if (verdict.action === 'allow') return next()
		this.onToolVerdict(verdict, exec)
		if (verdict.action === 'warn') return next()
		return {
			isError: true,
			error: { message: verdict.reason },
			content: [{ type: 'text', text: verdict.reason }],
		}
	}

	/**
	 * 写后校验：写入的文件里出现退化内容就按错误处理。
	 * @param {object} exec - 工具执行上下文
	 * @param {object} result - 工具结果
	 * @param {Function} next - 宿主续接
	 * @returns {Promise<object>} 决策
	 */
	async guardWrittenFile(exec, result, next) {
		const config = this.impl.config
		if (config.enabled === false || config.postExecute?.enabled !== true) return next()
		const decision = await decidePostExecute(exec, result, {
			roots: config.postExecute.roots,
			maxFileBytes: config.postExecute.maxFileBytes,
			rules: config.rules,
		})
		if (decision.kind === 'block') {
			this.onWrittenFileViolation(exec, decision)
		}
		return decision
	}

	/**
	 * 早期检测：进入下一轮之前检查历史里是否已经有退化内容。
	 * @param {object} payload - agent/pre-step 载荷
	 * @param {Function} next - 宿主续接
	 * @returns {Promise<object>} 决策
	 */
	async guardHistory(payload, next) {
		const config = this.impl.config
		if (config.enabled === false) return next()
		const messages = payload?.messages ?? []
		const model = payload?.agent?.options?.model ?? ''
		for (const message of messages) {
			const text = messageText(message)
			if (!text) continue
			const detector = new DegenerationDetector({
				channel: 'text',
				rules: config.rules,
				windowChars: config.stream?.windowChars,
			})
			const verdict = detector.feed(text.slice(-HISTORY_TAIL_CHARS)) ?? detector.flush()
			if (!verdict) continue
			this.onVerdict({
				...verdict,
				channel: 'history',
			}, { channel: 'history', action: 'detect', model }, { sessionId: payload?.agent?.session?.id })
		}
		return next()
	}

	/**
	 * 失败重试：退化导致的失败按配置重来一轮或换模型。
	 * @param {object} payload - agent/request-error 载荷
	 * @param {Function} next - 宿主续接
	 * @returns {Promise<object>} 动作
	 */
	async handleRequestError(payload, next) {
		const config = this.impl.config
		if (config.enabled === false) return next()
		if (config.retry?.policy === 'no-retry') return next()
		const context = {
			sessionId: payload?.agent?.session?.id,
			agentId: payload?.agent?.id,
		}
		const action = this.retry.decide(payload, context)
		if (!action) return next()
		this.retry.noteDegeneration({
			...context,
			// 复审缺陷 C3：request-error 载荷里只有 provider，没有 model
			// （`.dsh-src/dsh-agent-loop/lib/index.js:1136-1143`），
			// 模型名要从 agent 上取；取不到再退回 provider，至少不是空串。
			model: payload?.agent?.options?.model ?? payload?.provider ?? null,
			rule: 'symbol-run',
		})
		return { kind: 'retry' }
	}

	/**
	 * 换模型重试：把待生效的模型覆盖写到下一次请求上。
	 * @param {object} payload - agent/request 载荷
	 * @param {Function} next - 宿主续接
	 * @returns {Promise<object>} 请求配置
	 */
	async applyModelOverride(payload, next) {
		const resolved = await next()
		const context = {
			sessionId: payload?.agent?.session?.id,
			agentId: payload?.agent?.id,
		}
		const override = this.retry.takePendingModelOverride(context)
		if (!override) return resolved
		return { ...resolved, provider: override.provider, model: override.model }
	}

	/**
	 * 记录一次流式裁决。
	 * @param {object} verdict - 裁决
	 * @param {object} info - 裁决附带的通道、模型等信息
	 * @param {object} [options] - 调用选项
	 */
	onVerdict(verdict, info, options) {
		const context = {
			// `llm/stream` 的选项里带会话 id（宿主每次模型调用都会传），
			// 有了它才能把这次干预挂到具体会话上——会话视图的干预流水靠它对号入座。
			sessionId: options?.sessionId ?? null,
			model: info?.model ?? options?.model ?? null,
			provider: info?.provider ?? options?.provider ?? null,
			channel: info?.channel ?? verdict?.channel ?? null,
			action: info?.action ?? null,
			marker: info?.marker ?? null,
			original: info?.original ?? null,
			offset: info?.offset ?? null,
			source: 'stream',
		}
		const recorded = this.impl.recordVerdict(verdict, context)
		if (recorded.entry) {
			this.ctx.logger?.warn?.(`退化守卫命中 ${recorded.entry.rule}（模型 ${recorded.entry.model ?? '未知'}），已按 ${recorded.entry.action ?? '处置'} 处理`)
		}
	}

	/**
	 * 记录一次工具入参裁决。
	 * @param {object} verdict - 裁决
	 * @param {object} exec - 工具执行上下文
	 */
	onToolVerdict(verdict, exec) {
		const recorded = this.impl.recordVerdict({
			rule: verdict.detail?.rule ?? 'symbol-run',
			severity: verdict.detail?.severity ?? 'medium',
			channel: 'tool-args',
			detail: { count: verdict.detail?.count ?? 0 },
			evidence: verdict.detail?.evidence ?? '',
		}, {
			action: verdict.action,
			source: 'tool-args',
			// 复审缺陷 C4：ToolExecutionInput 上没有 model 字段
			// （`.dsh-src/dsh-tool-cordis/lib/types/api-catalog.js:8176`），
			// 它带的 agent 只有 `{id}`。这里取不到模型就记 null，
			// 不要拿 provider 冒充模型（按模型区分的白名单会失真）。
			model: exec?.agent?.options?.model ?? null,
		})
		if (recorded.entry) {
			this.ctx.logger?.warn?.(`退化守卫命中工具参数（${exec?.name ?? '未知工具'}），动作 ${verdict.action}`)
		}
	}

	/**
	 * 记录一次写后校验命中。
	 * @param {object} exec - 工具执行上下文
	 * @param {object} decision - 决策
	 */
	onWrittenFileViolation(exec, decision) {
		const recorded = this.impl.recordVerdict({
			rule: 'symbol-run',
			severity: 'high',
			channel: 'post-execute',
			detail: { count: 0 },
			evidence: '',
		}, {
			action: 'block',
			source: 'post-execute',
			model: null,
		})
		if (recorded.entry) {
			this.ctx.logger?.warn?.(`退化守卫命中写入文件（${exec?.name ?? '未知工具'}），已按错误处理`)
		}
	}

	/**
	 * 插件卸载时清理监听器。
	 */
	dispose() {
		for (const dispose of this.disposers.splice(0)) {
			try {
				dispose()
			} catch {
				/* 注销失败不影响其它监听器 */
			}
		}
	}
}

/**
 * 从一条消息里取出可检查的文本。
 * @param {object} message - 消息
 * @returns {string} 文本
 */
function messageText(message) {
	if (typeof message?.content === 'string') return message.content
	if (!Array.isArray(message?.content)) return ''
	const parts = []
	for (const block of message.content) {
		if (typeof block?.text === 'string') parts.push(block.text)
	}
	return parts.join('\n')
}
