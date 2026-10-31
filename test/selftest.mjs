#!/usr/bin/env node
/**
 * 自测脚本：一次跑完「清单自检 + 契约自检 + 端到端自检」。
 *
 * 用法：
 *   node test/selftest.mjs
 *
 * 退出码 0 表示全部通过。它刻意不依赖宿主运行时（cordis 只在可选检查里需要），
 * 所以任何装了依赖的机器都能跑。
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')

let failures = 0
/**
 * 跑一项检查。
 * @param {string} name - 检查名
 * @param {Function} fn - 检查体
 * @returns {Promise<void>} 无
 */
async function check(name, fn) {
	try {
		await fn()
		console.log(`✔ ${name}`)
	} catch (error) {
		failures += 1
		console.log(`✘ ${name}`)
		console.log(`  ${error?.message ?? error}`)
	}
}

const load = (relative) => import(pathToFileURL(path.join(ROOT, relative)).href)

// ── 1. 清单自检（相当于 npm pack --dry-run 的内容核对）─────────────────

await check('package.json 可解析且字段完整', () => {
	const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
	assert.equal(manifest.name, 'dsh-guard-degen')
	assert.equal(manifest.type, 'module')
	assert.equal(manifest.main, 'lib/index.js')
	assert.ok(manifest.exports['.'], '缺少主导出')
	assert.ok(manifest.exports['./client'], '缺少浏览器导出')
	assert.ok(manifest.dsh?.bundle?.patch, '缺少 bundle patch 声明')
	assert.ok(Array.isArray(manifest.dsh?.client?.inject), '缺少客户端注入声明')
	assert.ok(manifest.peerDependencies?.['@deepseek-ai/dsh'], '缺少宿主 peer 依赖')
})

await check('exports 指向的文件都存在', () => {
	const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
	for (const target of Object.values(manifest.exports)) {
		assert.ok(fs.existsSync(path.join(ROOT, target)), `导出目标不存在：${target}`)
	}
	assert.ok(fs.existsSync(path.join(ROOT, manifest.dsh.bundle.patch)), 'bundle patch 文件不存在')
})

await check('files 字段覆盖到实际存在的文件', () => {
	const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
	assert.ok(manifest.files.includes('lib/**/*.js'))
	assert.ok(manifest.files.includes('cordis.patch.yml'))
	for (const pattern of manifest.files) {
		if (pattern.includes('*')) continue
		assert.ok(fs.existsSync(path.join(ROOT, pattern)), `files 里的 ${pattern} 不存在`)
	}
})

await check('cordis.patch.yml 的配置键都在 CONFIG_SPEC 里', async () => {
	const { CONFIG_SPEC } = await load('lib/config.js')
	const text = fs.readFileSync(path.join(ROOT, 'cordis.patch.yml'), 'utf8')
	assert.match(text, /id:\s*guard-degen/, 'patch 缺少 id')
	assert.match(text, /name:\s*dsh-guard-degen/, 'patch 缺少 name')
	// 取 config 段里的叶子键路径，按缩进推断层级。
	const lines = text.split(/\r?\n/)
	const stack = []
	const paths = []
	let inConfig = false
	for (const line of lines) {
		if (/^\s*config:\s*$/.test(line)) {
			inConfig = true
			continue
		}
		if (!inConfig) continue
		const match = /^(\s*)([A-Za-z0-9_]+):\s*(.*)$/.exec(line)
		if (!match) continue
		const indent = match[1].length
		while (stack.length > 0 && stack[stack.length - 1].indent >= indent) stack.pop()
		stack.push({ indent, key: match[2] })
		if (match[3] !== '') paths.push(stack.map((item) => item.key))
	}
	assert.ok(paths.length > 0, '没有解析出任何配置键')
	for (const keyPath of paths) {
		let spec = CONFIG_SPEC
		for (const key of keyPath) {
			assert.ok(spec && typeof spec === 'object', `未知配置路径：${keyPath.join('.')}`)
			spec = spec.fields ? spec.fields[key] : spec[key]
			assert.ok(spec, `未知配置路径：${keyPath.join('.')}`)
		}
	}
})

// ── 2. 契约自检 ────────────────────────────────────────────────────────

await check('宿主导出：名字、远程方法表、Config schema', async () => {
	const mod = await load('lib/index.js')
	assert.equal(mod.name, 'guard-degen')
	assert.ok(Array.isArray(mod.REMOTE_METHODS))
	assert.equal(mod.REMOTE_METHODS.length, 13)
	assert.equal(typeof mod.default, 'function')
	const schema = mod.default.Config
	assert.ok(schema, '没有 Config schema')
	const validated = schema['~standard']?.validate({})
	assert.equal(validated?.issues, undefined, `Config schema 拒绝了空配置：${JSON.stringify(validated?.issues)}`)
})

await check('服务实现覆盖全部远程方法', async () => {
	const [{ createGuardDegenService }, { REMOTE_METHODS }] = await Promise.all([load('lib/service.js'), load('lib/index.js')])
	const service = createGuardDegenService({ useOverride: false })
	for (const method of REMOTE_METHODS) {
		assert.equal(typeof service[method], 'function', `服务缺少方法 ${method}`)
	}
})

