/**
 * 配置层：规格、规整、校验与运行时覆盖。
 *
 * 设计要点：
 * - **单一来源**：`CONFIG_SPEC` 既驱动 `normalizeConfig` / `validateConfig`，
 *   也被 `buildSchema(z, spec)` 翻译成宿主要求的 schemastery schema
 *   （宿主半边 `export const Config = buildSchema(z, CONFIG_SPEC)`）。
 * - **不硬依赖 schemastery**：`buildSchema` 把 `z` 作为参数传入，
 *   这样本模块可以脱离宿主单测。
 * - **覆盖优先级**：profile patch（宿主给我们的 config） < 运行时覆盖文件
 *   （`~/.dsh/guard-degen/config.json`）。覆盖层用于不污染 profile 的临时调参。
 *
 * @module dsh-guard-degen/config
 */

import fs from 'node:fs'
import path from 'node:path'
import { normalizeRules } from './detect.js'
import { ensureDir, harnessHome } from './paths.js'

/**
 * 运行时覆盖文件的默认位置。
 *
 * 刻意做成函数而不是模块级常量：harness home 是**调用时**才解析的
 * （`DSH_HOME` 可能在模块加载之后才被设置），模块级常量会把路径钉死在加载那一刻，
 * 测试没法把自己隔离到临时目录里。
 *
 * @returns {string} 绝对路径
 */
export function overrideFile() {
	return path.join(harnessHome(), 'guard-degen', 'config.json')
}

/**
 * 配置规格。
 *
 * 每项字段：`{type, default, ...}`。
 * type 取值：`boolean` / `number` / `string` / `enum` / `stringArray` / `object` / `rules`。
 *
 * 每个叶子字段都带一句 `desc`：这一项在守卫流水线里到底管什么。
 * 界面把它显示在输入框下面，用户不必猜「改了会怎样」。
 */
