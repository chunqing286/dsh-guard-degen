/**
 * 工件扫描与修复测试 —— T7。
 *
 * 全程用内存里的假文件系统，**不碰真实磁盘**：
 * 读取、写入、目录遍历全部注入桩函数，断言只看返回值与桩调用记录。
 *
 * 覆盖重点：
 * 1. 游程口径（单个 `★` 不算命中；阈值两侧；与 `detect.js` 同口径）
 * 2. 只读边界（`apply` 默认 false ⇒ 一次写入都不许发生，连备份都不许）
 * 3. 修复的字节级保真（只动游程那几段，其余逐字节不变）
 * 4. 备份先于改写、改写后回读复核、残留如实上报
 * 5. 失败隔离（一个文件读不到，其它照常处理）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
	DEFAULT_EXTENSIONS,
	DEFAULT_IGNORE,
	DEFAULT_MAX_FILE_BYTES,
	repairArtifacts,
	scanArtifacts,
} from '../lib/artifacts.js'
import { DEFAULT_SYMBOLS, collapseSymbolRuns } from '../lib/detect.js'
import './helpers/temp-home.mjs'

/**
 * 平台无关的假路径根：Windows 下是 `C:\dsh-test`，POSIX 下是 `/dsh-test`。
 * 断言里的路径一律经 fp() 拼出来 —— 硬编码盘符在 Linux 上会被 path.resolve()
 * 改写，桩文件系统就再也匹配不上了。
 */
const FAKE_ROOT = path.resolve(path.sep, 'dsh-test')
/** 把相对片段拼成当前平台的绝对路径。 */
const fp = (...parts) => path.join(FAKE_ROOT, ...parts)

/**
 * 修复的测试入口：把根目录固定在假文件系统的盘根上。
 *
 * 复审缺陷 N3 之后，修复必须受根目录约束（默认是工作区），
 * 这组用例显式给出根目录，根目录策略本身由专门的用例覆盖。
 *
 * @param {object} options - 选项
 * @returns {object} 修复结果
 */
function repair(options) {
	return repairArtifacts({ roots: [FAKE_ROOT], ...options })
}

/**
 * 构造一份内存文件系统（读取缺失文件时抛 ENOENT，与 fs 一致）。
 * @param {Record<string, string>} files - 初始文件表
 * @returns {{files: Map<string, string>, writes: Array<{path: string, data: string}>, readFile: (p: string) => string, writeFile: (p: string, d: string) => void}} 假文件系统
 */
function fakeFs(files = {}) {
	const map = new Map(Object.entries(files))
	const writes = []
	return {
		files: map,
		writes,
		readFile(p) {
			if (!map.has(p)) {
				const err = new Error(`ENOENT: no such file or directory, open '${p}'`)
				err.code = 'ENOENT'
				throw err
			}
			return map.get(p)
		},
		writeFile(p, data) {
			writes.push({ path: p, data })
			map.set(p, data)
		},
	}
}

/** 造一段含单段游程的文本。 */
function oneRunText(run = '⇒', count = 40) {
	return `头部内容\n${run.repeat(count)}\n尾部内容\n`
}

// ── 扫描：多字符单元重复 ───────────────────────────────────────────────────

test('scan：多字符单元整段重复也算命中（用户给的形态）', () => {
	const block = '⇒⇒§ ⇒⇒§ §'
	const text = `头部内容\n\n${Array.from({ length: 12 }, () => block).join('\n\n')}\n\n尾部内容\n`
	const fsx = fakeFs({ [fp('proj', 'notes.md')]: text })
	const report = scanArtifacts({ roots: [fp('proj')], files: [fp('proj', 'notes.md')], readFile: fsx.readFile })

	assert.equal(report.files.length, 1, '应当报告这个文件')
	const hit = report.files[0].hits[0]
	assert.equal(hit.rule, 'unit-run')
	assert.equal(hit.repeats, 12)
	assert.equal(hit.count, 84)
	assert.ok(hit.preview.includes('⇒⇒§'))
})

