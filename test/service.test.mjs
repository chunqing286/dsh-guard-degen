/**
 * 服务实现层测试 —— T11。
 *
 * 服务层不依赖 Cordis / typert：所有外部能力（判定日志、白名单、扫描器、遮蔽器）
 * 都从参数注入，测试不碰真实磁盘上的会话与工程文件。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { createGuardDegenService, resolveSessionFile } from '../lib/service.js'
import { VerdictLog, Whitelist } from '../lib/log.js'
import './helpers/temp-home.mjs'

/** 造一个临时目录。 */
function tempDir() {
	return fs.mkdtempSync(path.join(os.tmpdir(), 'degen-guard-service-'))
}

/**
 * 造一个服务实例。
 * @param {object} [overrides] - 覆盖项
 * @returns {{service: object, dir: string, calls: object}} 服务与调用记录
 */
function makeService(overrides = {}) {
	const dir = overrides.dir ?? tempDir()
	const calls = { scan: [], repair: [], mask: [], scanSessions: [] }
	const service = createGuardDegenService({
		config: overrides.config ?? {},
		overrideFile: path.join(dir, 'config.json'),
		verdictLog: new VerdictLog({ dir: path.join(dir, 'log') }),
		whitelist: new Whitelist({ file: path.join(dir, 'whitelist.json') }),
		cwd: overrides.cwd ?? dir,
		sessionsRoot: overrides.sessionsRoot ?? path.join(dir, 'sessions'),
		revertsFile: overrides.revertsFile ?? path.join(dir, 'reverts.jsonl'),
		scanArtifacts: overrides.scanArtifacts ?? (async (options) => {
			calls.scan.push(options)
			return { files: [], summary: { filesScanned: 0 } }
		}),
		repairArtifacts: overrides.repairArtifacts ?? (async (options) => {
			calls.repair.push(options)
			return { applied: false, results: [], summary: { requested: options.files.length } }
		}),
		scanSessions: overrides.scanSessions ?? (async (options) => {
			calls.scanSessions.push(options)
			return { sessions: [], summary: {} }
		}),
		maskSession: overrides.maskSession ?? (async (options) => {
			calls.mask.push(options)
			return { masked: 0, symbols: 0 }
		}),
	})
	return { service, dir, calls }
}

test('默认配置齐全，并带上规格与覆盖文件路径', () => {
	const { service } = makeService()
	const view = service.getConfig()
	assert.equal(view.config.enabled, true)
	assert.equal(view.config.toolGuard.mode, 'warn')
	assert.equal(view.config.stream.reasoning, 'truncate')
	assert.equal(view.config.stream.text, 'sanitize')
	assert.ok(view.spec && typeof view.spec === 'object')
	assert.ok(view.overrideFile.endsWith('config.json'))
})

test('setConfig 写入运行时覆盖并立刻生效', () => {
	const { service, dir } = makeService()
	const result = service.setConfig({ enabled: false, toolGuard: { mode: 'refuse' } })
	assert.equal(result.ok, true, JSON.stringify(result.errors))
	assert.equal(result.config.enabled, false)
	assert.equal(result.config.toolGuard.mode, 'refuse')
	const saved = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'))
	assert.equal(saved.enabled, false)
	assert.equal(saved.toolGuard.mode, 'refuse')
	assert.equal(service.config.enabled, false, '生效配置要立刻更新')
})

test('setConfig 拒绝非法值，并且不落盘', () => {
	const { service, dir } = makeService()
	const result = service.setConfig({ toolGuard: { mode: '瞎写' } })
	assert.equal(result.ok, false)
	assert.ok(result.errors.length > 0)
	assert.equal(fs.existsSync(path.join(dir, 'config.json')), false, '非法补丁不能写文件')
})

test('setConfig(null) 清空运行时覆盖', () => {
	const { service } = makeService()
	service.setConfig({ enabled: false })
	assert.equal(service.config.enabled, false)
	const cleared = service.setConfig(null)
	assert.equal(cleared.ok, true)
	assert.equal(cleared.config.enabled, true, '清空覆盖后回到宿主配置')
})

test('getRules 返回规则表、规则 id 与放宽步长', () => {
	const { service } = makeService()
	const view = service.getRules()
	assert.equal(view.rules['symbol-run'].on, true)
	assert.ok(view.ids.includes('symbol-run'))
	assert.ok(view.defaults['symbol-run'])
	assert.ok(view.relaxStep['symbol-run'])
})