export const CONFIG_SPEC = {
	enabled: { type: 'boolean', default: true, desc: '守卫总开关。关掉后流式检测、工具参数闸门、写入后校验全部停用，判定日志也不再新增。' },
	modelIncludes: { type: 'stringArray', default: [], desc: '只对这些模型生效（按名字包含匹配）。留空表示所有模型都守卫。' },
	rules: { type: 'rules', default: {}, desc: '检测规则表。决定「什么样的输出算退化」：符号游程、整段重复、周期性循环、语义新颖度等，每条规则可单独开关与调阈值。' },
	stream: {
		type: 'object',
		default: {},
		desc: '流式守卫：模型边吐字边检测，发现退化立刻处置。',
		fields: {
			reasoning: { type: 'enum', values: ['off', 'truncate', 'sanitize'], default: 'truncate', desc: '思考流（reasoning）检出退化时怎么办：off 不管；truncate 截断该通道并以「退化」结束本轮；sanitize 把退化游程折叠成标记〔退化符号流×N〕，本轮继续。' },
			text: { type: 'enum', values: ['off', 'truncate', 'sanitize'], default: 'sanitize', desc: '正文流（text）检出退化时怎么办：off 不管；truncate 截断并结束本轮；sanitize 折叠成标记，本轮继续。' },
			holdbackChars: { type: 'number', default: 256, min: 64, max: 65536, integer: true, desc: '滞留窗口：先扣住这么多字符再判退化。太小可能收不回头，太大会拖慢首字。' },
			windowChars: { type: 'number', default: 4096, min: 256, max: 1048576, integer: true, desc: '检测窗口：每次判定只看最近这么多字符。影响能发现多长的退化段。' },
			maxInterventionsPerCall: { type: 'number', default: 1, min: 0, max: 10, integer: true, desc: '单次模型调用里最多改写几处退化。0 表示不限次数——只要发现退化就尝试干预；超过上限后不再改写，直接截断交给重试策略。' },
			unitRun: { type: 'boolean', default: true, desc: '流式守卫是否也治理「多字符单元重复」（例如 ⇒⇒§ ⇒⇒§ § 整段整段地重复）。关掉就只管同一个符号连成一片的那种退化。' },
			unitRepeats: { type: 'number', default: 4, min: 2, max: 10000, integer: true, desc: '多字符单元重复的份数阈值：同一个单元连续出现多少次才算退化。调大更宽松，调小更敏感。' },
		},
	},
	toolGuard: {
		type: 'object',
		default: {},
		desc: '工具参数守卫：模型写工具入参时如果已经在退化，拦下来。',
		fields: {
			mode: { type: 'enum', values: ['off', 'warn', 'refuse'], default: 'warn', desc: '命中退化参数时怎么办：off 不管；warn 只记一条日志、照常执行；refuse 直接拒绝这次工具调用。' },
			scope: { type: 'enum', values: ['all', 'write-only', 'oversized-only'], default: 'all', desc: '检查哪些工具：all 全部；write-only 只查会写文件的工具；oversized-only 只查参数特别长的调用。' },
			minRun: { type: 'number', default: 20, min: 2, max: 10000, integer: true, desc: '退化游程阈值：连续多少个退化符号才算退化。调小更敏感，也更容易误报。' },
			maxArgsChars: { type: 'number', default: 2048, min: 64, max: 1048576, integer: true, desc: '超大参数阈值：参数超过这个长度才检查（配合 scope 使用）。' },
			unitRun: { type: 'boolean', default: true, desc: '工具守卫是否也治理「多字符单元重复」（例如 ⇒⇒§ ⇒⇒§ § 整段整段地重复）。关掉就只管同一个符号连成一片的那种退化。' },
			unitRepeats: { type: 'number', default: 4, min: 2, max: 10000, integer: true, desc: '多字符单元重复的份数阈值：同一个单元连续出现多少次才算退化。调大更宽松，调小更敏感。' },
		},
	},
	postExecute: {
		type: 'object',
		default: {},
		desc: '写入后校验：工具刚写完文件时再扫一遍，拦住写进磁盘的退化内容。',
		fields: {
			enabled: { type: 'boolean', default: false, desc: '是否开启写入后校验。开启后每次写文件都会多一次扫描。' },
			maxFileBytes: { type: 'number', default: 524288, min: 1024, max: 67108864, integer: true, desc: '校验文件大小上限：超过这个大小的文件跳过不扫。' },
			roots: { type: 'stringArray', default: [], desc: '只校验这些目录下的文件。留空表示一个目录都不校验（写入后校验等于不生效）。' },
		},
	},
	retry: {
		type: 'object',
		default: {},
		desc: '重试策略：因退化被截断之后，怎么把这一轮救回来。',
		fields: {
			policy: { type: 'enum', values: ['same-model', 'steer', 'no-retry'], default: 'same-model', desc: '退化后怎么办：same-model 用同一个模型重来；steer 给模型追加提示让它换个写法；no-retry 不重试。' },
			maxSameModelRetries: { type: 'number', default: 1, min: 0, max: 10, integer: true, desc: '同一个模型最多重试几次。0 表示不重试。' },
			recurrenceLimit: { type: 'number', default: 2, min: 1, max: 20, integer: true, desc: '累计重试上限：连续多次退化之后不再重试，避免和模型耗在一起。' },
			switchModel: {
				type: 'object',
				default: {},
				desc: '自动换模型：同模型重试仍退化时改用另一个模型。',
				fields: {
					enabled: { type: 'boolean', default: false, desc: '是否允许自动换模型。' },
					provider: { type: 'string', default: '', desc: '换到哪个 provider。留空表示沿用当前 provider。' },
					model: { type: 'string', default: '', desc: '换到哪个模型名。留空表示沿用当前模型。' },
				},
			},
		},
	},
	artifacts: {
		type: 'object',
		default: {},
		desc: '工件治理：工程目录里已经写进磁盘的退化内容。',
		fields: {
			roots: { type: 'stringArray', default: [], desc: '工件扫描根目录。留空表示用当前工作区兜底（会扫描整个工作区）；填上目录就只扫这些目录。' },
			minRun: { type: 'number', default: 20, min: 2, max: 10000, integer: true, desc: '工件退化游程阈值：连续多少个退化符号才算退化。' },
			unitRun: { type: 'boolean', default: true, desc: '工件治理是否也认「多字符单元重复」（例如 ⇒⇒§ ⇒⇒§ § 整段整段地重复）。关掉就只治理同一个符号连成一片的那种退化。' },
			unitRepeats: { type: 'number', default: 4, min: 2, max: 10000, integer: true, desc: '多字符单元重复的份数阈值：同一个单元连续出现多少次才算退化。' },
			mode: { type: 'enum', values: ['collapse', 'remove'], default: 'collapse', desc: '工件修复方式：collapse 折叠成标记（原文位置还看得出来）；remove 整段删掉。' },
			apply: { type: 'boolean', default: false, desc: '工件修复默认落盘。关着的时候修复动作只出预览，需要在界面上再确认一次才写盘。' },
			maxFileBytes: { type: 'number', default: 8388608, min: 1024, max: 67108864, integer: true, desc: '单文件大小上限：超限的文件会被跳过并单独列出来。' },
		},
	},
	sessions: {
		type: 'object',
		default: {},
		desc: '会话治理：会话存档里已经落盘的退化内容。',
		fields: {
			minRun: { type: 'number', default: 20, min: 2, max: 10000, integer: true, desc: '会话退化游程阈值：连续多少个退化符号才算退化。' },
			unitRun: { type: 'boolean', default: true, desc: '会话治理是否也认「多字符单元重复」（例如 ⇒⇒§ ⇒⇒§ § 整段整段地重复）。关掉就只治理同一个符号连成一片的那种退化。' },
			unitRepeats: { type: 'number', default: 4, min: 2, max: 10000, integer: true, desc: '多字符单元重复的份数阈值：同一个单元连续出现多少次才算退化。' },
			mode: { type: 'enum', values: ['copy', 'replace'], default: 'copy', desc: '会话遮蔽落点：copy 另存为副本（原文不动）；replace 就地改写会话存档。' },
			maskMode: { type: 'enum', values: ['collapse', 'remove'], default: 'collapse', desc: '会话遮蔽内容方式：collapse 折叠成标记；remove 整段删掉。' },
		},
	},
	logging: {
		type: 'object',
		default: {},
		desc: '日志：判定流水与旁证副本。',
		fields: {
			enabled: { type: 'boolean', default: true, desc: '是否写判定日志。关掉后界面上就看不到历史命中记录了。' },
			dir: { type: 'string', default: '', desc: '日志目录。留空表示用默认目录（~/.dsh/guard-degen）。' },
			maxSidecarChars: { type: 'number', default: 262144, min: 1024, max: 16777216, integer: true, desc: '旁证副本大小上限：被丢弃的原文片段最多存这么多字符。' },
		},
	},
	ack: {
		type: 'object',
		default: {},
		desc: '误报反馈：把误判登记成白名单，之后同类判定不再拦截。',
		fields: {
			enabled: { type: 'boolean', default: true, desc: '是否允许登记误报。' },
			autoRelax: { type: 'boolean', default: true, desc: '登记误报后是否自动放宽对应规则。' },
		},
	},
	commands: {
		type: 'object',
		default: {},
		desc: '斜杠命令：在对话里用 /degen 之类的命令手动扫一扫。',
		fields: {
			enabled: { type: 'boolean', default: true, desc: '是否注册斜杠命令。' },
		},
	},
}

