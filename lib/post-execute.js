/**
 * 写后校验 —— 在 `tools/post-execute` 这一层回读刚写入的产物。
 *
 * 工具闸门（B1）拦的是「参数里已经退化」；这一层拦的是「参数看着正常、但落盘结果里是退化内容」。
 * 后者是唯一能**事前**救回被写坏的工程文件的手段（事后只能靠扫描修复）。
 *
 * 命中后返回 `{kind:'block', feedback}`：宿主会把结果转成 isError 并把反馈回灌给模型，
 * 模型据此重写。注意这不会自动还原文件 —— 还原需要写前快照（见 lib/tool-guard.js 的快照钩子），
 * 且默认关闭（动用户仓库文件属于「存疑层」，需显式开启）。
 *
 * @module lib/post-execute
 */

import path from 'node:path'

import { DEFAULT_SYMBOLS } from './detect.js'
import { classifyTool, detectText } from './tool-guard.js'
import { isInsideRoots as isInsideRootsReal } from './artifacts.js'

/** 会被当成「写入目标」的参数名。 */
const PATH_KEYS = ['file_path', 'filepath', 'path', 'file', 'filename', 'target_file', 'target', 'dest', 'destination', 'output_path']

/** 默认最大校验文件大小（字节）。 */
export const DEFAULT_MAX_FILE_BYTES = 512 * 1024

/**
 * 从工具参数里提取写入目标。
 * @param {unknown} args - 工具参数
 * @returns {{path: string, key: string}[]} 写入目标
 */
export function extractWriteTargets(args) {
	const out = []
	if (!args || typeof args !== 'object') return out
	for (const key of PATH_KEYS) {
		const value = args[key]
		if (typeof value === 'string' && value.length > 0) out.push({ path: value, key })
	}
	return out
}

/**
 * 判断路径是否落在允许的根目录内。
 *
 * 比较的是**解析之后**的路径：`/work/../etc/passwd` 解析后是 `/etc/passwd`，
 * 不在 `/work` 之内。字符串前缀比较会被 `..` 绕过。
 *
 * 复审缺陷 F4：这里原先是按字面路径比较，和 `lib/artifacts.js` 里那一份
 * 不是同一个判定——根目录里的一个符号链接指向根目录外时，两份判定给出的答案相反，
 * 于是「写后校验」会去读根目录之外的文件。现在统一按**真实路径**判定。
 *
 * @param {string} target - 路径
 * @param {string} [root] - 根目录
 * @returns {boolean} 是否在根目录内
 */
export function isInsideRoot(target, root) {
	if (!root) return false
	return isInsideRootsReal(target, [root])
}

/**
 * 判断路径是否落在任意一个允许的根目录内。
 *
 * **空列表表示「什么都不许看」**，不是「不限制」：这一层会去读文件，
 * 放行等于让模型指定的任意路径都能被读进来。
 *
 * @param {string} target - 路径
 * @param {string[]} [roots] - 根目录列表
 * @returns {boolean} 是否在允许范围内
 */
export function isInsideRoots(target, roots) {
	if (!Array.isArray(roots) || roots.length === 0) return false
	return isInsideRootsReal(target, roots)
}

/**
 * 检测文件内容里的退化片段。
 * @param {string[]} paths - 文件路径
 * @param {object} options - 选项
 * @returns {Promise<{path: string, rule: string, count: number, preview: string}[]>} 违规列表
 */
export async function detectFileViolations(paths, options = {}) {
	const readFile = options.readFile ?? defaultReadFile
	const maxFileBytes = Math.max(0, Number(options.maxFileBytes) || DEFAULT_MAX_FILE_BYTES)
	const roots = Array.isArray(options.roots) && options.roots.length > 0
		? options.roots
		: options.root ? [options.root] : [process.cwd()]
	const violations = []
	for (const path of paths) {
		if (!isInsideRoots(path, roots)) continue
		let content
		try {
			content = await readFile(path)
		} catch {
			continue
		}
		if (typeof content !== 'string' || content.length === 0) continue
		if (maxFileBytes > 0 && Buffer.byteLength(content, 'utf8') > maxFileBytes) continue
		const verdict = detectText(content, {
			rules: options.rules,
			symbols: options.symbols ?? DEFAULT_SYMBOLS,
			windowChars: options.windowChars,
		})
		if (!verdict) continue
		violations.push({
			path,
			rule: verdict.rule,
			count: verdict.detail?.count ?? verdict.detail?.repeats ?? 0,
			preview: verdict.evidence ?? '',
		})
	}
	return violations
}

/**
 * 生成回灌给模型的反馈内容。
 * @param {{path: string, rule: string, count: number, preview: string}[]} violations - 违规列表
 * @returns {{type: 'text', text: string}[]} 反馈内容
 */
export function buildFeedback(violations) {
	const lines = violations.map((violation) => {
		const count = violation.count ? `连续相同符号 ${violation.count} 个` : '退化重复片段'
		return `- ${violation.path}：命中规则 ${violation.rule}（${count}）`
	})
	const text = [
		'写入结果被判定为退化内容，已按错误处理，请重新写入正常内容。',
		'判定明细：',
		...lines,
		'提示：不要重复发送同一段符号或同一句话；如内容确实需要包含少量符号，请拆开并加上说明。',
	].join('\n')
	return [{ type: 'text', text }]
}

/**
 * 写后校验的决策入口。
 * @param {{name: string, arguments: unknown}} exec - 工具执行上下文
 * @param {{isError?: boolean}} result - 工具结果
 * @param {object} options - 选项
 * @returns {Promise<{kind: 'accept'}|{kind: 'block', feedback: object[]}>} 决策
 */
export async function decidePostExecute(exec, result, options = {}) {
	// 默认关闭：这一层会去读模型指定的文件，开着才有意义。
	if (options.enabled !== true) return { kind: 'accept' }
	if (result?.isError === true) return { kind: 'accept' }
	const name = exec?.name ?? ''
	const isWriteTool = options.isWriteTool ?? ((toolName) => classifyTool(toolName) === 'write')
	if (!isWriteTool(name)) return { kind: 'accept' }
	const targets = extractWriteTargets(exec?.arguments)
	if (targets.length === 0) return { kind: 'accept' }
	const violations = await detectFileViolations(targets.map((target) => target.path), options)
	if (violations.length === 0) return { kind: 'accept' }
	return { kind: 'block', feedback: buildFeedback(violations) }
}

/**
 * 默认的文件读取实现。
 * @param {string} path - 路径
 * @returns {Promise<string>} 文件内容
 */
async function defaultReadFile(path) {
	const { readFile } = await import('node:fs/promises')
	return readFile(path, 'utf8')
}