test('scan：unitRun 关掉之后就只认符号游程', () => {
	const block = '⇒⇒§ ⇒⇒§ §'
	const text = `${Array.from({ length: 12 }, () => block).join('\n\n')}\n`
	const fsx = fakeFs({ [fp('proj', 'notes.md')]: text })
	const report = scanArtifacts({
		roots: [fp('proj')],
		files: [fp('proj', 'notes.md')],
		readFile: fsx.readFile,
		unitRun: false,
	})
	assert.equal(report.files.length, 0, '关掉之后不该命中')
})

test('scan：单元重复的份数阈值可调', () => {
	const block = '⇒⇒§ ⇒⇒§ §'
	const text = `${Array.from({ length: 4 }, () => block).join('\n\n')}\n`
	const fsx = fakeFs({ [fp('proj', 'notes.md')]: text })
	const strict = scanArtifacts({ roots: [fp('proj')], files: [fp('proj', 'notes.md')], readFile: fsx.readFile, unitRepeats: 5 })
	assert.equal(strict.files.length, 0, '4 份不该命中 5 份的阈值')
	const loose = scanArtifacts({ roots: [fp('proj')], files: [fp('proj', 'notes.md')], readFile: fsx.readFile, unitRepeats: 4 })
	assert.equal(loose.files.length, 1)
})

// ── 修复：多字符单元重复与红绿对照 ─────────────────────────────────────────

test('repair：多字符单元重复被折叠成〔退化单元×N〕', () => {
	const block = '⇒⇒§ ⇒⇒§ §'
	const text = `头部内容\n\n${Array.from({ length: 12 }, () => block).join('\n\n')}\n\n尾部内容\n`
	const fsx = fakeFs({ [fp('proj', 'notes.md')]: text })
	const result = repair({
		files: [fp('proj', 'notes.md')],
		apply: true,
		mode: 'collapse',
		readFile: fsx.readFile,
		writeFile: fsx.writeFile,
	})

	const row = result.results[0]
	assert.equal(row.changed, true)
	assert.equal(row.replaced, 1)
	assert.equal(row.symbols, 84)
	const after = fsx.files.get(fp('proj', 'notes.md'))
	assert.ok(after.includes('〔退化单元×12〕'), after)
	assert.ok(!after.includes('⇒⇒§'), '退化内容应当被换掉')
	assert.ok(after.includes('头部内容') && after.includes('尾部内容'), '前后文保留')
})

test('repair：摘掉长游程后碎片拼出的重复也要一次清干净（回读复核要通过）', () => {
	// 退化内容常常是「长游程 + 碎片」交替：游程被摘掉后碎片会贴到一起，
	// 拼出一个**新的**多字符单元重复。只看原文就会漏掉它 ——
	// 改写完回读复核才发现残渣也在重复，就只能如实报「复核未通过」。
	const lengths = [25, 30, 27, 31]
	const text = `头部内容\n${lengths.map((n) => `${'⇒'.repeat(n)} **⇒⇒ **`).join('')}尾部内容\n`
	const fsx = fakeFs({ [fp('proj', 'notes.md')]: text })
	const result = repair({
		files: [fp('proj', 'notes.md')],
		apply: true,
		mode: 'collapse',
		readFile: fsx.readFile,
		writeFile: fsx.writeFile,
	})

	const row = result.results[0]
	assert.equal(row.error, undefined, `回读复核要通过：${row.error ?? ''}`)
	assert.equal(row.remaining, 0, '不能留下新拼出来的重复')
	const after = fsx.files.get(fp('proj', 'notes.md'))
	assert.ok(!after.includes('**⇒⇒ **'), '碎片拼出来的重复也要清掉')
	assert.ok(after.includes('头部内容') && after.includes('尾部内容'), '前后文保留')
})

