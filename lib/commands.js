/**
 * 斜杠命令：`/degen-status`、`/degen-scan`、`/degen-fix`、`/degen-clean`、`/degen-ack`。
 *
 * 宿主契约（dsh-commands/lib/index.js:149-176 与 :258-290）：
 * - `commands.register({name, description, input?, handler})`，name 不带斜杠；
 * - handler 收到 `{commandId, agent, rawInput, attachments, signal}`，
 *   返回 `{kind:'success'|'error', text}`；抛异常会被宿主记成 command/done 错误。
 *
 * 这里所有宿主能力都**注入**，命令层只负责解析输入、组织文案、调用依赖。
 *
 * @module dsh-guard-degen/commands
 */

import path from 'node:path'

/** 注册的命令名（不含斜杠）。 */
export const COMMAND_NAMES = ['degen-status', 'degen-scan', 'degen-fix', 'degen-clean', 'degen-ack']

/**
 * 把原始输入切成参数。
 * @param {string | undefined} rawInput - 原始输入
 * @returns {string[]} 参数列表
 */
export function parseArgs(rawInput) {
	if (typeof rawInput !== 'string') return []
	return rawInput.split(/\s+/).map((item) => item.trim()).filter((item) => item.length > 0)
}

/**
 * 把命令处理函数包一层：依赖抛错时返回错误结果而不是把异常抛给宿主。
 * @param {(invocation: any) => Promise<any>} handler - 处理函数
 * @returns {(invocation: any) => Promise<{kind: string, text: string}>} 包装后的处理函数
 */
function guard(handler) {
	return async (invocation) => {
		try {
			return await handler(invocation)
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error)
			return { kind: 'error', text: `退化守卫命令执行失败：${message}` }
		}
	}
}

/**
 * 生成状态文本。
 * @param {object} status - 状态
 * @returns {string} 文本
 */
export function renderStatus(status) {
	const config = status?.config ?? {}
	const guardConfig = config.toolGuard ?? {}
	const rules = config.rules ?? {}
	const enabled = Object.entries(rules).filter(([, rule]) => rule?.on !== false).map(([id]) => id)
	const verdicts = Array.isArray(status?.verdicts) ? status.verdicts : []
	const lines = [
		'退化守卫状态',
		`- 工具闸门：${guardConfig.mode ?? 'off'}（范围 ${guardConfig.scope ?? 'all'}）`,
		`- 写后校验：${config.postExecute?.enabled === false ? '关闭' : '开启'}`,
		`- 启用规则：${enabled.length > 0 ? enabled.join('、') : '（无）'}`,
		`- 判定记录：${verdicts.length} 条`,
	]
	if (verdicts.length > 0) {
		const last = verdicts[verdicts.length - 1]
		lines.push(`- 最近一次：${last.rule ?? '?'}（模型 ${last.model ?? '?'}，通道 ${last.channel ?? '?'}）`)
	}
	return lines.join('\n')
}

/**
 * 生成扫描结果文本。
 * @param {object} report - 扫描报告
 * @returns {string} 文本
 */
export function renderScanReport(report) {
	const summary = report?.summary ?? {}
	const lines = [
		`扫描完成：${summary.filesScanned ?? 0} 个文件，${summary.filesWithHits ?? 0} 个命中，${summary.totalRuns ?? 0} 段游程，共 ${summary.totalSymbols ?? 0} 个符号。`,
	]
	const files = Array.isArray(report?.files) ? report.files : []
	for (const file of files.slice(0, 20)) {
		lines.push(`- ${file.path}：${file.runCount ?? 0} 段 / ${file.symbolCount ?? 0} 个符号`)
	}
	if (files.length > 20) lines.push(`- …另有 ${files.length - 20} 个文件`)
	if (files.length === 0) lines.push('没有发现退化内容。')
	else lines.push('用 /degen-fix <文件路径…> 修复选中的文件。')
	return lines.join('\n')
}

/**
 * 生成修复结果文本。
 * @param {object} result - 修复结果
 * @returns {string} 文本
 */
export function renderRepairResult(result) {
	const summary = result?.summary ?? {}
	if (result?.error) return result.error
	const lines = [`修复完成：请求 ${summary.requested ?? 0} 个，成功 ${summary.changed ?? 0} 个，失败 ${summary.failed ?? 0} 个，清理 ${summary.symbols ?? 0} 个符号。`]
	for (const item of result?.results ?? []) {
		if (item?.error) lines.push(`- ${item.path}：失败（${item.error}）`)
		else if (item?.changed) lines.push(`- ${item.path}：已清理 ${item.symbols ?? 0} 个符号${item.backup ? `，备份 ${item.backup}` : ''}`)
		else lines.push(`- ${item.path}：无需修改`)
	}
	return lines.join('\n')
}

