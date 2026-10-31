/**
 * Remote 标记助手：在没有 TypeScript 装饰器的纯 JS 环境里给宿主方法打 typert 标记。
 *
 * 原理（对照 `@deepseek-ai/dsh-typert-protocol` 的实现）：
 * - 协议包的 `Remote(name)` 返回一个 `(method, context) => void` 的装饰器；
 * - 装饰器只做一件事：调用 `context.addInitializer(fn)` 登记初始化函数；
 * - 初始化函数执行时用 `Object.getPrototypeOf(this)` 找到原型，把标记写上去。
 *
 * 所以纯 JS 只需要手搓一个带 `addInitializer` 的 context，再用
 * `Object.create(prototype)` 当 `this` 执行那个初始化函数，等效于装饰器语法。
 * 协议内部使用的描述符键不在它的导出列表里，因此这里不复制常量，
 * 而是直接调用协议包导出的 `Remote`（由宿主半边 `lib/index.js` 注入）。
 *
 * @module dsh-guard-degen/remote
 */

/**
 * 构造一个装饰器可用的最小 context。
 * @param {string} name - 方法名
 * @returns {object} context
 */
function decoratorContext(name) {
	return {
		kind: 'method',
		name,
		static: false,
		private: false,
		access: {
			has: () => true,
			get: () => undefined,
		},
		addInitializer(fn) {
			this.initializer = fn
		},
		initializer: null,
	}
}

/**
 * 给原型上的若干方法打上 Remote 标记。
 *
 * @param {object} prototype - 宿主类原型
 * @param {string[]} methodNames - 方法名列表
 * @param {(name: string) => Function} decorate - Remote 装饰器工厂（协议包导出的 `Remote`）
 * @returns {string[]} 实际打上标记的方法名
 */
export function markRemoteMethods(prototype, methodNames, decorate) {
	if (!prototype || typeof prototype !== 'object') throw new TypeError('markRemoteMethods: 需要一个原型对象')
	if (typeof decorate !== 'function') throw new TypeError('markRemoteMethods: 需要 Remote 装饰器工厂')
	const marked = []
	for (const name of methodNames) {
		const method = prototype[name]
		if (typeof method !== 'function') throw new TypeError(`markRemoteMethods: 原型上找不到方法 ${name}`)
		const context = decoratorContext(name)
		const decorator = decorate(name)
		if (typeof decorator !== 'function') throw new TypeError(`markRemoteMethods: 装饰器工厂对 ${name} 没有返回函数`)
		decorator(method, context)
		if (typeof context.initializer !== 'function') {
			throw new Error(`markRemoteMethods: 方法 ${name} 的装饰器没有登记初始化函数`)
		}
		context.initializer.call(Object.create(prototype))
		marked.push(name)
	}
	return marked
}
