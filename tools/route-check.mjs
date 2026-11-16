/**
 * 后端装配检查：不启动 DSH，用假的 ctx 跑一遍 index.js 的 apply()，
 * 断言面板需要的路由确实注册上了——包括「webServer 比插件晚就绪」这条重启路径。
 *
 * 用法：node tools/route-check.mjs
 */
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(here, '..')

const EXPECT = ['/ouch/state', '/ouch/shot', '/ouch/report', '/ouch/diag', '/ouch/logout', '/ouch/login', '/ouch/auto', '/ouch/push', '/ouch/ui-stamp']

const registered = []
const fakeServer = {
  register(entry) {
    registered.push(entry.path)
    return () => {}
  },
}

// 一开始故意不给 webServer：模拟 DSH 重启时插件先加载、webServer 后就绪。
const serverRef = { value: undefined }
const ctx = {
  logger: { warn: () => {}, info: () => {} },
  effect(factory) {
    const dispose = factory()
    return () => { try { dispose?.() } catch { /* ignore */ } }
  },
  get(name) {
    if (name === 'webServer') return serverRef.value
    return undefined
  },
  inject(_deps, callback) {
    const timer = setTimeout(() => { callback(ctx) }, 30)
    return () => clearTimeout(timer)
  },
  tools: { register: () => () => {} },
}

const { apply } = await import(pathToFileURL(path.join(root, 'index.js')).href)

apply(ctx, {})
await new Promise((resolve) => setTimeout(resolve, 120))
const before = registered.slice()

serverRef.value = fakeServer
await new Promise((resolve) => setTimeout(resolve, 900))
const after = registered.slice()

let failed = 0
function check(name, ok, detail) {
  if (!ok) failed += 1
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
}

check('webServer 未就绪时不注册路由', before.length === 0, `已注册 ${before.length} 条`)
for (const routePath of EXPECT) {
  check(`路由 ${routePath} 在服务就绪后注册`, after.includes(routePath), `共 ${after.length} 条`)
}
check('没有重复注册', new Set(after).size === after.length, `${after.length} 条 / 去重 ${new Set(after).size} 条`)

if (failed) {
  console.error(`${failed} 项路由检查失败`)
  process.exit(1)
}
console.log('全部路由检查通过')
