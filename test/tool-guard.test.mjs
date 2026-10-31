/**
 * 工具参数闸门测试 —— T3。
 *
 * 判定口径必须与流式侧一致（同一套 Detector / 同一套规则）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { checkToolArgs, classifyTool, collectArgText, TOOL_GUARD_MODES, TOOL_GUARD_SCOPES } from '../lib/tool-guard.js'

const RUN = '⇒'.repeat(64)

test('模式取值集合固定', () => {
	assert.deepEqual(TOOL_GUARD_MODES, ['off', 'warn', 'refuse'])
	assert.deepEqual(TOOL_GUARD_SCOPES, ['all', 'write-only', 'oversized-only'])
})

test('写类工具识别', () => {
	assert.equal(classifyTool('write'), 'write')
	assert.equal(classifyTool('write_file'), 'write')
	assert.equal(classifyTool('edit'), 'write')
	assert.equal(classifyTool('apply_patch'), 'write')
	assert.equal(classifyTool('str_replace'), 'write')
	assert.equal(classifyTool('create_file'), 'write')
	assert.equal(classifyTool('read'), 'read')
	assert.equal(classifyTool('read_file'), 'read')
	assert.equal(classifyTool('grep'), 'read')
	assert.equal(classifyTool('list_dir'), 'read')
	assert.equal(classifyTool('some_unknown_tool'), 'other')
	assert.equal(classifyTool('create_goal'), 'other', 'create_goal 只改目标状态，不落盘')
	assert.equal(classifyTool('update_goal'), 'other')
	assert.equal(classifyTool('create_file'), 'write')
})

test('参数文本收集：递归取所有字符串值', () => {
	const text = collectArgText({ path: 'a.md', content: '正文', nested: { x: ['y', 3] } })
	assert.ok(text.includes('a.md'))
	assert.ok(text.includes('正文'))
	assert.ok(text.includes('y'))
	assert.ok(!text.includes('3'), '数字不算文本')
})

test('off 模式：完全不拦', () => {
	const result = checkToolArgs({ content: RUN }, { mode: 'off', toolName: 'write' })
	assert.equal(result.action, 'allow')
	assert.equal(result.reason, undefined)
})

test('warn 模式：放行但给出理由', () => {
	const result = checkToolArgs({ content: RUN }, { mode: 'warn', toolName: 'write' })
	assert.equal(result.action, 'warn')
	assert.ok(result.reason.includes('退化'), result.reason)
	assert.equal(result.detail.rule, 'symbol-run')
	assert.ok(result.detail.count >= 20, `实际：${result.detail.count}`)
})

test('refuse 模式：拒绝并给出模型可读的原因', () => {
	const result = checkToolArgs({ content: RUN }, { mode: 'refuse', toolName: 'write' })
	assert.equal(result.action, 'refuse')
	assert.ok(result.reason.includes('退化'), result.reason)
	assert.ok(/\d+/.test(result.reason), '原因里要带上符号个数')
})

test('正常参数不拦：JSON / 代码 / 中文', () => {
	const samples = [
		{ content: '{"name":"张三","tags":["a","b"]}' },
		{ content: 'function add(a, b) {\n  return a + b;\n}\n' },
		{ content: '# 验证记录\n\n## 第一步\n检查配置是否正确，确认通过后继续下一步。' },
		{ content: 'const x = "⇒⇒⇒"; // 这是一次性符号，非连续游程' },
	]
	for (const args of samples) {
		const result = checkToolArgs(args, { mode: 'refuse', toolName: 'write' })
		assert.equal(result.action, 'allow', `误拦：${JSON.stringify(args).slice(0, 60)}`)
	}
})

test('scope=write-only：只拦写类工具', () => {
	const options = { mode: 'refuse', scope: 'write-only' }
	const write = checkToolArgs({ content: RUN }, { ...options, toolName: 'write' })
	assert.equal(write.action, 'refuse')
	const read = checkToolArgs({ content: RUN }, { ...options, toolName: 'read' })
	assert.equal(read.action, 'allow')
	const other = checkToolArgs({ content: RUN }, { ...options, toolName: 'some_unknown_tool' })
	assert.equal(other.action, 'allow')
})

test('scope=oversized-only：只在参数超阈值时生效', () => {
	const options = { mode: 'refuse', scope: 'oversized-only', maxArgsChars: 100 }
	const small = checkToolArgs({ content: '⇒'.repeat(30) }, { ...options, toolName: 'write' })
	assert.equal(small.action, 'allow', '参数不够长就不拦')
	const large = checkToolArgs({ content: 'x'.repeat(200) + RUN }, { ...options, toolName: 'write' })
	assert.equal(large.action, 'refuse')
})

test('scope=all：任何工具都拦', () => {
	const options = { mode: 'refuse', scope: 'all' }
	for (const toolName of ['write', 'read', 'some_unknown_tool']) {
		assert.equal(checkToolArgs({ content: RUN }, { ...options, toolName }).action, 'refuse')
	}
})

test('超长参数中段的游程也能被发现（必须分片喂入）', () => {
	// 游程夹在两段长文本中间：一次性喂入时判定窗口会把前半段裁掉，漏检。
	// 填充文本必须无重复结构，否则会先命中别的规则，测的就不是分片这件事了。
	const filler = Array.from({ length: 4000 }, (_, i) => `段落${i}：结论与依据`).join('')
	const result = checkToolArgs({ content: `${filler}${RUN}${filler}` }, { mode: 'refuse', toolName: 'write' })
	assert.equal(result.action, 'refuse')
	assert.equal(result.detail.rule, 'symbol-run', `命中了别的规则：${JSON.stringify(result.detail)}`)
})

test('判定细节带规则名与位置', () => {
	const result = checkToolArgs({ content: `前言${RUN}` }, { mode: 'refuse', toolName: 'write' })
	assert.equal(result.detail.rule, 'symbol-run')
	assert.equal(result.detail.onset, 2)
	assert.ok(result.detail.count >= 20)
})

// ── 多字符单元重复 ────────────────────────────────────────────────────────

/** 用户给的那种退化：同一个多字符单元整段整段地重复。 */
const UNIT_BLOCK = '⇒⇒§ ⇒⇒§ §'
/** 12 份单元重复拼成的参数内容。 */
const UNIT_TEXT = `前置说明。\n\n${Array.from({ length: 12 }, () => UNIT_BLOCK).join('\n\n')}\n\n后置说明。`

