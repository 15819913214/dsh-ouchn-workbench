/**
 * One Edge/Chrome page driven over CDP.
 *
 * The workbench needs something the runboard tool cannot give it: page values
 * of arbitrary size (a 30-question paper is far past a 500-character note) and
 * a few domain actions such as "check this radio and prove it stuck". This
 * module is therefore a small superset of the runboard page, not a wrapper.
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import net from 'node:net'
import path from 'node:path'
import { Cdp } from './cdp.js'

const VIEWPORT = { width: 1440, height: 900 }
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Resolve a Chromium-family executable, preferring Edge on Windows. */
export function findBrowserExecutable() {
  const candidates = []
  if (process.env.WORKBENCH_BROWSER) candidates.push(process.env.WORKBENCH_BROWSER)
  if (process.env.RUNBOARD_BROWSER) candidates.push(process.env.RUNBOARD_BROWSER)
  const programFiles = process.env.ProgramFiles || 'C:\\Program Files'
  const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)'
  const localAppData = process.env.LOCALAPPDATA || ''
  candidates.push(
    `${programFilesX86}\\Microsoft\\Edge\\Application\\msedge.exe`,
    `${programFiles}\\Microsoft\\Edge\\Application\\msedge.exe`,
    `${programFiles}\\Google\\Chrome\\Application\\chrome.exe`,
    `${programFilesX86}\\Google\\Chrome\\Application\\chrome.exe`,
    `${localAppData}\\Microsoft\\Edge\\Application\\msedge.exe`,
  )
  return candidates.find((candidate) => candidate && existsSync(candidate)) ?? null
}

/** Ask the OS for an unused loopback port. */
function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      server.close(() => resolve(typeof address === 'object' && address ? address.port : 0))
    })
  })
}

/** Poll the DevTools HTTP endpoint until a page target exists. */
async function waitForPageTarget(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let lastError = 'no DevTools endpoint'
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1500) })
      if (response.ok) {
        const targets = await response.json()
        const page = targets.find((target) => target.type === 'page' && typeof target.webSocketDebuggerUrl === 'string')
        if (page) return page
        lastError = 'no page target yet'
      } else {
        lastError = `HTTP ${response.status}`
      }
    } catch (error) {
      lastError = error?.message ?? String(error)
    }
    await sleep(250)
  }
  throw new Error(`浏览器调试端口未就绪（${lastError}）`)
}

const ELEMENT_FINDER = `(target) => {
  if (!target) return null
  if (target.ref) return document.querySelector('[data-wb-ref="' + String(target.ref).replace(/["\\\\]/g, '') + '"]')
  if (target.selector) { try { return document.querySelector(target.selector) } catch (error) { return null } }
  if (target.text) {
    const needle = String(target.text).trim()
    if (!needle) return null
    const candidates = Array.from(document.querySelectorAll('a,button,[role=button],[role=link],[role=tab],input,textarea,select,label,li,span,div'))
    return candidates.find((element) => {
      const label = (element.innerText || element.value || '').trim()
      if (!label.includes(needle)) return false
      const rect = element.getBoundingClientRect()
      return rect.width > 0 && rect.height > 0
    }) || null
  }
  return null
}`

const SNAPSHOT_SCRIPT = (maxChars, maxElements) => `(() => {
  const limit = ${maxElements}
  const visible = (element) => {
    const rect = element.getBoundingClientRect()
    if (rect.width < 1 || rect.height < 1) return false
    const style = getComputedStyle(element)
    if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) === 0) return false
    return rect.bottom > -800 && rect.top < innerHeight + 800
  }
  const label = (element) => ((element.innerText || element.value || element.getAttribute('aria-label') || element.getAttribute('placeholder') || '') + '')
    .replace(/\\s+/g, ' ').trim().slice(0, 100)
  const selector = 'a[href],button,input,textarea,select,[role=button],[role=link],[role=tab],[role=checkbox],summary'
  const nodes = Array.from(document.querySelectorAll(selector)).filter(visible).slice(0, limit)
  let index = 0
  const elements = nodes.map((element) => {
    index += 1
    const ref = 'r' + index
    element.setAttribute('data-wb-ref', ref)
    return {
      ref,
      tag: element.tagName.toLowerCase(),
      type: element.getAttribute('type') || element.getAttribute('role') || '',
      text: label(element),
      name: element.getAttribute('name') || '',
      href: element.tagName === 'A' ? (element.getAttribute('href') || '') : '',
      checked: element.checked === true,
      disabled: element.disabled === true || element.getAttribute('aria-disabled') === 'true',
    }
  })
  const bodyText = (document.body ? document.body.innerText : '') || ''
  return {
    url: location.href,
    title: document.title,
    text: bodyText.replace(/[ \\t]+\\n/g, '\\n').trim().slice(0, ${maxChars}),
    elements,
    scroll: { y: Math.round(scrollY), height: Math.round(document.documentElement.scrollHeight) },
  }
})()`

