/**
 * 变异校验：把每一处修复改回缺陷状态，确认有测试真的会红。
 *
 * 背景：复审第三轮发现，前两轮的「修复」里有好几处没有用例钉住——
 * 把代码改回去，测试照样全绿，等于没修。本脚本把每个修复点逐个回退，
 * 要求**必须有测试失败**，否则这一处修复就是「假修复」。
 *
 * 用法：node check-mutations.mjs
 * 退出码 0 = 全部变异都被测试抓到；1 = 有变异没被抓到。
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const pluginDir = path.resolve(here, '..')
const node = process.execPath

/**
 * 变异清单：每一项都必须让至少一个测试失败。
 * @type {{id: string, file: string, from: string, to: string, why: string}[]}
 */
const MUTATIONS = [
	{
		id: 'N1 纯空白增量不再算游程结束',
		file: 'lib/stream-guard.js',
		from: `					// 空白属于游程的一部分：抑制掉，游程继续。\n					return { kept: '', symbols, ended: false }`,
		to: `					break`,
		why: '复审缺陷 N1：空白增量会把符号游程截成两段，后一段原始符号漏进正文',
	},
	{
		id: 'N2 干预上限用尽时原样放行',
		file: 'lib/stream-guard.js',
		from: `			this.report(verdict, 'truncate', state)\n			this.cutStream(state, verdict, states, out)\n			return { cut: true, next: null }`,
		to: `			this.report(verdict, 'pass', state)\n			return { cut: false, next: null }`,
		why: '复审缺陷 N2：上限放行会让原始退化符号直接落进会话',
	},
	{
		id: 'N4 遮蔽目标不再受会话根目录约束',
		file: 'lib/sessions.js',
		from: `	if (!isInsideRoots(file, roots)) {\n		result.error = '文件不在允许的会话根目录之内，已跳过。'\n		return result\n	}`,
		to: `	// 变异：去掉根目录约束`,
		why: '复审缺陷 N4：浏览器端能改写磁盘上任意文件',
	},
	{
		id: 'N5 没有退化时仍然落盘',
		file: 'lib/sessions.js',
		from: `	if (plan.masked === 0) {\n		result.applied = false\n		return result\n	}`,
		to: `	// 变异：没有退化也照样写`,
		why: '复审缺陷 N5：没东西可修却改写源文件并留下备份',
	},
	{
		id: 'N6 遮蔽副本与备份落回源文件旁边',
		file: 'lib/sessions.js',
		from: `	return path.join(pluginWorkDir(), 'masked', \`\${base}.\${shortHash(file)}.masked\`)`,
		to: `	return \`\${file}.masked\``,
		why: '复审缺陷 N6：往宿主会话目录里丢文件',
	},
	{
		id: 'N3 修复的根目录不再默认工作区',
		file: 'lib/artifacts.js',
		from: `	const roots = Array.isArray(options.roots) && options.roots.filter(isNonEmptyString).length > 0\n		? options.roots.filter(isNonEmptyString)\n		: [process.cwd()]`,
		to: `	const roots = Array.isArray(options.roots) ? options.roots.filter(isNonEmptyString) : null`,
		why: '复审缺陷 N3：扫描与修复口径不一致，修复能改任意路径',
	},
	{
		id: 'A2 游程结束位置退回 pending 相对下标',
		file: 'lib/stream-guard.js',
		from: `		const runEndCh = pendingStart + end`,
		to: `		const runEndCh = end`,
		why: '覆盖缺口 A2：滞留窗口滑动后 block-end 的权威文本会少一截正文',
	},
	{
		id: 'A3 块结束时的收尾判定被去掉',
		file: 'lib/stream-guard.js',
		from: `					let verdict = state.detector.flush()\n					let rounds = 0\n					while (verdict && rounds < MAX_VERDICTS_PER_CHUNK) {\n						const action = this.applyVerdict(state, verdict, states, out)\n						if (action.cut) {\n							this.cut = true\n							return out\n						}\n						verdict = action.next ?? null\n						rounds += 1\n					}\n					// 复审缺陷 F3：块在这里结束，游程也就在这里结束 ——`,
		to: `					let verdict = null\n					let rounds = 0\n					while (verdict && rounds < MAX_VERDICTS_PER_CHUNK) {\n						const action = this.applyVerdict(state, verdict, states, out)\n						if (action.cut) {\n							this.cut = true\n							return out\n						}\n						verdict = action.next ?? null\n						rounds += 1\n					}\n					// 复审缺陷 F3：块在这里结束，游程也就在这里结束 ——`,
		why: '覆盖缺口 A3：块尾部的退化会漏过',
	},
	{
		id: 'A3 流结束时的收尾判定被去掉',
		file: 'lib/stream-guard.js',
		from: `					let verdict = state.detector.flush()\n					let rounds = 0\n					while (verdict && rounds < MAX_VERDICTS_PER_CHUNK) {\n						const action = this.applyVerdict(state, verdict, states, out)\n						if (action.cut) {\n							this.cut = true\n							return out\n						}\n						verdict = action.next ?? null\n						rounds += 1\n					}\n					// 复审缺陷 F3：流结束也要结算标记计数。`,
		to: `					let verdict = null\n					let rounds = 0\n					while (verdict && rounds < MAX_VERDICTS_PER_CHUNK) {\n						const action = this.applyVerdict(state, verdict, states, out)\n						if (action.cut) {\n							this.cut = true\n							return out\n						}\n						verdict = action.next ?? null\n						rounds += 1\n					}\n					// 复审缺陷 F3：流结束也要结算标记计数。`,
		why: '覆盖缺口 A3：没有 block-end 的流，尾部退化会漏过',
	},
	{
		id: 'A5 collapseSymbolRuns 不再折叠',
		file: 'lib/detect.js',
		from: `		return \`\${head}\${marker(symbols)}\``,
		to: `		return whole`,
		why: '覆盖缺口 A5：符号游程不再折叠成标记',
	},
	{
		id: 'L1 扫描时静默跳过超大文件',
		file: 'lib/artifacts.js',
		from: `			if (size > maxFileBytes) {\n				filesSkipped += 1\n				skippedTooLarge.push(file)\n				continue\n			}`,
		to: `			if (size > maxFileBytes) {\n				filesSkipped += 1\n				continue\n			}`,
		why: '实测缺陷：2.5MB 的污染文档被 2MB 上限悄悄跳过，报告显示「一切正常」',
	},
	{
		id: 'L2 单文件大小上限退回 2MB',
		file: 'lib/artifacts.js',
		from: `export const DEFAULT_MAX_FILE_BYTES = 8 * 1024 * 1024`,
		to: `export const DEFAULT_MAX_FILE_BYTES = 2 * 1024 * 1024`,
		why: '实测缺陷：大文件继续被跳过，退化堆在越写越大的文件里',
	},
	{
		id: 'L3 服务层不再把配置里的大小上限传给扫描',
		file: 'lib/service.js',
		from: `			const configuredMax = Number(state.config.artifacts?.maxFileBytes)\n			const maxFileBytes = requestedMax > 0 ? requestedMax : (configuredMax > 0 ? configuredMax : undefined)`,
		to: `			const maxFileBytes = requestedMax > 0 ? requestedMax : undefined`,
		why: '实测缺陷：GUI 里调了大小上限也不生效',
	},
	{
		id: 'D1 游程跨块时照样只折叠后半段',
		file: 'lib/stream-guard.js',
		from: `		if (verdict.onset < pendingStart) return { ok: false, next: null }\n		const start = verdict.onset - pendingStart`,
		to: `		const start = Math.max(0, verdict.onset - pendingStart)`,
		why: '复审缺陷 D1：起点已流出滞留窗口时钳到 0 → 只清后半段，还发一个少算了一半的标记',
	},
	{
		id: 'D2 截断时又混用绝对与相对坐标',
		file: 'lib/stream-guard.js',
		from: `		const relCut = cut - this.channelPendingStart(state)`,
		to: `		const relCut = cut`,
		why: '复审缺陷 D2：截断点算错，退化尾巴原样放行',
	},
	{
		id: 'D3 窗口溢出时照旧把游程头部切掉',
		file: 'lib/detect.js',
		from: `			const runStart = trailingRunStart(this.buffer.slice(0, cut), this.symbols)\n			const safeCut = runStart >= 0 ? runStart : cut`,
		to: `			const safeCut = cut`,
		why: '复审缺陷 D3：游程头部被切出窗口，onset 指向游程中部',
	},
	{
		id: 'D4 标记计数不再同步回权威文本',
		file: 'lib/stream-guard.js',
		from: `		const at = marker.blockPos\n		if (at >= 0 && block.text.slice(at, at + oldText.length) === oldText) {\n			block.text = block.text.slice(0, at) + newText + block.text.slice(at + oldText.length)\n			return\n		}\n		// 位置对不上（块文本被裁剪过）：退回按内容替换**最后一次**出现。\n		const last = block.text.lastIndexOf(oldText)\n		if (last >= 0) {\n			block.text = block.text.slice(0, last) + newText + block.text.slice(last + oldText.length)\n		}`,
		to: `		// 变异：权威文本里的标记计数不再回写`,
		why: '复审缺陷 D4：存档里的标记计数与实际清掉的符号数不一致（权威文本不再回写）',
	},
	{
		id: 'D5 遮蔽目标不再拒绝符号链接',
		file: 'lib/sessions.js',
		from: `	if (isSymlinked(file)) {`,
		to: `	if (false) {`,
		why: '复审缺陷 D5：会话根目录里的符号链接能把根目录外的文件改掉',
	},
	{
		id: 'D5 根目录判定不再按真实路径比较',
		file: 'lib/artifacts.js',
		from: `		const rootReal = realPathOf(root) ?? path.resolve(root)`,
		to: `		const rootReal = path.resolve(root)`,
		why: '复审缺陷 D5：根目录配成符号链接时，里面的文件全被判成越界',
	},
	{
		id: 'D5 遮蔽的两层防线同时失效',
		edits: [
			{ file: 'lib/sessions.js', from: `	if (isSymlinked(file)) {`, to: `	if (false) {` },
			{ file: 'lib/artifacts.js', from: `	const real = realPathOf(file) ?? path.resolve(file)`, to: `	const real = path.resolve(file)` },
		],
		why: '复审缺陷 D5：符号链接闸门与真实路径判定同时失效时，根目录外的文件会被改掉',
	},
	{
		id: 'D6 命令修复入口不再认根目录',
		file: 'lib/service.js',
		from: `		const roots = normalizeRoots(request.roots, state.config.artifacts?.roots, cwd)`,
		to: `		const roots = normalizeRoots(undefined, state.config.artifacts?.roots, cwd)`,
		why: '复审缺陷 D6：命令点名的文件因为不在工作区里而修不了',
	},
	{
		id: "D7 工件侧以两个点开头的文件名又被判成越界",
		file: 'lib/artifacts.js',
		from: `		if (relative === '..' || relative.startsWith(\`..\${path.sep}\`) || path.isAbsolute(relative)) continue`,
		to: `		if (relative.startsWith('..') || path.isAbsolute(relative)) continue`,
		why: '复审缺陷 D7：工件侧的合法文件名被误判越界',
	},
	// ── 第 5 轮（写入路径安全）────────────────────────────────────────────
	{
		id: 'S1 远程扫描又认调用方给的根目录',
		file: 'lib/service.js',
		from: `			const roots = normalizeRoots(undefined, state.config.artifacts?.roots, cwd)\n			const minRun = numberOr(undefined, state.config.artifacts?.minRun, 20)\n			// 大小上限`,
		to: `			const roots = normalizeRoots(options.roots, state.config.artifacts?.roots, cwd)\n			const minRun = numberOr(undefined, state.config.artifacts?.minRun, 20)\n			// 大小上限`,
		why: '复审缺陷 F1：浏览器端能把扫描范围改成任意目录（只读的文件枚举器）',
	},
	{
		id: 'S2 远程修复又认调用方给的 minRun',
		file: 'lib/service.js',
		from: `			const minRun = numberOr(undefined, state.config.artifacts?.minRun, 20)\n			// 修复同样受根目录约束：能扫到的才能修。`,
		to: `			const minRun = numberOr(request.minRun, state.config.artifacts?.minRun, 20)\n			// 修复同样受根目录约束：能扫到的才能修。`,
		why: '复审缺陷 F6：调用方把 minRun 调到 2，修复就变成通用文本改写器',
	},
	{
		id: 'S3 遮蔽落点不再受范围约束',
		file: 'lib/sessions.js',
		from: `	if (!isAllowedMaskTarget(output, roots)) {\n		result.error = '输出路径不在允许的范围内，已跳过。'\n		return result\n	}`,
		to: `	// 变异：副本落点不再检查`,
		why: '复审缺陷 F3：浏览器端能把副本写到任意路径',
	},
	{
		id: 'S4 写入前不再复核符号链接与根目录',
		file: 'lib/artifacts.js',
		from: `		if (isSymlinked(file)) {\n			result.changed = false\n			result.replaced = 0\n			result.symbols = 0\n			result.error = '拒绝修改符号链接指向的文件（写入前复核发现路径已变）。'\n			return result\n		}`,
		to: `		// 变异：写入前不再复核`,
		why: '复审缺陷 F5：检查与写入之间的窗口里文件被换成符号链接',
	},
	{
		id: 'S5 旁车文件名不再净化',
		file: 'lib/log.js',
		from: `	const safeBase = String(baseName ?? 'verdict').replace(/[^A-Za-z0-9._-]/g, '_')`,
		to: `	const safeBase = String(baseName ?? 'verdict')`,
		why: '复审缺陷 F7：旁车文件名能带着路径分隔符逃出日志目录',
	},
	{
		id: 'S6 写后校验的根目录判定不再认真实路径',
		file: 'lib/post-execute.js',
		from: `	return isInsideRootsReal(target, roots)`,
		to: `	return roots.some((root) => {\n		const rel = path.relative(root, target)\n		return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))\n	})`,
		why: '复审缺陷 F4：根目录里的符号链接能把读范围带到外面',
	},
	// ── 第 6 轮（流式守卫缺陷 F1–F8）────────────────────────────────────
	{
		id: 'F1a 游程取最后一段而不是最早一段',
		file: 'lib/detect.js',
		edits: [
			{
				file: 'lib/detect.js',
				from: `	let i = from\n	while (i < text.length) {`,
				to: `	let i = from\n	let last = null\n	while (i < text.length) {`,
			},
			{
				file: 'lib/detect.js',
				from: `		if (count >= minRun) {\n			// \`char\` 是**那个符号本身**（例如 '⇒'），不是整段游程 ——\n			// 复审缺陷 S5：日志与裁决里要能一眼看出命中的是哪个符号。\n			return { char: firstChar, count, index: i, length: lastSymbolEnd - i }\n		}`,
				to: `		if (count >= minRun) {\n			// 变异：记下最后一段而不是立刻返回最早的那一段\n			last = { char: firstChar, count, index: i, length: lastSymbolEnd - i }\n		}`,
			},
			{
				file: 'lib/detect.js',
				from: `		i = j > i ? j : i + 1\n	}\n	return null\n}`,
				to: `		i = j > i ? j : i + 1\n	}\n	return last\n}`,
			},
		],
		why: '复审缺陷 F1：同一段增量里早的那段游程既没折叠也没切断',
	},
	{
		id: 'F1b 一段增量只处理第一条裁决',
		file: 'lib/stream-guard.js',
		from: `						verdict = action.next ?? null\n						rounds += 1`,
		to: `						verdict = null\n						rounds += 1`,
		why: '复审缺陷 F1：同一段增量里的第二段游程被丢掉',
	},
	{
		id: 'F2 先裁剪窗口再判定',
		file: 'lib/detect.js',
		from: `		const incremental = this._incremental(text, start)\n		if (this.buffer.length > this.windowChars) {`,
		to: `		if (this.buffer.length > this.windowChars) {`,
		why: '复审缺陷 F2：超长增量开头的游程被裁出窗口，永远判不出来',
	},
	{
		id: 'F3 块结束时不结算标记计数',
		file: 'lib/stream-guard.js',
		from: `					// 复审缺陷 F3：块在这里结束，游程也就在这里结束 ——\n					// 标记的计数必须在这里结算，否则存档里写的是初始计数（少算）。\n					this.finalizeMarker(state)`,
		to: `					// 变异：不在块结束时结算标记计数`,
		why: '复审缺陷 F3：没有收尾增量时标记计数不结算',
	},
	{
		id: 'F4 标记按字符串替换而不是按位置',
		file: 'lib/stream-guard.js',
		from: `		const at = marker.blockPos\n		if (at >= 0 && block.text.slice(at, at + oldText.length) === oldText) {`,
		to: `		const at = block.text.indexOf(oldText)\n		if (at >= 0) {`,
		why: '复审缺陷 F4：两段同样长的游程时计数落到了另一个标记上',
	},
	{
		id: 'F5 未结算的标记被提前释放',
		file: 'lib/stream-guard.js',
		from: `			if (entry.kind === 'marker' && this.isProvisionalMarker(entry)) break`,
		to: `			// 变异：未结算的标记也照常释放`,
		why: '复审缺陷 F5：delta 的计数与权威文本的计数对不上',
	},
	{
		id: 'F6 切断时不关闭全部打开的块',
		file: 'lib/stream-guard.js',
		from: `		for (const block of [...this.blocks.values()]) {\n			const closed = block.blockType === 'tool-call'\n				? { type: 'tool-call', ...this.closeToolCall(block) }\n				: { type: block.blockType === 'reasoning' ? 'reasoning' : 'text', text: block.text }\n			out.push({ type: 'block-end', index: block.index, block: closed })\n		}`,
		to: `		for (const block of [...this.blocks.values()]) {\n			if (!block.channel) continue\n			const channelState = states[block.channel]\n			if (!channelState || channelState.policy === 'off') continue\n			out.push({ type: 'block-end', index: block.index, block: { type: block.blockType === 'reasoning' ? 'reasoning' : 'text', text: block.text } })\n		}`,
		why: '复审缺陷 F6：策略关闭的通道与 tool-call 块留在打开状态',
	},
	{
		id: 'F7 匹配不上的 block-end 原样放行',
		file: 'lib/stream-guard.js',
		from: `						rewritten = { ...chunk, block: { ...chunk.block, text: this.sanitizeText(chunk.block?.text ?? '') } }`,
		to: `						// 变异：匹配不上就原样放行`,
		why: '复审缺陷 F7：原始符号经 block-end 进权威文本',
	},
	{
		id: 'F8 守卫实例复用时不重置状态',
		file: 'lib/stream-guard.js',
		from: `		this.cut = false\n		this.interventions = 0\n		this.pending = []\n		this.pendingLen = 0\n		this.blocks.clear()`,
		to: `		// 变异：不重置单次调用的状态`,
		why: '复审缺陷 F8：同一个守卫实例第二次跑就停摆',
	},
	// ── 第 6 轮（宿主契约复核 C1–C4）────────────────────────────────────
	{
		id: 'C1 模块级 inject 又依赖自建命名空间',
		file: 'lib/client.js',
		from: `		const inject = ['slots', 'locale', 'remote']`,
		to: `		const inject = ['slots', 'locale', 'remote', 'remote.guardDegen']`,
		why: '复审缺陷 C1：fiber 等不到自己才会创建的服务 → apply 不执行 → Web 起不来',
	},
	{
		id: 'C2 早期检测又从 agent.model 取模型',
		file: 'lib/index.js',
		from: `		const model = payload?.agent?.options?.model ?? ''`,
		to: `		const model = payload?.agent?.model ?? ''`,
		why: '复审缺陷 C2：宿主 agent 上没有 model 字段，模型白名单静默失效',
	},
	{
		id: 'C3 失败重试又记 provider 当模型',
		file: 'lib/index.js',
		from: `			model: payload?.agent?.options?.model ?? payload?.provider ?? null,`,
		to: `			model: payload?.provider,`,
		why: '复审缺陷 C3：复发统计与白名单键记的是 provider id',
	},
	{
		id: 'C4 工具入参裁决又拿 exec.model 当模型',
		file: 'lib/index.js',
		from: `			model: exec?.agent?.options?.model ?? null,`,
		to: `			model: exec?.model ?? null,`,
		why: '复审缺陷 C4：ToolExecutionInput 上没有 model 字段',
	},
	// ── 整段删除（remove）方式的对照视图 ────────────────────────────────
	{
		id: 'R1 remove 方式的绿行又拿一句占位话冒充改后的内容',
		file: 'lib/client.js',
		from: `\t\t\t\t\tconst masked = typeof segment.maskedWindow === 'string' ? segment.maskedWindow : ''`,
		to: `\t\t\t\t\tconst masked = '（该段被删除）'`,
		why: '用户诉求：remove 是要把重复符号直接删掉，绿行必须显示删完剩下的真实内容',
	},
	{
		id: 'R2 对照视图的「遮蔽后」又拿原文切窗口',
		file: 'lib/sessions.js',
		from: `\t\t\t\t// collapse 方式下退化段变成标记，标记也在窗口里。\n\t\t\t\tmaskedWindow: masked.value.slice(Math.max(0, span.start - PREVIEW_CONTEXT_CHARS), span.end + PREVIEW_CONTEXT_CHARS),`,
		to: `\t\t\t\t// collapse 方式下退化段变成标记，标记也在窗口里。\n\t\t\t\tmaskedWindow: node.value.slice(Math.max(0, run.start - PREVIEW_CONTEXT_CHARS), run.end + PREVIEW_CONTEXT_CHARS),`,
		why: 'remove 方式的绿行里会重新出现退化符号：用户看到的还是「没删掉」',
	},
]

