/**
 * 命令注册测试 —— T9。
 *
 * 宿主契约（dsh-commands/lib/index.js:149-176, 258-290）：
 * - `commands.register({name, description, input?, handler})`，name 不带斜杠；
 * - handler 收到 `{commandId, agent, rawInput, attachments, signal}`，返回 `{kind:'success'|'error', text}`。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'

import { COMMAND_NAMES, createCommandDefinitions, registerCommands } from '../lib/commands.js'

/** 造一套依赖桩。 */
function deps(overrides = {}) {
	return {
		getStatus: () => ({ config: { toolGuard: { mode: 'warn' } }, verdicts: [{ rule: 'symbol-run', model: 'm' }] }),
		scanArtifacts: async () => ({ summary: { filesScanned: 10, filesWithHits: 2, totalRuns: 3, totalSymbols: 120 }, files: [{ path: 'a.md', runCount: 2, symbolCount: 100 }] }),
		repairArtifacts: async () => ({ applied: true, summary: { requested: 1, changed: 1, failed: 0, symbols: 100 }, results: [{ path: 'a.md', changed: true, symbols: 100 }] }),
		maskSession: async () => ({ masked: 3, symbols: 900, toolCallsKept: 2, remaining: 0, output: '/tmp/x.masked' }),
		ackVerdict: () => ({ rule: 'symbol-run', model: 'm', id: 'v1' }),
		...overrides,
	}
}

test('命令名固定', () => {
	assert.deepEqual(COMMAND_NAMES, ['degen-status', 'degen-scan', 'degen-fix', 'degen-clean', 'degen-ack'])
})

test('每个命令都有名字、描述与处理函数', () => {
	for (const definition of createCommandDefinitions(deps())) {
		assert.equal(typeof definition.name, 'string')
		assert.ok(definition.name.length > 0)
		assert.ok(definition.description.length > 0)
		assert.equal(typeof definition.handler, 'function')
	}
})

test('degen-status 返回配置与判定摘要', async () => {
	const definitions = createCommandDefinitions(deps())
	const status = definitions.find((d) => d.name === 'degen-status')
	const result = await status.handler({ rawInput: '' })
	assert.equal(result.kind, 'success')
	assert.ok(result.text.includes('symbol-run'), result.text)
	assert.ok(result.text.includes('warn'), result.text)
})

test('degen-scan 调用扫描器并汇报命中', async () => {
	const calls = []
	const definitions = createCommandDefinitions(deps({
		scanArtifacts: async (options) => {
			calls.push(options)
			return { summary: { filesScanned: 10, filesWithHits: 1, totalRuns: 2, totalSymbols: 64 }, files: [{ path: 'a.md', runCount: 2, symbolCount: 64 }] }
		},
	}))
	const scan = definitions.find((d) => d.name === 'degen-scan')
	const result = await scan.handler({ rawInput: '/tmp/proj' })
	assert.equal(result.kind, 'success')
	assert.ok(result.text.includes('a.md'), result.text)
	assert.ok(result.text.includes('64'), result.text)
	assert.equal(calls.length, 1)
	assert.equal(calls[0].roots[0], '/tmp/proj')
})

test('degen-scan 不给路径时用默认根目录', async () => {
	const calls = []
	const definitions = createCommandDefinitions(deps({
		scanArtifacts: async (options) => {
			calls.push(options)
			return { summary: { filesScanned: 0, filesWithHits: 0, totalRuns: 0, totalSymbols: 0 }, files: [] }
		},
	}))
	const scan = definitions.find((d) => d.name === 'degen-scan')
	await scan.handler({ rawInput: '' })
	assert.equal(calls.length, 1)
	assert.ok(calls[0].roots.length >= 1)
})

test('degen-fix 没有给文件时报错而不是乱改', async () => {
	const calls = []
	const definitions = createCommandDefinitions(deps({
		repairArtifacts: async (options) => {
			calls.push(options)
			return { applied: false, summary: {}, results: [] }
		},
	}))
	const fix = definitions.find((d) => d.name === 'degen-fix')
	const result = await fix.handler({ rawInput: '   ' })
	assert.equal(result.kind, 'error')
	assert.equal(calls.length, 0, '没给文件就不该调修复')
})

