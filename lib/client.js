/**
 * 浏览器半边：退化守卫 GUI（配置页 + 工件/会话页）。
 *
 * 设计要点：
 * - **手写 bundle**：运行环境没有打包器，客户端产物就是这段经典脚本；
 *   宿主用 `window.__ModuleLoader__.load` 注册，工厂返回 `{apply, inject}`。
 * - **无 JSX**：一律 `React.createElement`。
 * - **依赖面最小**：只用 `react`；typert 贡献自带的迷你 schema 顶替 zod
 *   （注册器只校验 `mode` / `typeSymbol` / `create` 的结构契约，不会调用 schema）。
 * - **只读优先**：工件修复与会话遮蔽默认 `apply=false`，界面上先预览再落盘。
 * - **线名对齐**：贡献里的参数线名 == 宿主方法形参名，宿主按 SRC 模式解析。
 *
 * @module dsh-guard-degen/client
 */

window.__ModuleLoader__.load({
	id: 'dsh-guard-degen',
	factory: (require) => {
		var module = { exports: {} }
		var exports = module.exports
		Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

		const React = require('react')
		const h = React.createElement

		// ── 迷你 schema ──────────────────────────────────────────────────────
		// typert 的 strict codec 只被结构校验（mode / typeSymbol / create），
		// 这里给出一个行为正确的最小实现，避免为了一个结构约束引入 zod。

		/**
		 * 造一个最小 schema 节点。
		 * @param {string} kind - 类型名
		 * @param {(value: any) => boolean} check - 校验函数
		 * @param {boolean} [optional] - 是否允许 undefined
		 * @returns {object} schema 节点
		 */
		function schemaNode(kind, check, optional) {
			const api = {
				kind,
				optional: () => schemaNode(kind, check, true),
				nonoptional: () => schemaNode(kind, check, false),
				safeParse(value) {
					if (optional === true && value === undefined) return { success: true, data: undefined }
					if (check(value)) return { success: true, data: value }
					return { success: false, error: { message: `期望 ${kind}` } }
				},
				parse(value) {
					const parsed = api.safeParse(value)
					if (!parsed.success) throw new Error(parsed.error.message)
					return parsed.data
				},
			}
			return api
		}

		/**
		 * 迷你 zod：只覆盖本插件用到的构造子。
		 * @returns {object} schema 工厂
		 */
		function createMiniSchema() {
			const isPlainObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)
			return {
				string: () => schemaNode('string', (value) => typeof value === 'string'),
				number: () => schemaNode('number', (value) => typeof value === 'number' && Number.isFinite(value)),
				unknown: () => schemaNode('unknown', () => true),
				record: () => schemaNode('object', isPlainObject),
				strictObject: (shape) => schemaNode('object', (value) => {
					if (!isPlainObject(value)) return false
					for (const key of Object.keys(value)) {
						if (!(key in shape)) return false
						const field = shape[key]
						if (typeof field?.safeParse === 'function' && !field.safeParse(value[key]).success) return false
					}
					return true
				}),
			}
		}

		// ── remote-info（对齐 @deepseek-ai/dsh-typert-protocol/remote-info）──

		/**
		 * 判断参数是否可省略。
		 * @param {object} parameter - 参数描述
		 * @returns {boolean} 是否可省略
		 */
		function optionalParameter(parameter) {
			return parameter.source === 'json' && parameter.acceptsUndefined === true
		}

		/** 按线名收集参数的输入 schema。 */
		class NamedInput {
			constructor(parameters, strict, zod) {
				this.parameters = parameters
				this.strict = strict
				this.zod = zod
			}

			codec(parameter) {
				return this.strict ? parameter.strictCodec : parameter.codec
			}

			create = () => this.schema ??= this.zod.strictObject(Object.fromEntries(this.parameters.map((parameter) => {
				const value = this.codec(parameter).create()
				return [parameter.wire, optionalParameter(parameter) ? value.optional() : value.nonoptional()]
			})))
		}

		/**
		 * 造一个可挂载的 typert 贡献。
		 * @param {object} spec - 方法事实
		 * @param {object} zod - schema 工厂
		 * @returns {object} RemoteInfo 实例
		 */
		function createTypertRemoteInfo(spec, zod) {
			return {
				spec,
				zod,
				get package() {
					return spec.package
				},
				get descriptors() {
					return this.resolve().descriptors
				},
				get methods() {
					return this.resolve().methods
				},
				resolve() {
					if (this.index !== undefined) return this.index
					const descriptors = []
					const methods = Object.create(null)
					for (const [endpoint, definition] of Object.entries(spec.methods)) {
						const separator = endpoint.indexOf('/')
						const namespace = endpoint.slice(0, separator)
						const method = endpoint.slice(separator + 1)
						const parameters = definition.parameters.map((parameter) => ({ ...parameter, wire: parameter.wire ?? parameter.name }))
						const descriptor = {
							...definition,
							id: `${spec.package}#${endpoint}`,
							namespace,
							method,
							parameters,
							result: definition.result,
						}
						if (definition.invocation.kind === 'direct') {
							descriptor.input = (options) => {
								const strict = options?.strict === true
								return new NamedInput(parameters, strict, zod)
							}
							descriptor.invoke = (remote, input, signal) => {
								const values = parameters.map((parameter) => input[parameter.wire])
								if (definition.cancellation !== undefined) values.push(signal)
								const receiver = Reflect.get(remote, namespace)
								const call = Reflect.get(receiver, method)
								return call.apply(receiver, values)
							}
							methods[endpoint] = descriptor
						}
						descriptors.push(descriptor)
					}
					this.index = { descriptors, methods }
					return this.index
				},
			}
		}

		// ── 远程方法表 ───────────────────────────────────────────────────────
		// 参数线名必须与宿主方法形参名一致：宿主按 SRC 模式从形参名解析线名。

		const REMOTE_METHOD_SPECS = [
			{ name: 'getConfig', params: [] },
			{ name: 'setConfig', params: [{ name: 'patch', type: 'record' }] },
			{ name: 'getRules', params: [] },
			{ name: 'getStatus', params: [] },
			{ name: 'getVerdicts', params: [{ name: 'limit', type: 'number', optional: true }, { name: 'sessionId', type: 'string', optional: true }] },
			{ name: 'ackVerdict', params: [{ name: 'verdictId', type: 'string', optional: true }] },
			{ name: 'scanArtifacts', params: [{ name: 'options', type: 'record', optional: true }] },
			{ name: 'repairArtifacts', params: [{ name: 'request', type: 'record', optional: true }] },
			{ name: 'scanSessions', params: [{ name: 'options', type: 'record', optional: true }] },
			{ name: 'cleanSessions', params: [{ name: 'request', type: 'record', optional: true }] },
			{ name: 'scanSessionWorkspace', params: [{ name: 'request', type: 'record', optional: true }] },
			{ name: 'listInterventions', params: [{ name: 'request', type: 'record', optional: true }] },
			{ name: 'revertIntervention', params: [{ name: 'request', type: 'record', optional: true }] },
		]

		/**
		 * 造一个参数 codec。
		 * @param {string} endpoint - 端点名
		 * @param {object} param - 参数描述
		 * @returns {object} codec
		 */
		function parameterCodec(endpoint, param) {
			const mini = createMiniSchema()
			const schema = param.type === 'number' ? mini.number() : param.type === 'string' ? mini.string() : mini.record()
			return {
				mode: 'strict',
				typeSymbol: `dsh-guard-degen#${endpoint}:parameter:${param.name}`,
				create: () => schema,
				jsonSchema: { type: param.type === 'number' ? 'number' : param.type === 'string' ? 'string' : 'object' },
			}
		}

		/**
		 * 造出 typert 贡献：11 个方法、参数线名对齐宿主形参名。
		 * @returns {object} RemoteInfo 实例
		 */
		function buildContribution() {
			const methods = {}
			for (const method of REMOTE_METHOD_SPECS) {
				const endpoint = `guardDegen/${method.name}`
				methods[endpoint] = {
					service: 'guardDegen',
					description: `退化守卫远程方法 ${method.name}`,
					invocation: { kind: 'direct' },
					parameters: method.params.map((param) => ({
						name: param.name,
						wire: param.name,
						description: `参数 ${param.name}`,
						source: 'json',
						acceptsUndefined: param.optional === true,
						codec: parameterCodec(endpoint, param),
						strictCodec: parameterCodec(endpoint, param),
					})),
					result: { mode: 'src-json' },
				}
			}
			return createTypertRemoteInfo({ package: 'dsh-guard-degen', methods }, createMiniSchema())
		}

		// ── 语言包 ───────────────────────────────────────────────────────────

		const NS = 'guardDegen'

		const zh = {
			nav: '退化守卫',
			sectionTitle: '退化守卫',
			sectionIntro: '配置退化守卫的拦截策略，查看判定日志，并治理工件与会话存档里的退化内容。',
			tabs: '退化守卫视图',
			empty: '本部署没有开放任何退化守卫视图。',
			tabConfig: '配置',
			tabLogs: '日志',
			tabArtifacts: '工件',
			loading: '加载中…',
			retry: '重试',
			save: '保存改动',
			clearOverride: '清除运行时覆盖',
			reload: '重新载入',
			noChange: '没有改动。',
			saved: '已写入运行时覆盖文件。',
			overrideFile: '覆盖文件',
			overrideActive: '存在运行时覆盖',
			overrideEmpty: '没有运行时覆盖（当前值来自 profile patch）',
			enabledOn: '守卫已启用',
			enabledOff: '守卫已停用',
			groupStream: '分组配置',
			groupOthers: '顶层配置',
			groupToolGuard: '工具参数守卫',
			groupPostExecute: '写入后校验',
			groupRetry: '重试策略',
			groupArtifacts: '工件治理',
			groupSessions: '会话治理',
			groupLogging: '日志',
			groupAck: '误报反馈',
			verdictAck: '确认误报',
			verdictAcdked: '已登记为误报。',
			logsIntro: '每一次退化判定都记在这里：命中了哪条规则、发生在哪个会话、守卫做了什么处理。点一条记录可以看检出的退化特征，以及自动治理前后的对照。',
			logsSessionFilter: '会话',
			logsAllSessions: '全部会话',
			logsSessionSearch: '按会话 ID 或名称筛选',
			logsSessionSearchHint: '输入会话 ID 或会话名称的一部分，只看匹配的判定记录。',
			logsSessionId: '会话ID',
			logsSessionTitle: '会话名称',
			logsTime: '时间',
			logsModel: '模型',
			logsRule: '规则',
			logsChannel: '通道',
			logsAction: '处置',
			logsFeature: '退化特征',
			logsOperations: '操作',
			logsEmpty: '还没有判定记录。',
			logsEmptySession: '这个会话还没有判定记录。',
			logsDetailTitle: '判定详情',
			logsDetailEmpty: '点上面任意一条记录，这里会显示检出的退化特征与治理前后的对照。',
			logsDetailSeverity: '严重度',
			logsDetailEvidence: '判定依据',
			logsFeatureUnit: '单元「{unit}」连续重复了 {repeats} 次',
			logsFeatureSymbol: '连续 {count} 个退化符号连成一片',
			logsFeatureGeneric: '命中 {count} 处退化',
			logsRemediated: '已自动治理',
			logsNotRemediated: '仅记录判定，未自动治理',
			logsDiffTitle: '治理前后对照',
			logsDiffRemoved: '治理前',
			logsDiffAdded: '治理后',
			logsActionSanitize: '净化（折叠成标记）',
			logsActionTruncate: '截断',
			logsActionWarn: '告警',
			logsActionRefuse: '拒绝',
			logsActionBlock: '拦截',
			logsNoteSanitize: '退化的那一段被折叠成一个标记，模型输出照常继续。',
			logsNoteTruncate: '输出在这里截断，后面的内容没有落盘。',
			logsNoteWarn: '只记了一条判定，工具调用照常执行。',
			logsNoteRefuse: '这次工具调用被拒绝了，参数里的退化内容没有执行。',
			logsNoteBlock: '这次写入被拦下了，退化内容没有落盘。',
			logsUntitled: '（无标题）',
			logsNoSession: '（无会话）',
			logsTotal: '共 {n} 条判定',
			logsReload: '刷新',
			groupCommands: '斜杠命令',
			artifactRoots: '扫描根目录（逗号分隔，留空用默认）',
			artifactRootsHint: '点「扫描」会把这里填的范围写进配置，修复按同一范围执行。',
			artifactScan: '扫描工件',
			artifactScanning: '扫描中…',
			artifactSummary: '扫描结果',
			artifactEmpty: '没有命中退化内容。',
			artifactSkippedTooLarge: '以下文件超过大小上限，未被检查（可在配置页调大「单文件大小上限」）',
			artifactSelectAll: '全选',
			artifactClear: '清空选择',
			artifactMode: '修复方式',
			artifactModeCollapse: '折叠成标记',
			artifactModeRemove: '整段删除',
			artifactModeHint: '「整段删除」把重复符号直接从文件里删掉，一个标记都不写；「折叠成标记」会留下〔退化符号流×N〕。',
			artifactPreview: '预览修复',
			artifactApply: '执行修复',
			artifactConfirm: '确认对所选文件落盘修复？原文件会先备份。',
			artifactResult: '修复结果',
			sessionScan: '扫描会话',
			sessionScanning: '扫描中…',
			sessionEmpty: '没有命中退化内容的会话。',
			sessionMaskPreview: '预览遮蔽',
			sessionMaskApply: '执行遮蔽',
			sessionMaskConfirm: '确认遮蔽所选会话？copy 模式另存为新文件，replace 模式会备份原文件。',
			sessionUntitled: '（无标题）',
			maskMode: '遮蔽方式',
			maskModeCollapse: '折叠成标记',
			maskModeRemove: '整段删除',
			maskModeHint: '切换方式后，预览会立刻按新方式重算。',
			maskModeRemoveHint: '「整段删除」：重复符号直接从会话里删掉，一个标记都不写；对照视图里「遮蔽后」显示的就是删完剩下的内容。',
			maskTarget: '落地方式',
			maskTargetReplace: '直接改写会话存档',
			maskTargetCopy: '另存为副本',
			maskTargetHint: '「直接改写」会把会话存档本身换掉（原文件先备份到 ~/.dsh/guard-degen/backups）。当前界面上的历史消息仍是旧内容，重新打开会话才能看到改写结果。',
			maskTargetReplaceHint: '就地改写：会话存档会被原子替换，原文件备份到 ~/.dsh/guard-degen/backups；进行中的会话会在改写后的内容之后继续追加。',
			maskMemoryHint: '注意：就地改写只改「存档文件」。当前打开的会话在宿主内存里仍是改写前的旧内容 —— 屏幕上的历史、上下文视图、下一次发给模型的请求都还带着退化片段；要让改写生效，需要重启 DSH（或新开一个宿主进程）后重新打开这个会话。不刷新就继续对话，退化片段会照旧发给模型（只有新生成的输出会被流式守卫拦下）。',
			maskAppliedNote: '已写回存档。宿主内存里的当前会话仍是改写前的旧内容：继续对话还会把旧内容发给模型；重启 DSH 后重新打开本会话才会看到改写后的内容。',
			maskAppliedInPlace: '已就地改写 {path}',
			maskBackup: '备份 {path}',
			maskReplanned: '会话在预览之后又有新写入，已按最新内容重新计算。',
			diffCleared: '（整条内容被删空了）',
			viewGuardDegen: '退化守卫',
			sessionViewIntro: '针对当前会话的工作目录扫描工件，并遮蔽当前会话里的退化内容。',
			sessionViewWorkspace: '工作区工件',
			sessionViewCurrent: '当前会话',
			sessionViewScan: '扫描当前会话',
			sessionViewScanning: '扫描中…',
			sessionViewEmpty: '当前会话的工作目录里没有命中退化内容。',
			sessionViewClean: '当前会话里没有命中退化内容。',
			sessionViewNoSession: '读不出这个会话的存档（可能还没落盘）。',
			sessionViewCwd: '工作目录',
			sessionViewRuns: '退化段',
			sessionViewSymbols: '符号数',
			sessionViewMax: '最长游程',
			interventionsTitle: '流式干预流水',
			interventionsIntro: '每一次检测命中都记在这里：什么时候、哪个通道、命中哪条规则、做了什么处理（截断 / 净化折叠）、在会话里的哪个位置。净化条目可以预览处理结果，也能按条回退。',
			interventionsRefresh: '刷新',
			interventionsLoading: '读取中…',
			interventionsEmpty: '这个会话还没有记录到退化干预。',
			interventionActionSanitize: '净化（折叠成标记）',
			interventionActionTruncate: '截断',
			interventionPosition: '位置',
			interventionNoPosition: '存档里已经找不到这段内容了（可能已被回退或重写）。',
			interventionPreviewToggle: '预览处理结果',
			interventionLocate: '转到对话视图',
			interventionRevert: '回退这一条',
			interventionRevertConfirm: '回退这一条干预？会话存档会被原子替换，原文件先备份到 ~/.dsh/guard-degen/backups。',
			interventionRevertDone: '已回退这一条干预：原文已写回会话存档。',
			interventionRevertMemoryNote: '注意：回退只改了存档文件。宿主内存里的当前会话还是改写前的版本 —— 屏幕上的历史、上下文视图、下一次发给模型的请求都还没变；重启 DSH 后重新打开本会话才会生效。',
			interventionRevertFail: '回退失败：{message}',
			interventionReverted: '已回退',
			interventionNotRestorable: '截断类干预没有保留原文，无法回退。',
			diffTitle: '遮蔽前后对照',
			diffEmpty: '没有需要遮蔽的退化片段。',
			diffTruncated: '仅显示部分片段。',
			diffRemoved: '遮蔽前',
			diffAdded: '遮蔽后',
			artifactDiffTitle: '修复前后对照',
			artifactDiffRemoved: '修复前',
			artifactDiffAdded: '修复后',
			artifactDiffUnitNote: '单元「{unit}」重复了 {repeats} 次',
			artifactDiffRemovedNote: '整段删除',
			maskUnitNote: '单元「{unit}」重复了 {repeats} 次',
			maskSummary: '已遮蔽 {masked} 段 / {symbols} 个符号',
			maskPreviewOnly: '预览（未写盘）',
			maskApplied: '已写入磁盘',
			maskRemaining: '残留 {remaining} 段',
			maskOutput: '输出 {path}',
			maskError: '出错：{message}',
			busy: '处理中…',
			failed: '调用失败',
			none: '（无）',
		}

		const en = {
			nav: 'Degeneration guard',
			sectionTitle: 'Degeneration guard',
			sectionIntro: 'Configure the guard policy, inspect the verdict log, and clean degeneration out of artifacts and session archives.',
			tabs: 'Guard views',
			empty: 'This deployment exposes no guard views.',
			tabConfig: 'Config',
			tabLogs: 'Logs',
			tabArtifacts: 'Artifacts',
			loading: 'Loading…',
			retry: 'Retry',
			save: 'Save changes',
			clearOverride: 'Clear runtime override',
			reload: 'Reload',
			noChange: 'Nothing changed.',
			saved: 'Written to the runtime override file.',
			overrideFile: 'Override file',
			overrideActive: 'runtime override active',
			overrideEmpty: 'no runtime override (values come from the profile patch)',
			enabledOn: 'guard enabled',
			enabledOff: 'guard disabled',
			groupStream: 'Grouped settings',
			groupOthers: 'Top-level settings',
			groupToolGuard: 'Tool argument guard',
			groupPostExecute: 'Post-write verification',
			groupRetry: 'Retry policy',
			groupArtifacts: 'Artifact governance',
			groupSessions: 'Session governance',
			groupLogging: 'Logging',
			groupAck: 'False-positive feedback',
			verdictAck: 'Mark as false positive',
			verdictAcdked: 'Recorded as false positive.',
			logsIntro: 'Every degeneration verdict is recorded here: which rule fired, in which session, and what the guard did about it. Select a row to see the detected features and the before/after view of the automatic remediation.',
			logsSessionFilter: 'Session',
			logsAllSessions: 'All sessions',
			logsSessionSearch: 'Filter by session ID or name',
			logsSessionSearchHint: 'Type part of a session ID or session name to only see matching verdicts.',
			logsSessionId: 'Session ID',
			logsSessionTitle: 'Session name',
			logsTime: 'Time',
			logsModel: 'Model',
			logsRule: 'Rule',
			logsChannel: 'Channel',
			logsAction: 'Action',
			logsFeature: 'Detected feature',
			logsOperations: 'Actions',
			logsEmpty: 'No verdict recorded yet.',
			logsEmptySession: 'This session has no verdict recorded yet.',
			logsDetailTitle: 'Verdict detail',
			logsDetailEmpty: 'Select a row above to see the detected degeneration features and the before/after view.',
			logsDetailSeverity: 'Severity',
			logsDetailEvidence: 'Evidence',
			logsFeatureUnit: 'unit “{unit}” repeated {repeats} times in a row',
			logsFeatureSymbol: '{count} degeneration symbols in a row',
			logsFeatureGeneric: '{count} degeneration hits',
			logsRemediated: 'remediated automatically',
			logsNotRemediated: 'recorded only, not remediated',
			logsDiffTitle: 'Before / after remediation',
			logsDiffRemoved: 'before',
			logsDiffAdded: 'after',
			logsActionSanitize: 'sanitize (collapse into a marker)',
			logsActionTruncate: 'truncate',
			logsActionWarn: 'warn',
			logsActionRefuse: 'refuse',
			logsActionBlock: 'block',
			logsNoteSanitize: 'The degenerate run was collapsed into a marker; the stream continued.',
			logsNoteTruncate: 'The output was cut here; nothing after this point was written.',
			logsNoteWarn: 'Only a verdict was recorded; the tool call ran anyway.',
			logsNoteRefuse: 'The tool call was refused; the degenerate arguments never ran.',
			logsNoteBlock: 'The write was blocked; the degenerate content never reached disk.',
			logsUntitled: '(untitled)',
			logsNoSession: '(no session)',
			logsTotal: '{n} verdicts in total',
			logsReload: 'Reload',
			groupCommands: 'Slash commands',
			artifactRoots: 'Scan roots (comma separated, empty for default)',
			artifactRootsHint: 'Scanning also writes these roots into the config, so repair uses the same scope.',
			artifactScan: 'Scan artifacts',
			artifactScanning: 'Scanning…',
			artifactSummary: 'Scan result',
			artifactEmpty: 'No degeneration found.',
			artifactSkippedTooLarge: 'Files over the size limit were not checked (raise "per-file size limit" in the config tab)',
			artifactSelectAll: 'Select all',
			artifactClear: 'Clear selection',
			artifactMode: 'Repair mode',
			artifactModeCollapse: 'collapse into a marker',
			artifactModeRemove: 'delete the segment',
			artifactModeHint: '"delete the segment" removes the repeated symbols from the file and writes no marker; "collapse into a marker" leaves 〔退化符号流×N〕 behind.',
			artifactPreview: 'Preview repair',
			artifactApply: 'Apply repair',
			artifactConfirm: 'Apply the repair to the selected files? Originals are backed up first.',
			artifactResult: 'Repair result',
			sessionScan: 'Scan sessions',
			sessionScanning: 'Scanning…',
			sessionEmpty: 'No polluted session found.',
			sessionMaskPreview: 'Preview masking',
			sessionMaskApply: 'Apply masking',
			sessionMaskConfirm: 'Mask the selected session? copy writes a new file, replace backs up the original.',
			sessionUntitled: '(untitled)',
			maskMode: 'Masking mode',
			maskModeCollapse: 'collapse into a marker',
			maskModeRemove: 'delete the segment',
			maskModeHint: 'Switching the mode recomputes the preview right away.',
			maskModeRemoveHint: '"delete the segment" removes the repeated symbols from the session and writes no marker; the "after" row of the diff shows what is left behind.',
			maskTarget: 'Where it lands',
			maskTargetReplace: 'rewrite the session archive in place',
			maskTargetCopy: 'write a separate copy',
			maskTargetHint: '"Rewrite in place" replaces the session archive itself (the original is backed up to ~/.dsh/guard-degen/backups). The messages on screen stay stale until the session is reopened.',
			maskTargetReplaceHint: 'In-place rewrite: the archive is atomically replaced and the original is backed up to ~/.dsh/guard-degen/backups; a running session keeps appending after the rewritten content.',
			maskMemoryHint: 'Note: an in-place rewrite only changes the archive file. The session you have open still holds the pre-rewrite text in the host\'s memory — the on-screen transcript, the context view and the next request to the model all still carry the degenerate run. Restart DSH (or start a fresh host process) and reopen the session for the rewrite to take effect. Continuing without a reload keeps sending the old text to the model; only newly generated output is caught by the stream guard.',
			maskAppliedNote: 'Written back to the archive. The open session still holds the pre-rewrite text in the host\'s memory: continuing the conversation still sends the old text to the model; restart DSH and reopen this session to see the rewritten content.',
			maskAppliedInPlace: 'rewritten in place: {path}',
			maskBackup: 'backup {path}',
			maskReplanned: 'The session changed after the preview; the masking was recomputed on the latest content.',
			diffCleared: '(the whole content was deleted)',
			viewGuardDegen: 'Degeneration guard',
			sessionViewIntro: 'Scan the artifacts of this session workspace and mask the degeneration inside this very session.',
			sessionViewWorkspace: 'Workspace artifacts',
			sessionViewCurrent: 'Current session',
			sessionViewScan: 'Scan this session',
			sessionViewScanning: 'Scanning…',
			sessionViewEmpty: 'No degeneration found in this session workspace.',
			sessionViewClean: 'No degeneration found in this session.',
			sessionViewNoSession: 'Cannot read this session archive (it may not be persisted yet).',
			sessionViewCwd: 'Workspace',
			sessionViewRuns: 'Runs',
			sessionViewSymbols: 'Symbols',
			sessionViewMax: 'Longest run',
			interventionsTitle: 'Stream intervention log',
			interventionsIntro: 'Every detection hit is logged here: when, which channel, which rule, what was done (truncate / sanitize) and where in the session it happened. Sanitize entries can be previewed and reverted one by one.',
			interventionsRefresh: 'Refresh',
			interventionsLoading: 'Loading…',
			interventionsEmpty: 'No degeneration intervention recorded for this session yet.',
			interventionActionSanitize: 'Sanitize (collapsed)',
			interventionActionTruncate: 'Truncate',
			interventionPosition: 'Position',
			interventionNoPosition: 'The content is no longer in the archive (reverted or rewritten).',
			interventionPreviewToggle: 'Preview result',
			interventionLocate: 'Go to chat view',
			interventionRevert: 'Revert this entry',
			interventionRevertConfirm: 'Revert this intervention? The session archive is replaced atomically and the original file is backed up under ~/.dsh/guard-degen/backups.',
			interventionRevertDone: 'Reverted: the original text is back in the session archive.',
			interventionRevertMemoryNote: 'Note: the revert only changed the archive file. The open session still holds the pre-revert version in the host\'s memory — the on-screen transcript, the context view and the next request to the model are unchanged; restart DSH and reopen this session for it to take effect.',
			interventionRevertFail: 'Revert failed: {message}',
			interventionReverted: 'Reverted',
			interventionNotRestorable: 'Truncated interventions keep no original text and cannot be reverted.',
			diffTitle: 'Before / after masking',
			diffEmpty: 'No degeneration segment to mask.',
			diffTruncated: 'Showing only part of the segments.',
			diffRemoved: 'before',
			diffAdded: 'after',
			artifactDiffTitle: 'Before / after repair',
			artifactDiffRemoved: 'before',
			artifactDiffAdded: 'after',
			artifactDiffUnitNote: 'unit “{unit}” repeated {repeats} times',
			artifactDiffRemovedNote: 'removed entirely',
			maskUnitNote: 'unit “{unit}” repeated {repeats} times',
			maskSummary: 'masked {masked} segments / {symbols} symbols',
			maskPreviewOnly: 'preview (nothing written)',
			maskApplied: 'written to disk',
			maskRemaining: '{remaining} left',
			maskOutput: 'output {path}',
			maskError: 'error: {message}',
			busy: 'Working…',
			failed: 'call failed',
			none: '(none)',
		}

		// ── 样式 ─────────────────────────────────────────────────────────────

		const CSS = [
			'.gd-root{display:flex;flex-direction:column;gap:12px;max-width:820px;color:var(--dsw-alias-label-primary)}',
			// 会话视图：跟对话区同一块画布，边距交给宿主，内容自己撑开。
			'.gd-view{padding:12px 16px;max-width:100%;height:100%;overflow:auto;box-sizing:border-box}',
			'.gd-head{display:flex;flex-direction:column;gap:4px}',
			'.gd-title{margin:0;font-size:16px;font-weight:600}',
			'.gd-sub{margin:0;font-size:12px;color:var(--dsw-alias-label-tertiary);word-break:break-all}',
			'.gd-card{border:.5px solid var(--dsw-alias-border-l2);border-radius:8px;padding:12px;display:flex;flex-direction:column;gap:8px}',
			'.gd-card-title{margin:0;font-size:14px;font-weight:600}',
			'.gd-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:8px}',
			'.gd-field{display:flex;flex-direction:column;gap:4px}',
			'.gd-field-inline{flex-direction:row;align-items:center;gap:6px}',
			'.gd-label{font-size:12px;color:var(--dsw-alias-label-secondary)}',
			'.gd-hint{font-size:11px;color:var(--dsw-alias-label-tertiary)}',
			'.gd-input{background:transparent;border:.5px solid var(--dsw-alias-border-l2);border-radius:6px;color:inherit;padding:4px 6px;font:inherit;font-size:12px}',
			'.gd-textarea{font-family:ui-monospace,monospace;font-size:12px;min-height:120px;resize:vertical}',
			'.gd-actions{display:flex;gap:8px;flex-wrap:wrap}',
			'.gd-button{background:transparent;border:.5px solid var(--dsw-alias-border-l2);border-radius:6px;color:inherit;cursor:pointer;font:inherit;font-size:12px;padding:4px 10px}',
			'.gd-button[data-primary=true]{border-color:var(--dsw-alias-state-business-primary)}',
			'.gd-button[disabled]{opacity:.5;cursor:not-allowed}',
			'.gd-message{font-size:12px;color:var(--dsw-alias-label-tertiary)}',
			'.gd-warn{color:var(--dsw-alias-danger, #c96a5b)}',
			'.gd-message[data-tone=error]{color:var(--dsw-alias-state-critical,var(--dsw-alias-label-primary))}',
			'.gd-table{width:100%;border-collapse:collapse;font-size:12px}',
			'.gd-table th,.gd-table td{text-align:left;padding:4px 6px;border-bottom:.5px solid var(--dsw-alias-border-l2);vertical-align:top}',
			'.gd-path{word-break:break-all;font-family:ui-monospace,monospace}',
			'.gd-scroll{max-height:320px;overflow:auto}',
			'.gd-tag{display:inline-block;border:.5px solid var(--dsw-alias-border-l2);border-radius:4px;padding:0 4px;font-size:11px}',
			'.gd-tag[data-tone=ok]{border-color:var(--dsw-alias-state-success, #56a656)}',
			'.gd-tag[data-tone=warn]{border-color:var(--dsw-alias-danger, #c96a5b)}',
			'.gd-tag[data-tone=muted]{opacity:.7}',
			// ── 字段释义 ──
			'.gd-field-notes{display:flex;flex-direction:column;gap:2px}',
			'.gd-field-desc{margin:0;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary)}',
			'.gd-field-effect{margin:0;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary)}',
			// ── 干预流水 ──
			'.gd-interventions{display:flex;flex-direction:column;gap:8px}',
			'.gd-intervention{display:flex;flex-direction:column;gap:6px;border:.5px solid var(--dsw-alias-border-l2);border-radius:8px;padding:8px}',
			'.gd-intervention[data-reverted=true]{opacity:.72}',
			'.gd-intervention-head{display:flex;gap:6px;align-items:center;flex-wrap:wrap}',
			'.gd-intervention-pos{font-size:11px;color:var(--dsw-alias-label-tertiary);font-family:ui-monospace,monospace;word-break:break-all}',
			// ── 判定日志 ──
			'.gd-logs{display:flex;flex-direction:column;gap:8px}',
			'.gd-log-filters{display:flex;gap:8px;flex-wrap:wrap;align-items:center}',
			'.gd-log-filter{display:flex;flex-direction:column;gap:2px;min-width:220px}',
			// 点一行看详情：光标指过去要知道这行能点。
			'.gd-table tbody tr[data-clickable=true]{cursor:pointer}',
			'.gd-table tbody tr[data-selected=true]{background:rgba(127,127,127,.14)}',
			'.gd-log-session{font-family:ui-monospace,monospace;font-size:11px;word-break:break-all}',
			'.gd-log-detail{display:flex;flex-direction:column;gap:6px}',
			'.gd-log-kv{display:flex;gap:6px;flex-wrap:wrap;font-size:11px;color:var(--dsw-alias-label-secondary)}',
			'.gd-log-kv b{font-weight:600;color:var(--dsw-alias-label-primary)}',
			// 定位到对话里的那一条：短暂高亮一下，用户一眼能看见落在哪儿。
			'.gd-located{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px;border-radius:4px}',
			// ── 设置分区外壳 ──
			'.gd-section{display:flex;flex-direction:column;gap:12px;max-width:820px;color:var(--dsw-alias-label-primary)}',
			'.gd-section-title{margin:0;font-size:18px;font-weight:600}',
			'.gd-section-intro{margin:0;font-size:13px;color:var(--dsw-alias-label-tertiary)}',
			'.gd-tabs{display:flex;align-items:flex-end;gap:22px;border-bottom:.5px solid var(--dsw-alias-border-l2);margin-top:2px}',
			'.gd-tab{background:0 0;border:0;color:var(--dsw-alias-label-tertiary);cursor:pointer;font:inherit;font-size:13px;line-height:20px;padding:7px 1px 9px;position:relative}',
			'.gd-tab:hover,.gd-tab[data-active=true]{color:var(--dsw-alias-label-primary)}',
			'.gd-tab[data-active=true]:after{background:var(--dsw-alias-label-primary);content:"";border-radius:2px 2px 0 0;height:2px;position:absolute;bottom:-1px;left:0;right:0}',
			'.gd-panel{min-width:0;padding-top:2px}',
			// 页签分页的关键：作者样式里的 display 会盖掉浏览器默认的 [hidden]{display:none}，
			// 于是「没选中的页签」照样占着版面（两个页面叠在一页里）。
			// 这里显式把被隐藏的面板收掉，页签才真正分开。
			'.gd-root[hidden],.gd-panel[hidden],[data-gd-panel][hidden]{display:none !important}',
			'.gd-empty{color:var(--dsw-alias-label-tertiary);margin:0;font-size:13px}',
			// ── 会话列表 ──
			'.gd-session{display:flex;flex-direction:column;gap:2px;min-width:0}',
			'.gd-session-title{font-weight:600;word-break:break-word}',
			'.gd-session-id{font-size:11px;color:var(--dsw-alias-label-tertiary);font-family:ui-monospace,monospace;word-break:break-all}',
			// ── 遮蔽 diff ──
			'.gd-diff{display:flex;flex-direction:column;border:.5px solid var(--dsw-alias-border-l2);border-radius:8px;overflow:hidden}',
			'.gd-diff-head{display:flex;gap:8px;align-items:center;padding:5px 8px;font-size:11px;color:var(--dsw-alias-label-tertiary);border-bottom:.5px solid var(--dsw-alias-border-l2)}',
			'.gd-diff-body{display:flex;flex-direction:column;max-height:260px;overflow:auto}',
			'.gd-diff-line{display:grid;grid-template-columns:16px 1fr;gap:6px;padding:1px 8px;font-family:ui-monospace,monospace;font-size:11px;line-height:17px;white-space:pre-wrap;word-break:break-all}',
			'.gd-diff-line[data-kind=remove]{background:rgba(201,106,91,.16);box-shadow:inset 2px 0 0 #c96a5b}',
			'.gd-diff-line[data-kind=add]{background:rgba(86,166,86,.16);box-shadow:inset 2px 0 0 #56a656}',
			'.gd-diff-line[data-kind=context]{color:var(--dsw-alias-label-tertiary)}',
			'.gd-diff-mark{opacity:.75;font-weight:700}',
			'.gd-diff-note{opacity:.7;font-style:italic}',
			// 说明文字是行里的第三个格子。不钉住列的话，网格会把它塞进
			// 16px 宽的标记列——一个字一行，还把下面的红绿行挤出可视区。
			'.gd-diff-line>.gd-diff-note{grid-column:2 / -1}',
			'.gd-diff-legend{display:flex;gap:12px;align-items:center;font-size:11px;color:var(--dsw-alias-label-tertiary)}',
			'.gd-diff-swatch{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:4px;vertical-align:-1px}',
			'.gd-diff-swatch[data-kind=remove]{background:rgba(201,106,91,.5)}',
			'.gd-diff-swatch[data-kind=add]{background:rgba(86,166,86,.5)}',
		].join('')

		const STYLE_ID = 'dsh-guard-degen/client.css'

		/**
		 * 注入样式（幂等）。
		 * @returns {void}
		 */
		function injectStyle() {
			if (typeof document === 'undefined') return
			if (document.querySelector(`style[data-plugin-css="${STYLE_ID}"]`) !== null) return
			const tag = document.createElement('style')
			tag.dataset.plugin = 'dsh-guard-degen'
			tag.dataset.pluginCss = STYLE_ID
			tag.textContent = CSS
			document.head.appendChild(tag)
		}

		// ── 纯函数小工具（可单测）───────────────────────────────────────────

		/**
		 * 深拷贝（JSON 语义）。
		 * @param {any} value - 原值
		 * @returns {any} 拷贝
		 */
		function cloneJson(value) {
			if (value === undefined || value === null) return value
			return JSON.parse(JSON.stringify(value))
		}

		/**
		 * 按路径写值（不可变更新）。
		 * @param {object} base - 原对象
		 * @param {string[]} path - 路径
		 * @param {any} value - 新值
		 * @returns {object} 新对象
		 */
		function setIn(base, path, value) {
			const out = { ...(base ?? {}) }
			let cursor = out
			for (let i = 0; i < path.length - 1; i += 1) {
				const key = path[i]
				cursor[key] = { ...(cursor[key] ?? {}) }
				cursor = cursor[key]
			}
			cursor[path[path.length - 1]] = value
			return out
		}

		/**
		 * 取路径上的值。
		 * @param {object} base - 原对象
		 * @param {string[]} path - 路径
		 * @returns {any} 值
		 */
		function getIn(base, path) {
			let cursor = base
			for (const key of path) {
				if (cursor === undefined || cursor === null) return undefined
				cursor = cursor[key]
			}
			return cursor
		}

		/**
		 * 把逗号分隔的文本拆成列表。
		 * @param {string} text - 文本
		 * @returns {string[]} 列表
		 */
		function splitList(text) {
			return String(text ?? '')
				.split(',')
				.map((item) => item.trim())
				.filter((item) => item.length > 0)
		}

		/**
		 * 计算顶层差异（只提交真正改动的顶层键，避免覆盖文件被整体钉死）。
		 * @param {object} base - 原配置
		 * @param {object} draft - 草稿配置
		 * @returns {object} 差异
		 */
		function diffTopLevel(base, draft) {
			const out = {}
			for (const key of Object.keys(draft ?? {})) {
				const before = base?.[key]
				const after = draft[key]
				if (JSON.stringify(before ?? null) !== JSON.stringify(after ?? null)) out[key] = after
			}
			return out
		}

		/**
		 * 调用远程方法并拆开信封。
		 * @param {object} remote - 远程命名空间
		 * @param {string} method - 方法名
		 * @param {...any} args - 参数
		 * @returns {Promise<any>} 结果值
		 */
		async function callRemote(remote, method, ...args) {
			const result = await remote[method](...args)
			if (!result || result.ok !== true) {
				const error = result?.error
				const message = typeof error === 'string' ? error : error?.message ?? `${method} 调用失败`
				throw new Error(message)
			}
			return result.value
		}

		// ── 设置分区外壳 ─────────────────────────────────────────────────────

		/**
		 * 解析槽条目的标签（函数标签按当前语言求值）。
		 * @param {any} label - 标签（函数或字符串）
		 * @returns {string} 标签文本
		 */
		function resolveLabel(label) {
			try {
				if (typeof label === 'function') return String(label() ?? '')
				if (typeof label === 'string') return label
			} catch {
				return ''
			}
			return ''
		}

		/**
		 * 退化守卫设置分区：标题 + 「配置 / 日志 / 工件」子页签。
		 *
		 * 宿主侧的 `settings.section` 是列表槽：分区条目自己声明子槽
		 * （`children`），组件再用 `renderSlot` 渲染子槽里的页签条目。
		 * 页签清单由本分区自己的 `hooks.tabs` 提供 —— 宿主同名做法见
		 * `.dsh-src/dsh-client-ui-settings-plugins/lib/client.js` 的 `sectionInjected`。
		 *
		 * @param {object} props - 属性
		 * @returns {object} 元素
		 */
		function GuardDegenSection(props) {
			const { renderSlot } = props
			const t = makeTranslator(props.t)
			// `useTabs` 是宿主按 `hooks.tabs` 注入的标准 prop；
			// 离线单测里没有它，所以先取出来再判断，不直接调命名钩子。
			const tabHook = props.useTabs
			const rows = typeof tabHook === 'function' ? tabHook((value) => value ?? []) : []
			const list = Array.isArray(rows) ? rows : []
			const [activeId, setActiveId] = React.useState(undefined)
			const active = list.find((row) => row.id === activeId)?.id ?? list[0]?.id
			return h('div', { className: 'gd-section' },
				h('h2', { className: 'gd-section-title' }, t('sectionTitle')),
				h('p', { className: 'gd-section-intro' }, t('sectionIntro')),
				list.length === 0
					? h('p', { className: 'gd-empty' }, t('empty'))
					: h(React.Fragment, null,
						h('div', { className: 'gd-tabs', role: 'tablist', 'aria-label': t('tabs') },
							list.map((row) => h('button', {
								key: row.id,
								id: `guard-degen-tab-${row.id}`,
								type: 'button',
								role: 'tab',
								className: 'gd-tab',
								'aria-selected': row.id === active ? 'true' : 'false',
								'data-active': row.id === active ? 'true' : undefined,
								onClick: () => setActiveId(row.id),
							}, row.label))),
						// 两个页签都挂载，只把没选中的那个 `hidden` 掉。
						// 用 `only` 过滤会让没选中的页签被卸载，扫出来的报告就跟着没了。
						// 当前页签通过 owner prop（`activeTab`）告诉自己的页签组件。
						typeof renderSlot === 'function' ? renderSlot('guard-degen.tab', { activeTab: active }, {}) : null))
		}

		// ── 配置页 ───────────────────────────────────────────────────────────

		/**
		 * 规则表编辑框（JSON 文本，解析失败时保留原文不写回配置）。
		 * @param {object} props - 属性
		 * @returns {object} 元素
		 */
		function RulesField(props) {
			const { value, onChange, label, desc } = props
			const [raw, setRaw] = React.useState(() => JSON.stringify(value ?? {}, null, 2))
			const [error, setError] = React.useState('')
			return h('div', { className: 'gd-field' },
				h('span', { className: 'gd-label' }, label),
				h('textarea', {
					className: 'gd-input gd-textarea',
					rows: 8,
					value: raw,
					onChange: (event) => {
						const next = event.target.value
						setRaw(next)
						try {
							onChange(JSON.parse(next))
							setError('')
						} catch (err) {
							setError(String(err?.message ?? err))
						}
					},
				}),
				desc ? h('p', { className: 'gd-field-desc' }, desc) : null,
				error ? h('span', { className: 'gd-message', 'data-tone': 'error' }, error) : null)
		}

		/**
		 * 单个配置字段。
		 * @param {object} props - 属性
		 * @returns {object} 元素
		 */
		function Field(props) {
			const { def, value, path, onChange, label } = props
			const change = (next) => onChange(path, next)
			// 每个字段都带一句「这是什么」，再带一句「当前这个选择实际会发生什么」。
			const pathKey = path.join('.')
			const desc = typeof def.desc === 'string' ? def.desc : ''
			const effect = describeEffect(pathKey, value)
			const notes = (extra) => h('div', {
				className: 'gd-field-notes',
				// 说明文字在 <label> 里：点它不该顺手切换勾选框。
				onClick: (event) => event.preventDefault(),
			},
				desc ? h('p', { className: 'gd-field-desc' }, desc) : null,
				effect ? h('p', { className: 'gd-field-effect' }, effect) : null,
				extra ? h('p', { className: 'gd-field-desc' }, extra) : null)
			if (def.type === 'object') {
				return h('fieldset', { className: 'gd-card', style: { border: 'none', padding: 0, margin: 0 } },
					h('legend', { className: 'gd-card-title' }, label),
					desc ? h('p', { className: 'gd-field-desc' }, desc) : null,
					h('div', { className: 'gd-grid' },
						Object.entries(def.fields ?? {}).map(([key, child]) => h(Field, {
							key,
							def: child,
							value: getIn(value ?? {}, [key]),
							path: [...path, key],
							onChange,
							label: FIELD_LABELS[[...path, key].join('.')] ?? key,
						}))))
			}
			if (def.type === 'rules') {
				return h(RulesField, { value, label, desc, onChange: (next) => change(next) })
			}
			if (def.type === 'boolean') {
				return h('label', { className: 'gd-field gd-field-inline' },
					h('input', {
						type: 'checkbox',
						checked: value !== false,
						onChange: (event) => change(event.target.checked),
					}),
					h('span', { className: 'gd-label' }, label),
					notes())
			}
			if (def.type === 'number') {
				return h('label', { className: 'gd-field' },
					h('span', { className: 'gd-label' }, label),
					h('input', {
						type: 'number',
						className: 'gd-input',
						value: value === undefined || value === null ? '' : value,
						min: def.min,
						max: def.max,
						step: def.integer === true ? 1 : 'any',
						onChange: (event) => change(event.target.value === '' ? undefined : Number(event.target.value)),
					}),
					notes())
			}
			if (def.type === 'enum') {
				return h('label', { className: 'gd-field' },
					h('span', { className: 'gd-label' }, label),
					h('select', {
						className: 'gd-input',
						value: value ?? '',
						onChange: (event) => change(event.target.value),
					}, (def.values ?? []).map((item) => h('option', { key: item, value: item }, item))),
					notes())
			}
			if (def.type === 'stringArray') {
				return h('label', { className: 'gd-field' },
					h('span', { className: 'gd-label' }, label),
					h('input', {
						type: 'text',
						className: 'gd-input',
						value: (Array.isArray(value) ? value : []).join(', '),
						onChange: (event) => change(splitList(event.target.value)),
					}),
					notes())
			}
			return h('label', { className: 'gd-field' },
				h('span', { className: 'gd-label' }, label),
				h('input', {
					type: 'text',
					className: 'gd-input',
					value: value ?? '',
					onChange: (event) => change(event.target.value),
				}),
				notes())
		}

		/**
		 * 说明「当前这个选择实际会发生什么」。
		 *
		 * 释义（desc）说的是这个选项**是什么**；这里说的是**选了它之后**
		 * 守卫在运行时会怎么做。两句话一起看，才知道改动的影响。
		 *
		 * @param {string} path - 配置路径（点号分隔）
		 * @param {unknown} value - 当前值
		 * @returns {string} 效果说明；没有对应说明时返回空串
		 */
		function describeEffect(path, value) {
			const text = (key, params) => {
				const raw = EFFECT_TEXT[key]
				if (!raw) return ''
				return raw.replace(/\{(\w+)\}/g, (match, name) =>
					Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match)
			}
			const list = (items) => (Array.isArray(items) && items.length > 0 ? items.join('、') : '')
			switch (path) {
				case 'enabled':
					return value === false
						? text('enabledOff')
						: text('enabledOn')
				case 'modelIncludes':
					return list(value) === ''
						? text('modelIncludesEmpty')
						: text('modelIncludesSome', { list: list(value) })
				case 'rules':
					return text('rules')
				case 'stream.reasoning':
				case 'stream.text':
					return text(`stream.${value}`)
				case 'stream.holdbackChars':
					return text('stream.holdbackChars', { n: value ?? 0 })
				case 'stream.windowChars':
					return text('stream.windowChars', { n: value ?? 0 })
				case 'stream.maxInterventionsPerCall':
					return Number(value) === 0
						? text('stream.maxUnlimited')
						: text('stream.maxLimited', { n: value ?? 0 })
				case 'stream.unitRun':
					return value === false ? text('stream.unitRunOff') : text('stream.unitRunOn')
				case 'stream.unitRepeats':
					return text('stream.unitRepeats', { n: value ?? 0 })
				case 'toolGuard.mode':
					return text(`toolGuard.mode.${value}`)
				case 'toolGuard.scope':
					return text(`toolGuard.scope.${value}`)
				case 'toolGuard.minRun':
					return text('toolGuard.minRun', { n: value ?? 0 })
				case 'toolGuard.maxArgsChars':
					return text('toolGuard.maxArgsChars', { n: value ?? 0 })
				case 'toolGuard.unitRun':
					return value === false ? text('toolGuard.unitRunOff') : text('toolGuard.unitRunOn')
				case 'toolGuard.unitRepeats':
					return text('toolGuard.unitRepeats', { n: value ?? 0 })
				case 'postExecute.enabled':
					return value === false ? text('postExecute.off') : text('postExecute.on')
				case 'postExecute.maxFileBytes':
					return text('postExecute.maxFileBytes', { n: value ?? 0 })
				case 'postExecute.roots':
					return list(value) === ''
						? text('postExecute.rootsEmpty')
						: text('postExecute.rootsSome', { list: list(value) })
				case 'retry.policy':
					return text(`retry.policy.${value}`)
				case 'retry.maxSameModelRetries':
					return text('retry.maxSameModelRetries', { n: value ?? 0 })
				case 'retry.recurrenceLimit':
					return text('retry.recurrenceLimit', { n: value ?? 0 })
				case 'retry.switchModel.enabled':
					return value === false ? text('switchModel.off') : text('switchModel.on')
				case 'retry.switchModel.provider':
					return value ? text('switchModel.provider', { v: value }) : text('switchModel.providerEmpty')
				case 'retry.switchModel.model':
					return value ? text('switchModel.model', { v: value }) : text('switchModel.modelEmpty')
				case 'artifacts.roots':
					return list(value) === ''
						? text('artifacts.rootsEmpty')
						: text('artifacts.rootsSome', { list: list(value) })
				case 'artifacts.minRun':
					return text('artifacts.minRun', { n: value ?? 0 })
				case 'artifacts.unitRun':
					return value === false ? text('artifacts.unitRunOff') : text('artifacts.unitRunOn')
				case 'artifacts.unitRepeats':
					return text('artifacts.unitRepeats', { n: value ?? 0 })
				case 'artifacts.mode':
					return text(`artifacts.mode.${value}`)
				case 'artifacts.apply':
					return value === true ? text('artifacts.applyOn') : text('artifacts.applyOff')
				case 'artifacts.maxFileBytes':
					return text('artifacts.maxFileBytes', { n: value ?? 0 })
				case 'sessions.minRun':
					return text('sessions.minRun', { n: value ?? 0 })
				case 'sessions.unitRun':
					return value === false ? text('sessions.unitRunOff') : text('sessions.unitRunOn')
				case 'sessions.unitRepeats':
					return text('sessions.unitRepeats', { n: value ?? 0 })
				case 'sessions.mode':
					return text(`sessions.mode.${value}`)
				case 'sessions.maskMode':
					return text(`sessions.maskMode.${value}`)
				case 'logging.enabled':
					return value === false ? text('logging.off') : text('logging.on')
				case 'logging.dir':
					return value ? text('logging.dir', { v: value }) : text('logging.dirEmpty')
				case 'logging.maxSidecarChars':
					return text('logging.maxSidecarChars', { n: value ?? 0 })
				case 'ack.enabled':
					return value === false ? text('ack.off') : text('ack.on')
				case 'ack.autoRelax':
					return value === false ? text('ack.autoRelaxOff') : text('ack.autoRelaxOn')
				case 'commands.enabled':
					return value === false ? text('commands.off') : text('commands.on')
				default:
					return ''
			}
		}

		/** 效果说明文案（按配置路径分组）。 */
		const EFFECT_TEXT = {
			enabledOn: '守卫总开关已打开：判定、拦截、修复入口全部生效。',
			enabledOff: '守卫总开关已关闭：不再做任何检测与拦截，历史记录仍然保留。',
			modelIncludesEmpty: '不按模型过滤：所有模型的输出都纳入守卫。',
			modelIncludesSome: '只对模型名里包含「{list}」的模型生效，其余模型完全不受影响。',
			rules: '规则表决定哪些退化形态会被判定为命中；每条规则可单独关闭或放宽阈值。',
			'stream.off': '这个通道不做任何流式检测：退化内容会原样输出。',
			'stream.truncate': '这个通道命中即截断：退化段及其之后的内容直接丢弃（内容没落盘，无法回退）。',
			'stream.sanitize': '这个通道命中即折叠：退化段替换成一个标记，原文记进日志，可按条回退。',
			'stream.holdbackChars': '每次输出都保留末尾 {n} 个字符不参与检测，避免把正在写的句子判掉。',
			'stream.windowChars': '每次检测只看最近 {n} 个字符的窗口，更早的内容不再重复检测。',
			'stream.maxUnlimited': '不限次数：一次调用里发现多少处退化就干预多少次。',
			'stream.maxLimited': '一次调用最多干预 {n} 次；超过这个次数后本轮不再动作。',
			'stream.unitRunOn': '流式守卫也认「多字符单元重复」（例如 ⇒⇒§ ⇒⇒§ § 整段整段地重复）：净化通道把它折叠成〔退化单元×N〕，截断通道直接截断。份数阈值用下面这一项。',
			'stream.unitRunOff': '流式守卫只管同一个符号连成一片的退化，多字符单元重复不在本守卫的治理范围内。',
			'stream.unitRepeats': '流式守卫里，同一个单元连续重复 {n} 次才算退化；这一项只管流式通道，工件与会话治理各有一份。',
			'toolGuard.mode.off': '不检查工具参数：退化内容可以原样传进工具。',
			'toolGuard.mode.warn': '只记一条日志、照常执行这次工具调用（不拦）。',
			'toolGuard.mode.refuse': '直接拒绝这次工具调用，并把判定记进日志。',
			'toolGuard.scope.oversized-only': '只检查参数特别长的调用，普通参数不检查。',
			'toolGuard.scope.write-only': '只检查会写文件的工具调用。',
			'toolGuard.scope.all': '检查所有工具参数，包括很短的参数。',
			'toolGuard.minRun': '连续 {n} 个退化符号才算命中；阈值越大越不容易误报。',
			'toolGuard.maxArgsChars': '参数超过 {n} 个字符才算「超大参数」；未超过的参数按上面的范围规则处理。',
			'toolGuard.unitRunOn': '工具参数里出现「多字符单元重复」（例如 ⇒⇒§ ⇒⇒§ § 整段整段地重复）也算命中，模型会收到一条说明。份数阈值用下面这一项。',
			'toolGuard.unitRunOff': '工具参数只查同一个符号连成一片的退化，多字符单元重复不在本守卫的治理范围内。',
			'toolGuard.unitRepeats': '工具参数守卫里，同一个单元连续重复 {n} 次才算命中；这一项只管工具入参，工件与会话治理各有一份。',
			'postExecute.on': '工具写完文件后会再扫一遍文件内容，发现退化就记判定。',
			'postExecute.off': '不校验写入结果：工具写出的退化内容不会被发现。',
			'postExecute.maxFileBytes': '只校验 {n} 字节以内的文件；更大的文件会被跳过。',
			'postExecute.rootsEmpty': '留空表示不校验任何目录（写入后校验等于不生效）。',
			'postExecute.rootsSome': '只校验「{list}」这些目录里的文件。',
			'retry.policy.same-model': '退化后用同一个模型重新请求一次（次数上限见下面两项）。',
			'retry.policy.steer': '退化后给模型追加提示，让它换个写法再试。',
			'retry.policy.no-retry': '退化后不重试：这次回答照常交付。',
			'retry.maxSameModelRetries': '同一个模型最多重试 {n} 次。',
			'retry.recurrenceLimit': '一次任务里累计重试最多 {n} 次，超过就停。',
			'switchModel.on': '允许在退化反复出现时自动换一个模型回答。',
			'switchModel.off': '不自动换模型：退化后仍然用原来的模型。',
			'switchModel.provider': '换模型时切到 provider「{v}」。',
			'switchModel.providerEmpty': '留空表示沿用当前的 provider。',
			'switchModel.model': '换模型时使用模型「{v}」。',
			'switchModel.modelEmpty': '留空表示沿用当前模型。',
			'artifacts.rootsEmpty': '留空表示用当前工作区兜底：扫描会覆盖整个工作区。',
			'artifacts.rootsSome': '只扫描「{list}」这些目录里的文件。',
			'artifacts.minRun': '连续 {n} 个退化符号才算命中。',
			'artifacts.unitRunOn': '多字符单元整段重复（例如 ⇒⇒§ ⇒⇒§ §）也按退化治理。',
			'artifacts.unitRunOff': '只治理同一个符号连成一片的退化，单元重复不看。',
			'artifacts.unitRepeats': '同一个单元重复 {n} 次才算退化。',
			'artifacts.mode.collapse': '修复时把退化段折叠成一个标记，原文保留在标记旁边。',
			'artifacts.mode.remove': '修复时把退化段整段删掉。',
			'artifacts.applyOn': '点「修复」会直接写盘；否则只出预览。',
			'artifacts.applyOff': '点「修复」只出预览，不会改文件。',
			'artifacts.maxFileBytes': '单个文件超过 {n} 字节就不扫（会在报告里列为跳过）。',
			'sessions.minRun': '会话里连续 {n} 个退化符号才算命中。',
			'sessions.unitRunOn': '会话存档里出现「多字符单元重复」（例如 ⇒⇒§ ⇒⇒§ § 整段整段地重复）也按退化遮蔽。',
			'sessions.unitRunOff': '会话遮蔽只治理同一个符号连成一片的退化，多字符单元重复不看。',
			'sessions.unitRepeats': '同一个单元重复 {n} 次才算退化。',
			'sessions.mode.copy': '遮蔽会话时另存为副本，原会话存档不动。',
			'sessions.mode.replace': '遮蔽会话时就地改写存档（原文件先备份）。',
			'sessions.maskMode.collapse': '把退化段折叠成标记，保留前后文。',
			'sessions.maskMode.remove': '把退化段整段删掉。',
			'logging.on': '每次命中都会写进判定日志（含时间、位置与处理动作）。',
			'logging.off': '不写判定日志：命中记录不会被保存。',
			'logging.dir': '日志与旁车文件写在「{v}」。',
			'logging.dirEmpty': '留空表示用默认目录（~/.dsh/guard-degen）。',
			'logging.maxSidecarChars': '旁车文件最多存 {n} 个字符，超出部分只留摘要。',
			'ack.on': '可以把某次命中登记为误报，并自动放宽对应规则。',
			'ack.off': '不登记误报：每次命中都会照常拦截。',
			'ack.autoRelaxOn': '登记误报后自动放宽对应规则的阈值。',
			'ack.autoRelaxOff': '登记误报后只记录，不自动放宽规则。',
			'commands.on': '可以用 /degen-scan 等斜杠命令手动触发扫描。',
			'commands.off': '不注册斜杠命令：只能从界面里触发扫描。',
		}

		/** 字段标签（中文/英文共用一套 key）。 */
		const FIELD_LABELS = {
			enabled: '启用守卫',
			modelIncludes: '生效模型过滤（包含即生效，留空表示全部）',
			rules: '检测规则表（JSON）',
			stream: '流式守卫',
			'stream.reasoning': '推理流策略',
			'stream.text': '正文流策略',
			'stream.holdbackChars': '回看窗口字符数',
			'stream.windowChars': '检测窗口字符数',
			'stream.maxInterventionsPerCall': '单次调用最多干预次数',
			'stream.unitRun': '治理多字符单元重复',
			'stream.unitRepeats': '单元重复份数阈值',
			toolGuard: '工具参数守卫',
			'toolGuard.mode': '工具参数模式',
			'toolGuard.scope': '工具参数范围',
			'toolGuard.minRun': '退化游程阈值',
			'toolGuard.maxArgsChars': '超大参数阈值',
			'toolGuard.unitRun': '治理多字符单元重复',
			'toolGuard.unitRepeats': '单元重复份数阈值',
			postExecute: '写入后校验',
			'postExecute.enabled': '启用写入后校验',
			'postExecute.maxFileBytes': '校验文件大小上限',
			'postExecute.roots': '校验根目录',
			retry: '重试策略',
			'retry.policy': '重试策略',
			'retry.maxSameModelRetries': '同模型重试次数',
			'retry.recurrenceLimit': '累计重试上限',
			'retry.switchModel': '自动换模型',
			'retry.switchModel.enabled': '启用自动换模型',
			'retry.switchModel.provider': '目标 provider',
			'retry.switchModel.model': '目标模型',
			artifacts: '工件治理',
			'artifacts.roots': '工件扫描根目录',
			'artifacts.minRun': '工件退化游程阈值',
			'artifacts.unitRun': '治理多字符单元重复',
			'artifacts.unitRepeats': '单元重复份数阈值',
			'artifacts.mode': '工件修复方式',
			'artifacts.apply': '工件修复默认落盘',
			'artifacts.maxFileBytes': '单文件大小上限（字节，超限文件会被跳过并列出）',
			sessions: '会话治理',
			'sessions.minRun': '会话退化游程阈值',
			'sessions.unitRun': '治理多字符单元重复',
			'sessions.unitRepeats': '单元重复份数阈值',
			'sessions.mode': '会话遮蔽模式',
			'sessions.maskMode': '会话遮蔽内容方式',
			logging: '日志',
			'logging.enabled': '启用日志',
			'logging.dir': '日志目录',
			'logging.maxSidecarChars': '旁车文件大小上限',
			ack: '误报反馈',
			'ack.enabled': '启用误报反馈',
			'ack.autoRelax': '误报后自动放宽规则',
			commands: '斜杠命令',
			'commands.enabled': '启用斜杠命令',
		}

		/**
		 * 造一个带参数替换的取文案函数。
		 *
		 * locale 服务本身不做插值，这里补上最常见的一种：
		 * 文案里写 `{masked}`，调用时传 `{ masked: 4 }` 就会被替换掉。
		 *
		 * @param {Function} translate - locale 的取词函数
		 * @returns {Function} 取文案函数
		 */
		function makeTranslator(translate) {
			return (key, params) => {
				const text = typeof translate === 'function' ? translate(key) : key
				if (!params) return text
				return String(text).replace(/\{(\w+)\}/g, (match, name) =>
					Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match)
			}
		}

		/**
		 * 页签面板的外壳属性。
		 *
		 * 分区把当前选中的页签通过 owner prop（`activeTab`）传下来；
		 * 没选中的页签用 `hidden` 藏起来而不是卸载——
		 * 卸载会让扫出来的报告、对照视图跟着一起消失。
		 *
		 * @param {string} id - 页签自己的 id
		 * @param {string} activeTab - 当前选中的页签 id
		 * @param {string} className - 根节点类名
		 * @returns {object} 属性
		 */
		function tabPanelProps(id, activeTab, className) {
			return {
				id: `guard-degen-panel-${id}`,
				className,
				role: 'tabpanel',
				'aria-labelledby': `guard-degen-tab-${id}`,
				hidden: typeof activeTab === 'string' ? activeTab !== id : undefined,
			}
		}

		/**
		 * 配置页。
		 * @param {object} props - 属性
		 * @returns {object} 元素
		 */
		function ConfigTab(props) {
			const { remote } = props
			const t = makeTranslator(props.t)
			const [state, setState] = React.useState({ phase: 'loading', view: null, draft: null, message: '', errors: [], busy: false })

			const load = React.useCallback(async () => {
				setState((prev) => ({ ...prev, phase: 'loading', message: '', errors: [] }))
				try {
					const view = await callRemote(remote, 'getConfig')
					setState({ phase: 'ready', view, draft: cloneJson(view.config), message: '', errors: [], busy: false })
				} catch (err) {
					setState((prev) => ({ ...prev, phase: 'error', message: String(err?.message ?? err), busy: false }))
				}
			}, [remote])

			React.useEffect(() => {
				load()
			}, [load])

			const setPath = (path, value) => setState((prev) => ({ ...prev, draft: setIn(prev.draft, path, value) }))

			const save = async () => {
				const patch = diffTopLevel(state.view?.config ?? {}, state.draft ?? {})
				if (Object.keys(patch).length === 0) {
					setState((prev) => ({ ...prev, message: t('noChange') }))
					return
				}
				setState((prev) => ({ ...prev, busy: true, message: '', errors: [] }))
				try {
					const result = await callRemote(remote, 'setConfig', patch)
					if (result && result.ok === false) {
						setState((prev) => ({ ...prev, busy: false, errors: result.errors ?? [] }))
						return
					}
					const config = result?.config ?? patch
					setState((prev) => ({
						...prev,
						busy: false,
						view: { ...prev.view, config, override: result?.override ?? prev.view?.override },
						draft: cloneJson(config),
						message: t('saved'),
					}))
				} catch (err) {
					setState((prev) => ({ ...prev, busy: false, message: String(err?.message ?? err) }))
				}
			}

			const clearOverride = async () => {
				setState((prev) => ({ ...prev, busy: true, message: '', errors: [] }))
				try {
					const result = await callRemote(remote, 'setConfig', null)
					const config = result?.config ?? state.view?.config
					setState((prev) => ({
						...prev,
						busy: false,
						view: { ...prev.view, config, override: result?.override ?? {} },
						draft: cloneJson(config),
						message: t('saved'),
					}))
				} catch (err) {
					setState((prev) => ({ ...prev, busy: false, message: String(err?.message ?? err) }))
				}
			}

			const panel = tabPanelProps('guard-degen-config', props.activeTab, 'gd-root')
			if (state.phase === 'loading') {
				return h('div', panel, h('div', { className: 'gd-message' }, t('loading')))
			}

			if (state.phase === 'error') {
				return h('div', panel,
					h('div', { className: 'gd-message', 'data-tone': 'error' }, `${t('failed')}: ${state.message}`),
					h('div', { className: 'gd-actions' },
						h('button', { className: 'gd-button', type: 'button', onClick: load }, t('retry'))))
			}

			const view = state.view ?? {}
			const spec = view.spec ?? {}
			const overrideKeys = Object.keys(view.override ?? {})

			return h('div', panel,
				h('div', { className: 'gd-head' },
					h('h3', { className: 'gd-title' }, t('tabConfig')),
					h('p', { className: 'gd-sub' },
						`${view.config?.enabled === false ? t('enabledOff') : t('enabledOn')} · `,
						`${t('overrideFile')}: ${view.overrideFile ?? ''} · `,
						overrideKeys.length > 0 ? `${t('overrideActive')}(${overrideKeys.join(', ')})` : t('overrideEmpty'))),
				h('div', { className: 'gd-card' },
					h('h4', { className: 'gd-card-title' }, t('groupStream')),
					h('div', { className: 'gd-grid' },
						Object.entries(spec)
							.filter(([, def]) => def.type === 'object')
							.map(([key, def]) => h(Field, {
								key,
								def,
								value: getIn(state.draft ?? {}, [key]),
								path: [key],
								onChange: setPath,
								label: FIELD_LABELS[key] ?? key,
							})))),
				h('div', { className: 'gd-card' },
					h('h4', { className: 'gd-card-title' }, t('groupOthers')),
					h('div', { className: 'gd-grid' },
						Object.entries(spec)
							.filter(([, def]) => def.type !== 'object')
							.map(([key, def]) => h(Field, {
								key,
								def,
								value: getIn(state.draft ?? {}, [key]),
								path: [key],
								onChange: setPath,
								label: FIELD_LABELS[key] ?? key,
							})))),
				h('div', { className: 'gd-actions' },
					h('button', { className: 'gd-button', type: 'button', 'data-primary': 'true', disabled: state.busy, onClick: save }, t('save')),
					h('button', { className: 'gd-button', type: 'button', disabled: state.busy, onClick: clearOverride }, t('clearOverride')),
					h('button', { className: 'gd-button', type: 'button', disabled: state.busy, onClick: load }, t('reload'))),
				state.message ? h('div', { className: 'gd-message' }, state.message) : null,
				state.errors.length > 0
					? h('ul', { className: 'gd-message', 'data-tone': 'error' },
						state.errors.map((item, index) => h('li', { key: index }, `${item.path ?? ''} ${item.message ?? ''}`)))
					: null)
		}

		// ── 判定日志页 ───────────────────────────────────────────────────────

		/**
		 * 说明这次判定检出了什么退化特征。
		 *
		 * 判定日志只记了结构化的字段（「哪条规则、几个、什么单元」），
		 * 这里把它们拼成一句人话，让人不必去猜 unit-run 到底命中了什么。
		 *
		 * @param {object} entry - 判定记录
		 * @param {Function} t - 取文案
		 * @returns {string} 特征说明
		 */
		function describeVerdictFeature(entry, t) {
			const unit = String(entry?.unit ?? '')
			const repeats = Number(entry?.repeats ?? entry?.count ?? 0)
			if (entry?.rule === 'unit-run' && unit) {
				return t('logsFeatureUnit', { unit, repeats })
			}
			if (entry?.rule === 'symbol-run') {
				return t('logsFeatureSymbol', { count: repeats })
			}
			return t('logsFeatureGeneric', { count: repeats })
		}

		/**
		 * 判定动作的中文说法。
		 * @param {string} action - 动作（sanitize / truncate / warn / refuse / block）
		 * @param {Function} t - 取文案
		 * @returns {string} 动作说明
		 */
		function verdictActionLabel(action, t) {
			const map = {
				sanitize: 'logsActionSanitize',
				truncate: 'logsActionTruncate',
				warn: 'logsActionWarn',
				refuse: 'logsActionRefuse',
				block: 'logsActionBlock',
			}
			const key = map[String(action ?? '')]
			return key ? t(key) : String(action ?? '')
		}

		/**
		 * 把一条判定记录摊成红/绿对照的片段。
		 *
		 * 红色一行是「治理前」的退化内容（净化时是被折叠掉的原文，其余情况是判定依据），
		 * 绿色一行是「治理后」留下的东西：
		 * - 净化（sanitize）：留下折叠标记；
		 * - 截断（truncate）：后面没有了，只留一句说明；
		 * - 其余（告警 / 拒绝 / 拦截）：输出没被改写，只留一句说明。
		 *
		 * @param {object} entry - 判定记录
		 * @param {Function} t - 取文案
		 * @returns {object[]} 对照片段
		 */
		function verdictDiffSegments(entry, t) {
			const removed = String(entry?.original ?? entry?.evidence ?? '')
			if (removed.length === 0) return []
			const action = String(entry?.action ?? '')
			const marker = typeof entry?.marker === 'string' ? entry.marker : ''
			const isSanitize = action === 'sanitize' && marker.length > 0
			const addedNote = isSanitize
				? ''
				: action === 'truncate' ? t('logsNoteTruncate')
					: action === 'warn' ? t('logsNoteWarn')
						: action === 'refuse' ? t('logsNoteRefuse')
							: action === 'block' ? t('logsNoteBlock')
								: t('logsNotRemediated')
			return [{
				event: 1,
				path: `${entry?.channel ?? ''} · ${entry?.rule ?? ''}`,
				action: 'collapse',
				before: '',
				after: '',
				removed,
				removedTruncated: false,
				added: isSanitize ? marker : '',
				addedNote,
				note: describeVerdictFeature(entry, t),
				kind: String(entry?.rule ?? ''),
				unit: String(entry?.unit ?? ''),
				repeats: Number(entry?.repeats ?? entry?.count ?? 0),
			}]
		}

		/**
		 * 判定记录的红/绿对照视图。
		 *
		 * 与工件、会话页**同一套行式标记**：改写前（灰）、被拿掉的退化原文（红）、
		 * 治理后留下的东西（绿）。
		 *
		 * @param {object} props - 属性
		 * @param {object} props.entry - 判定记录
		 * @param {Function} props.t - 取文案
		 * @returns {object} 元素
		 */
		function VerdictDiff(props) {
			const { entry } = props
			const t = makeTranslator(props.t)
			const segments = verdictDiffSegments(entry, t)
			if (segments.length === 0) return null
			return h('div', { className: 'gd-diff' },
				h(DiffHead, {
					title: t('logsDiffTitle'),
					removedLabel: t('logsDiffRemoved'),
					addedLabel: t('logsDiffAdded'),
					t,
				}),
				h(DiffBody, { segments, t }))
		}

		/**
		 * 判定日志页：按会话筛选，点一条看退化特征与治理前后对照。
		 *
		 * 列表每行都带会话 id 与会话名称 —— 判定是挂在某次会话上的，
		 * 只看「模型 / 规则」根本不知道是哪一次会话出的问题。
		 *
		 * @param {object} props - 属性
		 * @returns {object} 元素
		 */
		function LogsTab(props) {
			const { remote } = props
			const t = makeTranslator(props.t)
			const [state, setState] = React.useState({
				phase: 'loading',
				entries: [],
				sessions: [],
				total: 0,
				sessionId: '',
				query: '',
				selectedId: '',
				busy: false,
				message: '',
			})

			/**
			 * 拉取判定流水（可只取某一个会话）。
			 * @param {string} sessionId - 会话 id（空串表示全部）
			 * @param {string} [selectId] - 拉完后选中的记录
			 * @returns {Promise<void>} 完成
			 */
			const load = React.useCallback(async (sessionId, selectId = '') => {
				const wanted = typeof sessionId === 'string' ? sessionId : ''
				setState((prev) => ({ ...prev, phase: 'loading', message: '' }))
				try {
					const view = await callRemote(remote, 'getVerdicts', 200, wanted || undefined)
					setState((prev) => ({
						...prev,
						phase: 'ready',
						entries: Array.isArray(view?.entries) ? view.entries : [],
						sessions: Array.isArray(view?.sessions) ? view.sessions : [],
						total: Number(view?.total ?? 0),
						sessionId: wanted,
						selectedId: selectId,
					}))
				} catch (err) {
					setState((prev) => ({ ...prev, phase: 'error', message: String(err?.message ?? err) }))
				}
			}, [remote])

			/**
			 * 把一次判定登记为误报。
			 * @param {string} verdictId - 判定 id
			 * @returns {Promise<void>} 完成
			 */
			const ack = async (verdictId) => {
				setState((prev) => ({ ...prev, busy: true, message: '' }))
				try {
					await callRemote(remote, 'ackVerdict', verdictId)
					await load(state.sessionId, verdictId)
					setState((prev) => ({ ...prev, busy: false, message: t('verdictAcdked') }))
				} catch (err) {
					setState((prev) => ({ ...prev, busy: false, message: String(err?.message ?? err) }))
				}
			}

			React.useEffect(() => {
				load('')
			}, [load])

			const panel = tabPanelProps('guard-degen-logs', props.activeTab, 'gd-root')
			if (state.phase === 'loading') {
				return h('div', panel, h('div', { className: 'gd-message' }, t('loading')))
			}
			if (state.phase === 'error') {
				return h('div', panel,
					h('div', { className: 'gd-message', 'data-tone': 'error' }, `${t('failed')}: ${state.message}`),
					h('div', { className: 'gd-actions' },
						h('button', { className: 'gd-button', type: 'button', onClick: () => load(state.sessionId, state.selectedId) }, t('retry'))))
			}

			// 文本筛选：会话 id 或会话名称里含有这段字的就留下。
			const query = String(state.query ?? '').trim().toLowerCase()
			const entries = (state.entries ?? []).filter((entry) => {
				if (!query) return true
				const sessionId = String(entry?.sessionId ?? '').toLowerCase()
				const title = String(entry?.sessionTitle ?? '').toLowerCase()
				return sessionId.includes(query) || title.includes(query)
			})
			const selected = (state.entries ?? []).find((entry) => (entry?.id ?? `${entry?.ts}`) === state.selectedId) ?? null

			return h('div', panel,
				h('div', { className: 'gd-head' },
					h('h3', { className: 'gd-title' }, t('tabLogs')),
					h('p', { className: 'gd-sub' }, t('logsIntro'))),
				h('div', { className: 'gd-card' },
					h('div', { className: 'gd-log-filters' },
						h('label', { className: 'gd-log-filter' },
							h('span', { className: 'gd-label' }, t('logsSessionFilter')),
							h('select', {
								className: 'gd-input',
								value: state.sessionId ?? '',
								onChange: (event) => load(event?.target?.value ?? ''),
							},
								h('option', { value: '' }, t('logsAllSessions')),
								(state.sessions ?? []).map((session) => h('option', {
									key: session?.sessionId || 'no-session',
									value: session?.sessionId ?? '',
								}, session?.sessionTitle
									? `${session.sessionTitle} · ${session.sessionId}`
									: (session?.sessionId ? session.sessionId : t('logsNoSession')))))),
						h('label', { className: 'gd-log-filter' },
							h('span', { className: 'gd-label' }, t('logsSessionSearch')),
							h('input', {
								className: 'gd-input',
								type: 'text',
								value: state.query ?? '',
								placeholder: t('logsSessionSearch'),
								onChange: (event) => setState((prev) => ({ ...prev, query: event?.target?.value ?? '' })),
							})),
						h('div', { className: 'gd-actions' },
							h('button', { className: 'gd-button', type: 'button', disabled: state.busy, onClick: () => load(state.sessionId, state.selectedId) }, t('logsReload')))),
					h('div', { className: 'gd-message' }, t('logsTotal', { n: state.total ?? 0 }))),
				entries.length === 0
					? h('div', { className: 'gd-message' }, state.sessionId ? t('logsEmptySession') : t('logsEmpty'))
					: h('div', { className: 'gd-card' },
						h('div', { className: 'gd-scroll' },
							h('table', { className: 'gd-table' },
								h('thead', null, h('tr', null,
									h('th', null, t('logsTime')),
									h('th', null, t('logsSessionId')),
									h('th', null, t('logsSessionTitle')),
									h('th', null, t('logsModel')),
									h('th', null, t('logsRule')),
									h('th', null, t('logsChannel')),
									h('th', null, t('logsAction')),
									h('th', null, t('logsFeature')),
									h('th', null, t('logsOperations')))),
								h('tbody', null, entries.map((entry) => {
									const key = entry?.id ?? `${entry?.ts}`
									const isSelected = key === state.selectedId
									return h('tr', {
										key,
										'data-clickable': 'true',
										'data-selected': isSelected ? 'true' : undefined,
										onClick: () => setState((prev) => ({ ...prev, selectedId: isSelected ? '' : key })),
									},
										h('td', null, String(entry?.ts ?? '')),
										h('td', { className: 'gd-log-session' }, entry?.sessionId || t('logsNoSession')),
										h('td', null, entry?.sessionTitle || t('logsUntitled')),
										h('td', { className: 'gd-path' }, entry?.model ?? ''),
										h('td', null, entry?.rule ?? ''),
										h('td', null, entry?.channel ?? ''),
										h('td', null, verdictActionLabel(entry?.action, t)),
										h('td', null, describeVerdictFeature(entry, t)),
										h('td', null, h('button', {
											className: 'gd-button',
											type: 'button',
											disabled: state.busy || entry?.id === undefined,
											onClick: (event) => {
												event?.stopPropagation?.()
												ack(entry.id)
											},
										}, t('verdictAck'))))
								}))))),
				selected
					? h('div', { className: 'gd-card' },
						h('h4', { className: 'gd-card-title' }, t('logsDetailTitle')),
						h('div', { className: 'gd-log-kv' },
							h('span', null, `${t('logsTime')}: `, h('b', null, String(selected?.ts ?? ''))),
							h('span', null, `${t('logsSessionId')}: `, h('b', null, selected?.sessionId || t('logsNoSession'))),
							h('span', null, `${t('logsSessionTitle')}: `, h('b', null, selected?.sessionTitle || t('logsUntitled'))),
							h('span', null, `${t('logsModel')}: `, h('b', null, selected?.model ?? '')),
							h('span', null, `${t('logsRule')}: `, h('b', null, selected?.rule ?? '')),
							h('span', null, `${t('logsChannel')}: `, h('b', null, selected?.channel ?? '')),
							h('span', null, `${t('logsAction')}: `, h('b', null, verdictActionLabel(selected?.action, t))),
							h('span', null, `${t('logsDetailSeverity')}: `, h('b', null, selected?.severity ?? ''))),
						h('div', { className: 'gd-log-kv' },
							h('span', null, `${t('logsFeature')}: `, h('b', null, describeVerdictFeature(selected, t))),
							h('span', null, selected?.action === 'sanitize' || selected?.action === 'truncate'
								? t('logsRemediated')
								: t('logsNotRemediated'))),
						selected?.evidence
							? h('div', { className: 'gd-log-kv' },
								h('span', null, `${t('logsDetailEvidence')}: `),
								h('span', { className: 'gd-path' }, String(selected.evidence)))
							: null,
						h(VerdictDiff, { entry: selected, t }))
					: h('div', { className: 'gd-message' }, t('logsDetailEmpty')),
				state.message ? h('div', { className: 'gd-message' }, state.message) : null)
		}

		// ── 遮蔽结果对照 ─────────────────────────────────────────────────────

		/**
		 * 红/绿对照的正文：遮蔽与工件修复**共用同一套行式标记**。
		 *
		 * 一段退化摊成四行：
		 * - 灰：这段在哪儿（第几处、哪个文件）；
		 * - 灰：改写前的上下文；
		 * - 红：被拿掉的那段退化内容；
		 * - 绿：换上去的东西（或者「这里什么都不留」）；
		 * - 灰：改写后的上下文。
		 *
		 * @param {object} props - 属性
		 * @param {Array<object>} props.segments - 对照片段
		 * @param {Function} props.t - 取文案
		 * @returns {object} 元素
		 */
		function DiffBody(props) {
			const { segments } = props
			const t = makeTranslator(props.t)
			return h('div', { className: 'gd-diff-body' },
				segments.map((segment, index) => {
					// remove 方式**没有替换文本**：退化段被整段删掉。
					// 对照视图直接把两行真实内容摆出来——「遮蔽前」是原文，
					// 「遮蔽后」是删完剩下的文字。符号是真的不见了，
					// 而不是「被换成了某一句话」。
					const isRemove = segment.action === 'remove'
					const original = typeof segment.originalWindow === 'string' ? segment.originalWindow : ''
					const masked = typeof segment.maskedWindow === 'string' ? segment.maskedWindow : ''
					const added = typeof segment.added === 'string' ? segment.added : ''
				// 多字符单元重复：把「哪个单元、重复了几份」写在片段标题后面。
				// 文案在**客户端**拼（宿主只给结构化字段），这样界面语言跟着界面走。
				// 片段自带 note 时以它为准（工件页用的是 artifactDiffUnitNote）。
				const isUnitRun = segment.kind === 'unit-run' || segment.rule === 'unit-run'
				const note = String(segment.note ?? '') || (isUnitRun && segment.unit
					? t('maskUnitNote', { unit: segment.unit, repeats: segment.repeats ?? 0 })
					: '')
					return h('div', { key: index },
						h('div', { className: 'gd-diff-line', 'data-kind': 'context' },
							h('span', { className: 'gd-diff-mark' }, ' '),
							h('span', null, `#${segment.event ?? 0} ${segment.path ?? ''}`),
							note ? h('span', { className: 'gd-diff-note' }, ` · ${note}`) : null),
						isRemove ? null : h('div', { className: 'gd-diff-line', 'data-kind': 'context' },
							h('span', { className: 'gd-diff-mark' }, ' '),
							h('span', null, segment.before ?? '')),
						h('div', { className: 'gd-diff-line', 'data-kind': 'remove' },
							h('span', { className: 'gd-diff-mark' }, '-'),
							isRemove
								? h('span', null, `${segment.originalTruncatedBefore ? '…' : ''}${original}${segment.originalTruncatedAfter ? '…' : ''}`)
								: h('span', null, `${segment.removed ?? ''}${segment.removedTruncated ? '…' : ''}`)),
						h('div', { className: 'gd-diff-line', 'data-kind': 'add' },
							h('span', { className: 'gd-diff-mark' }, '+'),
							isRemove
								? (masked.trim().length > 0
									? h('span', null, `${segment.maskedTruncatedBefore ? '…' : ''}${masked}${segment.maskedTruncatedAfter ? '…' : ''}`)
									: h('span', { className: 'gd-diff-note' }, t('diffCleared')))
								: (added.length > 0
									? h('span', null, added)
									: h('span', { className: 'gd-diff-note' }, segment.addedNote ?? t('diffCleared')))),
						isRemove ? null : h('div', { className: 'gd-diff-line', 'data-kind': 'context' },
							h('span', { className: 'gd-diff-mark' }, ' '),
							h('span', null, segment.after ?? '')))
				}))
		}

		/**
		 * 红/绿对照的头部：标题 + 图例。
		 * @param {object} props - 属性
		 * @param {string} props.title - 标题
		 * @param {string} props.removedLabel - 「改写前」的说法
		 * @param {string} props.addedLabel - 「改写后」的说法
		 * @param {boolean} [props.truncated] - 是否只显示了一部分
		 * @param {Function} props.t - 取文案
		 * @returns {object} 元素
		 */
		function DiffHead(props) {
			const { title, removedLabel, addedLabel } = props
			const t = makeTranslator(props.t)
			return h('div', { className: 'gd-diff-head' },
				h('span', null, title),
				h('span', { className: 'gd-diff-legend' },
					h('span', null, h('span', { className: 'gd-diff-swatch', 'data-kind': 'remove' }), removedLabel),
					h('span', null, h('span', { className: 'gd-diff-swatch', 'data-kind': 'add' }), addedLabel)),
				props.truncated ? h('span', null, t('diffTruncated')) : null)
		}

		/**
		 * 遮蔽结果的红/绿对照视图。
		 *
		 * 会话存档动辄几 MB，整份贴到界面上没有意义；
		 * 这里只把**被遮蔽的那几段**按「原文 / 改写后」两行摊开，
		 * 前后各带一小截上下文，方便定位到具体字段。
		 *
		 * @param {object} props - 属性
		 * @param {object} props.preview - 宿主给的预览数据
		 * @param {Function} props.t - 取文案
		 * @returns {object} 元素
		 */
		function MaskDiff(props) {
			const { preview } = props
			const t = makeTranslator(props.t)
			const segments = Array.isArray(preview?.segments) ? preview.segments : []
			if (segments.length === 0) {
				return h('div', { className: 'gd-message' }, t('diffEmpty'))
			}
			return h('div', { className: 'gd-diff' },
				h(DiffHead, {
					title: t('diffTitle'),
					removedLabel: t('diffRemoved'),
					addedLabel: t('diffAdded'),
					truncated: preview?.truncated === true,
					t,
				}),
				h(DiffBody, { segments, t }))
		}

		/**
		 * 工件修复的红/绿对照视图。
		 *
		 * 与遮蔽对照**同一套格式**：改写前的上下文（灰）、被拿掉的退化原文（红）、
		 * 换上去的标记（绿）、改写后的上下文（灰）。
		 * 预览和落盘给的是同一份数据 —— 预览里看到的红绿，落盘后就是那样。
		 *
		 * @param {object} props - 属性
		 * @param {object} props.preview - 宿主给的预览数据
		 * @param {string} [props.addNote] - 什么都不留时的说明（整段删除模式）
		 * @param {Function} props.t - 取文案
		 * @returns {object} 元素
		 */
		function RepairDiff(props) {
			const { preview } = props
			const t = makeTranslator(props.t)
			const raw = Array.isArray(preview?.segments) ? preview.segments : []
			if (raw.length === 0) return null
			// 「为什么这一段被判定成退化」写在片段旁边：
			// 单元重复要说清楚是哪个单元、重复了几次。
			const segments = raw.map((segment) => {
				const note = segment.kind === 'unit-run'
					? t('artifactDiffUnitNote', { unit: segment.unit ?? '', repeats: segment.repeats ?? 0 })
					: ''
				const addedNote = segment.added ? segment.addedNote : (segment.addedNote ?? props.addNote ?? '')
				return { ...segment, note, addedNote }
			})
			return h('div', { className: 'gd-diff' },
				h(DiffHead, {
					title: t('artifactDiffTitle'),
					removedLabel: t('artifactDiffRemoved'),
					addedLabel: t('artifactDiffAdded'),
					truncated: preview?.truncated === true,
					t,
				}),
				h(DiffBody, { segments, t }))
		}

		// ── 工件/会话页 ──────────────────────────────────────────────────────

		/**
		 * 工件扫描与修复页。
		 * @param {object} props - 属性
		 * @returns {object} 元素
		 */
		function ArtifactsTab(props) {
			const { remote } = props
			const t = makeTranslator(props.t)
			const [state, setState] = React.useState({
				roots: '',
				mode: 'collapse',
				report: null,
				selected: [],
				repair: null,
				busy: false,
				message: '',
				sessions: null,
				sessionSelected: '',
				maskMode: 'collapse',
				// 工件页遮蔽的是**历史**会话，默认仍按配置的 copy（另存副本），
				// 想就地改写可以在下拉框里切。
				maskTarget: 'copy',
				mask: null,
			})

			React.useEffect(() => {
				let alive = true
				callRemote(remote, 'getConfig')
					.then((view) => {
						if (!alive) return
						setState((prev) => ({
							...prev,
							roots: (view?.config?.artifacts?.roots ?? []).join(', '),
							mode: view?.config?.artifacts?.mode === 'remove' ? 'remove' : 'collapse',
							maskMode: view?.config?.sessions?.maskMode === 'remove' ? 'remove' : 'collapse',
							maskTarget: view?.config?.sessions?.mode === 'replace' ? 'replace' : 'copy',
						}))
					})
					.catch(() => {})
				return () => {
					alive = false
				}
			}, [remote])

			const scan = async () => {
				setState((prev) => ({ ...prev, busy: true, message: '', repair: null }))
				try {
					const roots = splitList(state.roots)
					// 扫描范围先写进配置：修复是按配置里的根目录约束的，
					// 两边口径必须一致，否则会出现「扫得到、修不了」。
					const saved = await callRemote(remote, 'setConfig', { artifacts: { roots } })
					if (saved && saved.ok === false) {
						setState((prev) => ({ ...prev, busy: false, message: (saved.errors ?? []).map((item) => item.message ?? String(item)).join('; ') || t('failed') }))
						return
					}
					const report = await callRemote(remote, 'scanArtifacts', roots.length > 0 ? { roots } : {})
					setState((prev) => ({ ...prev, busy: false, report, selected: [] }))
				} catch (err) {
					setState((prev) => ({ ...prev, busy: false, message: `${t('failed')}: ${err?.message ?? err}` }))
				}
			}

			const toggle = (path) => setState((prev) => ({
				...prev,
				selected: prev.selected.includes(path)
					? prev.selected.filter((item) => item !== path)
					: [...prev.selected, path],
			}))

			const repair = async (apply) => {
				if (state.selected.length === 0) return
				if (apply && typeof globalThis.confirm === 'function' && !globalThis.confirm(t('artifactConfirm'))) return
				setState((prev) => ({ ...prev, busy: true, message: '' }))
				try {
					const result = await callRemote(remote, 'repairArtifacts', {
						files: state.selected,
						mode: state.mode,
						apply,
					})
					setState((prev) => ({ ...prev, busy: false, repair: result }))
				} catch (err) {
					setState((prev) => ({ ...prev, busy: false, message: `${t('failed')}: ${err?.message ?? err}` }))
				}
			}

			const scanSessions = async () => {
				setState((prev) => ({ ...prev, busy: true, message: '', mask: null }))
				try {
					const report = await callRemote(remote, 'scanSessions', {})
					setState((prev) => ({ ...prev, busy: false, sessions: report, sessionSelected: '' }))
				} catch (err) {
					setState((prev) => ({ ...prev, busy: false, message: `${t('failed')}: ${err?.message ?? err}` }))
				}
			}

			const runMask = async (apply, maskMode) => {
				if (!state.sessionSelected) return
				if (apply && typeof globalThis.confirm === 'function' && !globalThis.confirm(t('sessionMaskConfirm'))) return
				setState((prev) => ({ ...prev, busy: true, message: '' }))
				try {
					const result = await callRemote(remote, 'cleanSessions', {
						sessionId: state.sessionSelected,
						mode: state.maskTarget,
						apply,
						maskMode,
					})
					setState((prev) => ({ ...prev, busy: false, mask: result }))
				} catch (err) {
					setState((prev) => ({ ...prev, busy: false, message: `${t('failed')}: ${err?.message ?? err}` }))
				}
			}

			const mask = (apply) => runMask(apply, state.maskMode)

			// 换一种遮蔽方式，预览立刻按新方式重算：
			// 红绿对照必须反映当前选中的方式，否则预览是在骗人。
			const changeMaskMode = async (value) => {
				setState((prev) => ({ ...prev, maskMode: value }))
				if (!state.sessionSelected || !state.mask) return
				await runMask(false, value)
			}

			// 换一种落地方式（copy / replace），预览也要跟着重算。
			const changeMaskTarget = async (value) => {
				setState((prev) => ({ ...prev, maskTarget: value }))
				if (!state.sessionSelected || !state.mask) return
				await runMask(false, state.maskMode)
			}

			const files = state.report?.files ?? []
			const sessions = (state.sessions?.sessions ?? []).filter((item) => item.runCount > 0)

			return h('div', tabPanelProps('guard-degen-artifacts', props.activeTab, 'gd-root'),
				h('div', { className: 'gd-head' },
					h('h3', { className: 'gd-title' }, t('tabArtifacts')),
					h('p', { className: 'gd-sub' }, state.message ?? '')),
				h('div', { className: 'gd-card' },
					h('h4', { className: 'gd-card-title' }, t('artifactScan')),
					h('label', { className: 'gd-field' },
						h('span', { className: 'gd-label' }, t('artifactRoots')),
						h('input', {
							type: 'text',
							className: 'gd-input',
							value: state.roots,
							onChange: (event) => setState((prev) => ({ ...prev, roots: event.target.value })),
						}),
						h('span', { className: 'gd-hint' }, t('artifactRootsHint'))),
					h('label', { className: 'gd-field gd-field-inline' },
						h('span', { className: 'gd-label' }, t('artifactMode')),
						h('select', {
							className: 'gd-input',
							value: state.mode,
							onChange: (event) => setState((prev) => ({ ...prev, mode: event.target.value })),
						},
						h('option', { key: 'collapse', value: 'collapse' }, t('artifactModeCollapse')),
						h('option', { key: 'remove', value: 'remove' }, t('artifactModeRemove')))),
					h('span', { className: 'gd-hint' }, t('artifactModeHint')),
					h('div', { className: 'gd-actions' },
						h('button', { className: 'gd-button', type: 'button', 'data-primary': 'true', disabled: state.busy, onClick: scan }, state.busy ? t('artifactScanning') : t('artifactScan')),
						h('button', { className: 'gd-button', type: 'button', disabled: state.busy || state.selected.length === 0, onClick: () => repair(false) }, t('artifactPreview')),
						h('button', { className: 'gd-button', type: 'button', disabled: state.busy || state.selected.length === 0, onClick: () => repair(true) }, t('artifactApply'))),
					files.length === 0 && state.report
						? h('div', { className: 'gd-message' }, t('artifactEmpty'))
						: null,
					// 超大文件被跳过了，必须说出来：否则「没扫到」会被误读成「没问题」。
					(state.report?.skippedTooLarge ?? []).length > 0
						? h('div', { className: 'gd-message gd-warn' },
							`${t('artifactSkippedTooLarge')}: ${state.report.skippedTooLarge.slice(0, 20).join(', ')}`
							+ (state.report.skippedTooLarge.length > 20 ? ` …(+${state.report.skippedTooLarge.length - 20})` : ''))
						: null,
					files.length > 0
						? h('div', { className: 'gd-actions' },
							h('button', { className: 'gd-button', type: 'button', onClick: () => setState((prev) => ({ ...prev, selected: files.map((item) => item.path) })) }, t('artifactSelectAll')),
							h('button', { className: 'gd-button', type: 'button', onClick: () => setState((prev) => ({ ...prev, selected: [] })) }, t('artifactClear')))
						: null,
					h(ArtifactTable, { files, selected: state.selected, onToggle: toggle }),
					state.repair
						? h(RepairResultCard, { result: state.repair, t })
						: null),
				h('div', { className: 'gd-card' },
					h('h4', { className: 'gd-card-title' }, t('sessionScan')),
					h('div', { className: 'gd-actions' },
						h('button', { className: 'gd-button', type: 'button', disabled: state.busy, onClick: scanSessions }, state.busy ? t('sessionScanning') : t('sessionScan'))),
					state.sessions && sessions.length === 0 ? h('div', { className: 'gd-message' }, t('sessionEmpty')) : null,
					sessions.length > 0
						? h('div', { className: 'gd-scroll' },
							h('table', { className: 'gd-table' },
								h('thead', null, h('tr', null,
									h('th', null, ''),
									h('th', null, 'session'),
									h('th', null, 'runs'),
									h('th', null, 'symbols'),
									h('th', null, 'max'))),
								h('tbody', null, sessions.map((session) => h('tr', { key: session.path },
									h('td', null, h('input', {
										type: 'checkbox',
										checked: state.sessionSelected === session.id,
										onChange: () => setState((prev) => ({ ...prev, sessionSelected: session.id })),
									})),
									h('td', null, h('div', { className: 'gd-session' },
										h('span', { className: 'gd-session-title' },
											session.title ? session.title : t('sessionUntitled')),
										h('span', { className: 'gd-session-id' }, session.id || session.path))),
									h('td', null, String(session.runCount)),
									h('td', null, String(session.symbolCount)),
									h('td', null, String(session.maxRun)))))))
						: null,
					h('label', { className: 'gd-field gd-field-inline' },
						h('span', { className: 'gd-label' }, t('maskMode')),
						h('select', {
							className: 'gd-input',
							value: state.maskMode,
							onChange: (event) => { changeMaskMode(event.target.value) },
						},
						h('option', { key: 'collapse', value: 'collapse' }, t('maskModeCollapse')),
						h('option', { key: 'remove', value: 'remove' }, t('maskModeRemove')))),
					h('label', { className: 'gd-field gd-field-inline' },
						h('span', { className: 'gd-label' }, t('maskTarget')),
						h('select', {
							className: 'gd-input',
							value: state.maskTarget,
							onChange: (event) => { changeMaskTarget(event.target.value) },
						},
						h('option', { key: 'copy', value: 'copy' }, t('maskTargetCopy')),
						h('option', { key: 'replace', value: 'replace' }, t('maskTargetReplace')))),
					h('span', { className: 'gd-hint' }, state.maskTarget === 'replace' ? t('maskTargetReplaceHint') : t('maskTargetHint')),
					h('span', { className: 'gd-hint' }, t('maskModeHint')),
					state.maskMode === 'remove' ? h('span', { className: 'gd-hint' }, t('maskModeRemoveHint')) : null,
					h('div', { className: 'gd-actions' },
						h('button', { className: 'gd-button', type: 'button', disabled: state.busy || !state.sessionSelected, onClick: () => mask(false) }, t('sessionMaskPreview')),
						h('button', { className: 'gd-button', type: 'button', disabled: state.busy || !state.sessionSelected, onClick: () => mask(true) }, t('sessionMaskApply'))),
					state.mask
						? h(MaskResultCard, { mask: state.mask, t: props.t })
						: null))
		}

		// ── 共用片段 ──────────────────────────────────────────────────────────

		/**
		 * 工件文件表（工件页与会话视图共用）。
		 * @param {object} props - 属性
		 * @param {Array<object>} props.files - 命中的文件
		 * @param {string[]} props.selected - 已选中的路径
		 * @param {Function} props.onToggle - 勾选回调
		 * @returns {object} 元素
		 */
		function ArtifactTable(props) {
			const files = Array.isArray(props?.files) ? props.files : []
			const selected = Array.isArray(props?.selected) ? props.selected : []
			if (files.length === 0) return null
			return h('div', { className: 'gd-scroll' },
				h('table', { className: 'gd-table' },
					h('thead', null, h('tr', null,
						h('th', null, ''),
						h('th', null, 'path'),
						h('th', null, 'runs'),
						h('th', null, 'symbols'),
						h('th', null, 'max'))),
					h('tbody', null, files.map((file) => h('tr', { key: file.path },
						h('td', null, h('input', {
							type: 'checkbox',
							checked: selected.includes(file.path),
							onChange: () => props.onToggle(file.path),
						})),
						h('td', { className: 'gd-path' }, file.path),
						h('td', null, String(file.runCount)),
						h('td', null, String(file.symbolCount)),
						h('td', null, String(file.maxRun)))))))
		}

		/**
		 * 工件修复结果表（工件页与会话视图共用）。
		 * @param {object} props - 属性
		 * @param {Array<object>} props.results - 逐文件结果
		 * @returns {object} 元素
		 */
		function RepairResultTable(props) {
			const results = Array.isArray(props?.results) ? props.results : []
			if (results.length === 0) return null
			return h('div', { className: 'gd-scroll' },
				h('table', { className: 'gd-table' },
					h('thead', null, h('tr', null,
						h('th', null, 'path'),
						h('th', null, 'changed'),
						h('th', null, 'replaced'),
						h('th', null, 'symbols'),
						h('th', null, 'backup'),
						h('th', null, 'error'))),
					h('tbody', null, results.map((row) => h('tr', { key: row.path },
						h('td', { className: 'gd-path' }, row.path),
						h('td', null, String(row.changed === true)),
						h('td', null, String(row.replaced ?? 0)),
						h('td', null, String(row.symbols ?? 0)),
						h('td', { className: 'gd-path' }, row.backup ?? ''),
						h('td', null, row.error ?? ''))))))
		}

		/**
		 * 遮蔽结果卡片：摘要 + 红绿对照（工件页与会话视图共用）。
		 * @param {object} props - 属性
		 * @param {object} props.mask - 宿主给的遮蔽结果
		 * @param {Function} props.t - 取文案
		 * @returns {object} 元素
		 */
		function MaskResultCard(props) {
			const mask = props?.mask
			const t = makeTranslator(props?.t)
			if (!mask) return null
			// replace 模式写的就是会话存档本身，不是「另存了一份」。
			const inPlace = mask.mode === 'replace'
			return h('div', { className: 'gd-card' },
				h('h4', { className: 'gd-card-title' }, t('diffTitle')),
				h('div', { className: 'gd-message' },
					mask.applied ? t('maskApplied') : t('maskPreviewOnly'),
					' · ',
					t('maskSummary', { masked: mask.masked ?? 0, symbols: mask.symbols ?? 0 }),
					mask.remaining ? ` · ${t('maskRemaining', { remaining: mask.remaining })}` : '',
					// 预览模式下 output 只是「会写到哪儿」，并没有真的落盘。
					mask.applied && mask.output
						? ` · ${inPlace ? t('maskAppliedInPlace', { path: mask.output }) : t('maskOutput', { path: mask.output })}`
						: '',
					mask.applied && mask.backup ? ` · ${t('maskBackup', { path: mask.backup })}` : '',
					mask.replanned ? ` · ${t('maskReplanned')}` : '',
					mask.error ? ` · ${t('maskError', { message: mask.error })}` : ''),
				mask.preview ? h(MaskDiff, { preview: mask.preview, t }) : null)
		}

		/**
		 * 工件修复结果卡片：摘要 + 逐文件的红绿对照（工件页与会话视图共用）。
		 *
		 * 勾选的文件修了什么，不能只给一句「改了 3 个文件」——
		 * 这里把每一处退化的「改写前 / 改写后」摊成红绿对照，
		 * 和会话遮蔽的对照视图是同一套格式。
		 *
		 * @param {object} props - 属性
		 * @param {object} props.result - 宿主给的修复结果
		 * @param {Function} props.t - 取文案
		 * @returns {object} 元素
		 */
		function RepairResultCard(props) {
			const result = props?.result
			const t = makeTranslator(props?.t)
			if (!result) return null
			const results = Array.isArray(result.results) ? result.results : []
			return h('div', { className: 'gd-card' },
				h('h4', { className: 'gd-card-title' }, t('artifactResult')),
				h('div', { className: 'gd-message' },
					`${result.applied ? 'applied' : 'preview'} · `,
					`requested=${result.summary?.requested ?? 0} `,
					`changed=${result.summary?.changed ?? 0} `,
					`failed=${result.summary?.failed ?? 0} `,
					`symbols=${result.summary?.symbols ?? 0}`),
				h(RepairResultTable, { results }),
				results.map((row) => h(RepairDiff, {
					key: row.path,
					preview: row.preview,
					addNote: result.mode === 'remove' ? t('artifactDiffRemovedNote') : '',
					t,
				})))
		}

		// ── 会话视图 ──────────────────────────────────────────────────────────

		/**
		 * 把时间戳格式成本地时间。
		 * @param {string} ts - ISO 时间串
		 * @returns {string} 形如 2026-10-30 14:05:09 的时间
		 */
		function formatStamp(ts) {
			if (!ts) return ''
			const date = new Date(ts)
			if (Number.isNaN(date.getTime())) return String(ts)
			const pad = (n) => String(n).padStart(2, '0')
			return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
		}

		/**
		 * 流式干预流水。
		 *
		 * 每一次检测命中都记一条：什么时候、哪个通道、命中哪条规则、
		 * 做了什么处理（截断 / 净化折叠）、在会话里的哪个位置。
		 * 净化条目可以预览红绿对照，也能按条回退。
		 *
		 * @param {object} props - 属性
		 * @returns {object} 元素
		 */
		function InterventionPanel(props) {
			const { remote, sessionId, onOpenChat } = props
			const t = makeTranslator(props.t)
			const [state, setState] = React.useState({ entries: null, error: '', busy: false, expanded: {}, message: '' })

			const load = React.useCallback(async () => {
				setState((prev) => ({ ...prev, busy: true, error: '' }))
				try {
					const result = await callRemote(remote, 'listInterventions', { sessionId })
					if (result && result.ok === false) {
						setState((prev) => ({ ...prev, busy: false, entries: [], error: result.error ?? t('failed') }))
						return
					}
					setState((prev) => ({ ...prev, busy: false, entries: Array.isArray(result?.entries) ? result.entries : [], error: '' }))
				} catch (err) {
					setState((prev) => ({ ...prev, busy: false, entries: [], error: String(err?.message ?? err) }))
				}
			}, [remote, sessionId])

			React.useEffect(() => {
				load()
			}, [load])

			const revert = async (entry) => {
				if (typeof globalThis.confirm === 'function' && !globalThis.confirm(t('interventionRevertConfirm'))) return
				setState((prev) => ({ ...prev, busy: true, message: '' }))
				try {
					const result = await callRemote(remote, 'revertIntervention', { id: entry.id })
					if (result && result.ok === false) {
						setState((prev) => ({ ...prev, busy: false, message: t('interventionRevertFail', { message: result.error ?? '' }) }))
						await load()
						return
					}
					setState((prev) => ({ ...prev, busy: false, message: t('interventionRevertDone'), reverted: true }))
					await load()				} catch (err) {
					setState((prev) => ({ ...prev, busy: false, message: t('interventionRevertFail', { message: String(err?.message ?? err) }) }))
				}
			}

			const toggle = (id) => setState((prev) => ({
				...prev,
				expanded: { ...prev.expanded, [id]: prev.expanded[id] !== true },
			}))

			const entries = state.entries
			return h('div', { className: 'gd-card' },
				h('div', { className: 'gd-head' },
					h('h4', { className: 'gd-card-title' }, t('interventionsTitle')),
					h('button', { className: 'gd-button', type: 'button', disabled: state.busy, onClick: load }, t('interventionsRefresh'))),
				h('p', { className: 'gd-sub' }, t('interventionsIntro')),
				state.message ? h('div', { className: 'gd-message' }, state.message) : null,
				state.reverted ? h('div', { className: 'gd-message gd-warn' }, t('interventionRevertMemoryNote')) : null,
				state.error ? h('div', { className: 'gd-message', 'data-tone': 'error' }, state.error) : null,
				entries === null
					? h('div', { className: 'gd-message' }, t('interventionsLoading'))
					: entries.length === 0
						? h('div', { className: 'gd-message' }, t('interventionsEmpty'))
						: h('div', { className: 'gd-interventions' }, entries.map((entry) => {
							const open = state.expanded[entry.id] === true
							const actionText = entry.action === 'sanitize' ? t('interventionActionSanitize') : t('interventionActionTruncate')
							const positionText = entry.position
								? `${t('interventionPosition')} #${entry.position.event} · ${entry.position.path ?? ''}`
								: t('interventionNoPosition')
							return h('div', { key: entry.id, className: 'gd-intervention', 'data-reverted': entry.reverted ? 'true' : 'false' },
								h('div', { className: 'gd-intervention-head' },
									h('span', { className: 'gd-tag' }, formatStamp(entry.ts)),
									h('span', { className: 'gd-tag' }, entry.channel ?? ''),
									h('span', { className: 'gd-tag' }, entry.rule ?? ''),
									h('span', { className: 'gd-tag', 'data-tone': entry.action === 'sanitize' ? 'ok' : 'warn' }, actionText),
									entry.reverted ? h('span', { className: 'gd-tag', 'data-tone': 'muted' }, t('interventionReverted')) : null),
								h('div', { className: 'gd-intervention-pos' }, positionText),
								h('div', { className: 'gd-actions' },
									h('button', { className: 'gd-button', type: 'button', onClick: () => toggle(entry.id) }, t('interventionPreviewToggle')),
									h('button', {
										className: 'gd-button',
										type: 'button',
										disabled: !entry.position || typeof onOpenChat !== 'function',
										onClick: () => onOpenChat(entry),
									}, t('interventionLocate')),
									entry.restorable
										? h('button', {
											className: 'gd-button',
											type: 'button',
											disabled: state.busy,
											onClick: () => revert(entry),
										}, t('interventionRevert'))
										: h('span', { className: 'gd-hint' }, entry.reverted ? t('interventionReverted') : t('interventionNotRestorable'))),
								open ? h(MaskDiff, { preview: entry.preview, t: props.t }) : null)
						})))
		}

		/**
		 * 把含有指定标记的消息滚到眼前。
		 *
		 * 对话视图没有消费定位参数，所以这里自己找：按标记文本在页面里定位
		 * 第一个包含它的元素，滚到视口中央并短暂高亮。
		 * 找不到就什么都不做（视图已经切换过去了，用户仍能看到会话）。
		 *
		 * @param {string} marker - 折叠标记文本
		 * @returns {void}
		 */
		function scrollToMarker(marker) {
			if (!marker || typeof document === 'undefined') return
			const needle = String(marker)
			const tryScroll = () => {
				const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
				let node = walker.nextNode()
				while (node) {
					if (node.nodeValue && node.nodeValue.includes(needle)) {
						const host = node.parentElement
						// 跳过本插件自己的界面（差分预览里也有同样的标记文本）。
						const ours = host?.closest?.('.gd-root')
						if (!ours && host && typeof host.scrollIntoView === 'function') {
							host.scrollIntoView({ block: 'center', behavior: 'smooth' })
							host.classList.add('gd-located')
							setTimeout(() => host.classList.remove('gd-located'), 1600)
							return true
						}
					}
					node = walker.nextNode()
				}
				return false
			}
			// 对话视图是切换后才渲染的：先等一小会儿，没找到再试几次。
			let tries = 0
			const tick = () => {
				tries += 1
				if (tryScroll() || tries >= 12) return
				setTimeout(tick, 120)
			}
			setTimeout(tick, 120)
		}

		/**
		 * 会话视图「退化守卫」：针对**当前会话**的退化治理。
		 *
		 * - 工件目录 = 当前会话所在的工作目录（由宿主从会话存档头部解析，
		 *   浏览器仍然不能点名任意目录）；
		 * - 要修的会话 = 当前会话。
		 *
		 * 比全局的「工件」页更有针对性：修的就是眼前这个会话。
		 *
		 * @param {object} props - 属性
		 * @param {string} props.sessionId - 当前会话 id
		 * @param {object} props.remote - 远程方法
		 * @param {Function} props.t - 取文案
		 * @returns {object} 元素
		 */
		function GuardDegenSessionView(props) {
			const { remote, sessionId } = props
			const t = makeTranslator(props.t)
			const [state, setState] = React.useState({
				workspace: null,
				selected: [],
				mode: 'collapse',
				maskMode: 'collapse',
				// 会话视图里的遮蔽默认**就地改写**当前会话：
				// 用户来这里就是要修眼前这个会话，不是要一份副本。
				maskTarget: 'replace',
				repair: null,
				mask: null,
				busy: false,
				message: '',
			})

			React.useEffect(() => {
				let alive = true
				callRemote(remote, 'getConfig')
					.then((view) => {
						if (!alive) return
						setState((prev) => ({
							...prev,
							mode: view?.config?.artifacts?.mode === 'remove' ? 'remove' : 'collapse',
							maskMode: view?.config?.sessions?.maskMode === 'remove' ? 'remove' : 'collapse',
						}))
					})
					.catch(() => {})
				return () => {
					alive = false
				}
			}, [remote])

			const scan = async () => {
				setState((prev) => ({ ...prev, busy: true, message: '', repair: null }))
				try {
					const workspace = await callRemote(remote, 'scanSessionWorkspace', { sessionId })
					if (workspace && workspace.ok === false) {
						setState((prev) => ({ ...prev, busy: false, message: workspace.error ?? t('failed') }))
						return
					}
					setState((prev) => ({ ...prev, busy: false, workspace, selected: [] }))
				} catch (err) {
					setState((prev) => ({ ...prev, busy: false, message: `${t('failed')}: ${err?.message ?? err}` }))
				}
			}

			const toggle = (path) => setState((prev) => ({
				...prev,
				selected: prev.selected.includes(path)
					? prev.selected.filter((item) => item !== path)
					: [...prev.selected, path],
			}))

			const repair = async (apply) => {
				if (state.selected.length === 0) return
				if (apply && typeof globalThis.confirm === 'function' && !globalThis.confirm(t('artifactConfirm'))) return
				setState((prev) => ({ ...prev, busy: true, message: '' }))
				try {
					const result = await callRemote(remote, 'repairArtifacts', {
						files: state.selected,
						mode: state.mode,
						apply,
						sessionId,
					})
					setState((prev) => ({ ...prev, busy: false, repair: result }))
				} catch (err) {
					setState((prev) => ({ ...prev, busy: false, message: `${t('failed')}: ${err?.message ?? err}` }))
				}
			}

			const runMask = async (apply, maskMode) => {
				if (!sessionId) return
				if (apply && typeof globalThis.confirm === 'function' && !globalThis.confirm(t('sessionMaskConfirm'))) return
				setState((prev) => ({ ...prev, busy: true, message: '' }))
				try {
					const result = await callRemote(remote, 'cleanSessions', {
						sessionId,
						mode: state.maskTarget,
						apply,
						maskMode,
					})
					setState((prev) => ({ ...prev, busy: false, mask: result }))
				} catch (err) {
					setState((prev) => ({ ...prev, busy: false, message: `${t('failed')}: ${err?.message ?? err}` }))
				}
			}

			// 换一种遮蔽方式，预览立刻按新方式重算。
			const changeMaskMode = async (value) => {
				setState((prev) => ({ ...prev, maskMode: value }))
				if (!state.mask) return
				await runMask(false, value)
			}

			// 换一种落地方式，预览也按新方式重算：
			// copy 与 replace 写的是不同的东西，preview 必须与将要落盘的一致。
			const changeMaskTarget = async (value) => {
				setState((prev) => ({ ...prev, maskTarget: value }))
				if (!state.mask) return
				await runMask(false, state.maskMode)
			}

			const files = state.workspace?.report?.files ?? []
			const session = state.workspace?.session ?? null
			const skipped = state.workspace?.report?.skippedTooLarge ?? []

			return h('div', { className: 'gd-root gd-view' },
				h('div', { className: 'gd-head' },
					h('h3', { className: 'gd-title' }, t('viewGuardDegen')),
					h('p', { className: 'gd-sub' }, t('sessionViewIntro'))),
				h('div', { className: 'gd-card' },
					h('h4', { className: 'gd-card-title' }, t('sessionViewWorkspace')),
					h('div', { className: 'gd-actions' },
						h('button', { className: 'gd-button', type: 'button', 'data-primary': 'true', disabled: state.busy, onClick: scan }, state.busy ? t('sessionViewScanning') : t('sessionViewScan'))),
					session
						? h('div', { className: 'gd-message' },
							`${t('sessionViewCwd')}: ${session.cwd ?? ''}`,
							session.title ? ` · ${session.title}` : '')
						: null,
					files.length === 0 && state.workspace ? h('div', { className: 'gd-message' }, t('sessionViewEmpty')) : null,
					skipped.length > 0
						? h('div', { className: 'gd-message gd-warn' },
							`${t('artifactSkippedTooLarge')}: ${skipped.slice(0, 20).join(', ')}`
							+ (skipped.length > 20 ? ` …(+${skipped.length - 20})` : ''))
						: null,
					files.length > 0
						? h('div', { className: 'gd-actions' },
							h('button', { className: 'gd-button', type: 'button', onClick: () => setState((prev) => ({ ...prev, selected: files.map((item) => item.path) })) }, t('artifactSelectAll')),
							h('button', { className: 'gd-button', type: 'button', onClick: () => setState((prev) => ({ ...prev, selected: [] })) }, t('artifactClear')))
						: null,
					h(ArtifactTable, { files, selected: state.selected, onToggle: toggle }),
					h('label', { className: 'gd-field gd-field-inline' },
						h('span', { className: 'gd-label' }, t('artifactMode')),
						h('select', {
							className: 'gd-input',
							value: state.mode,
							onChange: (event) => setState((prev) => ({ ...prev, mode: event.target.value })),
						},
						h('option', { key: 'collapse', value: 'collapse' }, t('maskModeCollapse')),
						h('option', { key: 'remove', value: 'remove' }, t('maskModeRemove')))),
					h('div', { className: 'gd-actions' },
						h('button', { className: 'gd-button', type: 'button', disabled: state.busy || state.selected.length === 0, onClick: () => repair(false) }, t('artifactPreview')),
						h('button', { className: 'gd-button', type: 'button', disabled: state.busy || state.selected.length === 0, onClick: () => repair(true) }, t('artifactApply'))),
					state.repair
						? h(RepairResultCard, { result: state.repair, t })
						: null),
				h('div', { className: 'gd-card' },
					h('h4', { className: 'gd-card-title' }, t('sessionViewCurrent')),
					session
						? h('div', { className: 'gd-message' },
							`${t('sessionViewRuns')}: ${session.runCount ?? 0} · `,
							`${t('sessionViewSymbols')}: ${session.symbolCount ?? 0} · `,
							`${t('sessionViewMax')}: ${session.maxRun ?? 0}`,
							session.title ? ` · ${session.title}` : '')
						: null,
					h('label', { className: 'gd-field gd-field-inline' },
						h('span', { className: 'gd-label' }, t('maskMode')),
						h('select', {
							className: 'gd-input',
							value: state.maskMode,
							onChange: (event) => { changeMaskMode(event.target.value) },
						},
						h('option', { key: 'collapse', value: 'collapse' }, t('maskModeCollapse')),
						h('option', { key: 'remove', value: 'remove' }, t('maskModeRemove')))),
					h('label', { className: 'gd-field gd-field-inline' },
						h('span', { className: 'gd-label' }, t('maskTarget')),
						h('select', {
							className: 'gd-input',
							value: state.maskTarget,
							onChange: (event) => { changeMaskTarget(event.target.value) },
						},
						h('option', { key: 'replace', value: 'replace' }, t('maskTargetReplace')),
						h('option', { key: 'copy', value: 'copy' }, t('maskTargetCopy')))),
					h('span', { className: 'gd-hint' }, state.maskTarget === 'replace' ? t('maskTargetReplaceHint') : t('maskTargetHint')),
					h('span', { className: 'gd-hint' }, t('maskModeHint')),
					state.maskMode === 'remove' ? h('span', { className: 'gd-hint' }, t('maskModeRemoveHint')) : null,
					// 内存里的旧内容这件事必须说清楚：就地改写改的是文件，
					// 宿主内存里的当前会话不会跟着变。
					state.maskTarget === 'replace'
						? h('div', { className: 'gd-message gd-warn' }, t('maskMemoryHint'))
						: null,
					h('div', { className: 'gd-actions' },
						h('button', { className: 'gd-button', type: 'button', disabled: state.busy || !sessionId, onClick: () => runMask(false, state.maskMode) }, t('sessionMaskPreview')),
						h('button', { className: 'gd-button', type: 'button', disabled: state.busy || !sessionId, onClick: () => runMask(true, state.maskMode) }, t('sessionMaskApply'))),
					state.mask
						? h(MaskResultCard, { mask: state.mask, t: props.t })
						: null,
					state.mask?.applied && state.maskTarget === 'replace'
						? h('div', { className: 'gd-message gd-warn' }, t('maskAppliedNote'))
						: null),
				// 流式干预流水：每一次检测命中都记在这里（时间、位置、所做的处理），
				// 净化条目可以预览红绿对照，也能按条回退。
				h(InterventionPanel, {
					remote,
					sessionId,
					t: props.t,
					onOpenChat: (entry) => {
						// 转到「对话」视图，并把那条消息滚到眼前。
						// 对话视图本身不消费定位参数，所以这里自己按标记文本找元素。
						if (typeof props.openView === 'function') props.openView('chat')
						scrollToMarker(entry?.marker)
					},
				}),
				state.message ? h('div', { className: 'gd-message' }, state.message) : null)
		}

		// ── 注入 ─────────────────────────────────────────────────────────────

		/**
		 * 浏览器端依赖的服务。
		 *
		 * 复审缺陷 C1：**不能**把 `remote.guardDegen` 写在这里。
		 * 这个命名空间只由本插件自己的 `ctx.remote.$mount()` 创建（见下面的 `apply`），
		 * 而模块级 `inject` 是 fiber 的依赖表：依赖缺失时 cordis 把 fiber 置为 INACTIVE，
		 * `apply` 根本不会执行 —— 于是 `remote.guardDegen` 永远等不到，
		 * 整个 Web 外壳会把这个「等待服务」的条目当成启动失败，直接抛错不启动。
		 *
		 * 宿主自己的写法也是「先挂载、再在 apply 内注入命名空间」：
		 * `.dsh-src/dsh-experimental-client-ui-cot-translation/lib/client.js:891`
		 * 的模块级 inject 只有 `remote/slots/locale/configForms`，
		 * 命名空间 `remote.cotTranslation` 是在 apply 里 `$mount` 之后才注入的。
		 */
		const inject = ['slots', 'locale', 'remote']

		/**
		 * 挂载 GUI 与远程方法。
		 * @param {object} ctx - 浏览器插件上下文
		 * @returns {Promise<Function>} 卸载函数
		 */
		async function apply(ctx) {
			injectStyle()
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'guard-degen: dictionaries')
			const unmountRemote = await ctx.remote.$mount(buildContribution())
			const ui = ctx.inject(['remote.guardDegen', 'slots', 'locale'], (child) => {
				const t = child.locale.bind(NS)
				const remote = child['remote.guardDegen']
				const props = () => ({ t, remote })
				// 「退化守卫」是与「插件」并列的设置分区：
				// 分区自己声明子槽 `guard-degen.tab`，
				// 「配置 / 日志 / 工件」三个页签挂在它下面（不再是「插件」里的两个页签）。
				let tabsVersion = -1
				let tabsRevision = -1
				let tabs = []
				const sectionInjected = () => ({
					hooks: {
						tabs: {
							getSnapshot: () => {
								const version = child.slots.getVersion('guard-degen.tab')
								const revision = child.locale.getSnapshot().revision
								if (version !== tabsVersion || revision !== tabsRevision) {
									tabsVersion = version
									tabsRevision = revision
									tabs = child.slots.entries('guard-degen.tab')
										.map((entry) => ({
											id: entry.options?.id ?? '',
											order: entry.options?.order ?? 0,
											label: resolveLabel(entry.options?.label),
										}))
										.sort((a, b) => a.order - b.order)
								}
								return tabs
							},
							subscribe: (listener) => {
								const offLedger = child.slots.subscribe('guard-degen.tab', listener)
								const offLocale = child.locale.subscribe(listener)
								return () => {
									offLedger()
									offLocale()
								}
							},
						},
					},
				})
				child.slots.inject('settings.section', () => child.slots.register({
					name: 'settings.section',
					id: 'guard-degen',
					order: 16,
					label: () => t('nav'),
					locale: NS,
					inject: sectionInjected,
					children: {
						'guard-degen.tab': { kind: 'list', scope: 'root' },
					},
				}, GuardDegenSection))
				child.slots.inject('guard-degen.tab', () => child.slots.register({
					name: 'guard-degen.tab',
					id: 'guard-degen-config',
					order: 10,
					label: () => t('tabConfig'),
					locale: NS,
					inject: props,
				}, ConfigTab))
				child.slots.inject('guard-degen.tab', () => child.slots.register({
					name: 'guard-degen.tab',
					id: 'guard-degen-logs',
					order: 15,
					label: () => t('tabLogs'),
					locale: NS,
					inject: props,
				}, LogsTab))
				child.slots.inject('guard-degen.tab', () => child.slots.register({
					name: 'guard-degen.tab',
					id: 'guard-degen-artifacts',
					order: 20,
					label: () => t('tabArtifacts'),
					locale: NS,
					inject: props,
				}, ArtifactsTab))
				// 会话视图「退化守卫」：挂进会话的视图页签行
				//（对话 / 轨迹 / 上下文 / 编队 … 那一排）。
				// 页签里只针对**当前会话**：工件目录是该会话的工作目录，
				// 要修的会话就是当前会话。
				child.slots.inject('conversation.view', () => child.slots.register({
					name: 'conversation.view',
					id: 'guard-degen',
					order: 20,
					label: () => t('viewGuardDegen'),
					locale: NS,
					inject: (sessionId) => ({ sessionId, t, remote }),
				}, GuardDegenSessionView))
			})
			try {
				await ui
			} catch (error) {
				await ui.dispose()
				await unmountRemote()
				throw error
			}
			return async () => {
				await ui.dispose()
				await unmountRemote()
			}
		}

		exports.NS = NS
		exports.apply = apply
		exports.inject = inject
		exports.__test = {
			REMOTE_METHOD_SPECS,
			buildContribution,
			createMiniSchema,
			cloneJson,
			setIn,
			getIn,
			splitList,
			diffTopLevel,
			callRemote,
			makeTranslator,
			GuardDegenSection,
			ConfigTab,
			LogsTab,
			ArtifactsTab,
			MaskDiff,
			ArtifactTable,
			RepairResultTable,
			MaskResultCard,
			DiffBody,
			DiffHead,
			RepairDiff,
			VerdictDiff,
			describeVerdictFeature,
			verdictDiffSegments,
			RepairResultCard,
			GuardDegenSessionView,
			InterventionPanel,
			Field,
			describeEffect,
			formatStamp,
			scrollToMarker,
			CSS,
			zh,
			en,
		}
		return module.exports
	},
})