/**
 * 取字段的默认值。
 * @param {any} def - 规格项
 * @returns {any} 默认值
 */
function defaultOf(def) {
	if (!def) return undefined
	if (def.type === 'rules') return normalizeRules(def.default ?? {})
	if (def.type === 'object') {
		const out = {}
		for (const [key, child] of Object.entries(def.fields ?? {})) out[key] = defaultOf(child)
		return out
	}
	return Array.isArray(def.default) ? [...def.default] : def.default
}

/**
 * 默认配置（全新对象，每次调用都重新生成）。
 * @returns {object} 配置
 */
export function defaultConfig() {
	const out = {}
	for (const [key, def] of Object.entries(CONFIG_SPEC)) out[key] = defaultOf(def)
	return out
}

/**
 * 规整一个字段值；类型不对就退回默认值。
 * @param {any} value - 传入值
 * @param {any} def - 规格项
 * @returns {any} 规整后的值
 */
function normalizeField(value, def) {
	const fallback = defaultOf(def)
	switch (def.type) {
		case 'boolean':
			return typeof value === 'boolean' ? value : fallback
		case 'string':
			return typeof value === 'string' ? value : fallback
		case 'number': {
			if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
			let number = value
			if (def.integer) number = Math.round(number)
			if (def.min !== undefined) number = Math.max(def.min, number)
			if (def.max !== undefined) number = Math.min(def.max, number)
			return number
		}
		case 'enum':
			return def.values.includes(value) ? value : fallback
		case 'stringArray':
			if (!Array.isArray(value)) return fallback
			return value.filter((item) => typeof item === 'string')
		case 'rules':
			return normalizeRules(value)
		case 'object': {
			const source = (value && typeof value === 'object' && !Array.isArray(value)) ? value : {}
			const out = {}
			for (const [key, child] of Object.entries(def.fields ?? {})) out[key] = normalizeField(source[key], child)
			return out
		}
		default:
			return fallback
	}
}

