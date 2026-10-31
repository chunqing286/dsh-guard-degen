/**
 * 写后校验测试 —— T4（B2）。
 *
 * 写类工具执行后回读产物，若写进文件的是退化内容，就把结果转成错误回灌给模型。
 * 文件读取走注入的桩函数，测试不碰真实磁盘。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { buildFeedback, decidePostExecute, extractWriteTargets } from '../lib/post-execute.js'

const RUN = '⇒'.repeat(64)

/** 造一个只含指定文件的读取桩。 */
function stubReader(files) {
	const calls = []
	return {
		calls,
		async readFile(path) {
			calls.push(path)
			if (!Object.hasOwn(files, path)) {
				const error = new Error(`ENOENT: ${path}`)
				error.code = 'ENOENT'
				throw error
			}
			return files[path]
		},
	}
}

test('从参数里提取写入目标', () => {
	const targets = extractWriteTargets({ file_path: 'docs/a.md', content: 'x', mode: 'overwrite' })
	assert.deepEqual(targets.map((t) => t.path), ['docs/a.md'])
	assert.deepEqual(extractWriteTargets({ path: 'b.txt' }).map((t) => t.path), ['b.txt'])
	assert.deepEqual(extractWriteTargets({ content: 'x' }), [])
	assert.deepEqual(extractWriteTargets({}), [])
})

test('关闭时一律放行', async () => {
	const reader = stubReader({ 'a.md': RUN })
	const decision = await decidePostExecute(
		{ name: 'write', arguments: { file_path: 'a.md' } },
		{ isError: false },
		{ enabled: false, readFile: reader.readFile },
	)
	assert.equal(decision.kind, 'accept')
	assert.equal(reader.calls.length, 0)
})

test('非写类工具不做校验', async () => {
	const reader = stubReader({ 'a.md': RUN })
	const decision = await decidePostExecute(
		{ name: 'read', arguments: { file_path: 'a.md' } },
		{ isError: false },
		{ enabled: true, readFile: reader.readFile },
	)
	assert.equal(decision.kind, 'accept')
	assert.equal(reader.calls.length, 0)
})

test('写入内容含游程：阻断并给出可读反馈', async () => {
	const reader = stubReader({ 'a.md': `前言${RUN}` })
	const decision = await decidePostExecute(
		{ name: 'write', arguments: { file_path: 'a.md' } },
		{ isError: false },
		{ enabled: true, readFile: reader.readFile },
	)
	assert.equal(decision.kind, 'block')
	assert.ok(decision.feedback[0].text.includes('a.md'), decision.feedback[0].text)
	assert.ok(decision.feedback[0].text.includes('退化'), decision.feedback[0].text)
	assert.ok(/\d+/.test(decision.feedback[0].text))
})

test('写入内容干净：放行', async () => {
	const reader = stubReader({ 'a.md': '# 标题\n\n正常内容。\n' })
	const decision = await decidePostExecute(
		{ name: 'write', arguments: { file_path: 'a.md' } },
		{ isError: false },
		{ enabled: true, readFile: reader.readFile },
	)
	assert.equal(decision.kind, 'accept')
})

test('文件读不到：放行（不能因为读失败就阻断正常写入）', async () => {
	const reader = stubReader({})
	const decision = await decidePostExecute(
		{ name: 'write', arguments: { file_path: 'missing.md' } },
		{ isError: false },
		{ enabled: true, readFile: reader.readFile },
	)
	assert.equal(decision.kind, 'accept')
})

test('工具本身失败：不再校验', async () => {
	const reader = stubReader({ 'a.md': RUN })
	const decision = await decidePostExecute(
		{ name: 'write', arguments: { file_path: 'a.md' } },
		{ isError: true },
		{ enabled: true, readFile: reader.readFile },
	)
	assert.equal(decision.kind, 'accept')
	assert.equal(reader.calls.length, 0)
})

test('超出大小上限的文件跳过', async () => {
	const reader = stubReader({ 'a.md': RUN })
	const decision = await decidePostExecute(
		{ name: 'write', arguments: { file_path: 'a.md' } },
		{ isError: false },
		{ enabled: true, readFile: reader.readFile, maxFileBytes: 4 },
	)
	assert.equal(decision.kind, 'accept')
})

test('不在工作区内的路径跳过', async () => {
	const reader = stubReader({ '/etc/passwd': RUN })
	const decision = await decidePostExecute(
		{ name: 'write', arguments: { file_path: '/etc/passwd' } },
		{ isError: false },
		{ enabled: true, readFile: reader.readFile, root: '/workspace' },
	)
	assert.equal(decision.kind, 'accept')
	assert.equal(reader.calls.length, 0)
})

test('多个根目录：任一根目录内的文件都要检查', async () => {
	const reader = stubReader({ '/work/a/a.md': RUN, '/work/b/b.md': RUN })
	const decision = await decidePostExecute(
		{ name: 'write', arguments: { file_path: '/work/a/a.md', path: '/work/b/b.md' } },
		{ isError: false },
		{ enabled: true, readFile: reader.readFile, roots: ['/work/a', '/work/b'] },
	)
	assert.equal(decision.kind, 'block')
	assert.equal(reader.calls.length, 2, '两个根目录内的文件都要回读')
})

test('多个根目录：根目录之外的文件跳过', async () => {
	const reader = stubReader({ '/other/c.md': RUN })
	const decision = await decidePostExecute(
		{ name: 'write', arguments: { file_path: '/other/c.md' } },
		{ isError: false },
		{ enabled: true, readFile: reader.readFile, roots: ['/work/a', '/work/b'] },
	)
	assert.equal(decision.kind, 'accept')
	assert.equal(reader.calls.length, 0)
})

test('反馈文本包含文件名、规则与符号个数', () => {
	const feedback = buildFeedback([{ path: 'a.md', rule: 'symbol-run', count: 64, preview: '⇒⇒⇒' }])
	assert.ok(feedback[0].text.includes('a.md'))
	assert.ok(feedback[0].text.includes('symbol-run'))
	assert.ok(feedback[0].text.includes('64'))
	assert.equal(feedback[0].type, 'text')
})

test('多个文件同时退化：反馈里都要提到', async () => {
	const reader = stubReader({ 'a.md': RUN, 'b.md': RUN })
	const decision = await decidePostExecute(
		{ name: 'write', arguments: { file_path: 'a.md', path: 'b.md' } },
		{ isError: false },
		{ enabled: true, readFile: reader.readFile },
	)
	assert.equal(decision.kind, 'block')
	assert.ok(decision.feedback[0].text.includes('a.md'), decision.feedback[0].text)
	assert.ok(decision.feedback[0].text.includes('b.md'), decision.feedback[0].text)
})
