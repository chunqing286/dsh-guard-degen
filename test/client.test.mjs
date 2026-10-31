/**
 * 浏览器半边（`lib/client.js`）的离线自测。
 *
 * 做法：伪造 `window.__ModuleLoader__` 与 `require('react')`，
 * 把 bundle 物化成普通模块，再对纯函数与组件做断言。
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CLIENT_PATH = path.join(HERE, '..', 'lib', 'client.js')

/**
 * React 替身：状态可预置，渲染一次即可断言结构。
 * @returns {object} React 替身
 */
function createFakeReact() {
	const api = {
		seed: [],
		index: 0,
		reset(seed = []) {
			api.seed = seed
			api.index = 0
		},
		createElement(type, props, ...children) {
			const merged = { ...(props ?? {}) }
			if (children.length > 0) merged.children = children.length === 1 ? children[0] : children
			return { type, props: merged }
		},
		useState(initial) {
			const slot = api.index++
			if (!(slot in api.seed)) {
				api.seed[slot] = typeof initial === 'function' ? initial() : initial
			}
			let current = api.seed[slot]
			const set = (next) => {
				current = typeof next === 'function' ? next(current) : next
				api.seed[slot] = current
			}
			return [current, set]
		},
		useEffect() {},
		useCallback(fn) {
			return fn
		},
		useMemo(fn) {
			return fn()
		},
		useRef(initial) {
			return { current: initial }
		},
	}
	return api
}

const fakeReact = createFakeReact()

/**
 * 展开组件元素：把函数型 type 真正跑一遍，拿到宿主元素树。
 * @param {any} node - 节点
 * @param {number} [depth] - 当前深度
 * @returns {any} 展开后的节点
 */
function expand(node, depth = 0) {
	if (depth > 30) return null
	if (Array.isArray(node)) return node.map((item) => expand(item, depth + 1))
	if (node === null || node === undefined || typeof node !== 'object') return node
	if (typeof node.type === 'function') {
		try {
			return expand(node.type(node.props ?? {}), depth + 1)
		} catch {
			return null
		}
	}
	return { ...node, props: { ...node.props, children: expand(node.props?.children, depth + 1) } }
}

/**
 * 收集元素树里的所有文本。
 * @param {any} node - 节点
 * @param {string[]} [out] - 收集结果
 * @returns {string[]} 文本
 */
function texts(node, out = []) {
	if (node === null || node === undefined || node === false || node === true) return out
	if (typeof node === 'string' || typeof node === 'number') {
		out.push(String(node))
		return out
	}
	if (Array.isArray(node)) {
		for (const item of node) texts(item, out)
		return out
	}
	if (node.props) {
		const children = node.props.children
		if (children !== undefined) texts(children, out)
	}
	return out
}

/**
 * 收集元素树里的所有元素节点。
 * @param {any} node - 节点
 * @param {any[]} [out] - 收集结果
 * @returns {any[]} 元素
 */
function elements(node, out = []) {
	if (node === null || node === undefined || typeof node !== 'object') return out
	if (Array.isArray(node)) {
		for (const item of node) elements(item, out)
		return out
	}
	if (node.type !== undefined) out.push(node)
	const children = node.props?.children
	if (children !== undefined) elements(children, out)
	return out
}

/** bundle 注册表。 */
let registration = null
globalThis.window = {
	__ModuleLoader__: {
		load(input) {
			registration = input
		},
	},
}

await import(pathToFileURL(CLIENT_PATH).href)

/** 物化后的模块导出。 */
const bundle = registration.factory((id) => {
	if (id === 'react') return fakeReact
	throw new Error(`不应请求 ${id}`)
})

test('bundle 用 window.__ModuleLoader__.load 注册，且 id 正确', () => {
	assert.equal(registration.id, 'dsh-guard-degen')
	assert.equal(typeof registration.factory, 'function')
})

test('模块导出 apply / inject / NS', () => {
	assert.equal(typeof bundle.apply, 'function')
	// 复审缺陷 C1：模块级 inject 不能包含 remote.guardDegen ——
	// 那个命名空间只由本插件自己的 $mount 创建，
	// 写在模块级依赖表里会让 cordis 等一个永远不会出现的服务，
	// 结果是 apply 不执行、整个 Web 外壳起不来。
	assert.deepEqual(bundle.inject, ['slots', 'locale', 'remote'])
	assert.equal(bundle.NS, 'guardDegen')
})

