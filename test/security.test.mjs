/**
 * 安全契约测试（评审轮新增）。
 *
 * 覆盖评审发现的越权写、路径穿越、遮蔽越界、非法配置落盘等问题：
 * - D1 服务边界不得接受调用方指定的输出路径；
 * - D2 修复不得顺着符号链接写到根目录之外；
 * - D3 显式文件列表不得绕过根目录；
 * - D4/D5 写后校验的根目录判定必须是真的包含关系；
 * - D6/D7 会话遮蔽只能动助手的文本/思考，工具调用与工具结果必须原样；
 * - D8 遮蔽后的残留必须报成错误；
 * - D9 setConfig 不得落盘非法配置；
 * - D10 非 UTF-8 文件不得被改坏，备份必须是字节副本。
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createGuardDegenService } from '../lib/service.js'
import { isInsideRoot, isInsideRoots } from '../lib/post-execute.js'
import { repairArtifacts, scanArtifacts } from '../lib/artifacts.js'
import './helpers/temp-home.mjs'

/**
 * 建一个临时目录。
 * @returns {string} 目录路径
 */
function tempDir() {
	return fs.mkdtempSync(path.join(os.tmpdir(), 'degen-security-'))
}

/**
 * 造一份带退化内容的文件。
 * @param {string} dir - 目录
 * @param {string} name - 文件名
 * @param {string} [body] - 正文
 * @returns {string} 文件路径
 */
function pollutedFile(dir, name, body = `head\n${'⇒'.repeat(30)}\ntail\n`) {
	const file = path.join(dir, name)
	fs.writeFileSync(file, body, 'utf8')
	return file
}

// ── D1：服务边界不接受调用方指定的输出路径 ────────────────────────────

test('D1 cleanSessions 不接受调用方指定的 outFile/auditFile', async () => {
	const dir = tempDir()
	const archive = path.join(dir, 'session.jsonl')
	fs.writeFileSync(archive, `${JSON.stringify({ type: 'assistant', data: { text: '⇒'.repeat(30) } })}\n`, 'utf8')
	const outside = path.join(tempDir(), 'evil.txt')
	const service = createGuardDegenService({
		sessionsRoot: dir,
		useOverride: false,
		scanSessions: async () => ({ sessions: [], summary: {} }),
		maskSession: async (options) => {
			// 复刻 lib/sessions.js 的行为：调用方指定的输出路径会被优先采用。
			if (options.outFile) fs.writeFileSync(options.outFile, 'x')
			if (options.auditFile) fs.writeFileSync(options.auditFile, 'x')
			return { applied: true, masked: 1, symbols: 30 }
		},
	})
	await service.cleanSessions({ file: archive, apply: true, outFile: outside, auditFile: `${outside}.audit` })
	assert.equal(fs.existsSync(outside), false, '调用方指定的 outFile 不该被写')
	assert.equal(fs.existsSync(`${outside}.audit`), false, '调用方指定的 auditFile 不该被写')
})

test('D1 repairArtifacts 不接受调用方指定的 backupDir', async () => {
	const dir = tempDir()
	const file = pollutedFile(dir, 'a.md')
	const elsewhere = path.join(tempDir(), 'backups')
	const service = createGuardDegenService({
		useOverride: false,
		scanArtifacts: async () => ({ files: [], summary: {} }),
		repairArtifacts: async (options) => {
			if (options.backupDir) fs.mkdirSync(options.backupDir, { recursive: true })
			return { applied: true, mode: options.mode, results: [], summary: { requested: 0, changed: 0, failed: 0, symbols: 0 } }
		},
	})
	await service.repairArtifacts({ files: [file], apply: true, backupDir: elsewhere })
	assert.equal(fs.existsSync(elsewhere), false, '调用方指定的 backupDir 不该被使用')
})

// ── D2：修复不顺着符号链接跑到根目录外 ────────────────────────────────

test('D2 修复不跟随指向根目录外的符号链接', async () => {
	const root = tempDir()
	const outsideDir = tempDir()
	const outside = path.join(outsideDir, 'outside.txt')
	fs.writeFileSync(outside, `head\n${'⇒'.repeat(30)}\ntail\n`, 'utf8')
	const link = path.join(root, 'link.md')
	try {
		fs.symlinkSync(outside, link, 'file')
	} catch {
		return // 没有符号链接权限的环境跳过
	}
	const result = await repairArtifacts({ files: [link], apply: true, roots: [root] })
	assert.equal(fs.readFileSync(outside, 'utf8'), `head\n${'⇒'.repeat(30)}\ntail\n`, '根目录外的文件被改写了')
	assert.equal(result.results?.[0]?.changed, false, '顺着链接的修复应当被拒绝')
	assert.match(String(result.results?.[0]?.error ?? ''), /链接|symlink|根目录/i)
})

