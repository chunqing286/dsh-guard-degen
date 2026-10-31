/**
 * 服务实现层：把配置、判定日志、误报白名单、工件扫描与会话遮蔽串成一组
 * 宿主与 GUI 都能调用的能力。
 *
 * 设计要点：
 * - **不依赖 Cordis / typert**：本模块只做业务逻辑，宿主接线在 `lib/index.js`，
 *   这样单测不需要宿主环境。
 * - **所有依赖可注入**：日志、白名单、扫描器都能替换，测试不碰真实磁盘。
 * - **写操作默认关**：修复与遮蔽都要求显式 `apply: true`，默认只出预览。
 *
 * @module dsh-guard-degen/service
 */

import fs from 'node:fs'
import path from 'node:path'
import {
	CONFIG_SPEC,
	overrideFile,
	loadOverride,
	mergeConfig,
	normalizeConfig,
	resolveConfig,
	saveOverride,
	validateConfig,
} from './config.js'
import { DEFAULT_RULES, RULE_IDS, RULE_RELAX_STEP, RULE_SEVERITY, normalizeRules } from './detect.js'
import { VerdictLog, Whitelist, appendJsonl, sampleHash } from './log.js'
import { scanArtifacts as scanArtifactFiles, repairArtifacts as repairArtifactFiles } from './artifacts.js'
import { scanSessions as scanSessionFiles, locateMarkers, maskSession, inspectSession, readSessionMeta, restoreSessionText } from './sessions.js'
import { harnessHome } from './paths.js'

/** 判定日志的默认条数上限。 */
export const DEFAULT_VERDICT_LIMIT = 50
/** 判定日志的最大条数上限。 */
export const MAX_VERDICT_LIMIT = 500
/** 读会话标题时允许的最大存档体积（字节）。 */
const SESSION_TITLE_MAX_BYTES = 16 * 1024 * 1024

/**
 * 在会话根目录里按会话 id 找到存档文件。
 *
 * 宿主的会话存档布局是 `<root>/<项目目录>/<编码后的会话 id>/<文件>.jsonl[.zstd]`，
 * 会话 id 只含安全字符时编码后与原样一致，因此按目录名匹配即可。
 *
 * 目录名有两种写法：裸 id（`0495b230-…`）和 `session-<id>`（`session-12aa8e7e-…`），
 * 而界面那边给的会话 id 又是另一种形态，所以三种写法都要能命中同一个会话。
 *
 * @param {string} root - 会话根目录
 * @param {string} sessionId - 会话 id
 * @returns {string | undefined} 最新命中的文件路径
 */
export function resolveSessionFile(root, sessionId) {
	if (!root || !sessionId) return undefined
	const raw = String(sessionId)
	const bare = raw.replace(/^session-/i, '')
	const needles = Array.from(new Set([raw, bare, `session-${bare}`].filter((item) => item.length > 0)))
	let best
	let bestTime = -1
	/**
	 * 递归收集候选文件。
	 * @param {string} dir - 当前目录
	 * @param {number} depth - 剩余深度
	 */
	const walk = (dir, depth) => {
		if (depth < 0) return
		let entries
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true })
		} catch {
			return
		}
		for (const entry of entries) {
			const full = path.join(dir, entry.name)
			if (entry.isDirectory()) {
				if (needles.some((needle) => entry.name.includes(needle))) {
					collect(full)
				} else {
					walk(full, depth - 1)
				}
			}
		}
	}
	/**
	 * 收集一个目录里的会话存档文件。
	 * @param {string} dir - 会话目录
	 */
	const collect = (dir) => {
		let files
		try {
			files = fs.readdirSync(dir, { withFileTypes: true })
		} catch {
			return
		}
		for (const file of files) {
			if (!file.isFile()) continue
			if (!/\.jsonl(\.zstd)?$/.test(file.name)) continue
			const full = path.join(dir, file.name)
			let time = 0
			try {
				time = fs.statSync(full).mtimeMs
			} catch {
				time = 0
			}
			if (time > bestTime) {
				bestTime = time
				best = full
			}
		}
	}
	walk(root, 4)
	return best
}

