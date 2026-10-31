/**
 * 工件扫描与修复 —— 把「模型输出退化」从流里搬到磁盘上的工程文件。
 *
 * ## 为什么要有这一层
 *
 * 流式守卫拦得住「当次输出」，拦不住**已经落盘**的退化内容：
 * 一次退化的模型输出被写进 `notes.md` / `report.ts` 之后，
 * 后续每一次读到这个文件的会话都会被二次污染，而判定器根本看不见它。
 *
 * 本模块只做两件事：
 * - `scanArtifacts()`：只读扫描，产出「哪些文件被污染、污染在哪」的报告；
 * - `repairArtifacts()`：按用户勾选的文件修复（先备份 → 再改写 → 再回读复核）。
 *
 * ## 口径统一
 *
 * 判定完全复用 `lib/detect.js` 的 `findSymbolRun()`：同一个 `minRun`（默认 20）、
 * 同一个符号集（默认 `DEFAULT_SYMBOLS`）、同一条「游程」定义。
 *
 * **单个符号不算命中**——`★` 在真实文档里是合法标记（`tmp_traj4.txt`、
 * `验证记录.md`），只有连续成串才叫退化。本模块不另写正则，
 * 游程位置靠反复调用 `findSymbolRun()` 向前收敛补齐。
 *
 * 退化**不总是单个符号的重复**：还有「多字符单元整段整段地重复」这种形态
 * （`⇒⇒§ ⇒⇒§ §` 反复出现），`symbol-run` 对它完全不可见。
 * 所以本模块同时认两种形态（`findAllRuns()`）：
 * - `symbol-run`：同一个符号连成一片（≥ `minRun` 个，默认 20）；
 * - `unit-run`：一个多字符单元重复 ≥ `unitRepeats` 次（默认 4）。
 *
 * ## 边界
 *
 * - 扫描永远是只读的；修复必须显式 `apply: true` 才会落盘。
 * - 修复只动「退化那几段」，其余内容逐字节保持不变。
 * - 改写后回读复核，残留退化如实上报，不假装成功。
 * - 一切文件读写都可注入，测试不碰真实磁盘。
 *
 * @module lib/artifacts
 */

import fs from 'node:fs'
import path from 'node:path'
import { DEFAULT_SYMBOLS, UNIT_RUN_DEFAULTS, findSymbolRun, findUnitRunsInResidue, preview } from './detect.js'
import { ensureDir } from './paths.js'

/** 默认扫描的扩展名白名单（工程文本类文件）。 */
export const DEFAULT_EXTENSIONS = [
	'.md', '.markdown', '.txt', '.rs', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
	'.json', '.yaml', '.yml', '.toml', '.py', '.go', '.java', '.c', '.h', '.cpp',
	'.hpp', '.cs', '.sh', '.bat', '.ps1', '.html', '.css', '.scss', '.sql', '.vue',
	'.svelte',
]

/** 默认忽略的目录名片段（路径里含这些片段就跳过）。 */
export const DEFAULT_IGNORE = ['node_modules', '.git', 'dist', 'build', '.next', 'coverage', '.venv']

/**
 * 默认单文件大小上限（8MB）。
 *
 * 为什么是 8MB：退化最容易堆在「越写越长」的文件里（实测一个 2.5MB 的验证记录文档
 * 里有 106 段退化游程）。原来的 2MB 上限会把它悄悄跳过，扫描报告显示「一切正常」。
 */
export const DEFAULT_MAX_FILE_BYTES = 8 * 1024 * 1024

/** 备份文件后缀。 */
export const BACKUP_SUFFIX = '.degen-backup'

/**
 * 折叠标记（与 `detect.js` 的 `collapseSymbolRuns` 默认标记保持一致）。
 * @param {number} n - 该段的符号个数
 * @returns {string} 标记文本
 */
export function collapseMarker(n) {
	return `〔退化符号流×${n}〕`
}

/**
 * 多字符单元重复的折叠标记。
 *
 * 与 `collapseMarker()` 分开：符号游程说的是「多少个符号」，
 * 单元重复说的是「同一个单元重复了多少次」——两者的信息量不一样。
 * @param {number} repeats - 重复次数
 * @returns {string} 标记文本
 */