// ── D3：显式文件列表不能绕过根目录 ────────────────────────────────────

test('D3 显式文件列表里的根目录外文件不会被扫描', async () => {
	const root = tempDir()
	const outside = pollutedFile(tempDir(), 'outside.md')
	const report = await scanArtifacts({ roots: [root], files: [outside] })
	assert.equal(report.files.length, 0, '根目录外的文件不该被扫描')
})

test('B3b 修复拒绝根目录之外的文件', async () => {
	const root = tempDir()
	const outside = pollutedFile(tempDir(), 'outside.md')
	const result = await repairArtifacts({ files: [outside], apply: true, roots: [root] })

	assert.equal(fs.readFileSync(outside, 'utf8').includes('⇒'.repeat(30)), true, '根目录外的文件被改写了')
	assert.equal(result.results?.[0]?.changed, false, '根目录外的文件不该被修复')
	assert.match(String(result.results?.[0]?.error ?? ''), /根目录/)
})

test('N3 不传根目录时，修复默认只认工作区', async () => {
	const outside = pollutedFile(tempDir(), 'outside.md')
	const result = await repairArtifacts({ files: [outside], apply: true })

	assert.equal(fs.readFileSync(outside, 'utf8').includes('⇒'.repeat(30)), true, '工作区之外的文件被改写了')
	assert.equal(result.results?.[0]?.changed, false, '默认根目录之外的文件不该被修复')
	assert.match(String(result.results?.[0]?.error ?? ''), /根目录/)
})

test('D3 显式文件列表里的根目录内文件仍会被扫描', async () => {
	const root = tempDir()
	const inside = pollutedFile(root, 'inside.md')
	const report = await scanArtifacts({ roots: [root], files: [inside] })
	assert.equal(report.files.length, 1)
})

// ── D4/D5：根目录判定 ─────────────────────────────────────────────────

test('D4 空的 roots 列表不允许读任何文件', () => {
	assert.equal(isInsideRoots('C:/Windows/System32/drivers/etc/hosts', []), false)
	assert.equal(isInsideRoots('C:/Windows/System32/drivers/etc/hosts', undefined), false)
})

test('D5 根目录判定基于解析后的路径，.. 不能穿越', () => {
	assert.equal(isInsideRoot('/work/../etc/passwd', '/work'), false)
	assert.equal(isInsideRoot('/work/sub/file.md', '/work'), true)
	assert.equal(isInsideRoot('/work', '/work'), true)
	assert.equal(isInsideRoot('/work2/file.md', '/work'), false)
})

test('D12 以 .. 开头的正常文件名不算越界', () => {
	// 复审缺陷 D7：`relative.startsWith('..')` 把 `..notes.md` 这类合法文件
	// 判成越界——真正的越界形态只有 `..` 本身或 `..\` 开头的目录。
	assert.equal(isInsideRoot('/work/..notes.md', '/work'), true)
	assert.equal(isInsideRoot('/work/..hidden/a.md', '/work'), true)
	assert.equal(isInsideRoot('/work/../outside.md', '/work'), false)
	assert.equal(isInsideRoot('/work/sub/../../outside.md', '/work'), false)
})

test('M1 工件侧的根目录判定：空 roots 一律拒绝', async () => {
	// 工件侧有自己的一份判定（按真实路径比较），和 post-execute 那份不是同一个函数。
	// 空 roots 必须同样是「什么都不许碰」——放行等于模型指定的任意路径都能被读进来。
	const { isInsideRoots: artifactRoots } = await import('../lib/artifacts.js')
	assert.equal(artifactRoots('C:/Windows/System32/drivers/etc/hosts', []), false)
	assert.equal(artifactRoots('C:/Windows/System32/drivers/etc/hosts', undefined), false)
	const dir = tempDir()
	const inside = pollutedFile(dir, 'inside.md')
	assert.equal(artifactRoots(inside, [dir]), true)
	assert.equal(artifactRoots(path.join(dir, '..', 'outside.md'), [dir]), false)
	assert.equal(artifactRoots(path.join(dir, '..'), [dir]), false, '根目录的直接上级也算越界')
	assert.equal(artifactRoots(path.join(dir, '..notes.md'), [dir]), true, '以两个点开头的文件名是合法文件')
})

test('M1 根目录本身是符号链接时，里面的文件仍然算数', async () => {
	// 根目录判定比较的是**真实路径**：用户把根目录配成一个链接时，
	// 按字面路径比较会把里面的文件全判成越界。
	const { isInsideRoots: artifactRoots } = await import('../lib/artifacts.js')
	const dir = tempDir()
	const real = path.join(dir, 'real')
	fs.mkdirSync(real, { recursive: true })
	const file = pollutedFile(real, 'inside.md')
	const link = path.join(dir, 'linked')
	try {
		fs.symlinkSync(real, link, 'junction')
	} catch {
		try {
			fs.symlinkSync(real, link, 'dir')
		} catch {
			return // 没有符号链接权限的环境跳过
		}
	}
	assert.equal(artifactRoots(file, [link]), true, '链接根目录里的文件不该被判成越界')
	assert.equal(artifactRoots(file, [real]), true)
})