await check('宿主类实现全部远程方法（装载期不会抛错）', async () => {
	const { REMOTE_METHODS, default: HostClass } = await load('lib/index.js')
	for (const method of REMOTE_METHODS) {
		assert.equal(typeof HostClass.prototype[method], 'function', `宿主类缺少远程方法 ${method}`)
	}
})

await check('浏览器 bundle 可装载，方法表与宿主一致', async () => {
	let registration = null
	globalThis.window = { __ModuleLoader__: { load: (input) => { registration = input } } }
	await import(pathToFileURL(path.join(ROOT, 'lib', 'client.js')).href)
	assert.ok(registration, '客户端 bundle 没有注册')
	const bundle = registration.factory((id) => {
		if (id === 'react') return { createElement: () => null }
		throw new Error(`意外的模块请求：${id}`)
	})
	assert.equal(typeof bundle.apply, 'function')
	assert.ok(Array.isArray(bundle.inject))
	const { REMOTE_METHODS } = await load('lib/index.js')
	const clientMethods = bundle.__test.REMOTE_METHOD_SPECS.map((item) => item.name)
	assert.deepEqual([...clientMethods].sort(), [...REMOTE_METHODS].sort())
})

// ── 3. 端到端自检 ──────────────────────────────────────────────────────

await check('退化的思考流被拦下（合成流）', async () => {
	const { guardStream } = await load('lib/stream-guard.js')
	const degenerate = '⇒'.repeat(400)
	async function* upstream() {
		yield { type: 'block-start', blockType: 'reasoning', index: 0 }
		yield { type: 'reasoning-delta', text: degenerate, index: 0 }
		yield { type: 'block-end', index: 0 }
	}
	const out = []
	for await (const chunk of guardStream(upstream(), { reasoning: 'truncate', text: 'sanitize' })) out.push(chunk)
	const text = out.map((chunk) => chunk.text ?? chunk.block?.text ?? '').join('')
	assert.ok(!/⇒{20,}/.test(text), '输出里仍有长串退化符号')
})

await check('工件扫描：预览不写盘，应用先备份', async () => {
	const { scanArtifacts, repairArtifacts } = await load('lib/artifacts.js')
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'degen-selftest-'))
	try {
		const file = path.join(dir, 'note.md')
		fs.writeFileSync(file, `正常内容\n${'·'.repeat(60)}\n正常结尾\n`, 'utf8')
		const report = await scanArtifacts({ roots: [dir] })
		assert.equal(report.files.length, 1, '扫描没有命中污染文件')
		assert.ok(report.files[0].runCount >= 1)
		const before = fs.readFileSync(file, 'utf8')
		const preview = await repairArtifacts({ files: [file], apply: false, roots: [dir] })
		assert.equal(preview.applied, false)
		assert.equal(fs.readFileSync(file, 'utf8'), before, '预览阶段写了文件')
		const applied = await repairArtifacts({ files: [file], apply: true, roots: [dir] })
		assert.equal(applied.applied, true)
		assert.ok(fs.existsSync(`${file}.degen-backup`), '没有生成备份')
		assert.ok(!/·{20,}/.test(fs.readFileSync(file, 'utf8')), '修复后仍有长串符号')
	} finally {
		fs.rmSync(dir, { recursive: true, force: true })
	}
})

await check('服务层：getConfig/setConfig/规则与判定闭环', async () => {
	const { createGuardDegenService } = await load('lib/service.js')
	// 用内存里的“覆盖文件”顶替真实磁盘：写入与回读走同一条路径。
	const store = new Map()
	const overrideFile = path.join(os.tmpdir(), 'degen-selftest-override', 'config.json')
	const service = createGuardDegenService({
		overrideFile,
		readFile: (file) => {
			if (!store.has(file)) throw new Error('覆盖文件不存在')
			return store.get(file)
		},
		writeFile: (file, data) => {
			store.set(file, data)
		},
	})
	const view = service.getConfig()
	assert.ok(view.spec, 'getConfig 没有返回规格')
	assert.equal(typeof view.config, 'object')
	const patched = service.setConfig({ stream: { maxInterventionsPerCall: 3 } })
	assert.equal(patched.ok, true, `setConfig 失败：${JSON.stringify(patched.errors)}`)
	assert.equal(patched.config.stream.maxInterventionsPerCall, 3)
	assert.equal(store.size, 1, '没有写运行时覆盖文件')
	assert.equal(service.getConfig().config.stream.maxInterventionsPerCall, 3, '覆盖没有生效')
	const bad = service.setConfig({ stream: { maxInterventionsPerCall: 'x' } })
	assert.equal(bad.ok, false, '非法值没有报错')
})

console.log('')
if (failures > 0) {
	console.log(`自测失败：${failures} 项未通过。`)
	process.exit(1)
}
console.log('自测全部通过。')