export function unitMarker(repeats) {
	return `〔退化单元×${repeats}〕`
}

// ── 内部工具 ───────────────────────────────────────────────────────────────

/**
 * 判断一个值是否是可用的非空字符串。
 * @param {unknown} value - 候选值
 * @returns {boolean} 是否为非空字符串
 */
function isNonEmptyString(value) {
	return typeof value === 'string' && value.trim() !== ''
}

/**
 * 规整根目录列表。
 * @param {unknown} input - 候选根目录
 * @returns {string[]} 根目录数组（缺省为当前工作目录）
 */
function normalizeRoots(input) {
	if (Array.isArray(input)) {
		const list = input.filter(isNonEmptyString)
		if (list.length > 0) return list
	}
	return [process.cwd()]
}

/**
 * 取文件的真实路径（解引用符号链接）。
 *
 * 写操作必须落在**真实文件**上：顺着链接写会把内容写到根目录之外，
 * 而备份还留在根目录里，看起来「成功」了。
 *
 * @param {string} file - 文件路径
 * @returns {string | null} 真实路径（取不到时返回 null）
 */
export function realPathOf(file) {
	try {
		return path.normalize(fs.realpathSync(path.resolve(file)))
	} catch {
		return null
	}
}

/**
 * 路径是否落在根目录之内（按解析后的真实路径比较，`..` 不能穿越）。
 * @param {string} file - 文件路径
 * @param {string[]} roots - 根目录列表
 * @returns {boolean} 是否在根目录之内
 */
export function isInsideRoots(file, roots) {
	if (!Array.isArray(roots) || roots.length === 0) return false
	const real = realPathOf(file) ?? path.resolve(file)
	for (const root of roots) {
		if (!isNonEmptyString(root)) continue
		const rootReal = realPathOf(root) ?? path.resolve(root)
		const relative = path.relative(rootReal, real)
		if (relative === '') return true
		// 越界只有 `..` 本身或 `..` 开头的目录段；`..notes.md` 是合法文件。
		if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) continue
		return true
	}
	return false
}

/**
 * 判断文件本身是不是符号链接（或位于符号链接目录里）。
 * @param {string} file - 文件路径
 * @returns {boolean} 是否经由符号链接
 */
export function isSymlinked(file) {
	const real = realPathOf(file)
	if (real === null) return false
	const resolved = path.resolve(file)
	if (process.platform === 'win32') return real.toLowerCase() !== resolved.toLowerCase()
	return real !== resolved
}

/**
 * 规整游程阈值。
 * @param {unknown} value - 候选阈值
 * @returns {number} 阈值（最小 2，缺省 20）
 */
function normalizeMinRun(value) {
	const n = Math.floor(Number(value))
	return Number.isFinite(n) && n >= 2 ? n : 20
}

/**
 * 规整符号集。
 * @param {unknown} value - 候选符号集
 * @returns {string} 符号集
 */
function normalizeSymbols(value) {
	return typeof value === 'string' && value.length > 0 ? value : DEFAULT_SYMBOLS
}

/**
 * 规整「多字符单元重复」的份数阈值。
 * @param {unknown} value - 候选阈值
 * @returns {number} 阈值（最小 2，缺省 4）
 */
function normalizeUnitRepeats(value) {
	const n = Math.floor(Number(value))
	return Number.isFinite(n) && n >= 2 ? n : 4
}

/**
 * 规整字符串列表（给的是数组就照用，空数组也是用户的明确意图）。
 * @param {unknown} input - 候选列表
 * @param {string[]} fallback - 缺省值
 * @returns {string[]} 列表
 */
function normalizeList(input, fallback) {
	return Array.isArray(input) ? input.filter(isNonEmptyString) : fallback
}

/**
 * 规整扩展名白名单（统一小写、带点）。
 * @param {unknown} input - 候选列表
 * @returns {string[]} 扩展名列表
 */
function normalizeExtensions(input) {
	return normalizeList(input, DEFAULT_EXTENSIONS).map((ext) => {
		const lower = ext.toLowerCase()
		return lower.startsWith('.') ? lower : `.${lower}`
	})
}