/**
 * 规整配置：补默认值、夹范围、剔除未知键。
 * @param {unknown} input - 用户配置
 * @returns {object} 规整后的配置
 */
export function normalizeConfig(input) {
	const source = (input && typeof input === 'object' && !Array.isArray(input)) ? input : {}
	const out = {}
	for (const [key, def] of Object.entries(CONFIG_SPEC)) {
		out[key] = normalizeField(source[key], def)
	}
	return out
}

/**
 * 校验配置，返回逐项错误（GUI 用）。
 * @param {unknown} input - 用户配置
 * @returns {{valid: boolean, errors: {path: string, message: string}[]}} 校验结果
 */
export function validateConfig(input) {
	const source = (input && typeof input === 'object' && !Array.isArray(input)) ? input : {}
	const errors = []
	/**
	 * 逐项检查。
	 * @param {any} value - 值
	 * @param {any} def - 规格项
	 * @param {string} prefix - 路径前缀
	 */
	function walk(value, def, prefix) {
		switch (def.type) {
			case 'boolean':
				if (value !== undefined && typeof value !== 'boolean') errors.push({ path: prefix, message: '必须是布尔值' })
				break
			case 'string':
				if (value !== undefined && typeof value !== 'string') errors.push({ path: prefix, message: '必须是字符串' })
				break
			case 'number':
				if (value !== undefined) {
					if (typeof value !== 'number' || !Number.isFinite(value)) errors.push({ path: prefix, message: '必须是数字' })
					else if (def.integer === true && !Number.isInteger(value)) errors.push({ path: prefix, message: '必须是整数' })
					else if (def.min !== undefined && value < def.min) errors.push({ path: prefix, message: `不能小于 ${def.min}` })
					else if (def.max !== undefined && value > def.max) errors.push({ path: prefix, message: `不能大于 ${def.max}` })
				}
				break
			case 'enum':
				if (value !== undefined && !def.values.includes(value)) {
					errors.push({ path: prefix, message: `只能是 ${def.values.join(' / ')}` })
				}
				break
			case 'stringArray':
				if (value !== undefined) {
					if (!Array.isArray(value)) errors.push({ path: prefix, message: '必须是数组' })
					else if (value.some((item) => typeof item !== 'string')) errors.push({ path: prefix, message: '数组元素必须都是字符串' })
				}
				break
			case 'rules':
				if (value !== undefined && (typeof value !== 'object' || value === null || Array.isArray(value))) {
					errors.push({ path: prefix, message: '必须是规则对象' })
				}
				break
			case 'object': {
				if (value !== undefined && (typeof value !== 'object' || value === null || Array.isArray(value))) {
					errors.push({ path: prefix, message: '必须是对象' })
					break
				}
				const source = (value && typeof value === 'object') ? value : {}
				for (const [key, child] of Object.entries(def.fields ?? {})) {
					walk(source[key], child, prefix ? `${prefix}.${key}` : key)
				}
				break
			}
			default:
				break
		}
	}
	for (const [key, def] of Object.entries(CONFIG_SPEC)) walk(source[key], def, key)
	return { valid: errors.length === 0, errors }
}