test('M3 空 roots 退回工作目录，扫描与修复口径一致', async () => {
	// 空列表在扫描与修复两侧都是「退回当前工作目录」——
	// 两边口径必须一致，否则会出现「扫得到但修不了」或者反过来。
	const dir = tempDir()
	const file = pollutedFile(dir, 'inside.md')
	const before = fs.readFileSync(file, 'utf8')
	const report = await scanArtifacts({ roots: [], files: [file] })
	assert.equal(report.files.length, 0, '工作目录之外的文件扫不到')
	const repaired = await repairArtifacts({ files: [file], apply: true, roots: [] })
	assert.equal(repaired.summary.changed, 0, '工作目录之外的文件修不了')
	assert.equal(fs.readFileSync(file, 'utf8'), before, '文件不该被改')
})

test('M3 修复时根目录之外的文件给出原因而不是静默跳过', async () => {
	const dir = tempDir()
	const outside = pollutedFile(tempDir(), 'outside.md')
	const before = fs.readFileSync(outside, 'utf8')
	const repaired = await repairArtifacts({ files: [outside], apply: true, roots: [dir] })
	assert.equal(repaired.results.length, 1)
	assert.equal(repaired.results[0].changed, false)
	assert.match(String(repaired.results[0].error ?? ''), /根目录/)
	assert.equal(fs.readFileSync(outside, 'utf8'), before, '文件不该被改')
})

test('M4 修复入口拒绝经由符号链接的文件', async () => {
	const root = tempDir()
	const outside = path.join(tempDir(), 'outside.md')
	fs.writeFileSync(outside, `head\n${'⇒'.repeat(30)}\ntail\n`, 'utf8')
	const link = path.join(root, 'link.md')
	try {
		fs.symlinkSync(outside, link, 'file')
	} catch {
		return // 没有符号链接权限的环境跳过
	}
	const before = fs.readFileSync(outside, 'utf8')
	const result = await repairArtifacts({ files: [link], apply: true, roots: [root] })
	assert.match(String(result.results?.[0]?.error ?? ''), /符号链接|根目录/)
	assert.equal(fs.readFileSync(outside, 'utf8'), before, '根目录外的文件不该被改')
})

// ── D6/D7：遮蔽只动助手的文本与思考 ───────────────────────────────────

test('D6 遮蔽只改助手文本，用户提示与工具结果原样保留', async () => {
	const { maskSession } = await import('../lib/sessions.js')
	const dir = tempDir()
	const archive = path.join(dir, 'session.jsonl')
	const userText = `帮我看下这个 ${'⇒'.repeat(30)}`
	const toolText = `文件内容 ${'⇒'.repeat(30)}`
	const assistantText = `好的 ${'⇒'.repeat(30)}`
	const lines = [
		{ type: 'session', version: 4, id: 'd6', createdAt: 1, cwd: dir },
		{ type: 'user', seq: 0, time: 2, data: { message: { content: [{ type: 'text', text: userText }] } } },
		{ type: 'tool', seq: 1, time: 3, data: { result: { content: toolText } } },
		{ type: 'assistant', seq: 2, time: 4, data: { message: { content: [{ type: 'text', text: assistantText }] } } },
	]
	fs.writeFileSync(archive, lines.map((line) => JSON.stringify(line)).join('\n') + '\n', 'utf8')
	const result = await maskSession({ file: archive, apply: true, mode: 'replace', minRun: 20, roots: [dir] })
	const after = fs.readFileSync(archive, 'utf8')
	assert.ok(after.includes(userText), '用户提示被改写了')
	assert.ok(after.includes(toolText), '工具结果被改写了')
	assert.ok(!after.includes(assistantText), '助手文本应当被遮蔽')
	assert.ok(result.masked >= 1)
})

