/**
 * 客户端 bundle 冒烟测试：不依赖浏览器，检查 `client.js` 能否被模块加载器执行完，
 * 以及是否导出了 `apply`。改完前端先跑这个，能挡掉「页面整个面板消失」这类
 * 顶层引用错误（之前 package.json 带 BOM 导致插件根本不加载，就是同类问题）。
 *
 * 用法：node tools/smoke-client.mjs
 */
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const here = path.dirname(fileURLToPath(import.meta.url))
const file = path.join(here, '..', 'client.js')
const source = await readFile(file, 'utf8')

let entry = null
const sandbox = {
  window: {
    __ModuleLoader__: {
      load(definition) { entry = definition },
    },
  },
  location: { href: 'http://127.0.0.1:55940/' },
  document: {
    createElement: () => ({ style: {}, appendChild() {}, setAttribute() {} }),
    head: { appendChild() {} },
    body: { appendChild() {} },
    querySelector: () => null,
    addEventListener() {},
  },
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  setInterval: () => 0,
  clearInterval() {},
  setTimeout: (fn) => { try { fn() } catch { /* ignore */ } return 0 },
  clearTimeout() {},
  fetch: async () => ({ ok: true, json: async () => ({ ok: true }) }),
  console,
  URL,
  Date,
}
sandbox.globalThis = sandbox

const context = vm.createContext(sandbox)
try {
  vm.runInContext(source, context, { filename: file })
} catch (error) {
  console.error('FAIL 执行 client.js 抛错：', error?.message ?? error)
  process.exit(1)
}
if (!entry || typeof entry.factory !== 'function') {
  console.error('FAIL 没有调用 window.__ModuleLoader__.load({ id, factory })')
  process.exit(1)
}
if (entry.id !== 'dsh-workbench') {
  console.error(`FAIL 模块 id 不对：${entry.id}`)
  process.exit(1)
}

const requireStub = (name) => {
  if (name === 'react') {
    return {
      createElement: () => null,
      useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
      useEffect: () => {},
      useRef: (value) => ({ current: value }),
      useCallback: (fn) => fn,
      useMemo: (fn) => fn(),
      Fragment: 'fragment',
    }
  }
  if (name === 'react/jsx-runtime') return { jsx: () => null, jsxs: () => null, Fragment: 'fragment' }
  return new Proxy({}, { get: () => () => ({}) })
}

let exported
try {
  exported = entry.factory(requireStub)
} catch (error) {
  console.error('FAIL factory 执行失败：', error?.message ?? error)
  process.exit(1)
}
if (typeof exported?.apply !== 'function') {
  console.error('FAIL 导出里没有 apply()')
  process.exit(1)
}
console.log(`OK client.js 可加载：id=${entry.id}, exports=${Object.keys(exported).join(',')}`)
console.log(`OK require 可用：${createRequire(import.meta.url) ? 'node:module 正常' : ''}`)