test('判定会落盘，并且能按条数取回', () => {
	const { service } = makeService()
	service.recordVerdict({ rule: 'symbol-run', severity: 'high', channel: 'reasoning', detail: { count: 64 } }, { model: 'm1', action: 'truncate' })
	service.recordVerdict({ rule: 'symbol-run', severity: 'high', channel: 'text', detail: { count: 32 } }, { model: 'm1', action: 'sanitize' })
	const all = service.getVerdicts()
	assert.equal(all.entries.length, 2)
	assert.equal(all.total, 2)
	const limited = service.getVerdicts(1)
	assert.equal(limited.entries.length, 1)
	assert.equal(limited.entries[0].channel, 'text', '取最近一条')
})

test('getVerdicts 能按会话过滤，并带上会话名称与会话清单', () => {
	const dir = tempDir()
	const sessionsRoot = path.join(dir, 'sessions')
	const sessionId = 'session-log-1'
	seedTitledSession(sessionsRoot, sessionId, '修登录页')
	const { service } = makeService({ dir, sessionsRoot })
	service.recordVerdict(
		{ rule: 'unit-run', channel: 'stream', detail: { count: 6, repeats: 6, unit: '⇒⇒§' } },
		{ sessionId, model: 'm1', action: 'sanitize', marker: '〔退化单元×6〕', original: '⇒⇒§ ⇒⇒§ ⇒⇒§' },
	)
	service.recordVerdict(
		{ rule: 'symbol-run', channel: 'text', detail: { count: 40 } },
		{ sessionId: 'session-log-2', model: 'm1', action: 'truncate' },
	)
	service.recordVerdict(
		{ rule: 'symbol-run', channel: 'text', detail: { count: 30 } },
		{ model: 'm1', action: 'truncate' },
	)

	const all = service.getVerdicts()
	assert.equal(all.entries.length, 3)
	assert.equal(all.total, 3)
	// 检出的退化特征被记下来了：什么单元、重复了几份。
	const unit = all.entries.find((entry) => entry.rule === 'unit-run')
	assert.equal(unit.unit, '⇒⇒§')
	assert.equal(unit.repeats, 6)
	// 每条判定都带会话名称（读会话存档的标题）。
	assert.equal(unit.sessionTitle, '修登录页')
	// 会话清单：界面的会话选择器用它。
	assert.equal(all.sessions.length, 3, '两个带会话的 + 一个没有会话的')
	const bucket = all.sessions.find((item) => item.sessionId === sessionId)
	assert.equal(bucket.sessionTitle, '修登录页')
	assert.equal(bucket.count, 1)

	const only = service.getVerdicts(50, sessionId)
	assert.equal(only.entries.length, 1, '按会话过滤后只剩这个会话的判定')
	assert.equal(only.entries[0].sessionId, sessionId)
	assert.equal(only.total, 1)
	assert.equal(only.sessions.length, 3, '会话清单不受过滤影响，选择器不会少选项')
})

test('getVerdicts 的会话过滤不认不存在的会话', () => {
	const { service } = makeService()
	service.recordVerdict({ rule: 'symbol-run', channel: 'text', detail: { count: 40 } }, { sessionId: 'sess-a', model: 'm1', action: 'truncate' })
	const none = service.getVerdicts(50, 'sess-不存在')
	assert.equal(none.entries.length, 0)
	assert.equal(none.total, 0)
})

test('ackVerdict 把最近一次判定登记为误报，之后同类判定不再落盘', () => {
	const { service } = makeService()
	service.recordVerdict({ rule: 'symbol-run', severity: 'high', channel: 'reasoning', detail: { count: 64 }, evidence: '⇒⇒⇒' }, { model: 'm1', action: 'truncate' })
	const ack = service.ackVerdict()
	assert.equal(ack.ok, true)
	assert.equal(ack.entry.rule, 'symbol-run')
	assert.equal(service.getStatus().whitelist.length, 1)

	const again = service.recordVerdict({ rule: 'symbol-run', severity: 'high', channel: 'reasoning', detail: { count: 64 }, evidence: '⇒⇒⇒' }, { model: 'm1', action: 'truncate' })
	assert.equal(again.suppressed, true, '登记为误报后同类判定应当被抑制')
	assert.equal(again.entry, null)
	assert.equal(service.getVerdicts().total, 1, '被抑制的判定不落盘')
})