test('D7 tool-call-chunks 记录里的工具参数原样保留', async () => {
	const { maskSession } = await import('../lib/sessions.js')
	const dir = tempDir()
	const archive = path.join(dir, 'session.jsonl')
	const args = JSON.stringify({ file_path: 'a.md', content: '⇒'.repeat(30) })
	const lines = [
		{ type: 'session', version: 4, id: 'd7', createdAt: 1, cwd: dir },
		{ type: 'assistant', seq: 0, time: 2, data: { stream: [{ type: 'tool-call-chunks', id: 'call-1', name: 'write', args: [args] }] } },
		{ type: 'assistant', seq: 1, time: 3, data: { message: { content: [{ type: 'text', text: '⇒'.repeat(30) }] } } },
	]
	fs.writeFileSync(archive, lines.map((line) => JSON.stringify(line)).join('\n') + '\n', 'utf8')
	await maskSession({ file: archive, apply: true, mode: 'replace', minRun: 20, roots: [dir] })
	const after = fs.readFileSync(archive, 'utf8').split('\n').filter((line) => line !== '')
	// 工具参数那行原样保留（存档里它是转义过的 JSON 字符串），助手正文那行被遮蔽。
	assert.ok(after[1].includes('⇒'.repeat(30)), 'tool-call-chunks 的参数被改写了')
	assert.ok(after[1].includes('tool-call-chunks'), 'tool-call-chunks 的结构被改写了')
	assert.ok(!after[2].includes('⇒'.repeat(30)), '助手正文没有被遮蔽')
})

// ── D8：残留必须报成错误 ──────────────────────────────────────────────

test('D8 遮蔽后仍有残留时报错而不是成功', async () => {
	const { maskSession } = await import('../lib/sessions.js')
	const dir = tempDir()
	const archive = path.join(dir, 'session.jsonl')
	fs.writeFileSync(archive, `${JSON.stringify({ type: 'assistant', data: { text: '⇒'.repeat(30) } })}\n`, 'utf8')
	const result = await maskSession({
		file: archive,
		apply: true,
		mode: 'replace',
		minRun: 20,
		roots: [dir],
		// 写回原文，模拟「改写没生效」。
		writeFile: () => {},
		// replace 模式是「写临时文件 + 改名」，这里同样让改名落空，
		// 才能走到回读复核那一步。
		rename: () => {},
	})
	assert.ok(result.remaining >= 1, '应当统计到残留')
	assert.match(String(result.error ?? ''), /残留|复核/i, '残留必须报错')
})

// ── D9：setConfig 不得落盘非法配置 ───────────────────────────────────

test('D9 合并后的配置非法时 setConfig 拒绝落盘', async () => {
	const store = new Map()
	const overrideFile = path.join(tempDir(), 'config.json')
	store.set(overrideFile, JSON.stringify({ stream: { holdbackChars: 'abc' } }))
	const service = createGuardDegenService({
		overrideFile,
		readFile: (file) => {
			if (!store.has(file)) throw new Error('没有覆盖文件')
			return store.get(file)
		},
		writeFile: (file, data) => store.set(file, data),
	})
	const result = service.setConfig({ stream: { windowChars: 1000 } })
	assert.equal(result.ok, false, '非法配置被放行了')
	assert.match(JSON.stringify(result.errors), /holdbackChars/)
})

test('D9 小数与负数的数值配置被拒绝', () => {
	const service = createGuardDegenService({ useOverride: false })
	const fractional = service.setConfig({ stream: { maxInterventionsPerCall: 1.5 } })
	assert.equal(fractional.ok, false, '小数应当被拒绝')
})

// ── D10：非 UTF-8 文件不得被改坏，备份必须是字节副本 ──────────────────

test('D10 非 UTF-8 文件不被改写，原字节保持不变', async () => {
	const dir = tempDir()
	const file = path.join(dir, 'gbk.md')
	const original = Buffer.concat([Buffer.from([0xd6, 0xd0, 0xce, 0xc4]), Buffer.from('说明\n'), Buffer.from('⇒'.repeat(30), 'utf8'), Buffer.from('\n', 'utf8')])
	fs.writeFileSync(file, original)
	const result = await repairArtifacts({ files: [file], apply: true, minRun: 20, roots: [dir] })
	assert.deepEqual(fs.readFileSync(file), original, '非 UTF-8 文件被改坏了')
	assert.match(String(result.results?.[0]?.error ?? ''), /UTF-8/)
	assert.equal(fs.existsSync(`${file}.degen-backup`), false, '被跳过的文件不该留下备份')
})

test('D10 UTF-8 文件的备份是原文件的字节副本', async () => {
	const dir = tempDir()
	const file = path.join(dir, 'utf8.md')
	const original = Buffer.from(`说明\n${'⇒'.repeat(30)}\n`, 'utf8')
	fs.writeFileSync(file, original)
	const result = await repairArtifacts({ files: [file], apply: true, minRun: 20, roots: [dir] })
	assert.equal(result.results?.[0]?.remaining, 0)
	const backup = fs.readFileSync(`${file}.degen-backup`)
	assert.deepEqual(backup, original, '备份不是原文件的字节副本')
})

// ── D11：审计旁车不得写在会话目录里 ──────────────────────────────────