test('repair：预览带红绿对照数据（改写前 / 改写后各一行）', () => {
	const block = '⇒⇒§ ⇒⇒§ §'
	const text = `头部内容\n\n${Array.from({ length: 12 }, () => block).join('\n\n')}\n\n尾部内容\n`
	const fsx = fakeFs({ [fp('proj', 'notes.md')]: text })
	const result = repair({
		files: [fp('proj', 'notes.md')],
		apply: false,
		mode: 'collapse',
		readFile: fsx.readFile,
		writeFile: fsx.writeFile,
	})

	const row = result.results[0]
	assert.ok(row.preview, '预览必须带对照数据')
	assert.equal(row.preview.truncated, false)
	const segment = row.preview.segments[0]
	assert.equal(segment.path, fp('proj', 'notes.md'))
	assert.equal(segment.kind, 'unit-run')
	assert.equal(segment.repeats, 12)
	assert.equal(segment.added, '〔退化单元×12〕')
	assert.ok(segment.removed.includes('⇒⇒§'), segment.removed)
	assert.ok(segment.before.includes('头部内容'), segment.before)
	assert.ok(segment.after.includes('尾部内容'), segment.after)
	assert.equal(fsx.writes.length, 0, '预览不许写盘')
})

test('repair：整段删除模式下对照视图不写标记', () => {
	const block = '⇒⇒§ ⇒⇒§ §'
	const text = `头部内容\n\n${Array.from({ length: 12 }, () => block).join('\n\n')}\n\n尾部内容\n`
	const fsx = fakeFs({ [fp('proj', 'notes.md')]: text })
	const result = repair({
		files: [fp('proj', 'notes.md')],
		apply: false,
		mode: 'remove',
		readFile: fsx.readFile,
		writeFile: fsx.writeFile,
	})

	const segment = result.results[0].preview.segments[0]
	assert.equal(segment.added, '', '删除模式下不写标记')
	assert.equal(segment.removed.includes('⇒⇒§'), true, '红行仍然是原来的退化内容')
})

// ── 扫描：命中与不命中 ─────────────────────────────────────────────────────

test('scan：超过大小上限的文件要单独列出来，不能悄悄跳过', () => {
	// 真实教训：2.5MB 的污染文档被 2MB 默认上限跳过，扫描报告显示「一切正常」，
	// 实际上文件里有 106 段退化。跳过必须看得见。
	const text = oneRunText()
	const fsx = fakeFs({ [fp('proj', 'big.md')]: text })
	const report = scanArtifacts({
		roots: [fp('proj')],
		files: [fp('proj', 'big.md')],
		maxFileBytes: 8,
		readFile: fsx.readFile,
	})

	assert.equal(report.files.length, 0, '超限文件不进命中列表')
	assert.equal(report.summary.filesScanned, 0)
	assert.equal(report.summary.filesSkipped, 1)
	assert.deepEqual(report.skippedTooLarge, [fp('proj', 'big.md')], '超限文件必须单独报出来')
})

test('scan：默认大小上限覆盖 2.5MB 级别的大文件', () => {
	assert.ok(DEFAULT_MAX_FILE_BYTES >= 8 * 1024 * 1024, '默认上限太小，大文件会被悄悄跳过')
})

test('scan：真实磁盘上的超大文件也要列出来（走真实 fs 的那条分支）', () => {
	// 上一条用的是假 fs；真实 fs 会先 stat 再决定跳不跳过，这条专门盯那条分支。
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'degen-size-'))
	const file = path.join(dir, 'big.md')
	fs.writeFileSync(file, 'x'.repeat(4096))
	try {
		const report = scanArtifacts({ roots: [dir], maxFileBytes: 1024 })
		assert.equal(report.summary.filesScanned, 0, '超限文件不该算作已扫描')
		assert.equal(report.summary.filesSkipped, 1)
		assert.deepEqual(report.skippedTooLarge, [file], '超限文件必须单独报出来')
	} finally {
		fs.rmSync(dir, { recursive: true, force: true })
	}
})

test('scan：命中一段符号游程时报告该文件与命中详情', () => {
	const text = oneRunText()
	const fsx = fakeFs({ [fp('proj', 'a.md')]: text })
	const report = scanArtifacts({ roots: [fp('proj')], files: [fp('proj', 'a.md')], readFile: fsx.readFile })

	assert.equal(report.files.length, 1, '应当报告这个文件')
	const file = report.files[0]
	assert.equal(file.path, fp('proj', 'a.md'))
	assert.equal(file.runCount, 1)
	assert.equal(file.symbolCount, 40)
	assert.equal(file.maxRun, 40)
	assert.equal(file.bytes, Buffer.byteLength(text, 'utf8'))
	assert.equal(file.hits.length, 1)
	assert.equal(file.hits[0].rule, 'symbol-run')
	assert.equal(file.hits[0].count, 40)
	assert.equal(file.hits[0].start, text.indexOf('⇒'))
	assert.equal(file.hits[0].end, text.indexOf('⇒') + 40)
	assert.ok(file.hits[0].preview.includes('⇒'))

	assert.equal(report.summary.filesScanned, 1)
	assert.equal(report.summary.filesWithHits, 1)
	assert.equal(report.summary.totalRuns, 1)
	assert.equal(report.summary.totalSymbols, 40)
	assert.equal(report.summary.maxRun, 40)
	assert.match(report.scannedAt, /^\d{4}-\d{2}-\d{2}T/)
	assert.deepEqual(report.roots, [fp('proj')])
})