test('工具参数里的多字符单元重复照样命中', () => {
	const result = checkToolArgs({ content: UNIT_TEXT }, { mode: 'refuse', toolName: 'write' })
	assert.equal(result.action, 'refuse')
	assert.equal(result.detail.rule, 'unit-run')
	assert.equal(result.detail.repeats, 12)
	assert.ok(result.reason.includes('12'), `原因里要写明重复了几份：${result.reason}`)
	assert.ok(result.reason.includes('⇒⇒§ ⇒⇒§ §'), `原因里要写明是哪个单元：${result.reason}`)
})

test('工具守卫：关掉多字符单元治理后这形态不再拦', () => {
	const result = checkToolArgs({ content: UNIT_TEXT }, { mode: 'refuse', toolName: 'write', unitRun: false })
	assert.equal(result.action, 'allow')
})

test('工具守卫：多字符单元重复的份数阈值说了算', () => {
	// 12 份重复：阈值 4 份命中，阈值 20 份不命中。
	const strict = checkToolArgs({ content: UNIT_TEXT }, { mode: 'refuse', toolName: 'write', unitRepeats: 20 })
	assert.equal(strict.action, 'allow', '阈值调到 20 份，12 份重复不算退化')
	const loose = checkToolArgs({ content: UNIT_TEXT }, { mode: 'refuse', toolName: 'write', unitRepeats: 4 })
	assert.equal(loose.action, 'refuse', '阈值调到 4 份，12 份重复照样命中')
	assert.equal(loose.detail.rule, 'unit-run')
})