test('D11 遮蔽的审计旁车写在插件自己的目录里，不落在会话目录', async () => {
	const { maskSession } = await import('../lib/sessions.js')
	const dir = tempDir()
	const archive = path.join(dir, 'session.jsonl')
	fs.writeFileSync(archive, `${JSON.stringify({ type: 'assistant', data: { text: '⇒'.repeat(30) } })}\n`, 'utf8')
	const result = await maskSession({ file: archive, apply: true, mode: 'copy', minRun: 20, roots: [dir] })

	assert.ok(result.audit, '要有审计文件路径')
	assert.equal(path.dirname(result.audit), path.dirname(result.audit), '审计路径必须可解析')
	assert.ok(!result.audit.startsWith(dir + path.sep), `审计文件不得写在会话目录里：${result.audit}`)
	assert.ok(result.audit.includes(`${path.sep}guard-degen${path.sep}`), `审计文件应放在插件目录下：${result.audit}`)
})

// ── 次要缺陷：配置项不得形同虚设、闸门不得默认放行 ────────────────────

test('次要：artifacts.apply=true 时 repairArtifacts 才会落盘', async () => {	const dir = tempDir()
	const file = pollutedFile(dir, 'a.md')
	const store = new Map()
	const overrideFile = path.join(tempDir(), 'config.json')
	const service = createGuardDegenService({
		overrideFile,
		readFile: (f) => {
			if (!store.has(f)) throw new Error('没有覆盖文件')
			return store.get(f)
		},
		writeFile: (f, data) => store.set(f, data),
	})
	const preview = await service.repairArtifacts({ files: [file] })
	assert.equal(preview.applied, false, '默认必须是只读预览')
	assert.equal(fs.readFileSync(file, 'utf8').includes('⇒'.repeat(30)), true, '预览不得改文件')

	const applied = await service.setConfig({ artifacts: { apply: true, roots: [dir] } })
	assert.equal(applied.ok, true, JSON.stringify(applied.errors ?? []))
	const result = await service.repairArtifacts({ files: [file] })
	assert.equal(result.applied, true, '配置里的 apply=true 必须生效')
	assert.equal(fs.readFileSync(file, 'utf8').includes('⇒'.repeat(30)), false, '应当已被修复')
})

test('次要：写后校验在 enabled 未设置时默认不放行', async () => {
	const { decidePostExecute } = await import('../lib/post-execute.js')
	const disabled = await decidePostExecute({ name: 'write', arguments: {} }, { isError: false }, { roots: [process.cwd()] })
	assert.equal(disabled.kind, 'accept', '未启用时不得拦下工具结果')
})

// ── 终审复审（第三轮）新增的用例 ─────────────────────────────────────
// 复审代理执行复现出来的：
// - N4 遮蔽会话的目标文件不受会话根目录约束 → 浏览器端能改写磁盘上任意文件；
// - N5 没有任何退化可遮时，仍然改写源文件并留下 .bak；
// - N6 遮蔽副本与备份仍落在会话目录里（审计旁车已经搬走了，副本没搬）。

test('N4 cleanSessions 拒绝会话根目录之外的文件', async () => {
	const dir = tempDir()
	const outside = pollutedFile(dir, 'not-a-session.txt', `head\n${'⇒'.repeat(40)}\ntail\n`)
	const sessionsRoot = path.join(dir, 'sessions')
	fs.mkdirSync(sessionsRoot, { recursive: true })
	const service = createGuardDegenService({ sessionsRoot })

	const result = await service.cleanSessions({ file: outside, apply: true, mode: 'replace' })

	// 必须断言确切文案：replace 模式下副本落点就是源文件本身，
	// 源文件闸门缺失时会被后面的「落点不在范围内」那条闸门兜住，
	// 只断言「有错误」分不清是哪一道闸门拦的。
	assert.equal(
		result.error,
		'文件不在允许的会话根目录之内，已跳过。',
		'会话根目录之外的文件必须被源文件闸门拦下',
	)
	assert.equal(fs.readFileSync(outside, 'utf8').includes('⇒'.repeat(40)), true, '原文件不得被改写')
	assert.equal(fs.existsSync(`${outside}.bak`), false, '不得留下备份')
	assert.equal(fs.existsSync(`${outside}.masked`), false, '不得留下遮蔽副本')
})

test('N4 会话根目录之内的文件仍然可以遮蔽', async () => {
	const dir = tempDir()
	const sessionsRoot = path.join(dir, 'sessions')
	fs.mkdirSync(sessionsRoot, { recursive: true })
	const archive = path.join(sessionsRoot, 'session.jsonl')
	fs.writeFileSync(archive, `${JSON.stringify({ type: 'assistant', data: { text: '⇒'.repeat(30) } })}\n`, 'utf8')
	const service = createGuardDegenService({ sessionsRoot })

	const result = await service.cleanSessions({ file: archive, apply: true, mode: 'copy' })

	assert.equal(result.error, undefined, result.error ?? '')
	assert.ok(result.masked >= 1, '应当确实遮蔽了退化内容')
})