/**
 * 判断路径是否命中忽略片段。
 * @param {string} file - 文件路径
 * @param {string[]} ignore - 忽略片段
 * @returns {boolean} 是否跳过
 */
function shouldIgnore(file, ignore) {
	const lower = file.toLowerCase()
	return ignore.some((frag) => lower.includes(frag.toLowerCase()))
}

/**
 * 判断扩展名是否在白名单里。
 * @param {string} file - 文件路径
 * @param {string[]} extensions - 扩展名白名单
 * @returns {boolean} 是否允许扫描
 */
function hasAllowedExtension(file, extensions) {
	return extensions.includes(path.extname(file).toLowerCase())
}

/**
 * 取文件大小（读不到时返回 null）。
 * @param {string} file - 文件路径
 * @returns {number | null} 字节数
 */
function statSize(file) {
	try {
		const stat = fs.statSync(file)
		return stat.isFile() ? stat.size : null
	} catch {
		return null
	}
}

/**
 * 递归收集目录下的文件（默认遍历器）。
 *
 * 跳过隐藏目录与忽略名单里的目录；目录深度上限 16 层。
 * @param {string} dir - 目录
 * @param {string[]} ignore - 忽略片段
 * @param {string[]} [out] - 输出数组
 * @param {number} [depth] - 当前深度
 * @returns {string[]} 文件路径
 */
function walkDir(dir, ignore, out = [], depth = 0) {
	if (depth > 16) return out
	let entries = []
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true })
	} catch {
		return out
	}
	for (const entry of entries) {
		const full = path.join(dir, entry.name)
		if (entry.isDirectory()) {
			if (entry.name.startsWith('.')) continue
			if (ignore.some((frag) => entry.name.toLowerCase() === frag.toLowerCase())) continue
			walkDir(full, ignore, out, depth + 1)
			continue
		}
		if (!entry.isFile()) continue
		out.push(full)
	}
	return out
}

/**
 * 找出文本里**所有**符号游程。
 *
 * `findSymbolRun()` 返回的是**最早一段**游程（守卫要按时间顺序处理），
 * 这里从命中的位置往后继续找，直到没有为止。
 * 判定口径完全交给 `findSymbolRun()`，本模块不另写正则。
 *
 * 复杂度 O(段数 × 文件长度)；段数通常是个位数，可以接受。
 *
 * @param {string} text - 文本
 * @param {{minRun?: number, chars?: string}} [options] - 判定参数
 * @returns {Array<{start: number, end: number, count: number, char: string}>} 游程列表（按起点升序，end 为开区间）
 */
export function findAllSymbolRuns(text, options = {}) {
	const runs = []
	if (typeof text !== 'string' || text.length === 0) return runs
	const minRun = normalizeMinRun(options.minRun)
	const chars = normalizeSymbols(options.chars)
	let from = 0
	while (from < text.length) {
		const hit = findSymbolRun(text, { minRun, chars, fromIndex: from })
		if (!hit) break
		const start = hit.index
		runs.push({ start, end: start + hit.length, count: hit.count, char: hit.char })
		// 下一段从本段之后开始（游程里的空白也算在区间内，不能漏）
		from = start + Math.max(1, hit.length)
	}
	return runs
}

/**
 * 找出文本里所有需要治理的退化段。
 *
 * 两种形态都收：
 * - `symbol-run`：同一个符号连成一片（≥ `minRun` 个）；
 * - `unit-run`：一个多字符单元反复出现（≥ `unitRepeats` 次）。
 *
 * 重叠的段只留一段（留最长的）：同一处退化不重复上报，也不重复改写。
 *
 * @param {string} text - 文本
 * @param {{minRun?: number, symbols?: string, unitRun?: boolean, unitRepeats?: number}} [options] - 判定参数
 * @returns {Array<{start: number, end: number, count: number, kind: string,
 *                  unit: string, repeats: number | null}>} 退化段列表（按起点升序，end 为开区间）
 */