test('scan：干净文件不进报告，但计入 filesScanned', () => {
	const fsx = fakeFs({ [fp('proj', 'clean.md')]: '# 标题\n正文没有任何退化。\n' })
	const report = scanArtifacts({ roots: [fp('proj')], files: [fp('proj', 'clean.md')], readFile: fsx.readFile })

	assert.equal(report.files.length, 0, '干净文件不该出现在报告里')
	assert.equal(report.summary.filesScanned, 1, '但要计入扫过的文件数')
	assert.equal(report.summary.filesWithHits, 0)
	assert.equal(report.summary.totalRuns, 0)
	assert.equal(report.summary.totalSymbols, 0)
	assert.equal(report.summary.maxRun, 0)
})

test('scan：单个符号不算命中（游程口径，不是单符号口径）', () => {
	const fsx = fakeFs({
		[fp('proj', 'tmp_traj4.txt')]: 'tmp_traj4：合法标记 ★ 与另一处 ★\n',
		[fp('proj', '验证记录.md')]: '# 验证记录\n- 已完成 ★\n',
	})
	const report = scanArtifacts({
		roots: [fp('proj')],
		files: [fp('proj', 'tmp_traj4.txt'), fp('proj', '验证记录.md')],
		readFile: fsx.readFile,
	})

	assert.equal(report.files.length, 0, '单个 ★ 不得算命中')
	assert.equal(report.summary.filesScanned, 2)
	assert.equal(report.summary.totalSymbols, 0)
})

test('scan：游程阈值两侧（19 个不命中，20 个命中）', () => {
	const fsx = fakeFs({
		[fp('proj', 'short.md')]: '·'.repeat(19),
		[fp('proj', 'long.md')]: '·'.repeat(20),
	})
	const report = scanArtifacts({
		roots: [fp('proj')],
		files: [fp('proj', 'short.md'), fp('proj', 'long.md')],
		readFile: fsx.readFile,
	})

	assert.equal(report.files.length, 1)
	assert.equal(report.files[0].path, fp('proj', 'long.md'))
	assert.equal(report.files[0].hits[0].count, 20)
})

test('scan：同一文件里的多段游程逐段上报', () => {
	const text = `第一段\n${'⇒'.repeat(25)}\n中间内容\n${'★'.repeat(30)}\n末尾`
	const fsx = fakeFs({ [fp('proj', 'multi.md')]: text })
	const report = scanArtifacts({ roots: [fp('proj')], files: [fp('proj', 'multi.md')], readFile: fsx.readFile })

	assert.equal(report.files.length, 1)
	const file = report.files[0]
	assert.equal(file.runCount, 2)
	assert.equal(file.symbolCount, 55)
	assert.equal(file.maxRun, 30)
	assert.equal(file.hits.length, 2)
	assert.equal(file.hits[0].count, 25)
	assert.equal(file.hits[0].start, text.indexOf('⇒'))
	assert.equal(file.hits[0].end, text.indexOf('⇒') + 25)
	assert.equal(file.hits[1].count, 30)
	assert.equal(file.hits[1].start, text.indexOf('★'))
	assert.equal(file.hits[1].end, text.indexOf('★') + 30)
	assert.equal(report.summary.totalRuns, 2)
	assert.equal(report.summary.totalSymbols, 55)
	assert.equal(report.summary.maxRun, 30)
})