/**
 * 生成遮蔽结果文本。
 * @param {object} result - 遮蔽结果
 * @returns {string} 文本
 */
export function renderMaskResult(result) {
	if (result?.error) return result.error
	const lines = [`会话遮蔽完成：遮蔽 ${result?.masked ?? 0} 段退化内容，清理 ${result?.symbols ?? 0} 个符号，保留 ${result?.toolCallsKept ?? 0} 个工具调用块。`]
	if (result?.output) lines.push(`输出：${result.output}`)
	if (result?.backup) lines.push(`备份：${result.backup}`)
	if (result?.remaining) lines.push(`仍有 ${result.remaining} 段残留，需要再跑一次。`)
	return lines.join('\n')
}

/**
 * 生成误报登记文本。
 * @param {object} entry - 白名单条目
 * @returns {string} 文本
 */
export function renderAckResult(entry) {
	return `已登记误报：规则 ${entry?.rule ?? '?'}，模型 ${entry?.model ?? '?'}。同类判定不再拦截，并把该规则阈值调高一档。`
}

/**
 * 生成全部命令定义。
 * @param {object} deps - 注入的宿主能力
 * @returns {{name: string, description: string, input?: object, handler: Function}[]} 命令定义
 */
export function createCommandDefinitions(deps = {}) {
	const getStatus = deps.getStatus ?? (() => ({ config: {}, verdicts: [] }))
	const scanArtifacts = deps.scanArtifacts ?? (async () => ({ summary: {}, files: [] }))
	const repairArtifacts = deps.repairArtifacts ?? (async () => ({ summary: {}, results: [] }))
	const maskSession = deps.maskSession ?? (async () => ({}))
	const ackVerdict = deps.ackVerdict ?? (() => null)

	return [
		{
			name: 'degen-status',
			description: '查看退化守卫的当前配置与最近判定',
			handler: guard(async () => ({ kind: 'success', text: renderStatus(getStatus()) })),
		},
		{
			name: 'degen-scan',
			description: '扫描工作区工程文件里的退化内容（只读）',
			input: { hint: '[目录路径，默认当前工作区]' },
			handler: guard(async (invocation) => {
				const roots = parseArgs(invocation?.rawInput)
				const targets = roots.length > 0 ? roots : [deps.cwd ?? process.cwd()]
				const report = await scanArtifacts({ roots: targets })
				return { kind: 'success', text: renderScanReport(report) }
			}),
		},
		{
			name: 'degen-fix',
			description: '修复指定文件里的退化内容（先备份再改写）',
			input: { hint: '<文件路径…>' },
			handler: guard(async (invocation) => {
				const files = parseArgs(invocation?.rawInput)
				if (files.length === 0) {
					return { kind: 'error', text: '请给出要修复的文件路径，例如：/degen-fix docs/验证记录.md' }
				}
				// 复审缺陷 N3：修复的根目录要跟扫描一致。
				// 用户在命令里点名的文件，其所在目录就是这次的根目录，
				// 这样「用户点了哪个就修哪个」的意图不会被默认的工作区范围挡掉。
				const roots = [...new Set(files.map((file) => path.dirname(path.resolve(file))))]
				const result = await repairArtifacts({ files, apply: true, roots })
				return { kind: 'success', text: renderRepairResult(result) }
			}),
		},
		{
			name: 'degen-clean',
			description: '遮蔽当前会话存档里的退化内容（保留工具调用配对）',
			handler: guard(async (invocation) => {
				const result = await maskSession({
					sessionId: invocation?.agent?.session?.id,
					apply: true,
				})
				if (result?.error) return { kind: 'error', text: result.error }
				return { kind: 'success', text: renderMaskResult(result) }
			}),
		},
		{
			name: 'degen-ack',
			description: '把最近一次判定登记为误报，后续同类不再拦截',
			handler: guard(async () => {
				const entry = ackVerdict()
				if (!entry) return { kind: 'error', text: '没有可确认的判定记录。' }
				return { kind: 'success', text: renderAckResult(entry) }
			}),
		},	]
}

/**
 * 把命令注册到宿主。
 * @param {{register: Function}} service - commands 服务
 * @param {object} deps - 注入的宿主能力
 * @returns {() => void} 注销函数
 */
export function registerCommands(service, deps = {}) {
	const disposers = []
	for (const definition of createCommandDefinitions(deps)) {
		const dispose = service.register(definition)
		if (typeof dispose === 'function') disposers.push(dispose)
	}
	return () => {
		for (const dispose of disposers) {
			try {
				dispose()
			} catch {
				/* 注销失败不影响其它命令 */
			}
		}
	}
}
