/**
 * 取证日志与误报白名单测试 —— T6。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { VerdictLog, Whitelist, sampleHash, shouldSuppress } from '../lib/log.js'
import { DEFAULT_RULES, findSymbolRun, normalizeRules, relaxRule } from '../lib/detect.js'

/** 造一个临时目录。 */
function tempDir() {
	return fs.mkdtempSync(path.join(os.tmpdir(), 'degen-log-'))
}

test('样本哈希稳定且区分内容', () => {
	assert.equal(sampleHash('abc'), sampleHash('abc'))
	assert.notEqual(sampleHash('abc'), sampleHash('abd'))
	assert.ok(sampleHash('abc').length >= 16)
})

test('判定日志条目字段完整', () => {
	const dir = tempDir()
	const log = new VerdictLog({ dir })
	const entry = log.record(
		{
			rule: 'symbol-run',
			severity: 'high',
			channel: 'reasoning',
			onset: 128,
			evidence: '⇒⇒⇒⇒',
			detail: { count: 64 },
		},
		{ sessionId: 's1', agentId: 'a1', model: 'MiniMax-M3.1-Flash', provider: 'minimax-cn', action: 'truncate', source: 'stream', sample: '⇒⇒⇒⇒' },
	)
	for (const key of ['id', 'ts', 'sessionId', 'agentId', 'model', 'provider', 'channel', 'rule', 'severity', 'action', 'onset', 'count', 'evidence', 'sampleHash', 'source']) {
		assert.ok(entry[key] !== undefined, `缺字段 ${key}`)
	}
	assert.equal(entry.count, 64)
	assert.equal(entry.rule, 'symbol-run')
	assert.ok(entry.id)
})

test('判定日志记录折叠现场：标记、原文与偏移', () => {
	const dir = tempDir()
	const log = new VerdictLog({ dir })
	const entry = log.record(
		{ rule: 'symbol-run', severity: 'high', channel: 'text', onset: 12, evidence: '⇒⇒⇒', detail: { count: 64 } },
		{
			sessionId: 's-1',
			model: 'm',
			action: 'sanitize',
			marker: '〔退化符号流×64〕',
			original: '⇒'.repeat(64),
			offset: 128,
		},
	)
	assert.equal(entry.marker, '〔退化符号流×64〕')
	assert.equal(entry.original, '⇒'.repeat(64))
	assert.equal(entry.offset, 128)
	assert.equal(entry.sessionId, 's-1')
	const [read] = log.list()
	assert.equal(read.marker, '〔退化符号流×64〕', '回读也要能拿到标记')
	assert.equal(read.original, '⇒'.repeat(64))
})

test('判定日志可回读，最后一条就是最新的', () => {
	const dir = tempDir()
	const log = new VerdictLog({ dir })
	log.record({ rule: 'symbol-run', severity: 'high', channel: 'reasoning', onset: 0, evidence: 'a', detail: { count: 20 } }, { sessionId: 's', model: 'm' })
	log.record({ rule: 'exact-cycle', severity: 'high', channel: 'text', onset: 9, evidence: 'b', detail: { count: 3 } }, { sessionId: 's', model: 'm' })
	const entries = log.list()
	assert.equal(entries.length, 2)
	assert.equal(entries[0].rule, 'symbol-run')
	assert.equal(log.last().rule, 'exact-cycle')
})

test('旁证副本单独落盘且只写不读', () => {
	const dir = tempDir()
	const log = new VerdictLog({ dir })
	const entry = log.record(
		{ rule: 'symbol-run', severity: 'high', channel: 'reasoning', onset: 0, evidence: '⇒⇒', detail: { count: 2 } },
		{ sessionId: 's', model: 'm', sample: '原始退化文本⇒⇒⇒' },
	)
	const sidecar = entry.sidecar
	assert.ok(sidecar, '应有旁证副本路径')
	assert.ok(fs.existsSync(sidecar))
	assert.ok(fs.readFileSync(sidecar, 'utf8').includes('原始退化文本'))
})