test('没有判定记录时 ackVerdict 给出错误', () => {
	const { service } = makeService()
	const ack = service.ackVerdict()
	assert.equal(ack.ok, false)
	assert.ok(ack.error)
})

test('modelIncludes 限定守卫范围', () => {
	const { service } = makeService({ config: { modelIncludes: ['MiniMax'] } })
	assert.equal(service.shouldGuardModel('minimax-cn/MiniMax-M3.1-Flash'), true)
	assert.equal(service.shouldGuardModel('deepseek-chat'), false)
})

test('modelIncludes 为空时守卫所有模型', () => {
	const { service } = makeService()
	assert.equal(service.shouldGuardModel('任何模型'), true)
})

test('scanArtifacts 用配置里的工作区与 minRun（复审 F1/F6：调用方给的不认）', async () => {
	const { service, calls, dir } = makeService({ config: { artifacts: { minRun: 30 } } })
	await service.scanArtifacts()
	assert.deepEqual(calls.scan[0].roots, [dir])
	assert.equal(calls.scan[0].minRun, 30)
	// 浏览器端给的根目录与阈值一律不认 ——
	// 否则远程调用可以把扫描/修复范围改成任意目录，等于一个通用文本改写器。
	await service.scanArtifacts({ roots: ['/a', '/b'], minRun: 5 })
	assert.deepEqual(calls.scan[1].roots, [dir], '根目录必须来自配置')
	assert.equal(calls.scan[1].minRun, 30, '阈值必须来自配置')
})

test('scanArtifacts 的大小上限取自配置（请求里带了才用请求的）', async () => {
	const { service, calls } = makeService({ config: { artifacts: { maxFileBytes: 12345678 } } })
	await service.scanArtifacts()
	assert.equal(calls.scan[0].maxFileBytes, 12345678, '配置里的大小上限必须传下去')
	await service.scanArtifacts({ maxFileBytes: 999 })
	assert.equal(calls.scan[1].maxFileBytes, 999, '请求里带了就用请求的')
})

test('repairArtifacts 也用配置里的大小上限', async () => {
	const { service, calls } = makeService({ config: { artifacts: { maxFileBytes: 12345678 } } })
	await service.repairArtifacts({ files: ['a.md'] })
	assert.equal(calls.repair[0].maxFileBytes, 12345678)
})

test('repairArtifacts 不给文件时直接报错', async () => {
	const { service } = makeService()
	const result = await service.repairArtifacts({})
	assert.equal(result.applied, false)
	assert.ok(result.error)
})

test('repairArtifacts 默认只预览，不落盘', async () => {
	const { service, calls } = makeService()
	await service.repairArtifacts({ files: ['a.md'] })
	assert.equal(calls.repair[0].apply, false, '默认不得改写文件')
	await service.repairArtifacts({ files: ['a.md'], apply: true })
	assert.equal(calls.repair[1].apply, true)
})

test('复审 D6：命令用的修复入口认根目录，浏览器用的那个不认', async () => {
	const { service, calls, dir } = makeService()
	// 命令侧：/degen-fix 会把根目录绑到用户点名文件的所在目录，
	// 浏览器侧：根目录只能由配置决定，浏览器不能放宽写范围。
	await service.repairArtifactsInRoots({ files: ['/elsewhere/secret.md'], roots: ['/elsewhere'], apply: true })
	assert.deepEqual(calls.repair[0].roots, ['/elsewhere'], '命令入口必须把根目录传下去')
	await service.repairArtifacts({ files: ['/elsewhere/secret.md'], roots: ['/elsewhere'], apply: true })
	assert.deepEqual(calls.repair[1].roots, [dir], '浏览器入口必须忽略调用方给的根目录')
})

test('cleanSessions 按会话 id 找到存档，并默认只预览', async () => {
	const dir = tempDir()
	const sessionsRoot = path.join(dir, 'sessions')
	const sessionId = '9ecbf69d-session'
	const sessionDir = path.join(sessionsRoot, 'project', sessionId)
	fs.mkdirSync(sessionDir, { recursive: true })
	fs.writeFileSync(path.join(sessionDir, 'session.v4.jsonl.zstd'), 'x')
	const { service, calls } = makeService({ sessionsRoot })
	const result = await service.cleanSessions({ sessionId })
	assert.equal(result.masked, 0)
	assert.equal(calls.mask[0].file, path.join(sessionDir, 'session.v4.jsonl.zstd'))
	assert.equal(calls.mask[0].apply, false, '默认只出预览')
})