test('degen-fix 按用户给的文件修复', async () => {
	const calls = []
	const definitions = createCommandDefinitions(deps({
		repairArtifacts: async (options) => {
			calls.push(options)
			return { applied: true, summary: { requested: 2, changed: 2, failed: 0, symbols: 130 }, results: [] }
		},
	}))
	const fix = definitions.find((d) => d.name === 'degen-fix')
	const result = await fix.handler({ rawInput: 'a.md b.md' })
	assert.equal(result.kind, 'success')
	assert.equal(calls.length, 1)
	assert.deepEqual(calls[0].files, ['a.md', 'b.md'])
	assert.equal(calls[0].apply, true)
})

test('M8 degen-fix 的根目录取自用户点名的文件所在目录', async () => {
	// 复审缺陷 N3：修复的根目录必须跟着用户点的文件走，
	// 否则「用户点了哪个就修哪个」的意图会被默认的工作区范围挡掉。
	const calls = []
	const definitions = createCommandDefinitions(deps({
		repairArtifacts: async (options) => {
			calls.push(options)
			return { applied: true, summary: { requested: 1, changed: 1, failed: 0, symbols: 30 }, results: [] }
		},
	}))
	const fix = definitions.find((d) => d.name === 'degen-fix')
	await fix.handler({ rawInput: 'docs/验证记录.md' })
	assert.equal(calls.length, 1)
	assert.deepEqual(calls[0].roots, [path.resolve('docs')], '根目录应当是点名文件的所在目录')
})

test('M8 degen-fix 多个文件分布在不同目录时根目录都带上', async () => {
	const calls = []
	const definitions = createCommandDefinitions(deps({
		repairArtifacts: async (options) => {
			calls.push(options)
			return { applied: true, summary: { requested: 2, changed: 2, failed: 0, symbols: 60 }, results: [] }
		},
	}))
	const fix = definitions.find((d) => d.name === 'degen-fix')
	await fix.handler({ rawInput: 'docs/a.md src/b.md' })
	assert.deepEqual(calls[0].roots, [path.resolve('docs'), path.resolve('src')])
})

test('degen-clean 调用会话遮蔽', async () => {
	const calls = []
	const definitions = createCommandDefinitions(deps({
		maskSession: async (options) => {
			calls.push(options)
			return { masked: 3, symbols: 900, toolCallsKept: 2, remaining: 0, output: '/tmp/x.masked' }
		},
	}))
	const clean = definitions.find((d) => d.name === 'degen-clean')
	const result = await clean.handler({ rawInput: '' })
	assert.equal(result.kind, 'success')
	assert.ok(result.text.includes('3'), result.text)
	assert.equal(calls.length, 1)
})

test('degen-ack 登记误报并说明规则', async () => {
	const calls = []
	const definitions = createCommandDefinitions(deps({
		ackVerdict: (options) => {
			calls.push(options)
			return { rule: 'symbol-run', model: 'm', id: 'v1' }
		},
	}))
	const ack = definitions.find((d) => d.name === 'degen-ack')
	const result = await ack.handler({ rawInput: '' })
	assert.equal(result.kind, 'success')
	assert.ok(result.text.includes('symbol-run'), result.text)
	assert.equal(calls.length, 1)
})

test('依赖抛错时返回错误结果而不是把异常抛出去', async () => {
	const definitions = createCommandDefinitions(deps({
		scanArtifacts: async () => {
			throw new Error('磁盘炸了')
		},
	}))
	const scan = definitions.find((d) => d.name === 'degen-scan')
	const result = await scan.handler({ rawInput: '/tmp' })
	assert.equal(result.kind, 'error')
	assert.ok(result.text.includes('磁盘炸了'), result.text)
})

test('注册后可以整体注销', () => {
	const registered = []
	const disposers = []
	const service = {
		register: (definition) => {
			registered.push(definition)
			const disposer = () => {
				const index = registered.indexOf(definition)
				if (index >= 0) registered.splice(index, 1)
			}
			disposers.push(disposer)
			return disposer
		},
	}
	const dispose = registerCommands(service, deps())
	assert.equal(registered.length, COMMAND_NAMES.length)
	dispose()
	assert.equal(registered.length, 0)
})