test('scan：多个文件命中时按 symbolCount 降序', () => {
	const fsx = fakeFs({
		[fp('proj', 'small.md')]: '⇒'.repeat(22),
		[fp('proj', 'big.md')]: '⇒'.repeat(60),
		[fp('proj', 'mid.md')]: '⇒'.repeat(31),
	})
	const report = scanArtifacts({
		roots: [fp('proj')],
		files: [fp('proj', 'small.md'), fp('proj', 'big.md'), fp('proj', 'mid.md')],
		readFile: fsx.readFile,
	})

	assert.deepEqual(report.files.map((f) => f.path), [
		fp('proj', 'big.md'),
		fp('proj', 'mid.md'),
		fp('proj', 'small.md'),
	])
})

test('scan：minRun 可下调（阈值仍是同一套判定口径）', () => {
	const fsx = fakeFs({ [fp('proj', 'a.md')]: '⇒'.repeat(5) })
	const strict = scanArtifacts({ roots: [fp('proj')], files: [fp('proj', 'a.md')], readFile: fsx.readFile })
	const loose = scanArtifacts({ roots: [fp('proj')], files: [fp('proj', 'a.md')], readFile: fsx.readFile, minRun: 5 })

	assert.equal(strict.files.length, 0)
	assert.equal(loose.files.length, 1)
	assert.equal(loose.files[0].hits[0].count, 5)
})

test('scan：符号集可替换', () => {
	const fsx = fakeFs({ [fp('proj', 'a.md')]: '◆'.repeat(30) })
	const report = scanArtifacts({
		roots: [fp('proj')],
		files: [fp('proj', 'a.md')],
		readFile: fsx.readFile,
		symbols: '◆',
	})

	assert.equal(report.files.length, 1)
	assert.equal(report.files[0].hits[0].count, 30)
})

// ── 扫描：过滤与跳过 ───────────────────────────────────────────────────────

test('scan：扩展名不在白名单的文件不扫描', () => {
	const fsx = fakeFs({
		[fp('proj', 'a.png')]: '⇒'.repeat(40),
		[fp('proj', 'b.md')]: '⇒'.repeat(40),
	})
	const report = scanArtifacts({
		roots: [fp('proj')],
		files: [fp('proj', 'a.png'), fp('proj', 'b.md')],
		readFile: fsx.readFile,
	})

	assert.equal(report.files.length, 1)
	assert.equal(report.files[0].path, fp('proj', 'b.md'))
	assert.equal(report.summary.filesScanned, 1)
	assert.equal(report.summary.filesSkipped, 1)
	assert.ok(DEFAULT_EXTENSIONS.includes('.md'))
	assert.ok(DEFAULT_EXTENSIONS.includes('.ts'))
})

test('scan：超过 maxFileBytes 的文件被跳过', () => {
	const fsx = fakeFs({
		[fp('proj', 'big.md')]: 'x'.repeat(3000),
		[fp('proj', 'small.md')]: '正常内容\n',
	})
	const report = scanArtifacts({
		roots: [fp('proj')],
		files: [fp('proj', 'big.md'), fp('proj', 'small.md')],
		readFile: fsx.readFile,
		maxFileBytes: 1000,
	})

	assert.equal(report.files.length, 0)
	assert.equal(report.summary.filesScanned, 1)
	assert.equal(report.summary.filesSkipped, 1)
})

test('scan：路径含忽略片段的文件被跳过', () => {
	const fsx = fakeFs({ [fp('proj', 'node_modules', 'pkg', 'a.md')]: '⇒'.repeat(40) })
	const report = scanArtifacts({
		roots: [fp('proj')],
		listFiles: () => [fp('proj', 'node_modules', 'pkg', 'a.md')],
		readFile: fsx.readFile,
	})

	assert.equal(report.files.length, 0)
	assert.equal(report.summary.filesScanned, 0)
	assert.equal(report.summary.filesSkipped, 1)
	assert.ok(DEFAULT_IGNORE.includes('node_modules'))
})

test('scan：给了 files 就不做目录遍历', () => {
	const fsx = fakeFs({ [fp('proj', 'a.md')]: '⇒'.repeat(30) })
	let called = 0
	const report = scanArtifacts({
		roots: [fp('proj')],
		files: [fp('proj', 'a.md')],
		listFiles: () => {
			called += 1
			return []
		},
		readFile: fsx.readFile,
	})

	assert.equal(called, 0, '显式文件列表不该触发目录遍历')
	assert.equal(report.files.length, 1)
})

