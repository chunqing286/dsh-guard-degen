/**
 * 校验：remove（整段删除）方式在**真实会话存档**上不留任何替代文字。
 *
 * 用户诉求：选择 remove 时，被检测到的重复特殊字符要**直接删掉**，
 * 不是换成某一句话（比如「（该段被删除）」）。
 * 界面上的对照视图已经改成显示「删完剩下的真实内容」，
 * 这里再从磁盘这一侧确认一遍：落盘文件里既没有占位话，也没有折叠标记。
 *
 * 用法：node verify/check-remove-mode.mjs
 * 退出码 0 = 通过；1 = 落盘内容里出现了不该有的替代文字。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import { maskSession, scanSessions } from '../lib/sessions.js'
import { decodeSession } from '../lib/scan.js'
import { harnessHome } from '../lib/paths.js'

/** 界面里用过的占位话：remove 方式下绝不该出现在落盘内容里。 */
const PLACEHOLDERS = ['该段被删除', '删完后这一行没有内容了', '整条内容被删空了']

/** 折叠标记：remove 方式下一个都不该留。 */
const MARKERS = ['〔退化内容已遮蔽', '〔退化符号流']

const sessionsRoot = path.join(harnessHome(), 'sessions')
const report = scanSessions({ root: sessionsRoot, maxFiles: 500 })
const polluted = report.sessions.filter((s) => s.runCount > 0)
console.log(`扫描 ${report.summary.filesScanned} 个会话存档，命中会话 ${polluted.length} 个`)

if (polluted.length === 0) {
	console.log('这台机器上没有退化会话，跳过（没有可校验的对象）')
	process.exit(0)
}

const target = polluted.sort((a, b) => b.symbolCount - a.symbolCount)[0]
console.log(`取符号最多的一个：${target.path}（${target.runCount} 段 / ${target.symbolCount} 个符号）`)

// 输出必须落在允许的根目录之内，所以放在源会话旁边，用完删掉。
const tmp = path.join(path.dirname(target.path), `.remove-probe-${Date.now()}.zstd`)
let result
try {
	result = maskSession({
		file: target.path,
		apply: true,
		mode: 'copy',
		maskMode: 'remove',
		outFile: tmp,
		roots: [sessionsRoot],
	})
	console.log('maskSession 结果：', {
		applied: result.applied,
		maskMode: result.maskMode,
		masked: result.masked,
		symbols: result.symbols,
		remaining: result.remaining,
		error: result.error ?? null,
	})

	assert.equal(result.error, undefined, `遮蔽失败：${result.error ?? ''}`)
	assert.equal(result.applied, true, '遮蔽没有落盘')
	assert.equal(result.maskMode, 'remove', '遮蔽方式不是 remove')
	assert.equal(result.remaining, 0, '落盘内容里还有可遮蔽的退化段')

	const before = decodeSession(fs.readFileSync(target.path)).text
	const after = decodeSession(fs.readFileSync(tmp)).text
	console.log(`\n—— 落盘文件内容检查 ——`)
	console.log(`原文长度 ${before.length} → 遮蔽后 ${after.length}`)
	assert.ok(after.length < before.length, '遮蔽后内容没有变短：退化段没被删掉')

	for (const phrase of PLACEHOLDERS) {
		assert.equal(after.includes(phrase), false, `落盘内容里出现了占位话「${phrase}」：remove 是要直接删掉，不写替代文字`)
		console.log(`OK: 落盘内容里没有「${phrase}」`)
	}
	for (const marker of MARKERS) {
		assert.equal(after.includes(marker), false, `落盘内容里出现了折叠标记「${marker}」：remove 方式一个标记都不该留`)
		console.log(`OK: 落盘内容里没有「${marker}」`)
	}
} finally {
	fs.rmSync(tmp, { force: true })
}

console.log('\n全部校验通过。')