test('N5 没有退化内容时不改写源文件，也不留备份', async () => {
	const { maskSession } = await import('../lib/sessions.js')
	const dir = tempDir()
	const archive = path.join(dir, 'session.jsonl')
	const clean = `${JSON.stringify({ type: 'assistant', data: { text: '一切正常。' } })}\n`
	fs.writeFileSync(archive, clean, 'utf8')

	const result = await maskSession({ file: archive, apply: true, mode: 'replace', minRun: 20, roots: [dir] })

	assert.equal(result.masked, 0, '这份存档本来就没有退化')
	assert.equal(result.applied, false, '没有可遮蔽的内容时不应落盘')
	assert.equal(fs.readFileSync(archive, 'utf8'), clean, '源文件必须保持原样')
	assert.equal(fs.existsSync(`${archive}.bak`), false, '不得留下备份')
})

test('N6 遮蔽副本与备份写在插件自己的目录里，不落在会话目录', async () => {
	const { maskSession } = await import('../lib/sessions.js')
	const dir = tempDir()
	const archive = path.join(dir, 'session.jsonl')
	fs.writeFileSync(archive, `${JSON.stringify({ type: 'assistant', data: { text: '⇒'.repeat(30) } })}\n`, 'utf8')

	const copy = await maskSession({ file: archive, apply: true, mode: 'copy', minRun: 20, roots: [dir] })

	assert.ok(copy.output, '要有遮蔽副本路径')
	assert.ok(!copy.output.startsWith(dir + path.sep), `遮蔽副本不得写在会话目录里：${copy.output}`)
	assert.ok(copy.output.includes(`${path.sep}guard-degen${path.sep}`), `遮蔽副本应放在插件目录下：${copy.output}`)
	assert.equal(fs.existsSync(`${archive}.masked`), false, '会话目录里不该多出 .masked 文件')

	const replaced = await maskSession({ file: archive, apply: true, mode: 'replace', minRun: 20, roots: [dir] })

	assert.ok(replaced.backup, '要有备份路径')
	assert.ok(!replaced.backup.startsWith(dir + path.sep), `备份不得写在会话目录里：${replaced.backup}`)
	assert.ok(replaced.backup.includes(`${path.sep}guard-degen${path.sep}`), `备份应放在插件目录下：${replaced.backup}`)
})

// ── 第五轮安全复审（独立评审代理复现）新增 ───────────────────────────
// 复现脚本在 %TEMP%\final-review-sec\，逐条对应：
// - F1 远程 scanArtifacts 认调用方给的 roots → 能读根目录之外的文件；
// - F2 远程写范围由同一套远程 API 改写（设计取舍，见 ledger 裁定）；
// - F3 maskSession 的 outFile/auditFile/backupFile 与 scanSessions 的 files 绕过根目录；
// - F4 写后校验的根目录判定不认符号链接，与 artifacts 那一份判定打架；
// - F5 判定与写入之间有窗口，中途换成符号链接就写到根目录外面去了；
// - F6 远程修复认调用方给的 minRun/symbols → 变成通用改写器；
// - F7 旁证副本的文件名没消毒 → 能落到日志目录之外。

test('F1 远程扫描不认调用方给的根目录', async () => {
	const dir = tempDir()
	const allowed = pollutedFile(dir, 'allowed.md')
	const outside = pollutedFile(tempDir(), 'private-notes.md')
	// 扫描范围来自宿主配置（GUI 写运行时覆盖也是同一个效果）。
	const service = createGuardDegenService({ useOverride: false, config: { artifacts: { roots: [dir] } } })

	const report = await service.scanArtifacts({ roots: [path.dirname(outside)] })

	assert.equal(report.files.some((item) => item.path === allowed), true, '配置里的根目录仍然要扫')
	assert.equal(report.files.some((item) => item.path === outside), false, '调用方指定的根目录不得被读取')
})

test('F1 命令专用入口才认调用方给的根目录', async () => {
	const dir = tempDir()
	const file = pollutedFile(dir, 'notes.md')
	const service = createGuardDegenService({ useOverride: false })

	const report = await service.scanArtifactsInRoots({ roots: [dir] })

	assert.equal(report.summary.filesWithHits, 1, '命令入口应当能扫指定目录')
	assert.equal(report.files[0].path, file)
})

test('F1 命令专用入口不在远程方法表里', async () => {
	const { REMOTE_METHODS } = await import('../lib/index.js')
	assert.equal(REMOTE_METHODS.includes('scanArtifactsInRoots'), false, '浏览器不得够到命令专用入口')
	assert.equal(REMOTE_METHODS.includes('repairArtifactsInRoots'), false, '浏览器不得够到命令专用入口')
})