/**
 * 深合并两个配置对象（后者覆盖前者）。
 * @param {object} base - 基础配置
 * @param {object} patch - 覆盖配置
 * @returns {object} 合并结果
 */
export function mergeConfig(base, patch) {
	const out = (base && typeof base === 'object') ? { ...base } : {}
	const source = (patch && typeof patch === 'object') ? patch : {}
	for (const [key, value] of Object.entries(source)) {
		if (value && typeof value === 'object' && !Array.isArray(value) && out[key] && typeof out[key] === 'object' && !Array.isArray(out[key])) {
			out[key] = mergeConfig(out[key], value)
		} else {
			out[key] = value
		}
	}
	return out
}

/**
 * 读运行时覆盖文件。
 * @param {string} [file] - 覆盖文件路径
 * @param {(path: string) => string} [readFile] - 可注入读取
 * @returns {object} 覆盖内容（读不到就是空对象）
 */
export function loadOverride(file = overrideFile(), readFile) {
	try {
		const read = readFile ?? ((target) => fs.readFileSync(target, 'utf8'))
		const parsed = JSON.parse(read(file))
		return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {}
	} catch {
		return {}
	}
}

/**
 * 写运行时覆盖文件。
 * @param {object} patch - 要保存的覆盖内容
 * @param {string} [file] - 覆盖文件路径
 * @param {(path: string, data: string) => void} [writeFile] - 可注入写入
 * @returns {boolean} 是否写入成功
 */
export function saveOverride(patch, file = overrideFile(), writeFile) {
	try {
		const write = writeFile ?? ((target, data) => fs.writeFileSync(target, data, 'utf8'))
		ensureDir(path.dirname(file))
		write(file, `${JSON.stringify(patch ?? {}, null, 2)}\n`)
		return true
	} catch {
		return false
	}
}

/**
 * 合成最终配置：profile patch < 运行时覆盖。
 * @param {object} [config] - 宿主给的配置
 * @param {object} [options] - 选项
 * @param {string} [options.overrideFile] - 覆盖文件路径
 * @param {boolean} [options.useOverride] - 是否读覆盖文件（默认 true）
 * @param {(path: string) => string} [options.readFile] - 可注入读取
 * @returns {{config: object, override: object}} 最终配置与覆盖内容
 */
export function resolveConfig(config, options = {}) {
	const override = options.useOverride === false ? {} : loadOverride(options.overrideFile ?? overrideFile(), options.readFile)
	return { config: normalizeConfig(mergeConfig(config ?? {}, override)), override }
}

/**
 * 把规格翻译成 schemastery schema。
 * @param {any} z - schemastery 的默认导出
 * @param {object} [spec] - 配置规格
 * @returns {any} schemastery schema
 */
export function buildSchema(z, spec = CONFIG_SPEC) {
	/**
	 * 翻译单个字段。
	 * @param {any} def - 规格项
	 * @returns {any} schema
	 */
	function field(def) {
		switch (def.type) {
			case 'boolean':
				return z.boolean().default(def.default)
			case 'string':
				return z.string().default(def.default)
			case 'number': {
				let schema = z.number().default(def.default)
				if (def.min !== undefined) schema = schema.min(def.min)
				if (def.max !== undefined) schema = schema.max(def.max)
				return schema
			}
			case 'enum':
				return z.union(def.values).default(def.default)
			case 'stringArray':
				return z.array(z.string()).default([...def.default])
			case 'rules':
				return z.dict(z.any()).default({})
			case 'object':
				return z.object(buildFields(def.fields ?? {}))
			default:
				return z.any().default(def.default)
		}
	}
	/**
	 * 翻译一组字段。
	 * @param {object} fields - 字段表
	 * @returns {object} schema 字典
	 */
	function buildFields(fields) {
		const out = {}
		for (const [key, def] of Object.entries(fields)) out[key] = field(def)
		return out
	}
	return z.object(buildFields(spec))
}