test('bundle 不用 JSX（源码里没有 JSX 标签）', async () => {
	const source = await fs.readFile(CLIENT_PATH, 'utf8')
	const code = source
		.replace(/\/\*[\s\S]*?\*\//g, '')
		.replace(/(^|[^:])\/\/.*$/gm, '$1')
	assert.equal(/<[A-Za-z][A-Za-z0-9]*[\s/>]/.test(code), false)
	assert.equal(source.includes('React.createElement'), true)
})

test('贡献含 13 个方法，端点名带 guardDegen 前缀', () => {
	const info = bundle.__test.buildContribution()
	const endpoints = Object.keys(info.spec.methods)
	assert.equal(endpoints.length, 13)
	for (const endpoint of endpoints) {
		assert.match(endpoint, /^guardDegen\/[A-Za-z]+$/)
	}
	assert.equal(endpoints.includes('guardDegen/scanArtifacts'), true)
	assert.equal(endpoints.includes('guardDegen/cleanSessions'), true)
	assert.equal(endpoints.includes('guardDegen/scanSessionWorkspace'), true)
	assert.equal(endpoints.includes('guardDegen/listInterventions'), true)
	assert.equal(endpoints.includes('guardDegen/revertIntervention'), true)
})

test('参数线名与宿主方法形参名一致', () => {
	const info = bundle.__test.buildContribution()
	const methods = info.spec.methods
	assert.deepEqual(methods['guardDegen/setConfig'].parameters.map((p) => p.wire), ['patch'])
	assert.deepEqual(methods['guardDegen/getVerdicts'].parameters.map((p) => p.wire), ['limit', 'sessionId'])
	assert.deepEqual(methods['guardDegen/ackVerdict'].parameters.map((p) => p.wire), ['verdictId'])
	assert.deepEqual(methods['guardDegen/scanArtifacts'].parameters.map((p) => p.wire), ['options'])
	assert.deepEqual(methods['guardDegen/repairArtifacts'].parameters.map((p) => p.wire), ['request'])
	assert.deepEqual(methods['guardDegen/cleanSessions'].parameters.map((p) => p.wire), ['request'])
})

test('每个参数 codec 都是 strict 且带 create() 工厂', () => {
	const info = bundle.__test.buildContribution()
	for (const definition of Object.values(info.spec.methods)) {
		for (const parameter of definition.parameters) {
			assert.equal(parameter.codec.mode, 'strict')
			assert.equal(typeof parameter.codec.create, 'function')
			assert.equal(typeof parameter.strictCodec.create, 'function')
			assert.equal(typeof parameter.codec.typeSymbol, 'string')
			assert.ok(parameter.codec.typeSymbol.length > 0)
		}
	}
})

test('结果 codec 用 src-json（宿主按源码模式解析）', () => {
	const info = bundle.__test.buildContribution()
	for (const definition of Object.values(info.spec.methods)) {
		assert.equal(definition.result.mode, 'src-json')
	}
})

test('可省略参数标记 acceptsUndefined=true', () => {
	const info = bundle.__test.buildContribution()
	const limit = info.spec.methods['guardDegen/getVerdicts'].parameters[0]
	const patch = info.spec.methods['guardDegen/setConfig'].parameters[0]
	assert.equal(limit.acceptsUndefined, true)
	assert.equal(patch.acceptsUndefined, false)
})

test('迷你 schema：strictObject 拒绝多余键，optional 允许 undefined', () => {
	const mini = bundle.__test.createMiniSchema()
	const schema = mini.strictObject({ name: mini.string(), age: mini.number().optional() })
	assert.equal(schema.safeParse({ name: 'a' }).success, true)
	assert.equal(schema.safeParse({ name: 'a', age: 1 }).success, true)
	assert.equal(schema.safeParse({ name: 'a', extra: 1 }).success, false)
	assert.equal(schema.safeParse({ name: 1 }).success, false)
	const optional = mini.number().optional()
	assert.equal(optional.safeParse(undefined).success, true)
	assert.equal(optional.safeParse(3).success, true)
	assert.equal(mini.number().nonoptional().safeParse(undefined).success, false)
})

test('setIn / getIn 按路径读写', () => {
	const base = { stream: { text: 'sanitize' } }
	const next = bundle.__test.setIn(base, ['stream', 'text'], 'truncate')
	assert.equal(next.stream.text, 'truncate')
	assert.equal(base.stream.text, 'sanitize')
	assert.equal(bundle.__test.getIn(next, ['stream', 'text']), 'truncate')
	assert.equal(bundle.__test.getIn(next, ['stream', 'missing']), undefined)
})

test('splitList 拆分逗号并去空白', () => {
	assert.deepEqual(bundle.__test.splitList(' a , b ,, c '), ['a', 'b', 'c'])
	assert.deepEqual(bundle.__test.splitList(''), [])
})

test('diffTopLevel 只挑出真正变动的顶层键', () => {
	const base = { enabled: true, stream: { text: 'sanitize' }, rules: {} }
	const draft = { enabled: true, stream: { text: 'truncate' }, rules: { 'symbol-run': { on: false } } }
	const diff = bundle.__test.diffTopLevel(base, draft)
	assert.deepEqual(Object.keys(diff).sort(), ['rules', 'stream'])
	assert.deepEqual(diff.stream, { text: 'truncate' })
})

test('callRemote 拆信封并在失败时抛错', async () => {
	const remote = {
		ok: async () => ({ ok: true, value: { hello: 1 } }),
		bad: async () => ({ ok: false, error: { code: 'x', message: '炸了' } }),
	}
	assert.deepEqual(await bundle.__test.callRemote(remote, 'ok'), { hello: 1 })
	await assert.rejects(() => bundle.__test.callRemote(remote, 'bad'), /炸了/)
})

test('配置页渲染出配置项标签与操作按钮', () => {
	const view = {
		config: { enabled: true, stream: { text: 'sanitize' }, rules: {} },
		override: {},
		spec: {
			enabled: { type: 'boolean', default: true },
			modelIncludes: { type: 'stringArray', default: [] },
			rules: { type: 'rules', default: {} },
			stream: { type: 'object', default: {}, fields: { text: { type: 'enum', values: ['off', 'truncate', 'sanitize'], default: 'sanitize' } } },
		},
		overrideFile: 'C:/tmp/config.json',
	}
	fakeReact.reset([{
		phase: 'ready',
		view,
		draft: JSON.parse(JSON.stringify(view.config)),
		message: '',
		errors: [],
		busy: false,
	}])
	const tree = expand(bundle.__test.ConfigTab({ remote: {}, t: (key) => key }))
	const all = texts(tree)
	assert.equal(all.includes('save'), true)
	assert.equal(all.includes('clearOverride'), true)
	assert.equal(all.includes('启用守卫'), true)
	assert.equal(all.includes('流式守卫'), true)
	assert.equal(all.includes('检测规则表（JSON）'), true)
	// 「最近判定」搬到「日志」页签了，配置页不再带判定列表。
	assert.equal(all.includes('verdictAck'), false)
	assert.equal(all.includes('symbol-run'), false)
	// 分组里的字段标签走 path 查表。
	const selects = elements(tree).filter((node) => node.type === 'select')
	assert.equal(selects.length >= 1, true)
	const checkboxes = elements(tree).filter((node) => node.type === 'input' && node.props.type === 'checkbox')
	assert.equal(checkboxes.length >= 1, true)
})

test('日志页：每条判定都带会话ID与会话名称，并能按会话筛选', () => {
	fakeReact.reset([{
		phase: 'ready',
		entries: [
			{ id: 'v1', ts: '2025-01-01T00:00:00Z', sessionId: 'sess-a', sessionTitle: '修登录页', model: 'm', rule: 'unit-run', channel: 'stream', action: 'sanitize', unit: '⇒⇒§', repeats: 6 },
			{ id: 'v2', ts: '2025-01-02T00:00:00Z', sessionId: 'sess-b', sessionTitle: '写周报', model: 'm', rule: 'symbol-run', channel: 'tool-args', action: 'warn', count: 40 },
		],
		sessions: [
			{ sessionId: 'sess-a', sessionTitle: '修登录页', count: 1, lastTs: '2025-01-01T00:00:00Z' },
			{ sessionId: 'sess-b', sessionTitle: '写周报', count: 1, lastTs: '2025-01-02T00:00:00Z' },
		],
		total: 2,
		sessionId: '',
		query: '',
		selectedId: '',
		busy: false,
		message: '',
	}])
	const tree = expand(bundle.__test.LogsTab({ remote: {}, t: (key) => bundle.__test.zh[key] ?? key }))
	const all = texts(tree)
	// 会话ID与会话名称都在列表里，人才知道这条判定说的是哪一次会话。
	assert.equal(all.includes('sess-a'), true)
	assert.equal(all.includes('修登录页'), true)
	assert.equal(all.includes('sess-b'), true)
	assert.equal(all.includes('写周报'), true)
	// 表头里明确有这两列。
	assert.equal(all.includes('会话ID'), true)
	assert.equal(all.includes('会话名称'), true)
	// 会话筛选下拉：全部会话 + 每个会话。
	const selects = elements(tree).filter((node) => node.type === 'select')
	assert.equal(selects.length >= 1, true)
	const options = elements(selects[0]).filter((node) => node.type === 'option')
	assert.equal(options.length, 3)
	assert.equal(texts(options[0])[0], '全部会话')
	// 文本筛选框存在（按会话 ID 或名称筛）。
	const search = elements(tree).filter((node) => node.type === 'input' && node.props.type === 'text')
	assert.equal(search.length >= 1, true)
	// 行仍然带误报反馈入口。
	assert.equal(all.includes('确认误报'), true)
})

test('日志页：选中一条判定就看到退化特征与治理前后对照', () => {
	fakeReact.reset([{
		phase: 'ready',
		entries: [{
			id: 'v1',
			ts: '2025-01-01T00:00:00Z',
			sessionId: 'sess-a',
			sessionTitle: '修登录页',
			model: 'm',
			rule: 'unit-run',
			channel: 'stream',
			action: 'sanitize',
			severity: 'warn',
			unit: '⇒⇒§',
			repeats: 6,
			count: 6,
			evidence: '⇒⇒§ ⇒⇒§ ⇒⇒§',
			original: '⇒⇒§ ⇒⇒§ ⇒⇒§ ⇒⇒§ ⇒⇒§ ⇒⇒§ ⇒⇒§',
			marker: '〔退化单元×6〕',
		}],
		sessions: [{ sessionId: 'sess-a', sessionTitle: '修登录页', count: 1, lastTs: '2025-01-01T00:00:00Z' }],
		total: 1,
		sessionId: '',
		query: '',
		selectedId: 'v1',
		busy: false,
		message: '',
	}])
	const tree = expand(bundle.__test.LogsTab({ remote: {}, t: (key) => bundle.__test.zh[key] ?? key }))
	const all = texts(tree)
	// 退化特征说清楚了：什么单元、重复了几次。
	assert.equal(all.some((item) => String(item).includes('⇒⇒§') && String(item).includes('6')), true)
	// 治理前后对照：红行是原文，绿行是折叠标记。
	assert.equal(all.includes('⇒⇒§ ⇒⇒§ ⇒⇒§ ⇒⇒§ ⇒⇒§ ⇒⇒§ ⇒⇒§'), true)
	assert.equal(all.includes('〔退化单元×6〕'), true)
	const kinds = elements(tree).filter((node) => node.props?.['data-kind'] === 'remove' || node.props?.['data-kind'] === 'add')
	assert.equal(kinds.length >= 2, true)
})

test('日志页：文本筛选只留下会话 ID 或名称命中的判定', () => {
	fakeReact.reset([{
		phase: 'ready',
		entries: [
			{ id: 'v1', ts: 't1', sessionId: 'sess-a', sessionTitle: '修登录页', rule: 'unit-run' },
			{ id: 'v2', ts: 't2', sessionId: 'sess-b', sessionTitle: '写周报', rule: 'symbol-run' },
		],
		sessions: [],
		total: 2,
		sessionId: '',
		query: '周报',
		selectedId: '',
		busy: false,
		message: '',
	}])
	const tree = expand(bundle.__test.LogsTab({ remote: {}, t: (key) => bundle.__test.zh[key] ?? key }))
	const all = texts(tree)
	assert.equal(all.includes('写周报'), true)
	assert.equal(all.includes('修登录页'), false)
})

test('日志页：未自动治理的判定也要说清楚「只记录、没改写」', () => {
	const segments = bundle.__test.verdictDiffSegments({
		rule: 'symbol-run',
		action: 'warn',
		evidence: '⇒⇒⇒⇒⇒⇒⇒⇒',
	}, (key, params) => (params ? `${key}:${JSON.stringify(params)}` : key))
	assert.equal(segments.length, 1)
	assert.equal(segments[0].removed, '⇒⇒⇒⇒⇒⇒⇒⇒')
	// 没有自动治理 → 绿色一行是说明，不是假装改写过的内容。
	assert.equal(segments[0].added, '')
	assert.match(segments[0].addedNote, /logsNoteWarn/)
	// 认不出来的动作也只说明「没有改写」，不编造治理结果。
	const unknown = bundle.__test.verdictDiffSegments({
		rule: 'symbol-run',
		action: 'something-else',
		evidence: '⇒⇒⇒⇒⇒⇒⇒⇒',
	}, (key, params) => (params ? `${key}:${JSON.stringify(params)}` : key))
	assert.match(unknown[0].addedNote, /logsNotRemediated/)
})

test('工件页渲染扫描结果并给出修复选择', () => {
	fakeReact.reset([{
		roots: '',
		mode: 'collapse',
		report: {
			files: [{ path: 'C:/work/docs/a.md', runCount: 3, symbolCount: 90, maxRun: 40 }],
			summary: { filesWithHits: 1, totalRuns: 3, totalSymbols: 90 },
		},
		selected: [],
		repair: null,
		busy: false,
		message: '',
		sessions: { sessions: [{ id: 'sess-1', path: 'C:/sess-1.jsonl', runCount: 2, symbolCount: 50, maxRun: 30 }] },
		sessionSelected: '',
		mask: null,
	}])
	const tree = expand(bundle.__test.ArtifactsTab({ remote: {}, t: (key) => key }))
	const all = texts(tree)
	assert.equal(all.includes('C:/work/docs/a.md'), true)
	assert.equal(all.includes('sess-1'), true)
	const checkboxes = elements(tree).filter((node) => node.type === 'input' && node.props.type === 'checkbox')
	assert.equal(checkboxes.length >= 2, true)
})

test('工件页把「因过大被跳过」的文件说出来，不让人误以为扫干净了', () => {
	fakeReact.reset([{
		roots: '',
		mode: 'collapse',
		report: {
			files: [],
			skippedTooLarge: ['E:/repo/docs/验证记录.md'],
			summary: { filesWithHits: 0, totalRuns: 0, totalSymbols: 0 },
		},
		selected: [],
		repair: null,
		busy: false,
		message: '',
		sessions: { sessions: [] },
		sessionSelected: '',
		mask: null,
	}])
	const tree = expand(bundle.__test.ArtifactsTab({ remote: {}, t: (key) => key }))
	const all = texts(tree)
	assert.equal(all.some((item) => String(item).includes('E:/repo/docs/验证记录.md')), true, '超限文件必须出现在界面上')
	assert.equal(all.some((item) => String(item).includes('artifactSkippedTooLarge')), true)
})

test('退化守卫注册成独立的设置分区，不再挂在「内置插件」下面', async () => {
	const source = await fs.readFile(CLIENT_PATH, 'utf8')
	// 与「插件」并列：自己占一个 settings.section 条目。
	assert.equal(source.includes("name: 'settings.section'"), true)
	assert.equal(source.includes("id: 'guard-degen'"), true)
	// 「配置 / 工件」是它自己的子槽。
	assert.equal(source.includes("'guard-degen.tab': { kind: 'list', scope: 'root' }"), true)
	assert.equal(source.includes("name: 'guard-degen.tab'"), true)
	// 不能再往「内置插件」的页签槽里注册。
	assert.equal(source.includes("child.slots.inject('settings.plugins.tab'"), false)
	assert.equal(source.includes("name: 'settings.plugins.tab'"), false)
})

test('分区外壳渲染出「配置 / 工件」两个页签，并把子槽交给 renderSlot', () => {
	const calls = []
	fakeReact.reset([])
	const tree = expand(bundle.__test.GuardDegenSection({
		t: (key) => key,
		useTabs: (selector) => selector([
			{ id: 'guard-degen-config', order: 10, label: '配置' },
			{ id: 'guard-degen-artifacts', order: 20, label: '工件' },
		]),
		renderSlot: (key, props, opts) => {
			calls.push({ key, props, opts })
			return 'panel'
		},
	}))
	const all = texts(tree)
	assert.equal(all.includes('配置'), true)
	assert.equal(all.includes('工件'), true)
	assert.equal(calls.length, 1)
	assert.equal(calls[0].key, 'guard-degen.tab')
	// 两个页签都挂载（不用 only 过滤），当前页签通过 owner prop 传下去。
	assert.equal(calls[0].opts?.only, undefined, '不能用 only 过滤，否则没选中的页签会被卸载')
	assert.equal(calls[0].props.activeTab, 'guard-degen-config', '默认落在第一个页签上')
})

test('没选中的页签被 hidden 藏起来而不是卸载（扫出来的报告不能丢）', () => {
	fakeReact.reset([{
		roots: '',
		mode: 'collapse',
		report: { files: [], summary: { filesWithHits: 0, totalRuns: 0, totalSymbols: 0 } },
		selected: [],
		repair: null,
		busy: false,
		message: '',
		sessions: { sessions: [] },
		sessionSelected: '',
		mask: null,
	}])
	const tree = expand(bundle.__test.ArtifactsTab({
		remote: {},
		t: (key) => key,
		activeTab: 'guard-degen-config',
	}))
	const root = tree
	assert.equal(root.props.role, 'tabpanel')
	assert.equal(root.props.hidden, true, '不是当前页签就要藏起来')
	// 反过来：当前页签不能被藏。
	fakeReact.reset([{
		roots: '',
		mode: 'collapse',
		report: { files: [], summary: { filesWithHits: 0, totalRuns: 0, totalSymbols: 0 } },
		selected: [],
		repair: null,
		busy: false,
		message: '',
		sessions: { sessions: [] },
		sessionSelected: '',
		mask: null,
	}])
	const active = expand(bundle.__test.ArtifactsTab({
		remote: {},
		t: (key) => key,
		activeTab: 'guard-degen-artifacts',
	}))
	assert.equal(active.props.hidden, false)
})

test('工件页的会话列表同时给出标题与会话 id', () => {
	fakeReact.reset([{
		roots: '',
		mode: 'collapse',
		report: { files: [], summary: { filesWithHits: 0, totalRuns: 0, totalSymbols: 0 } },
		selected: [],
		repair: null,
		busy: false,
		message: '',
		sessions: {
			sessions: [{
				id: 'sess-1',
				title: '帮我看看这个配置文件',
				path: 'C:/sess-1.jsonl',
				runCount: 2,
				symbolCount: 50,
				maxRun: 30,
			}],
		},
		sessionSelected: '',
		mask: null,
	}])
	const tree = expand(bundle.__test.ArtifactsTab({ remote: {}, t: (key) => key }))
	const all = texts(tree)
	assert.equal(all.includes('帮我看看这个配置文件'), true, '必须显示会话标题')
	assert.equal(all.includes('sess-1'), true, '会话 id 也要留着')
})

test('遮蔽结果用红/绿两行对照展示每一段退化', () => {
	fakeReact.reset([])
	const tree = expand(bundle.__test.MaskDiff({
		t: (key) => key,
		preview: {
			segments: [{
				event: 3,
				path: 'message.content[0].text',
				count: 30,
				before: '前面的正常文字',
				after: '后面的正常文字',
				removed: '⇒⇒⇒⇒⇒',
				removedTruncated: false,
				added: '〔退化内容已遮蔽×30〕',
			}],
			totalSegments: 1,
			truncated: false,
		},
	}))
	const kinds = elements(tree)
		.filter((node) => node.props?.['data-kind'])
		.map((node) => node.props['data-kind'])
	assert.equal(kinds.includes('remove'), true, '要有「遮蔽前」的红行')
	assert.equal(kinds.includes('add'), true, '要有「遮蔽后」的绿行')
	const all = texts(tree)
	assert.equal(all.includes('〔退化内容已遮蔽×30〕'), true)
	assert.equal(all.includes('⇒⇒⇒⇒⇒'), true)
})

test('工件修复预览也用红/绿两行对照展示每一段退化', () => {
	fakeReact.reset([])
	const tree = expand(bundle.__test.RepairDiff({
		t: (key) => key,
		preview: {
			segments: [{
				path: 'C:/work/notes.md',
				event: 1,
				kind: 'unit-run',
				unit: '⇒⇒§ ⇒⇒§ §',
				repeats: 12,
				before: '头部内容',
				after: '尾部内容',
				removed: '⇒⇒§ ⇒⇒§ § ⇒⇒§ ⇒⇒§ §',
				removedTruncated: false,
				added: '〔退化单元×12〕',
			}],
			truncated: false,
		},
	}))
	const kinds = elements(tree)
		.filter((node) => node.props?.['data-kind'])
		.map((node) => node.props['data-kind'])
	assert.equal(kinds.includes('remove'), true, '要有「修复前」的红行')
	assert.equal(kinds.includes('add'), true, '要有「修复后」的绿行')
	const all = texts(tree)
	assert.equal(all.includes('〔退化单元×12〕'), true)
	assert.equal(all.includes('⇒⇒§ ⇒⇒§ § ⇒⇒§ ⇒⇒§ §'), true)
	assert.equal(all.some((item) => String(item).includes('artifactDiffUnitNote')), true, '单元重复要说明是哪个单元重复了几次')
	assert.equal(all.includes('artifactDiffRemoved'), true)
	assert.equal(all.includes('artifactDiffAdded'), true)
})

test('对照视图里的说明文字要占正文列，不能塌进 16px 的标记列', () => {
	// 回归：说明文字是行里的第三个格子，不钉住列的话会被塞进标记列——
	// 一个字一行，还把下面的红绿行挤出可视区，用户根本看不到对照。
	const css = bundle.__test.CSS
	assert.equal(
		css.includes('.gd-diff-line>.gd-diff-note{grid-column:2 / -1}'),
		true,
		'说明文字必须钉在正文列上',
	)
	assert.equal(css.includes('.gd-diff-line{display:grid;grid-template-columns:16px 1fr;'), true)
})

test('工件整段删除模式下，对照视图说明这一段什么都不留', () => {
	fakeReact.reset([])
	const tree = expand(bundle.__test.RepairResultCard({
		t: (key) => key,
		result: {
			applied: false,
			mode: 'remove',
			summary: { requested: 1, changed: 1, failed: 0, symbols: 84 },
			results: [{
				path: 'C:/work/notes.md',
				changed: true,
				replaced: 1,
				symbols: 84,
				preview: {
					segments: [{
						path: 'C:/work/notes.md',
						event: 1,
						kind: 'symbol-run',
						before: '头部内容',
						after: '尾部内容',
						removed: '⇒'.repeat(30),
						removedTruncated: false,
						added: '',
					}],
					truncated: false,
				},
			}],
		},
	}))
	const all = texts(tree)
	assert.equal(all.some((item) => String(item).includes('artifactDiffRemovedNote')), true, '绿行要说明这一段不留东西')
	// 红行仍然是原来的退化内容 —— 不能拿一句占位话冒充。
	assert.equal(all.some((item) => String(item).includes('⇒')), true)
})

test('工件修复结果卡片：摘要之外逐文件给出对照', () => {
	fakeReact.reset([])
	const tree = expand(bundle.__test.RepairResultCard({
		t: (key) => key,
		result: {
			applied: false,
			mode: 'collapse',
			summary: { requested: 1, changed: 1, failed: 0, symbols: 84 },
			results: [{
				path: 'C:/work/notes.md',
				changed: true,
				replaced: 1,
				symbols: 84,
				preview: {
					segments: [{
						path: 'C:/work/notes.md',
						event: 1,
						kind: 'unit-run',
						unit: '⇒⇒§ ⇒⇒§ §',
						repeats: 12,
						before: '',
						after: '',
						removed: '⇒⇒§ ⇒⇒§ §',
						removedTruncated: false,
						added: '〔退化单元×12〕',
					}],
					truncated: false,
				},
			}],
		},
	}))
	const all = texts(tree)
	assert.equal(all.includes('artifactResult'), true, '要有结果标题')
	assert.equal(all.includes('C:/work/notes.md'), true, '要指出是哪个文件')
	assert.equal(all.includes('〔退化单元×12〕'), true, '要有对照里的绿行内容')
	const kinds = elements(tree)
		.filter((node) => node.props?.['data-kind'])
		.map((node) => node.props['data-kind'])
	assert.equal(kinds.includes('remove'), true)
	assert.equal(kinds.includes('add'), true)
})

test('会话视图的工件治理：修复结果用红绿对照显示', async () => {
	const source = await fs.readFile(CLIENT_PATH, 'utf8')
	// 会话视图里的工件修复结果不再只是一张表，而是带上红绿对照。
	assert.equal(source.includes('h(RepairResultCard, { result: state.repair, t })'), true)
	assert.equal(source.includes('function RepairResultCard('), true)
	assert.equal(source.includes('function RepairDiff('), true)
})

test('语言包中英文键集合一致', () => {
	assert.deepEqual(Object.keys(bundle.__test.zh).sort(), Object.keys(bundle.__test.en).sort())
})

test('会话视图注册进会话的视图页签行（conversation.view）', async () => {
	const source = await fs.readFile(CLIENT_PATH, 'utf8')
	assert.equal(source.includes("child.slots.inject('conversation.view'"), true, '必须挂到会话的视图槽上')
	assert.equal(source.includes("name: 'conversation.view'"), true)
	assert.equal(source.includes("id: 'guard-degen'"), true)
	// 页签名字叫「退化守卫」，跟对话 / 轨迹并列。
	assert.equal(source.includes("label: () => t('viewGuardDegen')"), true)
	assert.equal(bundle.__test.zh.viewGuardDegen, '退化守卫')
})

test('会话视图：工件目录是当前会话的工作目录，要修的会话就是当前会话', async () => {
	const source = await fs.readFile(CLIENT_PATH, 'utf8')
	// 工作目录由宿主从会话存档头部解析，浏览器只给会话 id。
	assert.equal(source.includes('scanSessionWorkspace'), true)
	assert.equal(source.includes('sessionId, t, remote'), true, '视图只拿会话 id，不拿目录')
	// 会话视图里的修复请求也带上 sessionId，写范围跟着会话收。
	assert.equal(source.includes('apply,\n\t\t\t\t\t\tsessionId,'), true)
})

test('会话视图渲染出工作区工件、当前会话统计与遮蔽入口', () => {
	fakeReact.reset([{
		workspace: {
			session: { id: 'sess-1', title: '修复登录', cwd: 'C:/work', events: 12, runCount: 2, symbolCount: 50, maxRun: 30 },
			report: { files: [{ path: 'C:/work/docs/a.md', runCount: 3, symbolCount: 90, maxRun: 40 }], summary: {} },
		},
		selected: [],
		mode: 'collapse',
		maskMode: 'collapse',
		repair: null,
		mask: null,
		busy: false,
		message: '',
	}])
	const tree = expand(bundle.__test.GuardDegenSessionView({ remote: {}, sessionId: 'sess-1', t: (key) => key }))
	const all = texts(tree)
	assert.equal(all.includes('C:/work/docs/a.md'), true, '要列出这个会话工作区里的工件')
	assert.equal(all.includes('sessionViewWorkspace'), true)
	assert.equal(all.includes('sessionViewCurrent'), true)
	assert.equal(all.some((item) => String(item).includes('C:/work')), true, '要显示工作目录')
	const selects = elements(tree).filter((node) => node.type === 'select')
	assert.equal(selects.length >= 2, true, '工件方式与遮蔽方式各一个选择框')
})

test('工件页也给会话遮蔽方式选择（collapse / remove）', () => {
	fakeReact.reset([{
		roots: '',
		mode: 'collapse',
		report: { files: [], summary: {} },
		selected: [],
		repair: null,
		busy: false,
		message: '',
		sessions: { sessions: [] },
		sessionSelected: '',
		maskMode: 'collapse',
		maskTarget: 'copy',
		mask: null,
	}])
	const tree = expand(bundle.__test.ArtifactsTab({ remote: {}, t: (key) => key }))
	const all = texts(tree)
	assert.equal(all.includes('maskMode'), true, '要有遮蔽方式这一项')
	assert.equal(all.includes('maskModeCollapse'), true)
	assert.equal(all.includes('maskModeRemove'), true)
})

test('会话视图默认就地改写当前会话，而不是另存副本', async () => {
	const source = await fs.readFile(CLIENT_PATH, 'utf8')
	// 会话视图的初始落地方式就是 replace：用户来这里就是要修眼前这个会话。
	assert.equal(source.includes("maskTarget: 'replace'"), true, '会话视图默认就地改写')
	// 请求带的是用户选中的落地方式，不能再写死 copy。
	assert.equal(source.includes('mode: state.maskTarget'), true, '遮蔽请求要带上落地方式')
	assert.equal(source.includes("mode: 'copy',"), false, '不能再把落地方式写死成 copy')
})

test('会话视图与工件页都有「落地方式」选择框', () => {
	fakeReact.reset([{
		workspace: {
			session: { id: 'sess-1', title: '修复登录', cwd: 'C:/work', events: 12, runCount: 2, symbolCount: 50, maxRun: 30 },
			report: { files: [], summary: {} },
		},
		selected: [],
		mode: 'collapse',
		maskMode: 'collapse',
		maskTarget: 'replace',
		repair: null,
		mask: null,
		busy: false,
		message: '',
	}])
	const tree = expand(bundle.__test.GuardDegenSessionView({ remote: {}, sessionId: 'sess-1', t: (key) => key }))
	const all = texts(tree)
	assert.equal(all.includes('maskTarget'), true, '要有落地方式这一项')
	assert.equal(all.includes('maskTargetReplace'), true, '要有「直接改写会话存档」')
	assert.equal(all.includes('maskTargetCopy'), true, '要有「另存为副本」')
	const selects = elements(tree).filter((node) => node.type === 'select')
	assert.equal(selects.length >= 3, true, '工件方式、遮蔽方式、落地方式各一个选择框')
	// 就地改写时要说清楚：界面上的历史消息不会当场变。
	assert.equal(all.includes('maskTargetReplaceHint'), true)
})

test('遮蔽结果卡片区分「就地改写」与「另存副本」，并给出备份路径', () => {
	fakeReact.reset([])
	const tree = expand(bundle.__test.MaskResultCard({
		mask: { applied: true, mode: 'replace', output: '/sessions/s1/session.v4.jsonl.zstd', backup: '/backups/s1.bak', masked: 2, symbols: 60 },
		t: (key) => key,
	}))
	const all = texts(tree)
	assert.equal(all.some((item) => String(item).includes('maskAppliedInPlace')), true, '就地改写要单独说明')
	assert.equal(all.some((item) => String(item).includes('maskBackup')), true, '要给出备份路径')
})

test('remove 方式的对照视图显示「遮蔽前 / 遮蔽后」两行真实内容', () => {
	fakeReact.reset([])
	const tree = expand(bundle.__test.MaskDiff({
		t: (key) => key,
		preview: {
			segments: [{
				event: 3,
				path: 'message.content[0].text',
				count: 30,
				action: 'remove',
				before: '前面的正常文字',
				after: '后面的正常文字',
				removed: '⇒⇒⇒⇒⇒',
				removedTruncated: false,
				added: '',
				originalWindow: '前面的正常文字⇒⇒⇒⇒⇒',
				originalTruncatedBefore: false,
				originalTruncatedAfter: false,
				maskedWindow: '前面的正常文字',
				maskedTruncatedBefore: false,
				maskedTruncatedAfter: false,
			}],
			totalSegments: 1,
			truncated: false,
			mode: 'remove',
		},
	}))
	const all = texts(tree)
	// 「遮蔽前」是原文，「遮蔽后」是删完剩下的文字：符号真的不见了。
	assert.equal(all.includes('前面的正常文字⇒⇒⇒⇒⇒'), true, '「遮蔽前」要显示原文')
	assert.equal(all.includes('前面的正常文字'), true, '「遮蔽后」要显示删完剩下的内容')
	// 不能再拿「（该段被删除）」这种话冒充改后的内容 —— 那看着像把符号换成了这句话。
	assert.equal(all.includes('（该段被删除）'), false, '不能拿一句占位话冒充改后的内容')
	assert.equal(all.includes('diffDeleted'), false, '不能拿一句占位话冒充改后的内容')
	assert.equal(all.includes('diffCleared'), false, '还有内容时不该说「删空了」')
})

test('会话遮蔽预览里的多字符单元重复要说明是哪个单元重复了几次', () => {
	fakeReact.reset([])
	const tree = expand(bundle.__test.MaskDiff({
		t: (key) => key,
		preview: {
			segments: [{
				event: 3,
				path: 'message.content[0].text',
				kind: 'unit-run',
				unit: '⇒⇒§ ⇒⇒§ §',
				repeats: 12,
				count: 84,
				action: 'collapse',
				before: '前置说明。',
				after: '后置说明。',
				removed: '⇒⇒§ ⇒⇒§ §',
				removedTruncated: false,
				added: '〔退化单元×12〕',
				originalWindow: '前置说明。⇒⇒§ ⇒⇒§ §',
				originalTruncatedBefore: false,
				originalTruncatedAfter: false,
				maskedWindow: '前置说明。〔退化单元×12〕',
				maskedTruncatedBefore: false,
				maskedTruncatedAfter: false,
			}],
			totalSegments: 1,
			truncated: false,
			mode: 'collapse',
		},
	}))
	const all = texts(tree)
	assert.equal(all.includes('〔退化单元×12〕'), true, '折叠标记要显示')
	assert.equal(all.some((item) => String(item).includes('maskUnitNote')), true, '要说明是哪个单元重复了几次')
})

test('remove 方式把整条内容删空时，说清楚「整条内容被删空了」', () => {
	fakeReact.reset([])
	const tree = expand(bundle.__test.MaskDiff({
		t: (key) => key,
		preview: {
			segments: [{
				event: 7,
				path: 'message.content[0].text',
				count: 30,
				action: 'remove',
				before: '',
				after: '',
				removed: '⇒⇒⇒⇒⇒',
				removedTruncated: false,
				added: '',
				originalWindow: '⇒⇒⇒⇒⇒',
				originalTruncatedBefore: false,
				originalTruncatedAfter: false,
				maskedWindow: '',
				maskedTruncatedBefore: false,
				maskedTruncatedAfter: false,
			}],
			totalSegments: 1,
			truncated: false,
			mode: 'remove',
		},
	}))
	const all = texts(tree)
	assert.equal(all.includes('diffCleared'), true, '整条删空要说清楚')
})

test('remove 方式只剩空白时，也算「整条内容被删空了」', () => {
	fakeReact.reset([])
	const tree = expand(bundle.__test.MaskDiff({
		t: (key) => key,
		preview: {
			segments: [{
				event: 8,
				path: 'data.stream[1].texts[3]',
				count: 30,
				action: 'remove',
				before: '',
				after: '',
				removed: '⇒ ⇒ ⇒ ⇒ ⇒',
				removedTruncated: false,
				added: '',
				originalWindow: '⇒ ⇒ ⇒ ⇒ ⇒',
				originalTruncatedBefore: false,
				originalTruncatedAfter: false,
				maskedWindow: ' ',
				maskedTruncatedBefore: false,
				maskedTruncatedAfter: false,
			}],
			totalSegments: 1,
			truncated: false,
			mode: 'remove',
		},
	}))
	const all = texts(tree)
	assert.equal(all.includes('diffCleared'), true, '只剩空白时也要说清楚')
})

test('collapse 方式的对照视图仍然把标记写进「遮蔽后」', () => {
	fakeReact.reset([])
	const tree = expand(bundle.__test.MaskDiff({
		t: (key) => key,
		preview: {
			segments: [{
				event: 3,
				path: 'message.content[0].text',
				count: 30,
				action: 'collapse',
				before: '前面的正常文字',
				after: '后面的正常文字',
				beforeTruncated: false,
				afterTruncated: false,
				removed: '⇒⇒⇒⇒⇒',
				removedTruncated: false,
				added: '〔退化内容已遮蔽×30〕',
				result: '',
			}],
			totalSegments: 1,
			truncated: false,
			mode: 'collapse',
		},
	}))
	const all = texts(tree)
	assert.equal(all.includes('〔退化内容已遮蔽×30〕'), true, 'collapse 方式要显示插入的标记')
})

test('页签分页靠 hidden：样式不能把藏起来的面板又显示出来', async () => {
	const source = await fs.readFile(CLIENT_PATH, 'utf8')
	// 作者样式里的 display 会盖掉浏览器默认的 [hidden]{display:none}，
	// 两个子页就会叠在同一页上 —— 必须显式把藏起来的面板收掉。
	assert.match(source, /\.gd-root\[hidden\][^{]*\{display:none !important\}/)
	assert.match(source, /\.gd-panel\[hidden\][^{]*\{display:none !important\}/)
})

test('文案支持 {name} 插值（locale 服务本身不做）', () => {
	const t = bundle.__test.makeTranslator((key) => bundle.__test.zh[key] ?? key)
	assert.equal(t('maskSummary', { masked: 4, symbols: 88 }), '已遮蔽 4 段 / 88 个符号')
	// 没给到的占位符原样留着，不能变成 undefined。
	assert.equal(t('maskSummary', { masked: 1 }), '已遮蔽 1 段 / {symbols} 个符号')
})

test('遮蔽预览：写中文摘要，预览态不谎报输出文件', () => {
	fakeReact.reset([{
		roots: '',
		mode: 'collapse',
		report: { files: [], summary: { filesWithHits: 0, totalRuns: 0, totalSymbols: 0 } },
		selected: [],
		repair: null,
		busy: false,
		message: '',
		sessions: { sessions: [] },
		sessionSelected: 'sess-1',
		mask: {
			applied: false,
			masked: 4,
			symbols: 88,
			remaining: 0,
			// 预览模式下宿主也会给出「打算写到哪儿」，界面不能当成已经写好了。
			output: 'C:/Users/Administrator/.dsh/guard-degen/masked/session.masked',
			preview: { segments: [], totalSegments: 0, truncated: false },
		},
	}])
	const tree = expand(bundle.__test.ArtifactsTab({
		remote: {},
		t: (key) => bundle.__test.zh[key] ?? key,
	}))
	const all = texts(tree)
	assert.equal(all.includes('预览（未写盘）'), true, '预览要说明没有落盘')
	assert.equal(all.includes('已遮蔽 4 段 / 88 个符号'), true)
	assert.equal(all.some((item) => String(item).includes('session.masked')), false, '预览态不该显示输出路径')
})

test('遮蔽落盘：显示输出文件路径', () => {
	fakeReact.reset([{
		roots: '',
		mode: 'collapse',
		report: { files: [], summary: { filesWithHits: 0, totalRuns: 0, totalSymbols: 0 } },
		selected: [],
		repair: null,
		busy: false,
		message: '',
		sessions: { sessions: [] },
		sessionSelected: 'sess-1',
		mask: {
			applied: true,
			masked: 4,
			symbols: 88,
			remaining: 0,
			output: 'C:/guard/masked/session.masked',
			preview: { segments: [], totalSegments: 0, truncated: false },
		},
	}])
	const tree = expand(bundle.__test.ArtifactsTab({
		remote: {},
		t: (key) => bundle.__test.zh[key] ?? key,
	}))
	const all = texts(tree)
	assert.equal(all.includes('已写入磁盘'), true)
	assert.equal(all.some((item) => String(item).includes('C:/guard/masked/session.masked')), true)
})

test('客户端方法表与宿主 REMOTE_METHODS 一致', async () => {
	const indexSource = await fs.readFile(path.join(HERE, '..', 'lib', 'index.js'), 'utf8')
	const block = indexSource.match(/export const REMOTE_METHODS = \[([\s\S]*?)\]/)
	assert.notEqual(block, null)
	const hostMethods = [...block[1].matchAll(/'([^']+)'/g)].map((item) => item[1])
	const clientMethods = bundle.__test.REMOTE_METHOD_SPECS.map((item) => item.name)
	assert.deepEqual(clientMethods, hostMethods)
})

test('客户端线名与宿主方法形参名一致', async () => {
	const serviceSource = await fs.readFile(path.join(HERE, '..', 'lib', 'service.js'), 'utf8')
	const info = bundle.__test.buildContribution()
	for (const method of bundle.__test.REMOTE_METHOD_SPECS) {
		const matched = serviceSource.match(new RegExp(`(?:async\\s+)?${method.name}\\s*\\(([^)]*)\\)`))
		assert.notEqual(matched, null, `宿主缺少方法 ${method.name}`)
		const hostParams = matched[1]
			.split(',')
			.map((item) => item.trim().split('=')[0].trim())
			.filter((item) => item.length > 0)
		const clientParams = info.spec.methods[`guardDegen/${method.name}`].parameters.map((item) => item.wire)
		assert.deepEqual(clientParams, hostParams, `${method.name} 的线名与形参名不一致`)
	}
})

test('配置里每一个叶子字段都有释义', async () => {
	const { CONFIG_SPEC } = await import('../lib/config.js')
	/**
	 * 递归收集叶子字段的路径（与界面 Field 的递归方式一致）。
	 * @param {object} def - 字段定义
	 * @param {string[]} path - 当前路径
	 * @returns {string[]} 叶子路径
	 */
	const leaves = (def, path = []) => {
		if (def?.type === 'object') {
			return Object.entries(def.fields ?? {}).flatMap(([key, child]) => leaves(child, [...path, key]))
		}
		return [path.join('.')]
	}
	/**
	 * 按路径取出规格里的字段定义。
	 * @param {string[]} path - 字段路径
	 * @returns {object} 字段定义
	 */
	const specAt = (path) => {
		let node = CONFIG_SPEC
		for (const part of path) {
			node = node?.fields ? node.fields[part] : node?.[part]
			if (!node) return {}
		}
		return node
	}
	for (const [key, def] of Object.entries(CONFIG_SPEC)) {
		for (const path of leaves(def, [key])) {
			const desc = specAt(path.split('.')).desc
			assert.ok(String(desc ?? '').trim().length > 0, `${path} 缺少释义`)
		}
	}
})

test('每个叶子配置项都能说出当前选择的实际效果', async () => {
	const { CONFIG_SPEC, normalizeConfig } = await import('../lib/config.js')
	const config = normalizeConfig({})
	/**
	 * 递归收集叶子字段的路径（与界面 Field 的递归方式一致）。
	 * @param {object} def - 字段定义
	 * @param {string[]} path - 当前路径
	 * @returns {string[]} 叶子路径
	 */
	const leaves = (def, path = []) => {
		if (def?.type === 'object') {
			return Object.entries(def.fields ?? {}).flatMap(([key, child]) => leaves(child, [...path, key]))
		}
		return [path.join('.')]
	}
	for (const [key, def] of Object.entries(CONFIG_SPEC)) {
		for (const path of leaves(def, [key])) {
			const value = path.split('.').reduce((acc, part) => (acc == null ? acc : acc[part]), config)
			const effect = bundle.__test.describeEffect(path, value)
			assert.ok(String(effect).trim().length > 0, `${path} 没有效果说明`)
		}
	}
})

test('「单次调用最多干预次数」为 0 时说明不限次数，大于 0 时说明上限', () => {
	const unlimited = bundle.__test.describeEffect('stream.maxInterventionsPerCall', 0)
	assert.ok(unlimited.includes('不限次数'), unlimited)
	const limited = bundle.__test.describeEffect('stream.maxInterventionsPerCall', 3)
	assert.ok(limited.includes('3'), limited)
	assert.ok(limited.includes('最多干预'), limited)
})

test('配置字段渲染时带上释义与效果说明', () => {
	fakeReact.reset([])
	const tree = expand(bundle.__test.Field({
		def: { type: 'enum', values: ['off', 'truncate', 'sanitize'], desc: '这个通道怎么处理退化。' },
		value: 'sanitize',
		path: ['stream', 'text'],
		onChange: () => {},
		label: '正文流策略',
	}))
	const all = texts(tree)
	assert.ok(all.includes('这个通道怎么处理退化。'), '要显示释义')
	assert.ok(all.some((item) => String(item).includes('折叠')), `要显示效果：${all.join('|')}`)
})

test('会话视图的干预流水：列出命中条目、给出位置，并提供回退按钮', () => {
	fakeReact.reset([{
		entries: [{
			id: 'v1',
			ts: '2026-10-30T06:05:09.000Z',
			channel: 'text',
			rule: 'symbol-run',
			action: 'sanitize',
			marker: '〔退化符号流×30〕',
			original: '⇒'.repeat(30),
			reverted: false,
			restorable: true,
			position: { event: 3, path: 'message.content[0].text', offset: 120, context: '…' },
			preview: { segments: [{ event: 3, path: 'message.content[0].text', before: '前', removed: '⇒⇒⇒', added: '〔退化符号流×30〕', after: '后' }] },
		}],
		error: '',
		busy: false,
		expanded: {},
		message: '',
	}])
	const tree = expand(bundle.__test.InterventionPanel({
		remote: {},
		sessionId: 'sess-1',
		t: (key) => bundle.__test.zh[key] ?? key,
		onOpenChat: () => {},
	}))
	const all = texts(tree)
	assert.ok(all.includes('流式干预流水'), '要有标题')
	assert.ok(all.some((item) => String(item).includes('#3')), `要显示位置：${all.join('|')}`)
	assert.ok(all.includes('回退这一条'), '要有回退按钮')
	assert.ok(all.includes('转到对话视图'), '要有定位按钮')
	assert.ok(all.includes('净化（折叠成标记）'), '要显示所做的处理')
})

test('就地改写要说清楚：只改存档，宿主内存里的当前会话还是旧内容', () => {
	fakeReact.reset([{
		workspace: {
			session: { id: 'sess-1', title: '修复登录', cwd: 'C:/work', events: 12, runCount: 2, symbolCount: 50, maxRun: 30 },
			report: { files: [], summary: {} },
		},
		selected: [],
		mode: 'collapse',
		maskMode: 'collapse',
		maskTarget: 'replace',
		repair: null,
		mask: null,
		busy: false,
		message: '',
	}])
	const tree = expand(bundle.__test.GuardDegenSessionView({ remote: {}, sessionId: 'sess-1', t: (key) => bundle.__test.zh[key] ?? key }))
	const all = texts(tree).map((item) => String(item))
	const hint = all.find((item) => item.includes('内存'))
	assert.ok(hint, `就地改写时要说明宿主内存里的旧内容：${all.join('|')}`)
	assert.ok(hint.includes('存档'), '要说明改的是存档文件')
	assert.ok(hint.includes('模型'), '要说明继续对话还会发给模型')
	assert.ok(hint.includes('重启'), '要说明怎么让它生效')
})

test('回退干预之后也要提醒：存档改了，当前会话的内存还没改', () => {
	fakeReact.reset([{
		entries: [{
			id: 'v1',
			ts: '2026-10-30T06:05:09.000Z',
			channel: 'text',
			rule: 'symbol-run',
			action: 'sanitize',
			marker: '〔退化符号流×30〕',
			original: '⇒'.repeat(30),
			reverted: true,
			restorable: false,
			position: null,
			preview: { segments: [] },
		}],
		error: '',
		busy: false,
		expanded: {},
		message: '已回退这一条干预：原文已写回会话存档。',
		reverted: true,
	}])
	const tree = expand(bundle.__test.InterventionPanel({
		remote: {},
		sessionId: 'sess-1',
		t: (key) => bundle.__test.zh[key] ?? key,
		onOpenChat: () => {},
	}))
	const all = texts(tree).map((item) => String(item))
	const note = all.find((item) => item.includes('重启'))
	assert.ok(note, `回退后要提醒重启才生效：${all.join('|')}`)
	assert.ok(note.includes('模型'), '要说明继续对话还会发给模型')
})