export function findAllRuns(text, options = {}) {
	const minRun = normalizeMinRun(options.minRun)
	const chars = normalizeSymbols(options.symbols)
	const symbolRuns = findAllSymbolRuns(text, { minRun, chars })
	const runs = symbolRuns.map((run) => ({
		start: run.start,
		end: run.end,
		count: run.count,
		kind: 'symbol-run',
		unit: run.char,
		repeats: null,
	}))
	if (options.unitRun !== false) {
		const unitOptions = {
			...UNIT_RUN_DEFAULTS,
			minRepeats: normalizeUnitRepeats(options.unitRepeats),
		}
		// 判定在残渣上做：先把符号游程摘掉，再在剩下的碎片里找单元重复。
		// 不这么做的话，治理完游程碎片会拼出一个新的单元重复，
		// 写完回读复核就通不过（报告「复核未通过」）。
		for (const hit of findUnitRunsInResidue(text, symbolRuns, unitOptions)) {
			runs.push({
				start: hit.start,
				end: hit.end,
				count: hit.count,
				kind: 'unit-run',
				unit: hit.unit,
				repeats: hit.repeats,
			})
		}
	}
	runs.sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start))
	const merged = []
	for (const run of runs) {
		const last = merged[merged.length - 1]
		if (last && run.start < last.end) {
			if ((run.end - run.start) > (last.end - last.start)) merged[merged.length - 1] = run
			continue
		}
		merged.push(run)
	}
	return merged
}

/**
 * 一段退化折叠后留下的标记。
 * @param {{kind: string, count: number, repeats: number | null}} run - 退化段
 * @returns {string} 标记文本
 */
function runMarker(run) {
	return run.kind === 'unit-run' ? unitMarker(run.repeats ?? 1) : collapseMarker(run.count)
}

/**
 * 把一段文本压成一行（对照视图一行只放得下一行内容）。
 * @param {string} value - 文本
 * @param {number} [max=160] - 最大长度
 * @returns {string} 单行文本
 */
function oneLine(value, max = 160) {
	const flat = String(value ?? '').replace(/\s+/g, ' ').trim()
	return flat.length > max ? flat.slice(0, max) : flat
}

/**
 * 为一次修复生成「红/绿对照」的预览数据。
 *
 * 每段退化摊成四行：改写前的上下文（灰）、被删掉的退化原文（红）、
 * 换上去的标记（绿）、改写后的上下文（灰）。
 *
 * @param {string} text - 原文
 * @param {Array<object>} runs - 退化段列表
 * @param {'collapse' | 'remove'} mode - 改写模式
 * @param {string} [file] - 文件路径（显示用）
 * @returns {{segments: Array<object>, truncated: boolean}} 预览数据
 */
export function buildRepairPreview(text, runs, mode, file) {
	const contextChars = 60
	const maxSegmentChars = 160
	const maxSegments = 50
	const segments = []
	for (const run of runs.slice(0, maxSegments)) {
		const removedRaw = text.slice(run.start, run.end)
		const removedFlat = String(removedRaw ?? '').replace(/\s+/g, ' ').trim()
		segments.push({
			path: file ?? '',
			event: segments.length + 1,
			kind: run.kind,
			unit: oneLine(run.unit, 60),
			repeats: run.repeats,
			count: run.count,
			before: oneLine(text.slice(Math.max(0, run.start - contextChars), run.start), contextChars),
			after: oneLine(text.slice(run.end, run.end + contextChars), contextChars),
			removed: removedFlat.length > maxSegmentChars ? removedFlat.slice(0, maxSegmentChars) : removedFlat,
			removedTruncated: removedFlat.length > maxSegmentChars,
			added: mode === 'remove' ? '' : runMarker(run),
		})
	}
	return { segments, truncated: runs.length > maxSegments }
}

/**
 * 按游程区间改写文本：只替换那几段，其余内容逐字节原样保留。
 * @param {string} text - 原文
 * @param {Array<{start: number, end: number, count: number}>} runs - 游程列表
 * @param {'collapse' | 'remove'} mode - 改写模式
 * @returns {string} 改写后的文本
 */
function applyRuns(text, runs, mode) {
	let out = ''
	let cursor = 0
	for (const run of runs) {
		out += text.slice(cursor, run.start)
		out += mode === 'remove' ? '' : runMarker(run)
		cursor = run.end
	}
	out += text.slice(cursor)
	return out
}

/**
 * 探测某个路径是否已存在（用注入的读取实现，不额外碰磁盘）。
 * @param {string} target - 目标路径
 * @param {(p: string) => string} readFile - 读取实现
 * @returns {boolean} 是否存在
 */