test('scan：注入的 listFiles 被用于目录遍历', () => {
	const fsx = fakeFs({ [fp('proj', 'a.md')]: '⇒'.repeat(30) })
	const seen = []
	const report = scanArtifacts({
		roots: [fp('proj')],
		listFiles: (root) => {
			seen.push(root)
			return [fp('proj', 'a.md')]
		},
		readFile: fsx.readFile,
	})

	assert.deepEqual(seen, [fp('proj')])
	assert.equal(report.files.length, 1)
	assert.equal(report.roots[0], fp('proj'))
})

test('scan：读不到的文件被跳过，不影响其它文件', () => {
	const fsx = fakeFs({ [fp('proj', 'ok.md')]: '⇒'.repeat(30) })
	const report = scanArtifacts({
		roots: [fp('proj')],
		files: [fp('proj', 'missing.md'), fp('proj', 'ok.md')],
		readFile: fsx.readFile,
	})

	assert.equal(report.files.length, 1)
	assert.equal(report.files[0].path, fp('proj', 'ok.md'))
	assert.equal(report.summary.filesScanned, 1)
	assert.equal(report.summary.filesSkipped, 1)
})

// ── 修复：只读预览 ─────────────────────────────────────────────────────────

test('repair：apply=false 时只读预览，一个字节都不写', () => {
	const text = oneRunText()
	const fsx = fakeFs({ [fp('proj', 'a.md')]: text })
	const result = repair({
		files: [fp('proj', 'a.md')],
		apply: false,
		readFile: fsx.readFile,
		writeFile: fsx.writeFile,
	})

	assert.equal(result.applied, false)
	assert.equal(fsx.writes.length, 0, '预览模式不许写盘')
	assert.equal(fsx.files.get(fp('proj', 'a.md')), text, '原文件必须原封不动')
	assert.equal(fsx.files.size, 1, '连备份文件都不许产生')

	const row = result.results[0]
	assert.equal(row.path, fp('proj', 'a.md'))
	assert.equal(row.changed, true)
	assert.equal(row.replaced, 1)
	assert.equal(row.symbols, 40)
	assert.equal(row.backup, undefined)
	assert.equal(row.error, undefined)
})

test('repair：不传 apply 时默认也是只读预览', () => {
	const fsx = fakeFs({ [fp('proj', 'a.md')]: oneRunText() })
	const result = repair({
		files: [fp('proj', 'a.md')],
		readFile: fsx.readFile,
		writeFile: fsx.writeFile,
	})

	assert.equal(result.applied, false)
	assert.equal(fsx.writes.length, 0)
	assert.equal(result.results[0].replaced, 1)
})

test('repair：预览模式汇总照样可用', () => {
	const fsx = fakeFs({
		[fp('proj', 'a.md')]: oneRunText(),
		[fp('proj', 'clean.md')]: '正常内容\n',
	})
	const result = repair({
		files: [fp('proj', 'a.md'), fp('proj', 'clean.md')],
		readFile: fsx.readFile,
		writeFile: fsx.writeFile,
	})

	assert.equal(result.summary.requested, 2)
	assert.equal(result.summary.changed, 1)
	assert.equal(result.summary.failed, 0)
	assert.equal(result.summary.symbols, 40)
})

// ── 修复：真正落盘 ─────────────────────────────────────────────────────────