/**
 * 复制插件目录到临时位置。
 * @param {string} target - 目标目录
 */
function copyPlugin(target) {
	fs.mkdirSync(target, { recursive: true })
	for (const entry of fs.readdirSync(pluginDir, { withFileTypes: true })) {
		if (entry.name === '.git') continue
		fs.cpSync(path.join(pluginDir, entry.name), path.join(target, entry.name), { recursive: true })
	}
}

/**
 * 跑一遍测试，返回是否全绿。
 * @param {string} dir - 插件副本目录
 * @returns {boolean} 是否全绿
 */
function runTests(dir) {
	const testDir = path.join(dir, 'test')
	const files = fs.readdirSync(testDir)
		.filter((name) => name.endsWith('.test.mjs'))
		.map((name) => path.join(testDir, name))
	const result = spawnSync(node, ['--test', ...files], { cwd: dir, encoding: 'utf8' })
	return result.status === 0
}

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'degen-mutations-'))
const copy = path.join(work, 'plugin')
copyPlugin(copy)

const baseline = runTests(copy)
if (!baseline) {
	console.error('基线就是红的：变异校验无从谈起，先把基线修绿。')
	process.exit(1)
}
console.log(`基线全绿（${MUTATIONS.length} 项变异待查）`)

const missed = []
for (const mutation of MUTATIONS) {
	// 一项变异可以改多个文件（`edits`），也可以只改一个文件（`file` + `from`/`to`）。
	const edits = mutation.edits ?? [{ file: mutation.file, from: mutation.from, to: mutation.to }]
	const backups = []
	let anchorMissing = null
	for (const edit of edits) {
		const target = path.join(copy, edit.file)
		const original = fs.readFileSync(target, 'utf8')
		backups.push({ target, original })
		let source = edit.from
		let replacement = edit.to
		if (!original.includes(source)) {
			// 文件是 CRLF 行尾时，锚点里的 \n 要跟着换成 \r\n，
			// 否则锚点永远找不到，变异根本没打上去（会被误报成「没被测试抓到」）。
			const crlf = source.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n')
			if (original.includes(crlf)) {
				source = crlf
				replacement = replacement.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n')
			}
		}
		if (!original.includes(source)) {
			anchorMissing = `${edit.file}：锚点没找到`
			break
		}
		fs.writeFileSync(target, original.replace(source, replacement))
	}
	if (anchorMissing) {
		console.error(`✖ ${mutation.id}：变异锚点没找到（${anchorMissing}）`)
		missed.push(mutation.id)
	} else {
		const green = runTests(copy)
		if (green) {
			console.error(`✖ ${mutation.id}：改回缺陷状态后测试仍然全绿 —— 这处修复没有用例钉住`)
			missed.push(mutation.id)
		} else {
			console.log(`✔ ${mutation.id}：被测试抓到（${mutation.why}）`)
		}
	}
	for (const backup of backups) fs.writeFileSync(backup.target, backup.original)
}

fs.rmSync(work, { recursive: true, force: true })

if (missed.length > 0) {
	console.error(`\n有 ${missed.length} 处变异没被测试抓到：`)
	for (const id of missed) console.error(`  - ${id}`)
	process.exit(1)
}
console.log('\n全部变异校验通过。')
