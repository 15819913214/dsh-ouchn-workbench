/**
 * 黑屏回归：用真实浏览器打开 `.preview/panel-harness.html`，测量右栏截图的真实几何尺寸。
 *
 * 之前的 bug 是主网格留了一列多余的分隔条，右栏被塞进 6px 宽的第 4 列：截图被压成一条
 * 竖线、只剩深色底 → 用户看到"登录进去后黑屏"。这里断言：
 *   1) <img> 真的被渲染；
 *   2) 图片宽度 > 260px（不再是被压成一条）；
 *   3) 图片完整落在容器内（不溢出、不超出容器宽高）；
 *   4) 主网格正好 4 列（左栏 | 分隔条 | 任务 | 右栏）。
 *
 * 用法：node tools/check-live-frame.mjs        （默认 47831 端口，需先跑 serve-preview）
 *      node tools/check-live-frame.mjs 47831
 */
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(here, '..')
const port = Number(process.argv[2]) || 47831
const url = `http://127.0.0.1:${port}/.preview/panel-harness.html`

function findBrowser() {
  const candidates = [
    process.env.WORKBENCH_BROWSER,
    `${process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)'}\\Microsoft\\Edge\\Application\\msedge.exe`,
    `${process.env.ProgramFiles || 'C:\\Program Files'}\\Microsoft\\Edge\\Application\\msedge.exe`,
    `${process.env.ProgramFiles || 'C:\\Program Files'}\\Google\\Chrome\\Application\\chrome.exe`,
    `${process.env.LOCALAPPDATA || ''}\\Microsoft\\Edge\\Application\\msedge.exe`,
  ]
  return candidates.find((item) => item && existsSync(item)) ?? null
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function ensureServer() {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(1500) })
    if (response.ok) return null
  } catch { /* 需要自己起 */ }
  const child = spawn(process.execPath, [path.join(here, 'serve-preview.mjs'), String(port)], { stdio: 'ignore', windowsHide: true })
  await sleep(1200)
  return child
}