/**
 * 创建守卫服务实现。
 *
 * @param {object} [deps] - 依赖
 * @param {object} [deps.config] - 宿主给的配置（profile patch）
 * @param {string} [deps.overrideFile] - 运行时覆盖文件路径
 * @param {boolean} [deps.useOverride] - 是否读运行时覆盖（默认 true）
 * @param {object} [deps.verdictLog] - 判定日志
 * @param {object} [deps.whitelist] - 误报白名单
 * @param {string} [deps.cwd] - 工作区根目录
 * @param {string} [deps.sessionsRoot] - 会话存档根目录
 * @param {Function} [deps.scanArtifacts] - 工件扫描实现
 * @param {Function} [deps.repairArtifacts] - 工件修复实现
 * @param {Function} [deps.scanSessions] - 会话扫描实现
 * @param {Function} [deps.maskSession] - 会话遮蔽实现
 * @returns {object} 服务实现
 */
export function createGuardDegenService(deps = {}) {
	const overrideFilePath = deps.overrideFile ?? overrideFile()
	const useOverride = deps.useOverride !== false
	const verdictLog = deps.verdictLog ?? new VerdictLog({ dir: path.join(harnessHome(), 'guard-degen') })
	const whitelist = deps.whitelist ?? new Whitelist({ file: path.join(harnessHome(), 'guard-degen', 'whitelist.json') })
	const cwd = deps.cwd ?? process.cwd()
	const sessionsRoot = deps.sessionsRoot ?? path.join(harnessHome(), 'sessions')
	const scanArtifacts = deps.scanArtifacts ?? scanArtifactFiles
	const repairArtifacts = deps.repairArtifacts ?? repairArtifactFiles
	const scanSessions = deps.scanSessions ?? scanSessionFiles
	const mask = deps.maskSession ?? maskSession
	const locate = deps.locateMarkers ?? locateMarkers
	const restore = deps.restoreSessionText ?? restoreSessionText
	// 回退台账：记下哪些干预已经被回退过，避免同一条被反复改写。
	const revertsFile = deps.revertsFile ?? path.join(harnessHome(), 'guard-degen', 'reverts.jsonl')

	const state = {
		base: deps.config ?? {},
		override: {},
		config: normalizeConfig(deps.config ?? {}),
	}

	/**
	 * 重新解析配置（宿主热更新或写覆盖文件之后调用）。
	 * @param {object} [config] - 新的宿主配置
	 * @returns {object} 当前生效配置
	 */
	function refresh(config) {
		if (config !== undefined) state.base = config ?? {}
		const resolved = resolveConfig(state.base, {
			overrideFile: overrideFilePath,
			useOverride,
			readFile: deps.readFile,
		})
		state.override = resolved.override
		state.config = resolved.config
		return state.config
	}

	refresh(deps.config)

	/**
	 * 当前生效规则。
	 * @returns {object} 规则表
	 */
	function rules() {
		return normalizeRules(state.config.rules ?? {})
	}

	/**
	 * 判断某个模型是否在守卫范围内。
	 * @param {string} model - 模型名
	 * @returns {boolean} 是否守卫
	 */
	function shouldGuardModel(model) {
		const includes = state.config.modelIncludes ?? []
		if (!Array.isArray(includes) || includes.length === 0) return true
		const name = String(model ?? '')
		return includes.some((item) => name.includes(item))
	}

	/**
	 * 记录一次判定；命中误报白名单时不再落盘。
	 * @param {object} verdict - 裁决
	 * @param {object} [context] - 上下文
	 * @returns {{suppressed: boolean, entry: object | null}} 结果
	 */
	function recordVerdict(verdict, context = {}) {
		const probe = {
			model: context.model ?? null,
			rule: verdict?.rule ?? null,
			sampleHash: context.sampleHash ?? sampleHash(context.sample ?? verdict?.evidence ?? ''),
		}
		if (typeof whitelist.matches === 'function' && whitelist.matches(probe)) {
			return { suppressed: true, entry: null }
		}
		const entry = verdictLog.record(verdict, context)
		return { suppressed: false, entry }
	}

	/**
	 * 解析一个会话的工作目录（**宿主侧**）。
	 *
	 * 浏览器只给会话 id，工作目录由宿主从会话存档的头部读出来 ——
	 * 与 F1 同一条口径：浏览器仍然没有能力点名任意目录。
	 *
	 * @param {string} sessionId - 会话 id
	 * @returns {{ok: boolean, file?: string, cwd?: string, error?: string}} 解析结果
	 */
	function resolveSessionWorkspace(sessionId) {
		const file = resolveSessionFile(sessionsRoot, sessionId)
		if (!file) return { ok: false, error: '找不到对应的会话存档文件。' }
		const meta = readSessionMeta(file)
		if (!meta.ok) return { ok: false, error: meta.error }
		if (!meta.cwd) return { ok: false, error: '读不出这个会话的工作目录。' }
		return { ok: true, file, cwd: meta.cwd }
	}

	// 会话标题缓存：判定日志页要按会话分组、显示「会话名称」，
	// 每次都重读会话存档太贵（存档动辄几 MB），这里按会话 id 记住结果。
	const sessionTitleCache = new Map()

	/**
	 * 读一个会话的名称（会话标题）。
	 *
	 * 会话标题来自存档里的 `session/title` 事件；读不出来就返回空串，
	 * 界面上退化成「（无标题）」，不影响其它列。
	 *
	 * @param {string} sessionId - 会话 id
	 * @returns {string} 会话名称
	 */
	function resolveSessionTitle(sessionId) {
		const id = typeof sessionId === 'string' ? sessionId.trim() : ''
		if (!id) return ''
		if (sessionTitleCache.has(id)) return sessionTitleCache.get(id)
		let title = ''
		try {
			const file = resolveSessionFile(sessionsRoot, id)
			if (file) {
				// 超大的存档不读标题：解一遍存档太慢，标题只是锦上添花。
				let size = 0
				try {
					size = fs.statSync(file).size
				} catch {
					size = 0
				}
				if (size <= SESSION_TITLE_MAX_BYTES) {
					const meta = readSessionMeta(file)
					if (meta.ok) title = meta.title ?? ''
				}
			}
		} catch {
			title = ''
		}
		sessionTitleCache.set(id, title)
		return title
	}

	/**
	 * 汇总判定日志里出现过的会话（供界面做会话选择器）。
	 *
	 * @param {object[]} entries - 全部判定条目
	 * @returns {{sessionId: string, sessionTitle: string, count: number, lastTs: string | null}[]} 会话清单
	 */
	function summarizeSessions(entries) {
		const buckets = new Map()
		for (const entry of entries) {
			const id = typeof entry?.sessionId === 'string' ? entry.sessionId : ''
			const bucket = buckets.get(id) ?? { sessionId: id, sessionTitle: '', count: 0, lastTs: null }
			bucket.count += 1
			if (!bucket.lastTs || String(entry?.ts ?? '') > bucket.lastTs) bucket.lastTs = entry?.ts ?? null
			buckets.set(id, bucket)
		}
		const list = [...buckets.values()]
		for (const bucket of list) bucket.sessionTitle = resolveSessionTitle(bucket.sessionId)
		list.sort((a, b) => String(b.lastTs ?? '').localeCompare(String(a.lastTs ?? '')))
		return list
	}

	const service = {
		/** 当前生效配置（只读快照）。 */
		get config() {
			return state.config
		},
		/** 判定日志。 */
		verdictLog,
		/** 误报白名单。 */
		whitelist,

		refresh,
		rules,
		shouldGuardModel,
		recordVerdict,

		/**
		 * 读取当前配置。
		 * @returns {{config: object, override: object, spec: object, overrideFile: string}} 配置视图
		 */
		getConfig() {
			return {
				config: state.config,
				override: state.override,
				spec: CONFIG_SPEC,
				overrideFile: overrideFilePath,
			}
		},

		/**
		 * 写运行时覆盖（不污染 profile patch）。
		 * @param {object | null} patch - 覆盖内容；传 null 表示清空覆盖
		 * @returns {{ok: boolean, config: object, override: object, errors: object[]}} 结果
		 */
		setConfig(patch) {
			if (patch === null || patch === undefined) {
				saveOverride({}, overrideFilePath, deps.writeFile)
				refresh()
				return { ok: true, config: state.config, override: state.override, errors: [] }
			}
			const check = validateConfig(patch)
			if (!check.valid) {
				return { ok: false, config: state.config, override: state.override, errors: check.errors }
			}
			const next = mergeConfig(state.override, patch)
			// 合并后的整体也要合法：覆盖文件里本来就有的坏值不能被这次写入「带」出去。
			const merged = validateConfig(next)
			if (!merged.valid) {
				return { ok: false, config: state.config, override: state.override, errors: merged.errors }
			}
			const saved = saveOverride(next, overrideFilePath, deps.writeFile)
			if (!saved) {
				return {
					ok: false,
					config: state.config,
					override: state.override,
					errors: [{ path: '', message: `无法写入覆盖文件 ${overrideFilePath}` }],
				}
			}
			refresh()
			return { ok: true, config: state.config, override: state.override, errors: [] }
		},

		/**
		 * 读取规则表。
		 * @returns {{rules: object, defaults: object, ids: string[], severity: object, relaxStep: object}} 规则视图
		 */
		getRules() {
			return {
				rules: rules(),
				defaults: DEFAULT_RULES,
				ids: RULE_IDS,
				severity: RULE_SEVERITY,
				relaxStep: RULE_RELAX_STEP,
			}
		},

		/**
		 * 读取状态总览。
		 * @returns {object} 状态
		 */
		getStatus() {
			const entries = verdictLog.list()
			return {
				enabled: state.config.enabled !== false,
				config: state.config,
				rules: rules(),
				verdicts: entries.slice(-20),
				whitelist: whitelist.list(),
				counts: {
					verdicts: entries.length,
					whitelist: whitelist.list().length,
				},
				lastVerdict: entries.length > 0 ? entries[entries.length - 1] : null,
			}
		},

		/**
		 * 读取判定流水。
		 *
		 * 每条记录都带上会话 id 与会话名称（宿主从会话存档里读出来的），
		 * 界面才能按会话筛选、按会话分组。给了 `sessionId` 就只返回该会话的记录。
		 *
		 * @param {number} [limit] - 最多返回多少条
		 * @param {string} [sessionId] - 只看这一个会话
		 * @returns {{entries: object[], total: number, sessions: object[]}} 判定流水
		 */
		getVerdicts(limit, sessionId) {
			const entries = verdictLog.list()
			const requested = Number(limit)
			const size = Number.isFinite(requested) && requested > 0
				? Math.min(MAX_VERDICT_LIMIT, Math.floor(requested))
				: DEFAULT_VERDICT_LIMIT
			const filter = typeof sessionId === 'string' ? sessionId.trim() : ''
			const matched = filter
				? entries.filter((entry) => (typeof entry?.sessionId === 'string' ? entry.sessionId : '') === filter)
				: entries
			const listed = matched.slice(-size)
			return {
				entries: listed.map((entry) => ({
					...entry,
					sessionTitle: resolveSessionTitle(entry?.sessionId ?? ''),
				})),
				total: matched.length,
				sessions: summarizeSessions(entries),
			}
		},

		/**
		 * 把一次判定登记为误报。
		 * @param {string} [verdictId] - 判定 id；省略则取最近一条
		 * @returns {{ok: boolean, entry?: object, error?: string}} 结果
		 */
		ackVerdict(verdictId) {
			const entries = verdictLog.list()
			const entry = verdictId
				? entries.find((item) => item.id === verdictId)
				: entries[entries.length - 1]
			if (!entry) return { ok: false, error: '没有可确认的判定记录。' }
			const added = whitelist.add({
				model: entry.model ?? '*',
				rule: entry.rule ?? '*',
				sampleHash: entry.sampleHash ?? '*',
				note: `误报确认 @${entry.ts}`,
			})
			return { ok: true, entry: added }
		},

		/**
		 * 扫描工程文件里的退化内容（只读）。
		 *
		 * 只透传白名单里的键：请求来自浏览器端，不能让它指定
		 * 输出路径、备份目录、注入的读写函数。
		 *
		 * @param {object} [options] - 选项
		 * @returns {Promise<object>} 扫描报告
		 */
		async scanArtifacts(options = {}) {
			// 复审缺陷 F1：扫描范围只认配置里的根目录。
			// 原来这里把请求里的 roots 透传下去，于是浏览器能指定任意目录，
			// 报告里会把那些文件的路径、大小、游程形状带出来——等于一个只读的文件枚举器。
			// GUI 那边本来就会先把输入框里的范围写进配置（setConfig({artifacts:{roots}})），
			// 所以按配置走不影响界面。
			const roots = normalizeRoots(undefined, state.config.artifacts?.roots, cwd)
			const minRun = numberOr(undefined, state.config.artifacts?.minRun, 20)
			// 大小上限：请求里带的优先，否则用配置里的（默认 8MB）。
			// 超限的文件会被跳过，但会在报告的 skippedTooLarge 里列出来。
			const requestedMax = Number(options.maxFileBytes)
			const configuredMax = Number(state.config.artifacts?.maxFileBytes)
			const maxFileBytes = requestedMax > 0 ? requestedMax : (configuredMax > 0 ? configuredMax : undefined)
			return scanArtifacts({
				roots,
				files: Array.isArray(options.files) ? options.files.filter((item) => typeof item === 'string' && item.length > 0) : undefined,
				minRun,
				unitRun: state.config.artifacts?.unitRun !== false,
				unitRepeats: numberOr(undefined, state.config.artifacts?.unitRepeats, 4),
				maxFileBytes,
			})
		},

		/**
		 * 扫描工程文件里的退化内容（只读）——**命令专用入口**，认调用方给的根目录。
		 *
		 * 复审缺陷 F1：`/degen-scan <目录>` 需要能扫用户点名的目录，
		 * 而面向浏览器的那个入口按设计只认配置里的根目录。
		 *
		 * 这个方法**不在**远程方法表里：浏览器够不到它。
		 *
		 * @param {object} [request] - 请求
		 * @returns {Promise<object>} 扫描报告
		 */
		async scanArtifactsInRoots(request = {}) {
			const roots = normalizeRoots(request.roots, state.config.artifacts?.roots, cwd)
			const minRun = numberOr(undefined, state.config.artifacts?.minRun, 20)
			const configuredMax = Number(state.config.artifacts?.maxFileBytes)
			return scanArtifacts({
				roots,
				files: Array.isArray(request.files) ? request.files.filter((item) => typeof item === 'string' && item.length > 0) : undefined,
				minRun,
				unitRun: state.config.artifacts?.unitRun !== false,
				unitRepeats: numberOr(undefined, state.config.artifacts?.unitRepeats, 4),
				maxFileBytes: configuredMax > 0 ? configuredMax : undefined,
			})
		},

		/**
		 * 修复工程文件里的退化内容（默认只预览）。
		 *
		 * 只透传白名单里的键：请求来自浏览器端，不能让它指定
		 * 输出路径、备份目录、注入的读写函数。
		 *
		 * @param {object} [request] - 请求
		 * @returns {Promise<object>} 修复结果
		 */
		async repairArtifacts(request = {}) {
			const files = Array.isArray(request.files) ? request.files.filter((item) => typeof item === 'string' && item.length > 0) : []
			if (files.length === 0) return { applied: false, mode: 'none', results: [], summary: { requested: 0, changed: 0, failed: 0, symbols: 0 }, error: '请先选择要修复的文件。' }
			const apply = request.apply === true || (request.apply === undefined && state.config.artifacts?.apply === true)
			const mode = request.mode === 'remove' ? 'remove' : state.config.artifacts?.mode ?? 'collapse'
			// 复审缺陷 F6：minRun 与符号集只认配置，不认请求。
			// 否则调用方可以把 minRun 调到 2、符号集调成 'e'，
			// 把修复变成一个「把任意文件里的字母 e 删掉」的通用改写器。
			const minRun = numberOr(undefined, state.config.artifacts?.minRun, 20)
			// 修复同样受根目录约束：能扫到的才能修。
			// 带 sessionId 时（会话视图），根目录是**这个会话的工作目录**，
			// 由宿主从会话存档头部读出来，浏览器不能自己点名目录。
			const sessionId = typeof request.sessionId === 'string' ? request.sessionId : ''
			let roots
			if (sessionId) {
				const workspace = resolveSessionWorkspace(sessionId)
				if (!workspace.ok) {
					return { applied: false, mode: 'none', results: [], summary: { requested: 0, changed: 0, failed: 0, symbols: 0 }, error: workspace.error }
				}
				roots = [workspace.cwd]
			} else {
				roots = normalizeRoots(undefined, state.config.artifacts?.roots, cwd)
			}
			const configuredMax = Number(state.config.artifacts?.maxFileBytes)
			return repairArtifacts({
				files,
				apply,
				mode,
				minRun,
				unitRun: state.config.artifacts?.unitRun !== false,
				unitRepeats: numberOr(undefined, state.config.artifacts?.unitRepeats, 4),
				roots,
				maxFileBytes: configuredMax > 0 ? configuredMax : undefined,
			})
		},

		/**
		 * 修复工程文件里的退化内容——**命令专用入口**，认调用方给的根目录。
		 *
		 * 复审缺陷 D6：`/degen-fix` 会把根目录绑到用户点名文件的所在目录，
		 * 但它原先走的是上面那个面向浏览器的入口，而那个入口按设计只认配置里的
		 * 根目录（浏览器不能放宽写范围）——于是命令算出来的根目录被丢掉，
		 * 用户点名的文件一个也修不了。
		 *
		 * 这个方法**不在**远程方法表里：浏览器够不到它，写范围仍然只由宿主决定。
		 *
		 * @param {object} [request] - 请求
		 * @returns {Promise<object>} 修复结果
		 */
		async repairArtifactsInRoots(request = {}) {
			const files = Array.isArray(request.files) ? request.files.filter((item) => typeof item === 'string' && item.length > 0) : []
			if (files.length === 0) return { applied: false, mode: 'none', results: [], summary: { requested: 0, changed: 0, failed: 0, symbols: 0 }, error: '请先选择要修复的文件。' }
			const apply = request.apply === true
			const mode = request.mode === 'remove' ? 'remove' : state.config.artifacts?.mode ?? 'collapse'
			const minRun = numberOr(undefined, state.config.artifacts?.minRun, 20)
			const roots = normalizeRoots(request.roots, state.config.artifacts?.roots, cwd)
			const configuredMax = Number(state.config.artifacts?.maxFileBytes)
			return repairArtifacts({
				files,
				apply,
				mode,
				minRun,
				unitRun: state.config.artifacts?.unitRun !== false,
				unitRepeats: numberOr(undefined, state.config.artifacts?.unitRepeats, 4),
				roots,
				maxFileBytes: configuredMax > 0 ? configuredMax : undefined,
			})
		},

		/**
		 * 扫描会话存档里的退化内容（只读）。
		 * @param {object} [options] - 选项
		 * @returns {Promise<object>} 扫描报告
		 */
		async scanSessions(options = {}) {
			const minRun = numberOr(undefined, state.config.sessions?.minRun, 20)
			// 复审缺陷 F6 附注：这里原先传的是 `symbols`，而 lib/sessions.js 读的是 `chars`，
			// 键名对不上，调用方指定的符号集被静默忽略。符号集统一走默认值，不接受调用方指定。
			// 多字符单元治理的开关与份数阈值同样只认配置：浏览器端不能放宽判定口径。
			return scanSessions({
				minRun,
				unitRun: state.config.sessions?.unitRun !== false,
				unitRepeats: numberOr(undefined, state.config.sessions?.unitRepeats, 4),
			})
		},

		/**
		 * 遮蔽会话存档里的退化内容（默认只预览）。
		 *
		 * 只透传白名单里的键：请求来自浏览器端，不能让它指定
		 * 输出路径、审计路径、备份路径。
		 *
		 * @param {object} [request] - 请求
		 * @returns {Promise<object>} 遮蔽结果
		 */
		async cleanSessions(request = {}) {
			const file = request.file ?? resolveSessionFile(sessionsRoot, request.sessionId)
			if (!file) return { applied: false, mode: 'none', masked: 0, symbols: 0, remaining: 0, error: '找不到对应的会话存档文件。' }
			const apply = request.apply === true
			const mode = request.mode === 'replace' ? 'replace' : state.config.sessions?.mode ?? 'copy'
			const minRun = numberOr(request.minRun, state.config.sessions?.minRun, 20)
			// 遮蔽方式：折叠成标记（默认）或整段删除。
			// 只认这两个值 —— 其它一律回落到配置里的默认方式。
			const maskMode = request.maskMode === 'remove'
				? 'remove'
				: (request.maskMode === 'collapse' ? 'collapse' : state.config.sessions?.maskMode ?? 'collapse')
			// 复审缺陷 N4：遮蔽目标必须在会话根目录之内。
			// 浏览器端能传任意 file，没有这道闸门就能让宿主改写磁盘上任意文件。
			return mask({
				file,
				apply,
				mode,
				minRun,
				roots: [sessionsRoot],
				maskMode,
				unitRun: state.config.sessions?.unitRun !== false,
				unitRepeats: numberOr(undefined, state.config.sessions?.unitRepeats, 4),
			})
		},

		/**
		 * 读取某个会话的**流式干预流水**。
		 *
		 * 判定日志记的是「什么时候、哪个通道、命中哪条规则、做了什么处理」；
		 * 但日志本身不知道这段话落在会话存档的哪个位置。这里把两者对上号：
		 * 用折叠标记去存档里定位，拿到事件序号、字段路径、上下文片段，
		 * 界面上就能给出「改前/改后」对照，也能按条回退。
		 *
		 * @param {object} [request] - 请求
		 * @param {string} request.sessionId - 会话 id
		 * @returns {Promise<object>} 干预流水
		 */
		async listInterventions(request = {}) {
			const sessionId = typeof request.sessionId === 'string' ? request.sessionId : ''
			if (!sessionId) return { ok: false, entries: [], error: '缺少 sessionId 参数。' }
			const entries = verdictLog.list().filter((item) => item.sessionId === sessionId)
			const revertedIds = new Set(readRevertLedger(revertsFile)
				.filter((item) => item.sessionId === sessionId)
				.map((item) => item.id))
			const file = resolveSessionFile(sessionsRoot, sessionId)
			// 按标记分组去存档里定位（同一段文字可能折叠过多次）。
			const hitsByMarker = new Map()
			if (file) {
				const markers = new Set(entries.map((item) => item.marker).filter((item) => typeof item === 'string' && item.length > 0))
				for (const marker of markers) {
					const located = locate({ file, marker, roots: [sessionsRoot] })
					if (located.ok) hitsByMarker.set(marker, located.hits)
				}
			}
			// 配对：同一标记的条目按时间顺序，对应同一标记的命中位置。
			// 已经回退过的条目不再占位置——它的标记已经从存档里消失了。
			const used = new Map()
			const paired = entries.map((entry) => {
				const marker = typeof entry.marker === 'string' ? entry.marker : ''
				const done = revertedIds.has(entry.id)
				let hit = null
				if (marker && !done) {
					const index = used.get(marker) ?? 0
					const list = hitsByMarker.get(marker) ?? []
					hit = list[index] ?? null
					if (hit) used.set(marker, index + 1)
				}
				const position = hit
					? { event: hit.event, path: hit.path, offset: hit.offset, context: hit.context }
					: null
				return {
					id: entry.id,
					ts: entry.ts,
					sessionId: entry.sessionId,
					model: entry.model,
					provider: entry.provider,
					channel: entry.channel,
					rule: entry.rule,
					severity: entry.severity,
					action: entry.action,
					onset: entry.onset,
					count: entry.count,
					evidence: entry.evidence,
					marker: entry.marker,
					original: entry.original,
					source: entry.source,
					reverted: done,
					// 截断类干预的内容根本没落盘，既没有位置也不能回退。
					restorable: entry.action === 'sanitize' && typeof entry.original === 'string' && entry.original.length > 0 && !done,
					position,
					preview: {
						segments: [{
							event: hit?.event ?? null,
							path: hit?.path ?? '',
							action: entry.action,
							before: hit?.contextBefore ?? '',
							after: hit?.contextAfter ?? '',
							removed: typeof entry.original === 'string' ? entry.original.slice(0, 400) : '',
							removedTruncated: typeof entry.original === 'string' && entry.original.length > 400,
							added: marker,
						}],
					},
				}
			})
			return { ok: true, sessionId, file: file ?? null, entries: paired, total: paired.length }
		},
	
		/**
		 * 回退一次净化干预：把会话存档里的折叠标记换回原文。
		 *
		 * 只认判定日志里的条目 id —— 浏览器不能点名文件、也不能自带原文，
		 * 否则就等于给了它一个「往会话存档里写任意内容」的口子。
		 *
		 * @param {object} [request] - 请求
		 * @param {string} request.id - 判定条目 id
		 * @returns {Promise<object>} 回退结果
		 */
		async revertIntervention(request = {}) {
			const id = typeof request.id === 'string' ? request.id : ''
			if (!id) return { ok: false, restored: false, error: '缺少 id 参数。' }
			const entries = verdictLog.list()
			const entry = entries.find((item) => item.id === id)
			if (!entry) return { ok: false, restored: false, error: '找不到这条干预记录。' }
			if (entry.action !== 'sanitize') {
				return { ok: false, restored: false, error: '只有净化（折叠成标记）的干预可以回退；截断类干预的内容没有落盘，无需回退。' }
			}
			const marker = typeof entry.marker === 'string' ? entry.marker : ''
			const original = typeof entry.original === 'string' ? entry.original : ''
			if (!marker || !original) {
				return { ok: false, restored: false, error: '这条记录没有保存折叠现场，无法回退。' }
			}
			const ledger = readRevertLedger(revertsFile)
			if (ledger.some((item) => item.id === id)) {
				return { ok: false, restored: false, alreadyReverted: true, error: '这条干预已经回退过了。' }
			}
			const sessionId = entry.sessionId ?? ''
			const file = resolveSessionFile(sessionsRoot, sessionId)
			if (!file) return { ok: false, restored: false, error: '找不到对应的会话存档文件。' }
			const located = locate({ file, marker, roots: [sessionsRoot] })
			if (!located.ok) return { ok: false, restored: false, error: located.error ?? '定位失败。' }
			// 同标记的条目按时间顺序占位：已经回退过的条目不占（它的标记已经不在存档里了）。
			const earlier = entries.filter((item) => item.marker === marker && item.ts < entry.ts && item.action === 'sanitize')
			const revertedIds = new Set(ledger.filter((item) => item.sessionId === sessionId).map((item) => item.id))
			const hitIndex = earlier.filter((item) => !revertedIds.has(item.id)).length
			const result = restore({
				file,
				from: marker,
				to: original,
				hitIndex,
				apply: true,
				roots: [sessionsRoot],
			})
			if (!result.applied) return { ok: false, restored: false, error: result.error ?? '回退失败。' }
			appendJsonl(revertsFile, {
				id,
				sessionId,
				marker,
				hitIndex,
				file,
				appliedAt: new Date().toISOString(),
				restoredChars: original.length,
			})
			return { ok: true, restored: true, id, sessionId, file, hitIndex, backup: result.backup ?? null }
		},

		/**
		 * 扫描「某个会话的工作区」：工件按这个会话的工作目录扫，
		 * 会话自身的退化单独统计。
		 *
		 * 工作目录由**宿主**从会话存档的头部读出来 ——
		 * 浏览器只给会话 id，仍然没有能力点名任意目录（与 F1 同一条口径）。
		 *
		 * @param {object} [request] - 请求
		 * @param {string} request.sessionId - 会话 id
		 * @returns {Promise<object>} 扫描结果
		 */
		async scanSessionWorkspace(request = {}) {
			const sessionId = typeof request.sessionId === 'string' ? request.sessionId : ''
			if (!sessionId) return { ok: false, error: '缺少 sessionId 参数。' }
			const file = resolveSessionFile(sessionsRoot, sessionId)
			if (!file) return { ok: false, error: '找不到对应的会话存档文件。' }
			const info = inspectSession(file, {
				minRun: numberOr(undefined, state.config.sessions?.minRun, 20),
				unitRun: state.config.sessions?.unitRun !== false,
				unitRepeats: numberOr(undefined, state.config.sessions?.unitRepeats, 4),
			})
			if (!info.ok) return { ok: false, error: info.error }
			if (!info.cwd) return { ok: false, error: '读不出这个会话的工作目录。' }
			const minRun = numberOr(undefined, state.config.artifacts?.minRun, 20)
			const configuredMax = Number(state.config.artifacts?.maxFileBytes)
			const report = await scanArtifacts({
				roots: [info.cwd],
				minRun,
				unitRun: state.config.artifacts?.unitRun !== false,
				unitRepeats: numberOr(undefined, state.config.artifacts?.unitRepeats, 4),
				maxFileBytes: configuredMax > 0 ? configuredMax : undefined,
			})
			return {
				ok: true,
				session: {
					id: info.id || sessionId,
					title: info.title,
					cwd: info.cwd,
					events: info.events,
					runCount: info.runCount,
					symbolCount: info.symbolCount,
					maxRun: info.maxRun,
				},
				report,
			}
		},
	}

	return service
}