test('repair：apply=true 时先备份再改写，改写后不再命中且其余内容不变', () => {
	const text = oneRunText()
	const fsx = fakeFs({ [fp('proj', 'a.md')]: text })
	const result = repair({
		files: [fp('proj', 'a.md')],
		apply: true,
		readFile: fsx.readFile,
		writeFile: fsx.writeFile,
	})

	assert.equal(result.applied, true)
	assert.equal(result.mode, 'collapse')

	const row = result.results[0]
	assert.equal(row.changed, true)
	assert.equal(row.replaced, 1)
	assert.equal(row.symbols, 40)
	assert.equal(row.remaining, 0, '回读复核应当没有残留')
	assert.equal(row.error, undefined)

	// 备份内容 == 原内容
	const backup = path.join(fp('proj'), 'a.md.degen-backup')
	assert.equal(row.backup, backup)
	assert.equal(fsx.files.get(backup), text)

	// 写入顺序：先备份，后改写
	assert.deepEqual(fsx.writes.map((w) => w.path), [backup, fp('proj', 'a.md')])

	// 改写后：不再命中，其余内容逐字节不变
	const after = fsx.files.get(fp('proj', 'a.md'))
	assert.equal(after, '头部内容\n〔退化符号流×40〕\n尾部内容\n')
	const again = scanArtifacts({ roots: [fp('proj')], files: [fp('proj', 'a.md')], readFile: fsx.readFile })
	assert.equal(again.files.length, 0, '改写后不该再命中')
})

test('repair：多段游程一次改写全部，其余内容逐字节保持', () => {
	const text = `第一段\n${'⇒'.repeat(25)}\n中间内容\n${'★'.repeat(30)}\n末尾`
	const fsx = fakeFs({ [fp('proj', 'multi.md')]: text })
	const result = repair({
		files: [fp('proj', 'multi.md')],
		apply: true,
		readFile: fsx.readFile,
		writeFile: fsx.writeFile,
	})

	const row = result.results[0]
	assert.equal(row.replaced, 2)
	assert.equal(row.symbols, 55)
	assert.equal(row.remaining, 0)
	const after = fsx.files.get(fp('proj', 'multi.md'))
	assert.equal(after, '第一段\n〔退化符号流×25〕\n中间内容\n〔退化符号流×30〕\n末尾')
})

test('repair：collapse 模式与 detect.js 的 collapseSymbolRuns 同口径', () => {
	const text = `a${'⇒'.repeat(30)}b${'★'.repeat(25)}c`
	const fsx = fakeFs({ [fp('proj', 'a.md')]: text })
	const result = repair({
		files: [fp('proj', 'a.md')],
		apply: true,
		mode: 'collapse',
		readFile: fsx.readFile,
		writeFile: fsx.writeFile,
	})

	const expected = collapseSymbolRuns(text, { minRun: 20, chars: DEFAULT_SYMBOLS }).text
	assert.equal(fsx.files.get(fp('proj', 'a.md')), expected)
	assert.equal(result.results[0].remaining, 0)
})

test('repair：remove 模式整段删掉，与 collapse 产出不同', () => {
	const text = oneRunText()
	const collapseFs = fakeFs({ [fp('proj', 'a.md')]: text })
	const removeFs = fakeFs({ [fp('proj', 'a.md')]: text })

	const collapsed = repair({
		files: [fp('proj', 'a.md')],
		apply: true,
		mode: 'collapse',
		readFile: collapseFs.readFile,
		writeFile: collapseFs.writeFile,
	})
	const removed = repair({
		files: [fp('proj', 'a.md')],
		apply: true,
		mode: 'remove',
		readFile: removeFs.readFile,
		writeFile: removeFs.writeFile,
	})

	assert.equal(collapsed.mode, 'collapse')
	assert.equal(removed.mode, 'remove')
	const collapsedText = collapseFs.files.get(fp('proj', 'a.md'))
	const removedText = removeFs.files.get(fp('proj', 'a.md'))
	assert.notEqual(collapsedText, removedText)
	assert.ok(collapsedText.includes('〔退化符号流×40〕'))
	assert.ok(!removedText.includes('〔退化符号流'))
	assert.ok(!removedText.includes('⇒'))
	assert.equal(removedText, '头部内容\n\n尾部内容\n')
	assert.equal(removed.results[0].remaining, 0)
})

test('repair：没有退化的文件不改动也不报错', () => {
	const text = '正常内容，没有任何退化。\n'
	const fsx = fakeFs({ [fp('proj', 'clean.md')]: text })
	const result = repair({
		files: [fp('proj', 'clean.md')],
		apply: true,
		readFile: fsx.readFile,
		writeFile: fsx.writeFile,
	})

	const row = result.results[0]
	assert.equal(row.changed, false)
	assert.equal(row.replaced, 0)
	assert.equal(row.symbols, 0)
	assert.equal(row.error, undefined)
	assert.equal(fsx.writes.length, 0, '没有要改的内容就不该产生备份或写入')
})

