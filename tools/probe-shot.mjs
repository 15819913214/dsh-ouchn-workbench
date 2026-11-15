/**
 * Capture a real simulated paper in the console browser, for the preview and for
 * eyeballing the paper's own layout.
 *
 * Uses `.preview/work` as its run root so it never touches the state the console
 * shows. Usage: node tools/probe-shot.mjs
 */
import http from 'node:http'
import path from 'node:path'
import { mkdirSync, copyFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { WorkbenchService } from '../src/service.js'
import { renderPaper } from '../src/mock.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const packageDir = path.join(here, '..')
const workspace = path.join(packageDir, '..')
const workRoot = path.join(workspace, '.preview', 'work')
mkdirSync(workRoot, { recursive: true })

let service = null
const server = http.createServer((request, response) => {
  const url = new URL(request.url, 'http://localhost')
  if (url.pathname === '/ouch/mock') {
    const paper = service?.paperCache.get(url.searchParams.get('paper') ?? '')
    if (!paper) { response.writeHead(404); response.end('no paper'); return }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end(renderPaper(paper))
    return
  }
  response.writeHead(404)
  response.end('not found')
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port

const ctx = {
  get(name) {
    if (name === 'webServer') return { getOrigin: () => `http://127.0.0.1:${port}`, port }
    if (name === 'workingDirectory') return { defaultDirectory: workRoot }
    return undefined
  },
  effect() {},
  logger: { warn: (message) => console.warn('[warn]', message) },
  tools: { register() {} },
}

service = new WorkbenchService(ctx, {
  packageDir,
  account: process.env.OUCHN_ACCOUNT ?? '',
  password: process.env.OUCHN_PASSWORD ?? '',
})
const exec = { agent: { session: { id: 'shot' } } }

if (!process.env.OUCHN_ACCOUNT || !process.env.OUCHN_PASSWORD) {
  console.error('需要环境变量 OUCHN_ACCOUNT / OUCHN_PASSWORD')
  process.exit(1)
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

try {
  const login = await service.login({}, exec)
  console.log('login:', login.student?.name)
  await service.sync({ courseId: '1246228' }, exec)
  const task = service.state.tasks.find((item) => item.stage === 'FORMATIVE' && item.questionCount > 0)
  console.log('task:', task?.title, task?.questionCount)
  await service.exam({ taskId: task.id }, exec)
  const solved = await service.solve({ taskId: task.id, fill: true }, exec)
  console.log('solve:', { matched: solved.matched, filled: solved.filled, verified: solved.verified?.ok })
  const graded = await service.submit({ taskId: task.id }, exec)
  console.log('submit:', { score: graded.score, total: graded.total, correct: graded.correct, pending: graded.pending })
  await sleep(400)
  const shot = await service.browser.screenshot('paper')
  console.log('shot:', shot.absolute)
  copyFileSync(shot.absolute, path.join(workspace, '.preview', 'paper.png'))
  await service.browser.perform({ action: 'click', selector: '#submit' })
  await sleep(600)
  const dialog = await service.browser.screenshot('paper-dialog')
  copyFileSync(dialog.absolute, path.join(workspace, '.preview', 'paper-dialog.png'))
  console.log('saved preview images')
} catch (error) {
  console.error('FAILED:', error?.stack ?? error)
  process.exitCode = 1
} finally {
  await service?.close({}, exec).catch(() => {})
  await service?.dispose().catch(() => {})
  server.close()
}
