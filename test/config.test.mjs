/**
 * 配置层测试 —— T10。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
	CONFIG_SPEC,
	buildSchema,
	defaultConfig,
	loadOverride,
	mergeConfig,
	normalizeConfig,
	resolveConfig,
	saveOverride,
	validateConfig,
} from '../lib/config.js'

import './helpers/temp-home.mjs'

test('默认配置齐备且每次都是新对象', () => {
	const first = defaultConfig()
	const second = defaultConfig()
	assert.equal(first.enabled, true)
	assert.equal(first.toolGuard.mode, 'warn')
	assert.equal(first.toolGuard.scope, 'all')
	assert.equal(first.stream.reasoning, 'truncate')
	assert.equal(first.stream.text, 'sanitize')
	assert.equal(first.stream.holdbackChars, 256)
	assert.equal(first.artifacts.apply, false, '工件修复默认必须只读')
	assert.equal(first.artifacts.maxFileBytes, 8 * 1024 * 1024, '大小上限默认要能覆盖 2.5MB 级别的大文件')
	assert.equal(first.postExecute.enabled, false)
	assert.equal(first.retry.maxSameModelRetries, 1)
	first.toolGuard.mode = 'refuse'
	assert.equal(second.toolGuard.mode, 'warn', '默认配置不能共享引用')
})

test('四处治理都有「是否启用多字符单元治理」的开关，默认都开着', () => {
	const config = defaultConfig()
	assert.equal(config.stream.unitRun, true, '流式守卫默认要治理多字符单元重复')
	assert.equal(config.toolGuard.unitRun, true, '工具守卫默认要治理多字符单元重复')
	assert.equal(config.sessions.unitRun, true, '会话治理默认要治理多字符单元重复')
	assert.equal(config.artifacts.unitRun, true, '工件治理默认要治理多字符单元重复')
	assert.equal(config.sessions.unitRepeats, 4, '会话治理的份数阈值默认 4')
	assert.equal(config.artifacts.unitRepeats, 4, '工件治理的份数阈值默认 4')
	assert.equal(config.stream.unitRepeats, 4, '流式守卫的份数阈值默认 4')
	assert.equal(config.toolGuard.unitRepeats, 4, '工具守卫的份数阈值默认 4')
})

test('多字符单元治理的开关可以被关掉', () => {
	const config = normalizeConfig({
		stream: { unitRun: false },
		toolGuard: { unitRun: false },
		sessions: { unitRun: false, unitRepeats: 8 },
	})
	assert.equal(config.stream.unitRun, false)
	assert.equal(config.toolGuard.unitRun, false)
	assert.equal(config.sessions.unitRun, false)
	assert.equal(config.sessions.unitRepeats, 8)
})

test('流式与工具守卫的份数阈值可以单独调', () => {
	const config = normalizeConfig({
		stream: { unitRepeats: 6 },
		toolGuard: { unitRepeats: 12 },
	})
	assert.equal(config.stream.unitRepeats, 6, '流式守卫的份数阈值单独生效')
	assert.equal(config.toolGuard.unitRepeats, 12, '工具守卫的份数阈值单独生效')
	assert.equal(config.artifacts.unitRepeats, 4, '工件治理的份数阈值不受影响')
	assert.equal(config.sessions.unitRepeats, 4, '会话治理的份数阈值不受影响')
})

test('规整会补齐缺失字段', () => {
	const config = normalizeConfig({})
	assert.equal(config.enabled, true)
	assert.equal(config.rules['symbol-run'].minRun, 20)
	assert.ok(config.rules['symbol-run'].channels.includes('reasoning'))
})

test('类型不对就退回默认值', () => {
	const config = normalizeConfig({ enabled: 'yes', toolGuard: { mode: 'explode' }, stream: { holdbackChars: 'lots' } })
	assert.equal(config.enabled, true)
	assert.equal(config.toolGuard.mode, 'warn')
	assert.equal(config.stream.holdbackChars, 256)
})

test('越界的数字被夹回范围内', () => {
	const config = normalizeConfig({ stream: { holdbackChars: 1 }, toolGuard: { maxArgsChars: 999999999 } })
	assert.equal(config.stream.holdbackChars, 64)
	assert.equal(config.toolGuard.maxArgsChars, 1048576)
})

test('未知键被丢掉', () => {
	const config = normalizeConfig({ totallyUnknown: 1, toolGuard: { nope: 2 } })
	assert.equal(config.totallyUnknown, undefined)
	assert.equal(config.toolGuard.nope, undefined)
})

test('校验能指出非法值', () => {
	const result = validateConfig({ toolGuard: { mode: 'explode' }, stream: { holdbackChars: -1 } })
	assert.equal(result.valid, false)
	const paths = result.errors.map((error) => error.path)
	assert.ok(paths.includes('toolGuard.mode'), JSON.stringify(result.errors))
	assert.ok(paths.includes('stream.holdbackChars'), JSON.stringify(result.errors))
})

test('校验合法配置通过', () => {
	const result = validateConfig({ enabled: true, toolGuard: { mode: 'refuse' }, rules: { 'symbol-run': { on: false } } })
	assert.equal(result.valid, true)
	assert.deepEqual(result.errors, [])
})

test('校验能发现类型错误', () => {
	const result = validateConfig({ enabled: 'true', modelIncludes: 'abc' })
	assert.equal(result.valid, false)
	assert.equal(result.errors.length >= 2, true)
})

test('深合并：覆盖层只覆盖给定的叶子', () => {
	const merged = mergeConfig(
		{ toolGuard: { mode: 'warn', scope: 'all' }, enabled: true },
		{ toolGuard: { mode: 'refuse' } },
	)
	assert.equal(merged.toolGuard.mode, 'refuse')
	assert.equal(merged.toolGuard.scope, 'all')
	assert.equal(merged.enabled, true)
})

test('运行时覆盖优先于宿主配置', () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'degen-cfg-'))
	const file = path.join(dir, 'config.json')
	saveOverride({ toolGuard: { mode: 'refuse' } }, file)
	const { config, override } = resolveConfig({ toolGuard: { mode: 'warn', scope: 'all' } }, { overrideFile: file })
	assert.equal(config.toolGuard.mode, 'refuse')
	assert.equal(config.toolGuard.scope, 'all')
	assert.equal(override.toolGuard.mode, 'refuse')
})

test('覆盖文件坏掉时退回空覆盖而不是崩', () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'degen-cfg-'))
	const file = path.join(dir, 'config.json')
	fs.writeFileSync(file, '{ 这不是 json', 'utf8')
	assert.deepEqual(loadOverride(file), {})
	const { config } = resolveConfig({ enabled: false }, { overrideFile: file })
	assert.equal(config.enabled, false)
})

test('可以关掉覆盖层', () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'degen-cfg-'))
	const file = path.join(dir, 'config.json')
	saveOverride({ enabled: false }, file)
	const { config } = resolveConfig({ enabled: true }, { overrideFile: file, useOverride: false })
	assert.equal(config.enabled, true)
})

test('schemastery schema 能从规格生成', () => {
	const calls = []
	const fakeZ = {
		boolean: () => chain('boolean'),
		string: () => chain('string'),
		number: () => chain('number'),
		array: () => chain('array'),
		dict: () => chain('dict'),
		any: () => chain('any'),
		union: (values) => chain(`union:${values.join('|')}`),
		object: (dict) => chain(`object:${Object.keys(dict).join(',')}`),
	}
	function chain(kind) {
		const api = {
			kind,
			default(value) {
				api.defaultValue = value
				return api
			},
			min(value) {
				api.minValue = value
				return api
			},
			max(value) {
				api.maxValue = value
				return api
			},
		}
		calls.push(api)
		return api
	}
	const schema = buildSchema(fakeZ)
	assert.equal(schema.kind, `object:${Object.keys(CONFIG_SPEC).join(',')}`)
	const toolGuard = calls.find((api) => api.kind.startsWith('object:') && api.kind.includes('mode') && api.kind.includes('scope'))
	assert.ok(toolGuard, '应生成 toolGuard 子对象')
	const modes = calls.filter((api) => api.kind.startsWith('union:'))
	assert.ok(modes.some((api) => api.kind === 'union:off|warn|refuse'), 'mode 应是字符串枚举')
})

test('单次调用最多干预次数允许 0（0 表示不限次数）', () => {
	const def = CONFIG_SPEC.stream.fields.maxInterventionsPerCall
	assert.equal(def.min, 0, '0 必须可填，否则「不限次数」根本存不进去')
	const config = normalizeConfig({ stream: { maxInterventionsPerCall: 0 } })
	assert.equal(config.stream.maxInterventionsPerCall, 0, '0 不能被夹回 1')
	const checked = validateConfig({ stream: { maxInterventionsPerCall: 0 } })
	assert.equal(checked.valid, true, JSON.stringify(checked.errors))
})

test('每个叶子配置项都带一句释义', () => {
	const missing = []
	/**
	 * 遍历叶子字段。
	 * @param {object} node - 规格节点
	 * @param {string} prefix - 路径前缀
	 */
	const walk = (node, prefix) => {
		if (node.type === 'object') {
			for (const [key, child] of Object.entries(node.fields ?? {})) walk(child, prefix ? `${prefix}.${key}` : key)
			return
		}
		if (typeof node.desc !== 'string' || !node.desc.trim()) missing.push(prefix)
	}
	for (const [key, def] of Object.entries(CONFIG_SPEC)) walk(def, key)
	assert.deepEqual(missing, [], '这些配置项缺释义：')
})