test('repair：备份文件名冲突时加序号，避免覆盖既有备份', () => {
	const original = oneRunText()
	const fsx = fakeFs({
		[fp('a', 'notes.md')]: original,
		[fp('b', 'notes.md')]: original,
	})
	const result = repair({
		files: [fp('a', 'notes.md'), fp('b', 'notes.md')],
		apply: true,
		backupDir: fp('bk'),
		readFile: fsx.readFile,
		writeFile: fsx.writeFile,
	})

	assert.equal(result.results[0].backup, path.join(fp('bk'), 'notes.md.degen-backup'))
	assert.equal(result.results[1].backup, path.join(fp('bk'), 'notes.md.degen-backup.1'))
	// 备份留的是**改写前**的原文
	assert.equal(fsx.files.get(path.join(fp('bk'), 'notes.md.degen-backup')), original)
	assert.equal(fsx.files.get(path.join(fp('bk'), 'notes.md.degen-backup.1')), original)
})

// ── 修复：失败路径 ─────────────────────────────────────────────────────────

test('repair：读不到的文件给出 error，其余文件照常处理', () => {
	const fsx = fakeFs({ [fp('proj', 'ok.md')]: oneRunText() })
	const result = repair({
		files: [fp('proj', 'missing.md'), fp('proj', 'ok.md')],
		apply: true,
		readFile: fsx.readFile,
		writeFile: fsx.writeFile,
	})

	const missing = result.results[0]
	assert.ok(missing.error, '读不到必须有说明')
	assert.match(missing.error, /读取失败/)
	assert.equal(missing.changed, false)

	const ok = result.results[1]
	assert.equal(ok.changed, true)
	assert.equal(ok.remaining, 0)
	assert.equal(ok.error, undefined)

	assert.equal(result.summary.requested, 2)
	assert.equal(result.summary.changed, 1)
	assert.equal(result.summary.failed, 1)
})

test('repair：写入失败时报错并如实标记未改动', () => {
	const fsx = fakeFs({ [fp('proj', 'a.md')]: oneRunText() })
	const result = repair({
		files: [fp('proj', 'a.md')],
		apply: true,
		readFile: fsx.readFile,
		// 备份写得进去，原文件写不进去
		writeFile: (p, data) => {
			if (p === fp('proj', 'a.md')) throw new Error('EACCES: permission denied')
			fsx.writeFile(p, data)
		},
	})

	const row = result.results[0]
	assert.ok(row.error)
	assert.match(row.error, /写入失败/)
	assert.equal(row.changed, false)
	assert.equal(row.replaced, 0)
	assert.equal(result.summary.failed, 1)
	// 原文件没被动过
	assert.equal(fsx.files.get(fp('proj', 'a.md')), oneRunText())
})

test('repair：备份写失败时不许动原文件', () => {
	const original = oneRunText()
	const fsx = fakeFs({ [fp('proj', 'a.md')]: original })
	const result = repair({
		files: [fp('proj', 'a.md')],
		apply: true,
		readFile: fsx.readFile,
		writeFile: (p, data) => {
			if (String(p).endsWith('.degen-backup')) throw new Error('EACCES: backup denied')
			fsx.writeFile(p, data)
		},
	})

	const row = result.results[0]
	assert.ok(row.error)
	assert.match(row.error, /备份失败/)
	assert.equal(row.changed, false)
	assert.equal(row.replaced, 0)
	assert.equal(fsx.files.get(fp('proj', 'a.md')), original, '原文件必须保持原样')
})

test('repair：回读复核发现残留时如实上报 remaining，不假装成功', () => {
	const original = oneRunText()
	const fsx = fakeFs({ [fp('proj', 'a.md')]: original })
	const result = repair({
		files: [fp('proj', 'a.md')],
		apply: true,
		readFile: fsx.readFile,
		// 写入桩不真的落盘 ⇒ 回读仍是原文 ⇒ 残留 1 段
		writeFile: () => {},
	})

	const row = result.results[0]
	assert.equal(row.remaining, 1)
	assert.ok(row.error, '有残留必须报出来')
})