function probeExists(target, readFile) {
	try {
		readFile(target)
		return true
	} catch {
		return false
	}
}

/**
 * 选一个不覆盖既有文件的备份路径。
 *
 * 命名：`<原文件名>.degen-backup`；已存在时追加序号 `.1`、`.2`……
 * @param {string} file - 原文件路径
 * @param {string | null} backupDir - 备份目录（null 表示与原文件同目录）
 * @param {Set<string>} taken - 本次调用已占用的备份路径
 * @param {(p: string) => string} readFile - 读取实现（用于探测存在性）
 * @returns {string} 备份路径
 */
function pickBackupPath(file, backupDir, taken, readFile) {
	const dir = backupDir ? path.resolve(backupDir) : path.dirname(file)
	const base = path.basename(file)
	let candidate = path.join(dir, `${base}${BACKUP_SUFFIX}`)
	let n = 1
	while (taken.has(candidate) || probeExists(candidate, readFile)) {
		candidate = path.join(dir, `${base}${BACKUP_SUFFIX}.${n}`)
		n += 1
		if (n > 999) {
			candidate = path.join(dir, `${base}${BACKUP_SUFFIX}.${Date.now()}`)
			break
		}
	}
	taken.add(candidate)
	return candidate
}

// ── 扫描 ───────────────────────────────────────────────────────────────────

/**
 * 扫描工程文件里的退化内容（只读）。
 *
 * 报告里**只列命中的文件**，`summary.filesScanned` 统计全部读过的文件。
 * 多个文件命中时按 `symbolCount` 降序排列。
 *
 * 显式 `files` 与目录遍历两条路走的是**同一套过滤**（忽略片段 + 扩展名白名单），
 * 所以「扫出来的文件」再传回扫描/修复不会因为过滤口径不同而丢文件。
 *
 * 计数口径：
 * - `filesScanned`：成功读入并判定过的文件数（含干净文件）；
 * - `filesSkipped`：被跳过/过滤掉的文件数（扩展名不在白名单、超大、读不到）；
 * - `totalRuns` / `totalSymbols`：命中的段数 / 符号总数；
 * - `maxRun`：最长一段的符号数。
 *
 * @param {object} [options] - 选项
 * @param {string[]} [options.roots] - 要扫描的目录（默认 `process.cwd()`）
 * @param {string[]} [options.files] - 显式文件列表（给了就只扫这些，不走目录遍历）
 * @param {(root: string) => string[]} [options.listFiles] - 可注入的目录遍历
 * @param {(path: string) => string} [options.readFile] - 可注入的读取
 * @param {number} [options.minRun] - 游程阈值（默认 20）
 * @param {string} [options.symbols] - 符号集（默认 `DEFAULT_SYMBOLS`）
 * @param {boolean} [options.unitRun] - 是否也认「多字符单元重复」（默认 true）
 * @param {number} [options.unitRepeats] - 单元重复的份数阈值（默认 4）
 * @param {number} [options.maxFileBytes] - 单文件大小上限（默认 8MB）
 * @param {string[]} [options.extensions] - 扩展名白名单
 * @param {string[]} [options.ignore] - 路径忽略片段
 * @returns {{roots: string[], scannedAt: string, files: Array<object>, summary: object}} 扫描报告
 */
