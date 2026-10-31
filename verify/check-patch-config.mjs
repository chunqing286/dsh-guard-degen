/**
 * 校验 cordis.patch.yml 里的 config 能被插件的 `static Config` 接受，
 * 且默认配置与 schema 默认值一致（宿主启动时不会因为配置形状不对而拒绝插件）。
 *
 * 只用 Node 内置模块 + 真 schemastery；YAML 用一个只够本文件形状的迷你解析器读。
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PLUGIN = path.resolve(HERE, '..')
const require_ = createRequire(path.join(HERE, 'noop.cjs'))
const z = require_('@deepseek-ai/schemastery')

const { CONFIG_SPEC, buildSchema, defaultConfig, normalizeConfig } = await import(pathToFileURL(path.join(PLUGIN, 'lib', 'config.js')).href)

/**
 * 读一个「缩进映射」的 YAML 子集（本 patch 文件的形状）：
 * 顶层是 `- key:` 的列表，值是缩进的映射；列表项的后续键与 `- ` 后的内容同列。
 * @param {string} text - YAML 文本
 * @returns {object[]} 顶层列表
 */
function parseSimpleYaml(text) {
	const lines = text.split(/\r?\n/).filter((line) => line.trim() !== '' && !line.trim().startsWith('#'))
	/**
	 * 读标量。
	 * @param {string} raw - 原始文本
	 * @returns {any} 标量值
	 */
	function parseScalar(raw) {
		if (raw === 'true') return true
		if (raw === 'false') return false
		if (raw === 'null' || raw === '~') return null
		if (/^-?\d+$/.test(raw)) return Number(raw)
		if (/^-?\d*\.\d+$/.test(raw)) return Number(raw)
		if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) return raw.slice(1, -1)
		return raw
	}
	/**
	 * 读一个块（列表或映射）。
	 * @param {number} index - 起始行
	 * @param {number} indent - 该块的缩进
	 * @returns {{value: any, next: number}} 解析结果与下一行
	 */
	function readBlock(index, indent) {
		const isList = lines[index] !== undefined && lines[index].trim().startsWith('- ') && lines[index].length - lines[index].trimStart().length === indent
		if (!isList) {
			const map = {}
			let cursor = index
			while (cursor < lines.length) {
				const line = lines[cursor]
				const current = line.length - line.trimStart().length
				if (current !== indent) break
				const trimmed = line.trim()
				if (trimmed.startsWith('- ')) break
				const colon = trimmed.indexOf(':')
				if (colon === -1) break
				const key = trimmed.slice(0, colon).trim()
				const inline = trimmed.slice(colon + 1).trim()
				cursor += 1
				if (inline !== '') {
					map[key] = parseScalar(inline)
					continue
				}
				if (cursor < lines.length) {
					const nextIndent = lines[cursor].length - lines[cursor].trimStart().length
					if (nextIndent > indent) {
						const block = readBlock(cursor, nextIndent)
						map[key] = block.value
						cursor = block.next
						continue
					}
				}
				map[key] = {}
			}
			return { value: map, next: cursor }
		}
		const items = []
		let cursor = index
		while (cursor < lines.length) {
			const line = lines[cursor]
			const current = line.length - line.trimStart().length
			if (current !== indent || !line.trim().startsWith('- ')) break
			const head = line.trim().slice(2)
			const colon = head.indexOf(':')
			const key = colon === -1 ? head : head.slice(0, colon).trim()
			const inline = colon === -1 ? '' : head.slice(colon + 1).trim()
			cursor += 1
			const item = {}
			item[key] = inline === '' ? {} : parseScalar(inline)
			// 列表项的内容缩进由下一行决定（YAML 允许任意更深的缩进）。
			if (cursor < lines.length) {
				const next = lines[cursor]
				const nextIndent = next.length - next.trimStart().length
				if (nextIndent > indent) {
					const block = readBlock(cursor, nextIndent)
					cursor = block.next
					if (inline === '') {
						item[key] = block.value
					} else if (block.value && typeof block.value === 'object' && !Array.isArray(block.value)) {
						Object.assign(item, block.value)
					}
				}
			}
			items.push(item)
		}
		return { value: items, next: cursor }
	}
	const block = readBlock(0, 0)
	assert.equal(block.next, lines.length, 'YAML 解析没有消费完所有行')
	return block.value
}

const schema = buildSchema(z, CONFIG_SPEC)
assert.ok(schema, '没有生成 schema')

const raw = fs.readFileSync(path.join(PLUGIN, 'cordis.patch.yml'), 'utf8')
const patches = parseSimpleYaml(raw)
assert.ok(Array.isArray(patches) && patches.length === 1, 'patch 文件应是一条 insert 列表')
assert.ok(Array.isArray(patches[0].insert), 'patch 里缺少 insert 列表')
assert.equal(patches[0].insert.length, 1, 'insert 里应只有一条')
const entry = patches[0].insert[0]
assert.equal(entry.id, 'guard-degen')
assert.equal(entry.name, 'dsh-guard-degen')
assert.equal(typeof entry.config, 'object')

const validated = schema['~standard'].validate(entry.config)
assert.equal(validated.issues, undefined, `patch 配置未被 schema 接受：${JSON.stringify(validated.issues)}`)
console.log('OK: patch 配置通过 schema 校验')

// schema 的默认值必须与 defaultConfig() 一致（宿主用 schema 默认值，GUI 用 defaultConfig()）。
// 规则表在 schema 里是 `{}`（不展开），规整后等价于完整默认表。
const resolved = normalizeConfig(schema({}))
assert.deepEqual(resolved, defaultConfig(), 'schema 默认值规整后与 defaultConfig() 不一致')
console.log('OK: schema 默认值规整后与 defaultConfig() 一致')

// patch 配置与默认值必须一致（避免两处漂移）。
assert.deepEqual(normalizeConfig(entry.config), defaultConfig(), 'patch 配置规整后与默认配置不一致')
console.log('OK: patch 配置规整后与默认配置一致')

console.log('全部校验通过。')