test('会话与工件的多字符单元治理开关只认配置（浏览器端不能放宽）', async () => {
	const dir = tempDir()
	const sessionsRoot = path.join(dir, 'sessions')
	const sessionId = '9ecbf69d-session'
	const sessionDir = path.join(sessionsRoot, 'project', sessionId)
	fs.mkdirSync(sessionDir, { recursive: true })
	fs.writeFileSync(path.join(sessionDir, 'session.v4.jsonl.zstd'), 'x')
	const { service, calls } = makeService({
		sessionsRoot,
		config: { sessions: { unitRun: false, unitRepeats: 9 }, artifacts: { unitRun: false, unitRepeats: 7 } },
	})
	await service.scanSessions()
	await service.cleanSessions({ sessionId })
	assert.equal(calls.scanSessions[0].unitRun, false, '会话扫描必须认配置里的开关')
	assert.equal(calls.scanSessions[0].unitRepeats, 9, '份数阈值必须来自配置')
	assert.equal(calls.mask[0].unitRun, false, '会话遮蔽必须认配置里的开关')
	assert.equal(calls.mask[0].unitRepeats, 9, '份数阈值必须来自配置')
	// 浏览器端就算在请求里塞了开关，也不认。
	await service.cleanSessions({ sessionId, unitRun: true, unitRepeats: 2 })
	assert.equal(calls.mask[1].unitRun, false, '请求里的开关必须被忽略')
	assert.equal(calls.mask[1].unitRepeats, 9, '请求里的份数阈值必须被忽略')
})

test('cleanSessions 找不到存档时给出错误', async () => {
	const { service } = makeService()
	const result = await service.cleanSessions({ sessionId: '不存在的会话' })
	assert.ok(result.error)
})

test('cleanSessions 认遮蔽方式：只认 collapse / remove，其它值回落到配置', async () => {
	const dir = tempDir()
	const sessionsRoot = path.join(dir, 'sessions')
	const sessionId = 'mask-mode-session'
	const sessionDir = path.join(sessionsRoot, 'project', sessionId)
	fs.mkdirSync(sessionDir, { recursive: true })
	fs.writeFileSync(path.join(sessionDir, 'session.v4.jsonl.zstd'), 'x')
	const { service, calls } = makeService({ sessionsRoot, config: { sessions: { maskMode: 'collapse' } } })
	await service.cleanSessions({ sessionId, maskMode: 'remove' })
	assert.equal(calls.mask[0].maskMode, 'remove', 'remove 必须透传给遮蔽器')
	await service.cleanSessions({ sessionId, maskMode: '瞎写' })
	assert.equal(calls.mask[1].maskMode, 'collapse', '非法值必须回落到配置里的方式')
	await service.cleanSessions({ sessionId })
	assert.equal(calls.mask[2].maskMode, 'collapse')
})

test('scanSessionWorkspace 用宿主解析出来的会话工作目录扫描（浏览器不能点名目录）', async () => {
	const dir = tempDir()
	const sessionsRoot = path.join(dir, 'sessions')
	const workspace = path.join(dir, 'workspace')
	const sessionId = '0495b230-350a-4ebe-99d8-2fa59902d048'
	const sessionDir = path.join(sessionsRoot, 'project', sessionId)
	fs.mkdirSync(sessionDir, { recursive: true })
	fs.writeFileSync(
		path.join(sessionDir, 'session.v4.jsonl.zstd'),
		`${JSON.stringify({ type: 'session', id: sessionId, cwd: workspace })}\n`,
	)
	const { service, calls } = makeService({ sessionsRoot })
	const result = await service.scanSessionWorkspace({ sessionId })
	assert.equal(result.ok, true, result.error)
	assert.equal(result.session.cwd, workspace)
	assert.deepEqual(calls.scan[0].roots, [workspace], '扫描根目录必须是这个会话的工作目录')
})

test('scanSessionWorkspace 缺 sessionId 或读不出工作目录时给错误', async () => {
	const { service } = makeService()
	const missing = await service.scanSessionWorkspace({})
	assert.equal(missing.ok, false)
	assert.ok(missing.error)
	const notFound = await service.scanSessionWorkspace({ sessionId: '不存在的会话' })
	assert.equal(notFound.ok, false)
	assert.ok(notFound.error)
})