export function scanArtifacts(options = {}) {
	const roots = normalizeRoots(options.roots)
	const minRun = normalizeMinRun(options.minRun)
	const symbols = normalizeSymbols(options.symbols)
	const unitRun = options.unitRun !== false
	const unitRepeats = normalizeUnitRepeats(options.unitRepeats)
	const maxFileBytes = Number(options.maxFileBytes) > 0 ? Number(options.maxFileBytes) : DEFAULT_MAX_FILE_BYTES
	const extensions = normalizeExtensions(options.extensions)
	const ignore = normalizeList(options.ignore, DEFAULT_IGNORE)
	const explicit = Array.isArray(options.files) ? options.files.filter(isNonEmptyString) : null
	const usingDefaultReader = typeof options.readFile !== 'function'
	const readFile = usingDefaultReader
		? (p) => fs.readFileSync(p, 'utf8')
		: options.readFile
	const listFiles = typeof options.listFiles === 'function'
		? options.listFiles
		: (root) => walkDir(root, ignore)

	// 收集候选文件
	const candidates = []
	if (explicit) {
		// 显式列表也要落在根目录之内：调用方不能拿它绕过扫描范围。
		for (const item of explicit) {
			if (isInsideRoots(item, roots)) candidates.push(item)
		}
	} else {
		for (const root of roots) {
			const list = listFiles(root)
			if (Array.isArray(list)) candidates.push(...list)
		}
	}
	const seen = new Set()
	const unique = []
	for (const item of candidates) {
		if (!isNonEmptyString(item)) continue
		if (seen.has(item)) continue
		seen.add(item)
		unique.push(item)
	}

	let filesScanned = 0
	let filesSkipped = 0
	const files = []
	// 超大文件单独列出来：跳过必须看得见，否则「扫过了」会被误读成「没问题」。
	const skippedTooLarge = []
	for (const file of unique) {
		if (shouldIgnore(file, ignore)) {
			filesSkipped += 1
			continue
		}
		if (!hasAllowedExtension(file, extensions)) {
			filesSkipped += 1
			continue
		}
		if (usingDefaultReader) {
			// 走真实 fs 时先看大小，避免把超大文件整个读进内存
			const size = statSize(file)
			if (size === null) {
				filesSkipped += 1
				continue
			}
			if (size > maxFileBytes) {
				filesSkipped += 1
				skippedTooLarge.push(file)
				continue
			}
		}
		let text = null
		try {
			text = readFile(file)
		} catch {
			filesSkipped += 1
			continue
		}
		if (typeof text !== 'string') {
			filesSkipped += 1
			continue
		}
		const bytes = Buffer.byteLength(text, 'utf8')
		if (bytes > maxFileBytes) {
			filesSkipped += 1
			skippedTooLarge.push(file)
			continue
		}
		filesScanned += 1
		const runs = findAllRuns(text, { minRun, chars: symbols, unitRun, unitRepeats })
		if (runs.length === 0) continue
		let symbolCount = 0
		let maxRun = 0
		for (const run of runs) {
			symbolCount += run.count
			if (run.count > maxRun) maxRun = run.count
		}
		files.push({
			path: file,
			bytes,
			runCount: runs.length,
			symbolCount,
			maxRun,
			hits: runs.map((run) => ({
				rule: run.kind,
				count: run.count,
				start: run.start,
				end: run.end,
				preview: preview(run.unit, 40),
				...(run.repeats === null ? {} : { repeats: run.repeats }),
			})),
		})
	}

	files.sort((a, b) => b.symbolCount - a.symbolCount || b.maxRun - a.maxRun || a.path.localeCompare(b.path))

	let totalRuns = 0
	let totalSymbols = 0
	let maxRunOverall = 0
	for (const file of files) {
		totalRuns += file.runCount
		totalSymbols += file.symbolCount
		if (file.maxRun > maxRunOverall) maxRunOverall = file.maxRun
	}

	return {
		roots,
		scannedAt: new Date().toISOString(),
		files,
		// 超大文件（超过大小上限）单独列出：它们没有被检查过。
		skippedTooLarge,
		summary: {
			filesScanned,
			filesSkipped,
			filesWithHits: files.length,
			totalRuns,
			totalSymbols,
			maxRun: maxRunOverall,
			skippedTooLarge: skippedTooLarge.length,
		},
	}
}

// ── 修复 ───────────────────────────────────────────────────────────────────

/**
 * 修复一个文件：备份 → 改写 → 回读复核。
 * @param {string} file - 文件路径
 * @param {object} ctx - 上下文
 * @returns {object} 单条结果
 */
