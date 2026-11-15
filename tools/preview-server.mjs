/**
 * Visual preview for the workbench console.
 *
 * The desktop GUI requires its launch token, so a separate browser cannot open the
 * real panel. This dev server renders the *actual* client component — same
 * `client.js`, real React, real state snapshot from a run — against the same
 * routes the Host provides, and defines the `--dsw-alias-*` tokens the panel reads.
 *
 * Usage: node tools/preview-server.mjs [--port 4177] [--state PATH] [--shot PATH]
 */
import http from 'node:http'
import path from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const packageDir = path.join(here, '..')
const workspace = path.join(packageDir, '..')
const previewDir = path.join(workspace, '.preview')

const arg = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`)
  return index > -1 && process.argv[index + 1] ? process.argv[index + 1] : fallback
}

const port = Number(arg('port', '4177'))
const statePath = arg('state', path.join(workspace, '.ouch', 'state.json'))
const shotPath = arg('shot', path.join(previewDir, 'paper.png'))
// A run that ended closes its browser, so the saved snapshot says "no frame".
// `--live` renders the console as it looks mid-run, which is what the detail
// image should show. `--demo` swaps the student for a placeholder so a
// screenshot of the panel can be published.
const forceLive = process.argv.includes('--live')
const demo = process.argv.includes('--demo')

const read = (file) => readFileSync(file)
const exists = (file) => existsSync(file)

/** The preview page: React UMD, the real client module, and a Host stand-in. */
const INDEX = `<!doctype html>
<html lang="zh-CN"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>国开作业执行台 · 预览</title>
<style>
  /* The handful of DSH alias tokens the console reads, in the app's dark palette. */
  :root{
    --dsw-alias-bg-base:#17181c;
    --dsw-alias-bg-layer-1:#1e2025;
    --dsw-alias-bg-layer-2:#26282e;
    --dsw-alias-label-primary:#e8eaed;
    --dsw-alias-label-secondary:#9aa0a6;
    --dsw-alias-border-l1:#2c2f36;
    --dsw-alias-border-l2:#3a3e46;
    --dsw-alias-state-success-primary:#47c79a;
    --dsw-alias-state-error-primary:#ef7a7a;
    --dsw-alias-state-idle-primary:#8b9199;
    --dsw-alias-brand-primary:#4d7dff;
    --dsw-font-family:"Segoe UI","Microsoft YaHei",system-ui,sans-serif;
    --dsw-font-family-mono:ui-monospace,"Cascadia Code",Consolas,monospace;
    --dsh-frame-top-clearance:0px;
  }
  html,body{margin:0;height:100%;background:var(--dsw-alias-bg-base);overflow:hidden}
  #root{height:100%}
</style>
</head><body>
<div id="root"></div>
<script>
  window.__ModuleLoader__ = { load(spec){ window.__WB_FACTORY__ = spec.factory } }
  window.require = function (name) {
    if (name === 'react') return window.React
    if (name === 'react-dom') return window.ReactDOM
    throw new Error('preview cannot resolve module: ' + name)
  }
</script>
<script src="/react.js"></script>
<script src="/react-dom.js"></script>
<script src="/client.js"></script>
<script src="/harness.js"></script>
</body></html>`

/** Mount the real component with a minimal stand-in for the DSH client context. */
const HARNESS = `(function () {
  var dict = {}
  var registered = {}
  var ctx = {
    effect: function (fn) { try { fn() } catch (error) { console.error(error) } return function () {} },
    on: function () { return function () {} },
    get: function () { return undefined },
    locale: {
      register: function (ns, dicts) { dict = dicts.zh || dicts.en || {} },
      bind: function () { return function (key) { return dict[key] !== undefined ? dict[key] : key } },
    },
    slots: {
      inject: function (owner, callback) { callback() },
      register: function (spec, component) {
        registered[spec.key || spec.id] = component
        return function () { delete registered[spec.key || spec.id] }
      },
    },
    layout: { selectPanel: function () {} },
    sessions: {},
    uiSession: {},
  }
  var module = window.__WB_FACTORY__(window.require)
  module.apply(ctx)
  var Panel = registered.workbench
  if (!Panel) { document.getElementById('root').textContent = 'panel component not registered'; return }
  window.ReactDOM.createRoot(document.getElementById('root')).render(window.React.createElement(Panel, {}))
})()`

const server = http.createServer((request, response) => {
  const url = new URL(request.url, 'http://localhost')
  const send = (status, type, body) => {
    response.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' })
    response.end(body)
  }
  try {
    if (url.pathname === '/' || url.pathname === '/index.html') return send(200, 'text/html; charset=utf-8', INDEX)
    if (url.pathname === '/harness.js') return send(200, 'text/javascript; charset=utf-8', HARNESS)
    if (url.pathname === '/client.js') return send(200, 'text/javascript; charset=utf-8', read(path.join(packageDir, 'client.js')))
    if (url.pathname === '/react.js') return send(200, 'text/javascript; charset=utf-8', read(path.join(previewDir, 'node_modules/react/umd/react.production.min.js')))
    if (url.pathname === '/react-dom.js') return send(200, 'text/javascript; charset=utf-8', read(path.join(previewDir, 'node_modules/react-dom/umd/react-dom.production.min.js')))
    if (url.pathname === '/ouch/state') {
      if (!exists(statePath)) return send(404, 'application/json', '{"error":"no state"}')
      const snapshot = JSON.parse(readFileSync(statePath, 'utf8'))
      if (forceLive) {
        snapshot.browser = { ...(snapshot.browser ?? {}), open: true, url: 'https://lms.ouchn.cn/course/1246228/ng#/formal-exam', title: '管理学基础 - 广州开放大学' }
        snapshot.shotRev = Math.max(1, snapshot.shotRev ?? 0)
      }
      if (demo && snapshot.student) {
        snapshot.student = { ...snapshot.student, name: '示例学生', account: '2026000000000', school: '示例开放大学' }
      }
      // The real route answers a matching rev with a two-field reply; the preview
      // always sends the snapshot so a refresh shows the current data.
      return send(200, 'application/json; charset=utf-8', JSON.stringify(snapshot))
    }
    if (url.pathname === '/ouch/shot') {
      if (!exists(shotPath)) return send(404, 'text/plain', 'no shot')
      return send(200, 'image/png', read(shotPath))
    }
    return send(404, 'text/plain', 'not found')
  } catch (error) {
    return send(500, 'text/plain', String(error?.stack ?? error))
  }
})

server.listen(port, '127.0.0.1', () => {
  console.log(`preview: http://127.0.0.1:${port}/`)
  console.log(`state  : ${statePath}${exists(statePath) ? '' : ' (missing)'}`)
  console.log(`shot   : ${shotPath}${exists(shotPath) ? '' : ' (missing)'}`)
})