test('repairArtifacts 带 sessionId 时，把写范围收在这个会话的工作目录里', async () => {
	const dir = tempDir()
	const sessionsRoot = path.join(dir, 'sessions')
	const workspace = path.join(dir, 'workspace')
	const sessionId = 'session-abc123'
	const sessionDir = path.join(sessionsRoot, 'project', sessionId)
	fs.mkdirSync(sessionDir, { recursive: true })
	fs.writeFileSync(
		path.join(sessionDir, 'session.v4.jsonl.zstd'),
		`${JSON.stringify({ type: 'session', id: 'abc123', cwd: workspace })}\n`,
	)
	const { service, calls } = makeService({ sessionsRoot })
	await service.repairArtifacts({ files: ['a.md'], sessionId, apply: true })
	assert.deepEqual(calls.repair[0].roots, [workspace], '修复范围必须跟着会话走')
})

test('resolveSessionFile 能命中 session-<id> 形式的目录名', () => {
	const dir = tempDir()
	const sessionsRoot = path.join(dir, 'sessions')
	const sessionDir = path.join(sessionsRoot, 'project', 'session-abc123')
	fs.mkdirSync(sessionDir, { recursive: true })
	const file = path.join(sessionDir, 'session.v4.jsonl.zstd')
	fs.writeFileSync(file, 'x')
	assert.equal(resolveSessionFile(sessionsRoot, 'abc123'), file, '裸 id 要能命中 session-<id> 目录')
	assert.equal(resolveSessionFile(sessionsRoot, 'session-abc123'), file)
})

test('resolveSessionFile 找不到时返回 undefined', () => {
	const dir = tempDir()
	assert.equal(resolveSessionFile(path.join(dir, 'sessions'), '不存在的会话'), undefined)
})

test('getStatus 汇总配置、规则、判定与白名单', () => {
	const { service } = makeService()
	service.recordVerdict({ rule: 'symbol-run', severity: 'high', channel: 'reasoning', detail: { count: 64 } }, { model: 'm1' })
	const status = service.getStatus()
	assert.equal(status.enabled, true)
	assert.ok(status.config)
	assert.ok(status.rules['symbol-run'])
	assert.equal(status.verdicts.length, 1)
	assert.equal(status.counts.verdicts, 1)
	assert.ok(status.lastVerdict)
})

/** 净化折叠标记。 */
const MARKER = '〔退化符号流×30〕'

/**
 * 造一个带折叠标记的会话存档。
 * @param {string} sessionsRoot - 会话根目录
 * @param {string} sessionId - 会话 id
 * @returns {string} 存档路径
 */