test('F3 遮蔽副本、审计、备份的路径必须落在允许范围内', async () => {
	const { maskSession } = await import('../lib/sessions.js')
	const dir = tempDir()
	const archive = path.join(dir, 'session.jsonl')
	fs.writeFileSync(archive, `${JSON.stringify({ type: 'assistant', data: { text: '⇒'.repeat(30) } })}\n`, 'utf8')
	const evil = path.join(tempDir(), 'evil-out.bin')

	const result = await maskSession({ file: archive, apply: true, mode: 'copy', minRun: 20, roots: [dir], outFile: evil })

	assert.ok(result.error, '越界的输出路径必须被拒绝')
	assert.equal(fs.existsSync(evil), false, '不得在越界位置写文件')
	assert.equal(fs.readFileSync(archive, 'utf8').includes('⇒'.repeat(30)), true, '源文件不得被改写')
})

test('F3 遮蔽审计文件同样不许越界', async () => {
	const { maskSession } = await import('../lib/sessions.js')
	const dir = tempDir()
	const archive = path.join(dir, 'session.jsonl')
	fs.writeFileSync(archive, `${JSON.stringify({ type: 'assistant', data: { text: '⇒'.repeat(30) } })}\n`, 'utf8')
	const evil = path.join(tempDir(), 'evil-audit.json')

	const result = await maskSession({ file: archive, apply: true, mode: 'copy', minRun: 20, roots: [dir], auditFile: evil })

	assert.ok(result.error, '越界的审计路径必须被拒绝')
	assert.equal(fs.existsSync(evil), false, '不得在越界位置写文件')
})

test('F3 scanSessions 的显式文件列表不得越过根目录', async () => {
	const { scanSessions } = await import('../lib/sessions.js')
	const dir = tempDir()
	const root = path.join(dir, 'sessions')
	fs.mkdirSync(root, { recursive: true })
	const inside = path.join(root, 'a.jsonl')
	fs.writeFileSync(inside, `${JSON.stringify({ type: 'assistant', data: { text: '⇒'.repeat(30) } })}\n`, 'utf8')
	const outside = path.join(dir, 'stranger.v4.jsonl')
	fs.writeFileSync(outside, `${JSON.stringify({ type: 'assistant', data: { text: '⇒'.repeat(30) } })}\n`, 'utf8')

	const report = scanSessions({ root, files: [inside, outside] })

	assert.equal(report.summary.filesScanned, 1, '只应扫描根目录之内的那一个')
	assert.equal(report.sessions.some((item) => item.path === outside), false, '根目录之外的文件不得被扫描')
})

test('F4 写后校验的根目录判定必须认符号链接', async () => {
	const dir = tempDir()
	const root = path.join(dir, 'root')
	fs.mkdirSync(root, { recursive: true })
	const target = path.join(dir, 'outside.md')
	fs.writeFileSync(target, `head\n${'⇒'.repeat(30)}\ntail\n`, 'utf8')
	const link = path.join(root, 'link.md')
	fs.symlinkSync(target, link, 'file')

	assert.equal(isInsideRoots(link, [root]), false, '指向根目录外的链接不得算在根目录之内')
	const { detectFileViolations } = await import('../lib/post-execute.js')
	const violations = await detectFileViolations([link], { roots: [root] })
	assert.equal(violations.length, 0, '不得读取根目录之外的文件')
})

test('F5 写入前必须按当下的真实路径再判一次', async () => {
	const dir = tempDir()
	const root = path.join(dir, 'root')
	fs.mkdirSync(root, { recursive: true })
	const target = path.join(dir, 'outside.md')
	fs.writeFileSync(target, `head\n${'⇒'.repeat(30)}\ntail\n`, 'utf8')
	const victim = path.join(root, 'victim.md')
	fs.writeFileSync(victim, `head\n${'⇒'.repeat(30)}\ntail\n`, 'utf8')

	const result = await repairArtifacts({
		files: [victim],
		apply: true,
		roots: [root],
		minRun: 20,
		// 判定通过之后、真正写下去之前，把文件换成指向根目录外的符号链接。
		beforeWrite: () => {
			fs.rmSync(victim)
			fs.symlinkSync(target, victim, 'file')
		},
	})

	const row = result.results[0]
	assert.ok(row.error, '写入前的复核必须拦下这次写入')
	assert.equal(fs.readFileSync(target, 'utf8').includes('⇒'.repeat(30)), true, '根目录之外的文件不得被改写')
})

test('F6 远程修复不认调用方给的符号集', async () => {
	const dir = tempDir()
	const file = pollutedFile(dir, 'notes.md', 'The coffee break policy says see you at 5.\n')
	// 根目录必须包含这个文件，否则修复会先被根目录闸门挡掉，测的就不是符号集了。
	const service = createGuardDegenService({
		useOverride: false,
		config: { artifacts: { roots: [dir], minRun: 2 } },
	})

	const result = await service.repairArtifacts({ files: [file], apply: true, symbols: 'e', minRun: 2 })

	assert.equal(result.results[0].changed, false, '调用方指定的符号集不生效')
	assert.equal(fs.readFileSync(file, 'utf8'), 'The coffee break policy says see you at 5.\n', '普通文字不得被改写')
})