const KEY_MAP = {
  Enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  Tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  Escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  Space: { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
}

/** One launched browser and its single working page. */
export class BrowserSession {
  constructor(options) {
    this.cdp = options.cdp
    this.child = options.child
    this.port = options.port
    this.profileDir = options.profileDir
    this.shotDir = options.shotDir
    this.closed = false
    this.seq = 0
  }

  /** Launch the browser with the plugin's own profile and attach to its page. */
  static async launch(options = {}) {
    const executable = options.executable || findBrowserExecutable()
    if (!executable) throw new Error('没有找到可用的 Edge / Chrome，可用 WORKBENCH_BROWSER 指定路径。')
    const profileDir = options.profileDir
    const shotDir = options.shotDir
    await mkdir(profileDir, { recursive: true })
    await mkdir(shotDir, { recursive: true })
    const port = await freePort()
    const args = [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--remote-allow-origins=*',
      '--disable-features=Translate,msEdgeSidebarV2,msEdgeCollections',
      '--hide-crash-restore-bubble',
      `--window-size=${VIEWPORT.width},${VIEWPORT.height}`,
      options.url || 'about:blank',
    ]
    if (options.headless) args.unshift('--headless=new')
    const child = spawn(executable, args, { stdio: 'ignore', windowsHide: !options.headless })
    child.on('error', () => { /* surfaced by the readiness poll */ })
    let target
    try {
      target = await waitForPageTarget(port, options.timeoutMs ?? 25000)
    } catch (error) {
      try { child.kill() } catch { /* already gone */ }
      throw error
    }
    const cdp = await Cdp.connect(target.webSocketDebuggerUrl)
    await cdp.call('Page.enable', {}, { timeoutMs: 10000 })
    await cdp.call('Runtime.enable', {}, { timeoutMs: 10000 })
    return new BrowserSession({ cdp, child, port, profileDir, shotDir })
  }

  /** Evaluate an expression and return its full JSON value. */
  async evaluate(expression, timeoutMs = 45000) {
    const result = await this.cdp.call('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
      allowUnsafeEvalBlockedByCSP: true,
    }, { timeoutMs })
    if (result.exceptionDetails) {
      const detail = result.exceptionDetails.exception?.description
        ?? result.exceptionDetails.text
        ?? 'page evaluation failed'
      throw new Error(String(detail).split('\n').slice(0, 3).join(' '))
    }
    return result.result?.value
  }

  /** Current URL and title. */
  async where() {
    return this.evaluate('({ url: location.href, title: document.title })')
  }

  /** Wait for a quiet ready state. */
  async settle(timeoutMs = 8000) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      try {
        const state = await this.evaluate('document.readyState')
        if (state === 'complete' || state === 'interactive') { await sleep(120); return }
      } catch { /* navigation in flight */ }
      await sleep(150)
    }
  }

  /** Navigate, tolerating hash-only SPA routes that fire no load event. */
  async goto(url, timeoutMs = 25000) {
    const target = String(url)
    const result = await this.cdp.call('Page.navigate', { url: target }, { timeoutMs: 20000 })
    if (result.errorText) throw new Error(`打开页面失败：${result.errorText}`)
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      await sleep(200)
      try {
        const state = await this.evaluate('({ href: location.href, ready: document.readyState })')
        if (!state || state.ready !== 'complete') continue
        if (sameDocumentTarget(state.href, target)) break
      } catch { /* navigation may still be in flight */ }
    }
    await this.settle(6000)
    await sleep(300)
    return this.where()
  }

  /** Read the page: text, interactive elements, scroll position. */
  async snapshot(options = {}) {
    const value = await this.evaluate(SNAPSHOT_SCRIPT(options.maxChars ?? 4000, options.maxElements ?? 80))
    if (!value || typeof value !== 'object') throw new Error('页面快照读取失败')
    return value
  }

  /** Execute one step and report what happened. */
  async perform(step) {
    const action = String(step.action || '').toLowerCase()
    if (action === 'goto') {
      if (!step.url) return { ok: false, note: 'goto 需要 url' }
      const where = await this.goto(step.url)
      return { ok: true, note: `已打开 ${where.title || where.url}`, url: where.url }
    }
    if (action === 'reload') {
      await this.cdp.call('Page.reload', { ignoreCache: false })
      await sleep(800)
      await this.settle(10000)
      const where = await this.where()
      return { ok: true, note: '已刷新页面', url: where.url }
    }
    if (action === 'back') {
      const history = await this.cdp.call('Page.getNavigationHistory')
      const index = Number(history.currentIndex ?? 0) - 1
      const entry = (history.entries || [])[index]
      if (!entry) return { ok: false, note: '没有可后退的历史记录' }
      await this.cdp.call('Page.navigateToHistoryEntry', { entryId: entry.id })
      await sleep(700)
      await this.settle(8000)
      return { ok: true, note: `已后退到 ${entry.url}` }
    }
    if (action === 'click' || action === 'check') {
      const target = { ref: step.ref, selector: step.selector, text: step.text }
      const rect = await this.evaluate(`(() => {
        const element = (${ELEMENT_FINDER})(${JSON.stringify(target)})
        if (!element) return null
        const clickable = element.tagName === 'INPUT' ? (element.closest('label') || element) : element
        clickable.scrollIntoView({ block: 'center', inline: 'center' })
        const box = clickable.getBoundingClientRect()
        return { x: box.left + box.width / 2, y: box.top + box.height / 2, width: box.width, height: box.height,
          label: ((clickable.innerText || clickable.value || '') + '').replace(/\\s+/g, ' ').trim().slice(0, 60),
          checked: element.checked === true, tag: element.tagName, type: element.type || '' }
      })()`)
      if (!rect) return { ok: false, note: `没有找到可点击元素：${step.ref || step.selector || step.text || '(未指定)'}` }
      if (action === 'check' && rect.checked && (rect.type === 'radio' || rect.type === 'checkbox')) {
        return { ok: true, note: `已经是选中状态：${rect.label}` }
      }
      if (rect.width < 1 || rect.height < 1) {
        await this.evaluate(`(() => { const element = (${ELEMENT_FINDER})(${JSON.stringify(target)}); if (element) element.click(); return true })()`)
      } else {
        const base = { x: rect.x, y: rect.y, button: 'left', clickCount: 1 }
        await this.cdp.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rect.x, y: rect.y, button: 'none' })
        await this.cdp.call('Input.dispatchMouseEvent', { type: 'mousePressed', ...base })
        await this.cdp.call('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base })
      }
      await sleep(280)
      if (action === 'check') {
        const state = await this.evaluate(`(() => { const element = (${ELEMENT_FINDER})(${JSON.stringify(target)}); return element ? { checked: element.checked === true, label: ((element.closest('label') || element).innerText || '').trim().slice(0,40) } : null })()`)
        if (state && state.checked) return { ok: true, note: `已选中「${state.label || rect.label}」` }
        return { ok: false, note: `点击后未选中：${rect.label || target.selector}` }
      }
      return { ok: true, note: `已点击「${rect.label || step.ref || step.selector || step.text}」` }
    }
    if (action === 'fill') {
      const target = { ref: step.ref, selector: step.selector, text: step.text }
      const value = String(step.value ?? '')
      const result = await this.evaluate(`(() => {
        const element = (${ELEMENT_FINDER})(${JSON.stringify(target)})
        if (!element) return { ok: false, reason: 'not-found' }
        element.focus()
        if (element.isContentEditable) {
          element.textContent = ${JSON.stringify(value)}
          element.dispatchEvent(new InputEvent('input', { bubbles: true, data: ${JSON.stringify(value)} }))
          return { ok: true, note: 'contenteditable', read: String(element.textContent).slice(0, 40) }
        }
        const prototype = element.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
        const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set
        if (setter) setter.call(element, ${JSON.stringify(value)})
        else element.value = ${JSON.stringify(value)}
        element.dispatchEvent(new Event('input', { bubbles: true }))
        element.dispatchEvent(new Event('change', { bubbles: true }))
        return { ok: true, note: 'input', read: String(element.value ?? '').slice(0, 40) }
      })()`)
      if (!result || result.ok !== true) return { ok: false, note: `没有找到可填写元素：${step.ref || step.selector || step.text || '(未指定)'}` }
      return { ok: true, note: `已填写 → ${String(result.read ?? '').slice(0, 30)}` }
    }
    if (action === 'press') {
      const spec = KEY_MAP[step.key || 'Enter']
      if (!spec) return { ok: false, note: `不支持的按键：${step.key}` }
      const body = { key: spec.key, code: spec.code, windowsVirtualKeyCode: spec.keyCode, nativeVirtualKeyCode: spec.keyCode }
      await this.cdp.call('Input.dispatchKeyEvent', { type: 'keyDown', ...body, ...(spec.text ? { text: spec.text } : {}) })
      await this.cdp.call('Input.dispatchKeyEvent', { type: 'keyUp', ...body })
      await sleep(250)
      return { ok: true, note: `已按下 ${step.key || 'Enter'}` }
    }
    if (action === 'scroll') {
      const amount = Number(step.amount ?? 700)
      const delta = String(step.direction || 'down') === 'up' ? -Math.abs(amount) : Math.abs(amount)
      await this.cdp.call('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 700, y: 450, deltaX: 0, deltaY: delta })
      await sleep(250)
      const position = await this.evaluate('Math.round(scrollY)')
      return { ok: true, note: `已滚动，scrollY=${position}` }
    }
    if (action === 'wait') {
      if (step.selector) {
        const deadline = Date.now() + (step.ms ?? 10000)
        while (Date.now() < deadline) {
          if (await this.evaluate(`Boolean(document.querySelector(${JSON.stringify(step.selector)}))`)) return { ok: true, note: `已等到 ${step.selector}` }
          await sleep(250)
        }
        return { ok: false, note: `等待超时：${step.selector}` }
      }
      if (step.text) {
        const deadline = Date.now() + (step.ms ?? 10000)
        while (Date.now() < deadline) {
          if (await this.evaluate(`(document.body ? document.body.innerText : '').includes(${JSON.stringify(step.text)})`)) return { ok: true, note: `已等到「${step.text}」` }
          await sleep(250)
        }
        return { ok: false, note: `等待超时：${step.text}` }
      }
      const waitMs = Math.min(Number(step.ms ?? 1000), 30000)
      await sleep(waitMs)
      return { ok: true, note: `已等待 ${waitMs}ms` }
    }
    if (action === 'eval') {
      if (!step.value) return { ok: false, note: 'eval 需要 value 表达式' }
      const value = await this.evaluate(String(step.value))
      const json = JSON.stringify(value)
      return { ok: true, note: json.length > 400 ? `${json.slice(0, 400)}…（共 ${json.length} 字符，需要完整值请用 ouch_page mode=eval）` : json }
    }
    if (action === 'screenshot') {
      const saved = await this.screenshot(step.note || 'step')
      return { ok: true, note: saved.relative }
    }
    return { ok: false, note: `不支持的动作：${action}` }
  }

  /** Capture a PNG into the plugin's shot directory. */
  async screenshot(label = 'shot') {
    const shot = await this.cdp.call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }, { timeoutMs: 20000 })
    this.seq += 1
    const safe = String(label || 'shot').replace(/[^\w.-]+/g, '-').slice(0, 40) || 'shot'
    const name = `${String(this.seq).padStart(3, '0')}-${safe}.png`
    const absolute = path.join(this.shotDir, name)
    await writeFile(absolute, Buffer.from(shot.data, 'base64'))
    return { absolute, relative: path.basename(absolute) }
  }

  /** Latest viewport as a JPEG data URL, for the panel's live card. */
  async shotDataUrl(quality = 60) {
    const shot = await this.cdp.call('Page.captureScreenshot', {
      format: 'jpeg', quality, captureBeyondViewport: false,
    }, { timeoutMs: 20000 })
    return `data:image/jpeg;base64,${shot.data}`
  }

  /** Close the browser process. */
  async close() {
    if (this.closed) return
    this.closed = true
    try { await this.cdp.call('Browser.close', {}, { timeoutMs: 3000 }) } catch { /* already gone */ }
    try { this.cdp.close() } catch { /* ignore */ }
    const child = this.child
    if (child && child.exitCode === null) {
      try { child.kill() } catch { /* ignore */ }
      await sleep(250)
      if (child.exitCode === null) { try { child.kill('SIGKILL') } catch { /* ignore */ } }
    }
  }
}

/** Compare a reached URL with the requested one, ignoring hash-only differences. */
function sameDocumentTarget(reached, requested) {
  try {
    const a = new URL(reached)
    const b = new URL(requested)
    if (a.origin !== b.origin) return false
    if (b.hash) return a.hash === b.hash && a.pathname === b.pathname
    return a.pathname === b.pathname
  } catch {
    return reached === requested
  }
}
