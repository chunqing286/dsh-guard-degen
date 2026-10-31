/**
 * 测试用的临时 harness home。
 *
 * 插件的默认落盘位置（配置、遮蔽副本、备份、审计旁车）都在 harness home 之下。
 * 测试如果不把它挪到临时目录，就会往用户真实的 `~/.dsh/guard-degen/` 里灌测试残留
 * —— 实测一次全量测试能写出上千个文件。
 *
 * `harnessHome()` 读的是 `process.env.DSH_HOME`（调用时读取），
 * 所以在测试文件顶部导入本模块就够了：每个测试文件都是独立进程。
 *
 * @module dsh-guard-degen/test/helpers/temp-home
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-guard-degen-home-'))
process.env.DSH_HOME = dir

/** 临时 harness home 的目录。 */
export const TEMP_HOME = dir

/**
 * 清理临时目录（测试进程退出前调用）。
 * @returns {void}
 */
export function cleanupTempHome() {
	try {
		fs.rmSync(dir, { recursive: true, force: true })
	} catch {
		// 清理失败不影响测试结论
	}
}

process.on('exit', cleanupTempHome)