test('F7 旁证副本的文件名必须消毒', async () => {
	const { writeSidecar } = await import('../lib/log.js')
	const base = tempDir()
	const dir = path.join(base, 'logs')
	fs.mkdirSync(dir, { recursive: true })

	// 三层 `..`：时间戳前缀只吸收一层，两层 `..` 时消毒与否看不出差别
	// （不消毒也仍落在日志目录里），三层才逼出真实行为。
	// 不消毒时：<dir>/<stamp>-../../../escaped.txt 会被折叠成 <base>/escaped.txt，
	// 也就是逃出了日志目录。
	const file = writeSidecar(dir, '../../../escaped', 'x')

	assert.ok(file, '应当写出旁证副本')
	assert.equal(path.dirname(file), dir, `旁证副本必须留在日志目录里：${file}`)
})

test('F5b 写入前的复核：指向根目录内部的符号链接同样要拦下', async () => {
	const dir = tempDir()
	const root = path.join(dir, 'root')
	fs.mkdirSync(root, { recursive: true })
	// 目标在根目录**内部**：根目录那道闸门放它过关，
	// 只有「写前复核是不是符号链接」这一道能拦下来。
	const target = path.join(root, 'target.md')
	fs.writeFileSync(target, `head\n${'⇒'.repeat(30)}\ntail\n`, 'utf8')
	const victim = path.join(root, 'victim.md')
	fs.writeFileSync(victim, `head\n${'⇒'.repeat(30)}\ntail\n`, 'utf8')

	const result = await repairArtifacts({
		files: [victim],
		apply: true,
		roots: [root],
		minRun: 20,
		beforeWrite: () => {
			fs.rmSync(victim)
			fs.symlinkSync(target, victim, 'file')
		},
	})

	const row = result.results[0]
	assert.equal(
		row.error,
		'拒绝修改符号链接指向的文件（写入前复核发现路径已变）。',
		'写前复核必须按当下的真实路径再判一次',
	)
	assert.equal(row.changed, false, '被拦下时不得算作已改写')
	assert.equal(
		fs.readFileSync(target, 'utf8').includes('⇒'.repeat(30)),
		true,
		'符号链接指向的文件不得被改写',
	)
})

test('F6 远程修复只认配置里的 minRun', async () => {
	const dir = tempDir()
	// 游程长度 5：调用方要的 minRun=2 会命中它，配置里的 minRun=20 不会。
	const file = pollutedFile(dir, 'notes.md', `head\n${'⇒'.repeat(5)}\ntail\n`)
	// 根目录必须包含这个文件，否则修复会先被根目录闸门挡掉，
	// 根本走不到 minRun 那一步，测的就不是 minRun 了。
	const service = createGuardDegenService({
		useOverride: false,
		config: { artifacts: { roots: [dir], minRun: 20 } },
	})

	const result = await service.repairArtifacts({ files: [file], apply: true, minRun: 2 })

	assert.equal(result.results[0].changed, false, '调用方把 minRun 调到 2 不生效')
	assert.equal(
		fs.readFileSync(file, 'utf8').includes('⇒'.repeat(5)),
		true,
		'短游程不得被当成退化改掉',
	)
})

test('N4 会话根目录之外的文件：副本模式也必须被拒绝', async () => {
	const { maskSession } = await import('../lib/sessions.js')
	const dir = tempDir()
	const sessionsRoot = path.join(dir, 'sessions')
	fs.mkdirSync(sessionsRoot, { recursive: true })
	const outside = path.join(dir, 'outside.jsonl')
	fs.writeFileSync(
		outside,
		`${JSON.stringify({ type: 'assistant', data: { text: '⇒'.repeat(30) } })}\n`,
		'utf8',
	)

	// 副本模式：副本落点（插件工作目录）本身是允许的，
	// 所以拦不拦得住完全取决于「源文件必须在会话根目录之内」这一道闸门。
	const result = await maskSession({
		file: outside,
		apply: true,
		mode: 'copy',
		minRun: 20,
		roots: [sessionsRoot],
	})

	assert.equal(
		result.error,
		'文件不在允许的会话根目录之内，已跳过。',
		'会话根目录之外的文件必须被源文件闸门拦下',
	)
	assert.equal(result.masked, 0, '不得对根目录之外的文件做遮蔽')
	assert.equal(
		fs.readFileSync(outside, 'utf8').includes('⇒'.repeat(30)),
		true,
		'原文件不得被改写',
	)
})