function repairOne(file, ctx) {
	const result = { path: file, changed: false, replaced: 0, symbols: 0 }

	// 不顺着符号链接写：链接的目标可能在根目录之外，而备份还留在根目录里，
	// 看上去「成功」了，实际改的是别处的文件。
	if (ctx.usingDefaultWriter && isSymlinked(file)) {
		result.error = '拒绝修改符号链接指向的文件（可能落在扫描根目录之外）。'
		return result
	}
	if (ctx.roots && ctx.roots.length > 0 && !isInsideRoots(file, ctx.roots)) {
		result.error = '文件不在配置的扫描根目录之内，已跳过。'
		return result
	}
	let text = null
	let originalBytes = null
	try {
		if (ctx.usingDefaultWriter) {
			// 按字节读：非 UTF-8 的文件一旦按文本解码就再也还原不回去，
			// 这类文件直接跳过，不做任何改写。
			originalBytes = fs.readFileSync(file)
			text = originalBytes.toString('utf8')
			if (!Buffer.from(text, 'utf8').equals(originalBytes)) {
				result.error = '文件不是 UTF-8 编码，已跳过（避免破坏原文）。'
				return result
			}
		} else {
			text = ctx.readFile(file)
		}
	} catch (err) {
		result.error = `读取失败: ${err?.message ?? String(err)}`
		return result
	}
	if (typeof text !== 'string') {
		result.error = '读取失败: 读到的不是文本'
		return result
	}

	const runs = findAllRuns(text, {
		minRun: ctx.minRun,
		chars: ctx.symbols,
		unitRun: ctx.unitRun,
		unitRepeats: ctx.unitRepeats,
	})
	if (runs.length === 0) {
		result.remaining = 0
		return result
	}
	const next = applyRuns(text, runs, ctx.mode)
	result.replaced = runs.length
	for (const run of runs) result.symbols += run.count
	result.changed = true
	// 红/绿对照的预览数据：预览与落盘给的是同一份（改的就是这些段）。
	result.preview = buildRepairPreview(text, runs, ctx.mode, file)

	if (!ctx.apply) {
		// 预览模式：只报将要改什么，一个字节都不写（连备份都不写）
		return result
	}

	// 先备份：备份写不成功就不许动原文件
	let backup = null
	try {
		backup = pickBackupPath(file, ctx.backupDir, ctx.taken, ctx.readFile)
		if (ctx.usingDefaultWriter) {
			ensureDir(path.dirname(backup))
			// 备份写的是原始字节，保证可以原样还原
			fs.writeFileSync(backup, originalBytes)
		} else {
			ctx.writeFile(backup, text)
		}
	} catch (err) {
		result.changed = false
		result.replaced = 0
		result.symbols = 0
		result.error = `备份失败: ${err?.message ?? String(err)}`
		return result
	}
	result.backup = backup

	// 再改写
	// 复审缺陷 F5：上面那次根目录/符号链接判定与这里的写入之间有窗口，
	// 中间如果文件被换成符号链接（指向根目录外），写下去就改到了外面那个文件。
	// 所以写之前按当下的真实路径再判一次。
	if (ctx.usingDefaultWriter) {
		if (typeof ctx.beforeWrite === 'function') {
			try {
				ctx.beforeWrite(file)
			} catch {
				// 钩子失败不影响修复流程：真正的判定在下面。
			}
		}
		if (isSymlinked(file)) {
			result.changed = false
			result.replaced = 0
			result.symbols = 0
			result.error = '拒绝修改符号链接指向的文件（写入前复核发现路径已变）。'
			return result
		}
		if (ctx.roots && ctx.roots.length > 0 && !isInsideRoots(file, ctx.roots)) {
			result.changed = false
			result.replaced = 0
			result.symbols = 0
			result.error = '文件不在配置的扫描根目录之内，已跳过（写入前复核）。'
			return result
		}
	}
	try {
		if (ctx.usingDefaultWriter) fs.writeFileSync(file, Buffer.from(next, 'utf8'))
		else ctx.writeFile(file, next)
	} catch (err) {
		result.changed = false
		result.replaced = 0
		result.symbols = 0
		result.error = `写入失败: ${err?.message ?? String(err)}`
		return result
	}

	// 回读复核：残留多少报多少，不假装成功
	try {
		const after = ctx.readFile(file)
		const remaining = findAllRuns(after, {
			minRun: ctx.minRun,
			chars: ctx.symbols,
			unitRun: ctx.unitRun,
			unitRepeats: ctx.unitRepeats,
		}).length
		result.remaining = remaining
		if (remaining > 0) result.error = `复核未通过: 仍有 ${remaining} 段退化内容`
	} catch (err) {
		result.error = `回读失败: ${err?.message ?? String(err)}`
	}
	return result
}

