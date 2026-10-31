/**
 * 路径解析：把配置里的相对路径解析到 harness home 下。
 *
 * 规则（与 DSH 其它插件一致）：
 *   - `$DSH_HOME/xxx`  → harness home（默认 `~/.dsh`）
 *   - `~/xxx`          → 用户 home
 *   - 绝对路径         → 原样使用
 *   - 其它相对路径     → harness home 下
 *
 * @module dsh-guard-degen/paths
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * harness home 目录。
 * @returns {string} 绝对路径
 */
export function harnessHome() {
	const fromEnv = process.env.DSH_HOME
	if (fromEnv && fromEnv.trim() !== '') return path.resolve(fromEnv)
	return path.join(os.homedir(), '.dsh')
}

/**
 * 解析配置里的路径值。
 * @param {string | null | undefined} value - 配置值
 * @returns {string | null} 绝对路径；value 为空时返回 null
 */
export function resolveHarnessPath(value) {
	if (typeof value !== 'string' || value.trim() === '') return null
	const raw = value.trim()
	if (raw === '~') return os.homedir()
	if (raw.startsWith('~/') || raw.startsWith('~\\')) return path.join(os.homedir(), raw.slice(2))
	if (path.isAbsolute(raw)) return raw
	const home = harnessHome()
	return path.join(home, raw)
}

/**
 * 确保目录存在。
 * @param {string} dir - 目录
 * @returns {string} 传入的目录
 */
export function ensureDir(dir) {
	fs.mkdirSync(dir, { recursive: true })
	return dir
}