test('白名单：登记后同类命中不再拦截', () => {
	const dir = tempDir()
	const list = new Whitelist({ file: path.join(dir, 'whitelist.json') })
	list.add({ model: 'MiniMax-M3.1-Flash', rule: 'symbol-run', sample: '⇒⇒⇒', note: '误报' })
	assert.equal(list.matches({ model: 'MiniMax-M3.1-Flash', rule: 'symbol-run', sample: '⇒⇒⇒' }), true)
	assert.equal(list.matches({ model: 'MiniMax-M3.1-Flash', rule: 'exact-cycle', sample: '⇒⇒⇒' }), false)
	assert.equal(list.matches({ model: 'deepseek-chat', rule: 'symbol-run', sample: '⇒⇒⇒' }), false)
	assert.equal(list.matches({ model: 'MiniMax-M3.1-Flash', rule: 'symbol-run', sample: '别的东西' }), false)
})

test('白名单：通配模型与通配规则', () => {
	const dir = tempDir()
	const list = new Whitelist({ file: path.join(dir, 'whitelist.json') })
	list.add({ model: '*', rule: 'symbol-run', sample: '⇒⇒⇒' })
	assert.equal(list.matches({ model: '任何模型', rule: 'symbol-run', sample: '⇒⇒⇒' }), true)
	assert.equal(list.matches({ model: '任何模型', rule: 'novelty', sample: '⇒⇒⇒' }), false)
})

test('白名单持久化：重新打开还在', () => {
	const dir = tempDir()
	const file = path.join(dir, 'whitelist.json')
	const first = new Whitelist({ file })
	first.add({ model: 'm', rule: 'symbol-run', sample: '⇒' })
	const second = new Whitelist({ file })
	assert.equal(second.matches({ model: 'm', rule: 'symbol-run', sample: '⇒' }), true)
	assert.equal(second.list().length, 1)
})

test('白名单可移除条目', () => {
	const dir = tempDir()
	const list = new Whitelist({ file: path.join(dir, 'whitelist.json') })
	const entry = list.add({ model: 'm', rule: 'symbol-run', sample: '⇒' })
	assert.equal(list.remove(entry.id), true)
	assert.equal(list.matches({ model: 'm', rule: 'symbol-run', sample: '⇒' }), false)
})

test('命中白名单时判定应当被抑制', () => {
	const dir = tempDir()
	const list = new Whitelist({ file: path.join(dir, 'whitelist.json') })
	list.add({ model: 'm', rule: 'symbol-run', sample: '⇒⇒' })
	assert.equal(shouldSuppress({ model: 'm', rule: 'symbol-run', sample: '⇒⇒' }, list), true)
	assert.equal(shouldSuppress({ model: 'm', rule: 'symbol-run', sample: '其它' }, list), false)
	assert.equal(shouldSuppress({ model: 'm', rule: 'symbol-run', sample: '⇒⇒' }, null), false)
})

test('误报确认会顺带把该规则的阈值调高一档', () => {
	const rules = normalizeRules({})
	const relaxed = relaxRule(rules, 'symbol-run')
	assert.ok(relaxed['symbol-run'].minRun > rules['symbol-run'].minRun)
	assert.equal(relaxed['exact-cycle'].maxCycleChars, rules['exact-cycle'].maxCycleChars)
	assert.equal(rules['symbol-run'].minRun, DEFAULT_RULES['symbol-run'].minRun, '原对象不能被就地改掉')
})

test('调高阈值后同样的文本不再命中', () => {
	const rules = normalizeRules({})
	const relaxed = relaxRule(rules, 'symbol-run')
	const run = '⇒'.repeat(DEFAULT_RULES['symbol-run'].minRun)
	assert.ok(findSymbolRun(run, { minRun: rules['symbol-run'].minRun }), '原阈值下应当命中')
	assert.equal(findSymbolRun(run, { minRun: relaxed['symbol-run'].minRun }), null, '调高一档后不该再命中')
})