function seedSession(sessionsRoot, sessionId) {
	const sessionDir = path.join(sessionsRoot, 'project', sessionId)
	fs.mkdirSync(sessionDir, { recursive: true })
	const file = path.join(sessionDir, 'session.v4.jsonl.zstd')
	const events = [
		{ type: 'session', version: 4, id: sessionId, createdAt: 1, cwd: 'C:/work' },
		{
			type: 'assistant/message',
			seq: 0,
			time: 2,
			surfaceOp: 'append',
			data: {
				turn: 1,
				step: 1,
				message: {
					role: 'assistant',
					content: [{ type: 'text', text: `结论如下${MARKER}以上。` }],
					source: { kind: 'model', provider: 'test', model: 'test-model' },
					id: 'msg-0',
				},
				stream: [],
			},
		},
	]
	fs.writeFileSync(file, Buffer.from(events.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8'))
	return file
}

/**
 * 造一个**带标题**的会话存档。
 *
 * 判定日志页要显示「会话名称」，名称来自存档里的 `session/title` 事件。
 *
 * @param {string} sessionsRoot - 会话根目录
 * @param {string} sessionId - 会话 id
 * @param {string} title - 会话标题
 * @returns {string} 存档路径
 */
function seedTitledSession(sessionsRoot, sessionId, title) {
	const sessionDir = path.join(sessionsRoot, 'project', sessionId)
	fs.mkdirSync(sessionDir, { recursive: true })
	const file = path.join(sessionDir, 'session.v4.jsonl.zstd')
	const events = [
		{ type: 'session', version: 4, id: sessionId, createdAt: 1, cwd: 'C:/work' },
		{ type: 'session/title', data: { title } },
	]
	fs.writeFileSync(file, Buffer.from(events.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8'))
	return file
}

test('listInterventions 返回本会话的干预并定位到存档位置', async () => {
	const dir = tempDir()
	const sessionsRoot = path.join(dir, 'sessions')
	const sessionId = 'session-abc123'
	seedSession(sessionsRoot, sessionId)
	const { service } = makeService({ sessionsRoot, revertsFile: path.join(dir, 'reverts.jsonl') })
	service.recordVerdict(
		{ rule: 'symbol-run', severity: 'high', channel: 'text', onset: 4, evidence: '⇒', detail: { count: 30 } },
		{ sessionId, model: 'm1', action: 'sanitize', marker: MARKER, original: '⇒'.repeat(30), offset: 12 },
	)
	const result = await service.listInterventions({ sessionId })
	assert.equal(result.ok, true, result.error)
	assert.equal(result.entries.length, 1)
	const entry = result.entries[0]
	assert.equal(entry.action, 'sanitize')
	assert.equal(entry.reverted, false)
	assert.equal(entry.restorable, true)
	assert.ok(entry.position, '要能定位到存档里的位置')
	assert.equal(entry.position.event, 1)
	assert.equal(entry.position.path, 'data.message.content[0].text')
	assert.ok(entry.preview.segments[0].removed.includes('⇒'), '预览里要有被折叠掉的原文')
	assert.equal(entry.preview.segments[0].added, MARKER)
})

test('listInterventions 只认本会话的干预', async () => {
	const dir = tempDir()
	const sessionsRoot = path.join(dir, 'sessions')
	seedSession(sessionsRoot, 'session-abc123')
	const { service } = makeService({ sessionsRoot, revertsFile: path.join(dir, 'reverts.jsonl') })
	service.recordVerdict({ rule: 'symbol-run', channel: 'text', detail: { count: 30 } }, { sessionId: 'session-other', model: 'm1', action: 'sanitize', marker: MARKER, original: 'x' })
	const result = await service.listInterventions({ sessionId: 'session-abc123' })
	assert.equal(result.entries.length, 0, '别的会话的干预不该出现在这里')
})

test('revertIntervention 把净化条目恢复成原文，并标记已回退', async () => {
	const dir = tempDir()
	const sessionsRoot = path.join(dir, 'sessions')
	const sessionId = 'session-abc123'
	const file = seedSession(sessionsRoot, sessionId)
	const revertsFile = path.join(dir, 'reverts.jsonl')
	const { service } = makeService({ sessionsRoot, revertsFile })
	service.recordVerdict(
		{ rule: 'symbol-run', severity: 'high', channel: 'text', onset: 4, evidence: '⇒', detail: { count: 30 } },
		{ sessionId, model: 'm1', action: 'sanitize', marker: MARKER, original: '⇒'.repeat(30), offset: 12 },
	)
	const [entry] = (await service.listInterventions({ sessionId })).entries
	const result = await service.revertIntervention({ id: entry.id })
	assert.equal(result.ok, true, result.error)
	assert.equal(result.restored, true)
	const text = fs.readFileSync(file, 'utf8')
	assert.ok(text.includes('⇒'.repeat(30)), '原文要写回存档')
	assert.ok(!text.includes(MARKER), '标记要被换掉')
	// 再看一眼：这条应当已经标成「已回退」，而且不能再回退一次。
	const after = await service.listInterventions({ sessionId })
	assert.equal(after.entries[0].reverted, true)
	assert.equal(after.entries[0].restorable, false)
	const twice = await service.revertIntervention({ id: entry.id })
	assert.equal(twice.ok, false)
	assert.equal(twice.alreadyReverted, true)
})

test('revertIntervention 拒绝截断类干预与不存在的条目', async () => {
	const dir = tempDir()
	const sessionsRoot = path.join(dir, 'sessions')
	const sessionId = 'session-abc123'
	seedSession(sessionsRoot, sessionId)
	const { service } = makeService({ sessionsRoot, revertsFile: path.join(dir, 'reverts.jsonl') })
	service.recordVerdict({ rule: 'symbol-run', channel: 'text', detail: { count: 30 } }, { sessionId, model: 'm1', action: 'truncate' })
	const [entry] = (await service.listInterventions({ sessionId })).entries
	const result = await service.revertIntervention({ id: entry.id })
	assert.equal(result.ok, false)
	assert.ok(result.error.includes('截断'), result.error)
	const missing = await service.revertIntervention({ id: '不存在的条目' })
	assert.equal(missing.ok, false)
})