/**
 * 按用户勾选的文件修复退化内容。
 *
 * `apply` 默认 **false**：默认是只读预览，只回报将要改什么，不写任何文件
 * （备份也不写）。只有 `apply: true` 才会落盘。
 *
 * 每条结果的语义：
 * - `changed`：应用模式下表示「已改写」；预览模式下表示「有待修复」；
 * - `replaced`：本次处理的退化段数（失败时为 0）；
 * - `symbols`：涉及的符号总数；
 * - `preview`：红/绿对照的预览数据（`segments` + `truncated`），界面按它渲染；
 * - `backup`：备份文件路径（仅实际落盘时给出）；
 * - `remaining`：改写后回读复核仍然命中的段数（正常为 0；预览模式不给）。
 *
 * 汇总口径：`summary.changed` 数「changed 为真」的行，`summary.failed` 数
 * 「带 error」的行——两者可能同时命中同一条（写成功但复核有残留）。
 *
 * @param {object} [options] - 选项
 * @param {string[]} [options.files] - 用户勾选要修的文件（必填）
 * @param {'collapse' | 'remove'} [options.mode] - 修复模式（默认 `remove`：整段删掉）
 * @param {boolean} [options.apply] - 是否真的落盘（默认 false，即只读预览）
 * @param {(path: string) => string} [options.readFile] - 可注入的读取
 * @param {(path: string, text: string) => void} [options.writeFile] - 可注入的写入
 * @param {string} [options.backupDir] - 备份目录（缺省与原文件同目录）
 * @param {number} [options.minRun] - 游程阈值（默认 20，与扫描同口径）
 * @param {string} [options.symbols] - 符号集（默认 `DEFAULT_SYMBOLS`）
 * @param {boolean} [options.unitRun] - 是否也修「多字符单元重复」（默认 true）
 * @param {number} [options.unitRepeats] - 单元重复的份数阈值（默认 4）
 * @returns {{applied: boolean, mode: string, results: Array<object>, summary: object}} 修复结果
 */
export function repairArtifacts(options = {}) {
	const files = Array.isArray(options.files) ? options.files.filter(isNonEmptyString) : []
	const mode = options.mode === 'collapse' ? 'collapse' : 'remove'
	const apply = options.apply === true
	const usingDefaultWriter = typeof options.writeFile !== 'function'
	// 复审缺陷 N3：修复的根目录默认与扫描一致（工作区），不再「不限制」。
	// 原来扫描按根目录圈定范围，修复却能改任意路径 —— 两边口径必须一致。
	const roots = Array.isArray(options.roots) && options.roots.filter(isNonEmptyString).length > 0
		? options.roots.filter(isNonEmptyString)
		: [process.cwd()]
	const ctx = {
		apply,
		mode,
		minRun: normalizeMinRun(options.minRun),
		symbols: normalizeSymbols(options.symbols),
		unitRun: options.unitRun !== false,
		unitRepeats: normalizeUnitRepeats(options.unitRepeats),
		readFile: typeof options.readFile === 'function' ? options.readFile : (p) => fs.readFileSync(p, 'utf8'),
		writeFile: usingDefaultWriter
			? (p, data) => fs.writeFileSync(p, data, 'utf8')
			: options.writeFile,
		usingDefaultWriter,
		backupDir: isNonEmptyString(options.backupDir) ? options.backupDir : null,
		roots,
		taken: new Set(),
		// 复审缺陷 F5 的测试缝：写下去之前的一个钩子。
		// 默认是空操作——生产路径上什么都不发生；测试用它把文件换成符号链接，
		// 验证「判定之后、写入之前」那道复核真的在拦。
		beforeWrite: typeof options.beforeWrite === 'function' ? options.beforeWrite : null,
	}

	const results = []
	for (const file of files) results.push(repairOne(file, ctx))

	let changed = 0
	let failed = 0
	let symbols = 0
	for (const row of results) {
		if (row.changed) changed += 1
		if (row.error) failed += 1
		symbols += row.symbols
	}

	return {
		applied: apply,
		mode,
		results,
		summary: { requested: files.length, changed, failed, symbols },
	}
}