/**
 * 读取回退台账（已经回退过的干预）。
 *
 * 台账是一行一条 JSON：{id, sessionId, marker, hitIndex, appliedAt}。
 * 读不出来就当没有回退过——台账只是幂等保护，不该挡住正常流程。
 *
 * @param {string} file - 台账文件路径
 * @returns {object[]} 台账条目
 */
function readRevertLedger(file) {
	let text
	try {
		text = fs.readFileSync(file, 'utf8')
	} catch {
		return []
	}
	const out = []
	for (const line of text.split('\n')) {
		if (line.trim() === '') continue
		try {
			const item = JSON.parse(line)
			if (item && typeof item.id === 'string') out.push(item)
		} catch {
			/* 坏行跳过 */
		}
	}
	return out
}

/**
 * 规整扫描根目录列表。
 * @param {string[] | undefined} primary - 首选根目录
 * @param {string[] | undefined} secondary - 次选根目录（配置里的）
 * @param {string} fallback - 兜底根目录
 * @returns {string[]} 根目录列表
 */
function normalizeRoots(primary, secondary, fallback) {
	for (const candidate of [primary, secondary]) {
		if (Array.isArray(candidate) && candidate.length > 0) {
			return candidate.filter((item) => typeof item === 'string' && item.length > 0)
		}
	}
	return [fallback]
}

/**
 * 取一个数字，非法或缺失时用兜底值。
 * @param {unknown} value - 传入值
 * @param {unknown} fallback - 配置里的值
 * @param {number} defaultValue - 默认值
 * @returns {number} 数字
 */
function numberOr(value, fallback, defaultValue) {
	if (typeof value === 'number' && Number.isFinite(value)) return value
	if (typeof fallback === 'number' && Number.isFinite(fallback)) return fallback
	return defaultValue
}