async function main() {
  const server = await ensureServer()
  const browser = findBrowser()
  if (!browser) throw new Error('没有找到 Edge/Chrome，可用 WORKBENCH_BROWSER 指定')

  const debugPort = 47900 + Math.floor(Math.random() * 80)
  const profile = path.join(process.env.TEMP || '.', `wb-check-${Date.now()}`)
  const child = spawn(browser, [
    '--headless=new',
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check',
    '--window-size=1440,900',
    url,
  ], { stdio: 'ignore', windowsHide: false })

  try {
    let target = null
    const deadline = Date.now() + 20000
    while (Date.now() < deadline && !target) {
      await sleep(300)
      try {
        const list = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`, { signal: AbortSignal.timeout(1500) })).json()
        target = list.find((item) => item.type === 'page' && item.webSocketDebuggerUrl)
      } catch { /* 还没起 */ }
    }
    if (!target) throw new Error('浏览器调试端口没就绪')

    const ws = new WebSocket(target.webSocketDebuggerUrl)
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = () => reject(new Error('CDP 连接失败')) })
    let seq = 0
    const pending = new Map()
    ws.onmessage = (event) => {
      const message = JSON.parse(event.data)
      const waiter = pending.get(message.id)
      if (!waiter) return
      pending.delete(message.id)
      if (message.error) waiter.reject(new Error(message.error.message))
      else waiter.resolve(message.result)
    }
    const call = (method, params, timeoutMs = 15000) => new Promise((resolve, reject) => {
      seq += 1
      const id = seq
      pending.set(id, { resolve, reject })
      ws.send(JSON.stringify({ id, method, params: params || {} }))
      setTimeout(() => { if (pending.delete(id)) reject(new Error(`${method} 超时`)) }, timeoutMs)
    })
    const evaluate = async (expression) => {
      const result = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || 'evaluate failed')
      return result.result?.value
    }

    await call('Runtime.enable')
    // 等面板把首屏和截图都渲染出来
    const ready = await (async () => {
      const until = Date.now() + 20000
      while (Date.now() < until) {
        const state = await evaluate(`(() => {
          const img = document.querySelector('img')
          return { ready: Boolean(window.__READY__), hasImg: Boolean(img), complete: img ? img.complete : false, h: img ? img.naturalHeight : 0, text: (document.body.innerText || '').slice(0, 60) }
        })()`)
        if (state.ready && state.hasImg && state.complete && state.h > 0) return state
        await sleep(400)
      }
      return null
    })()
    if (!ready) throw new Error('面板没有渲染出截图（可能仍是黑屏）')

    const measure = await evaluate(`(() => {
      const img = document.querySelector('img')
      const wrap = img.parentElement
      const ir = img.getBoundingClientRect()
      const wr = wrap.getBoundingClientRect()
      const grid = document.querySelector('[data-workbench-root] > div:last-child')
      const cols = getComputedStyle(grid).gridTemplateColumns.split(' ').filter(Boolean)
      return {
        img: { w: Math.round(ir.width), h: Math.round(ir.height), x: Math.round(ir.x), y: Math.round(ir.y) },
        wrap: { w: Math.round(wr.width), h: Math.round(wr.height) },
        natural: { w: img.naturalWidth, h: img.naturalHeight },
        objectFit: getComputedStyle(img).objectFit,
        cols,
        colsCount: cols.length,
        statsWidth: Math.round(document.querySelectorAll('[data-workbench-root] section')[4].getBoundingClientRect().width),
      }
    })()`)

    // 窗口收窄后再量一次，验证"调整边框时内部窗口跟着变"
    await call('Emulation.setDeviceMetricsOverride', { width: 1024, height: 720, deviceScaleFactor: 1, mobile: false })
    await sleep(600)
    const narrow = await evaluate(`(() => {
      const img = document.querySelector('img')
      const ir = img.getBoundingClientRect()
      return { w: Math.round(ir.width), h: Math.round(ir.height), wrap: Math.round(img.parentElement.getBoundingClientRect().width) }
    })()`)

    const checks = []
    const check = (name, ok, detail) => checks.push({ name, ok, detail })
    check('截图 <img> 已渲染', measure.img.w > 0 && measure.img.h > 0, `${measure.img.w}×${measure.img.h}`)
    check('截图宽度 > 260px（不再被压成一条）', measure.img.w > 260, `${measure.img.w}px`)
    check('截图完整落在容器内', measure.img.w <= measure.wrap.w + 1 && measure.img.h <= measure.wrap.h + 1,
      `img ${measure.img.w}×${measure.img.h} in wrap ${measure.wrap.w}×${measure.wrap.h}`)
    check('保持长宽比（object-fit: contain 且无拉伸）', Math.abs((measure.img.w / measure.img.h) - (measure.natural.w / measure.natural.h)) < 0.05,
      `${(measure.img.w / measure.img.h).toFixed(3)} vs ${(measure.natural.w / measure.natural.h).toFixed(3)}`)
    check('主网格 4 列（无多余分隔列）', measure.colsCount === 4, measure.cols.join(' | '))
    check('统计区与右栏同宽', Math.abs(measure.statsWidth - measure.wrap.w) < 3, `stats ${measure.statsWidth} vs live ${measure.wrap.w}`)
    check('窗口收窄后截图跟着缩放', narrow.w > 0 && narrow.w !== measure.img.w, `${measure.img.w}px → ${narrow.w}px`)

    let failed = 0
    for (const item of checks) {
      if (!item.ok) failed += 1
      console.log(`${item.ok ? 'OK  ' : 'FAIL'} ${item.name}${item.detail ? ` — ${item.detail}` : ''}`)
    }
    ws.close()
    if (failed) throw new Error(`${failed} 项黑屏回归检查失败`)
    console.log('黑屏回归检查通过')
  } finally {
    // 关掉临时浏览器与静态服务；kill 失败不影响结论（进程可能已自行退出）。
    try { child.kill() } catch { /* ignore */ }
    try { server?.kill() } catch { /* ignore */ }
    // headless 浏览器被杀时可能留下未决的 CDP 请求，静默吞掉。
    process.removeAllListeners('unhandledRejection')
  }
}

main().then(() => {
  process.exit(0)
}).catch((error) => {
  console.error(`FAIL ${error?.message ?? error}`)
  process.exit(1)
})
