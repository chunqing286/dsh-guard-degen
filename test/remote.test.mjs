/**
 * Remote 标记助手测试 —— T11。
 *
 * 这里用假装饰器复刻 `@deepseek-ai/dsh-typert-protocol` 的调用契约
 * （装饰器收到「方法函数 + 上下文」，上下文提供 addInitializer），
 * 真包的一致性由 tools/degen-guard/verify/check-remote.mjs 校验。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { markRemoteMethods } from '../lib/remote.js'

/**
 * 造一个假装饰器，记录它给每个方法登记的初始化函数。
 * @returns {{decorate: Function}} 装饰器
 */
function fakeDecorator() {
	const decorate = (name) => (method, context) => {
		context.addInitializer(function init() {
			const prototype = Object.getPrototypeOf(this)
			const list = prototype.__marks ?? (prototype.__marks = [])
			list.push(name)
		})
	}
	return { decorate }
}

/** 造一个带方法的服务类（每个用例独立，避免标记互相污染）。 */
function makeDemoClass() {
	return class Demo {
		/** 配置。 */
		async getConfig() {
			return {}
		}

		/** 写配置。 */
		async setConfig(patch) {
			return patch
		}
	}
}

test('给每个方法登记并执行初始化函数', () => {
	const Demo = makeDemoClass()
	const { decorate } = fakeDecorator()
	const marked = markRemoteMethods(Demo.prototype, ['getConfig', 'setConfig'], decorate)
	assert.deepEqual(marked, ['getConfig', 'setConfig'])
	assert.deepEqual(Demo.prototype.__marks, ['getConfig', 'setConfig'])
})

test('初始化函数在实例上下文里执行时写到原型上', () => {
	const Demo = makeDemoClass()
	const { decorate } = fakeDecorator()
	markRemoteMethods(Demo.prototype, ['getConfig'], decorate)
	// 模拟宿主：实例创建时再跑一次初始化函数
	const instance = Object.create(Demo.prototype)
	for (const initializer of Demo.prototype.__initializers ?? []) initializer.call(instance)
	assert.deepEqual(Demo.prototype.__marks, ['getConfig'], '标记写在原型上')
})

test('原型上找不到方法时抛错', () => {
	const Demo = makeDemoClass()
	const { decorate } = fakeDecorator()
	assert.throws(() => markRemoteMethods(Demo.prototype, ['nope'], decorate), /找不到方法 nope/)
})

test('装饰器没有登记初始化函数时抛错', () => {
	const Demo = makeDemoClass()
	assert.throws(() => markRemoteMethods(Demo.prototype, ['getConfig'], () => () => {}), /没有登记初始化函数/)
})

test('装饰器不是函数时抛错', () => {
	const Demo = makeDemoClass()
	assert.throws(() => markRemoteMethods(Demo.prototype, ['getConfig'], 'not-a-function'), /装饰器工厂/)
})

test('原型不对时抛错', () => {
	const { decorate } = fakeDecorator()
	assert.throws(() => markRemoteMethods(null, ['getConfig'], decorate), /原型对象/)
})
