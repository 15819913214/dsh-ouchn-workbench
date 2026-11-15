/**
 * End-to-end backend check without the Host: a stand-in for the web server serves
 * the simulated paper, and the service runs the whole flow — login, sync,
 * exam, solve, verify, discussion draft, report, close.
 *
 * Run with: node tools/smoke-e2e.mjs
 */
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { WorkbenchService } from '../src/service.js'
import { renderPaper } from '../src/mock.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const packageDir = path.join(here, '..')
const workspace = path.join(packageDir, '..')

let service = null
let port = 0

const server = http.createServer((request, response) => {
  const url = new URL(request.url, 'http://localhost')
  if (url.pathname === '/ouch/mock') {
    const id = url.searchParams.get('paper') ?? ''
    const paper = service?.paperCache.get(id)
    if (!paper) { response.writeHead(404); response.end('no paper'); return }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end(renderPaper(paper))
    return
  }
  if (url.pathname === '/ouch/state') {
    response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
    response.end(JSON.stringify(service.snapshot()))
    return
  }
  response.writeHead(404)
  response.end('not found')
})

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
port = server.address().port
console.log('stand-in server on', port)

const ctx = {
  get(name) {
    if (name === 'webServer') return { getOrigin: () => `http://127.0.0.1:${port}`, port }
    if (name === 'workingDirectory') return { defaultDirectory: workspace }
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
const exec = { agent: { session: { id: 'smoke' } } }

if (!process.env.OUCHN_ACCOUNT || !process.env.OUCHN_PASSWORD) {
  console.error('需要环境变量 OUCHN_ACCOUNT / OUCHN_PASSWORD（例如 $env:OUCHN_ACCOUNT="学号"）')
  process.exit(1)
}

// Mirror the tool registry's step bookkeeping so the run leaves a real timeline.
for (const method of ['open', 'login', 'sync', 'exam', 'solve', 'submit', 'discussion', 'library', 'report', 'close']) {
  const original = service[method].bind(service)
  service[method] = async (args, runExec) => {
    const step = service.begin(`ouch_${method}`, args ?? {})
    const started = Date.now()
    try {
      const value = await original(args, runExec)
      service.finish(step, value, Date.now() - started)
      return value
    } catch (error) {
      service.fail(step, error, Date.now() - started)
      throw error
    }
  }
}

const check = (label, condition, detail = '') => {
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
  if (!condition) process.exitCode = 1
}

try {
  console.log('\n== login ==')
  const login = await service.login({}, exec)
  console.log('student:', login.student)
  check('登录成功', login.loggedIn === true)
  check('读到学生姓名', Boolean(login.student?.name), login.student?.name)

  console.log('\n== sync ==')
  const t0 = Date.now()
  const sync = await service.sync({}, exec)
  console.log(`sync ${Date.now() - t0}ms`, { courses: sync.courses, tasks: sync.tasks, byAvailability: sync.byAvailability, uncovered: sync.uncovered })
  check('同步到 8 门课程', sync.courses === 8, String(sync.courses))
  check('同步到形考/终考/讨论任务', sync.tasks >= 40, String(sync.tasks))
  check('多数课程答案库有覆盖', sync.courses - (sync.uncovered?.length ?? 0) >= 6, `未覆盖 ${sync.uncovered?.join('、')}`)

  const tasks = service.state.tasks
  const formative = tasks.filter((task) => task.stage === 'FORMATIVE' && task.library && task.questionCount && task.questionCount > 0)
  console.log('可出卷形考任务:', formative.length)
  check('有可出卷的形考任务', formative.length > 0)
  const target = formative.find((task) => task.courseName.includes('管理学基础')) ?? formative[0]
  console.log('target:', target.id, target.courseName, target.title, 'q=', target.questionCount)

  console.log('\n== exam ==')
  const exam = await service.exam({ taskId: target.id }, exec)
  console.log({ paperId: exam.paperId, count: exam.count, url: exam.url, warning: exam.warning })
  check('生成模拟试卷', Boolean(exam.paperId))
  check('题数与任务一致', exam.count === target.questionCount, `${exam.count} vs ${target.questionCount}`)
  check('浏览器打开的是本地模拟页', String(exam.url).includes('/ouch/mock'))

  console.log('\n== solve (fill + verify) ==')
  const t1 = Date.now()
  const solved = await service.solve({ taskId: target.id, fill: true }, exec)
  console.log(`solve ${Date.now() - t1}ms`, {
    total: solved.total, matched: solved.matched, unmatched: solved.unmatched,
    filled: solved.filled, verified: solved.verified, failures: solved.failures,
  })
  check('全部题目匹配到答案', solved.matched === solved.total, `${solved.matched}/${solved.total}`)
  check('全部题目已填写', solved.filled === solved.total, `${solved.filled}/${solved.total}`)
  check('回读一致', solved.verified?.ok === true, JSON.stringify(solved.verified?.problems ?? []))

  const result = service.state.results[target.id]
  const mapping = result.questions.filter((question) => question.tier === 'exact' || question.tier === 'high').length
  check('答案来自答案库（exact/high）', mapping > 0, `${mapping}/${result.questions.length}`)

  console.log('\n== submit (grade) ==')
  const submitted = await service.submit({ taskId: target.id }, exec)
  console.log({
    score: submitted.score, total: submitted.total, correct: submitted.correct,
    wrong: submitted.wrong, pending: submitted.pending, suspect: submitted.suspect,
  })
  check('判分覆盖全部题目', submitted.correct + submitted.wrong + submitted.pending === solved.total,
    `${submitted.correct}+${submitted.wrong}+${submitted.pending} vs ${solved.total}`)
  check('得分不超过总分', submitted.score <= submitted.total, `${submitted.score}/${submitted.total}`)
  check('按题库判分时客观题无错误', submitted.wrong === 0, `错 ${submitted.wrong}`)
  const gradeState = service.state.grades[target.id]
  check('判分写入了逐题结果', Boolean(gradeState?.perQuestion?.[1]), JSON.stringify(Object.keys(gradeState?.perQuestion ?? {}).slice(0, 3)))

  console.log('\n== discussion ==')
  const discussionTask = tasks.find((task) => task.stage === 'DISCUSSION')
  const discussion = await service.discussion({ taskId: discussionTask.id }, exec)
  console.log('topic:', discussion.topic, '| draft chars:', discussion.draft.length)
  check('生成讨论草稿', discussion.draft.length > 80)

  console.log('\n== second task (no fill) ==')
  const second = formative.find((task) => task.id !== target.id)
  if (second) {
    await service.exam({ taskId: second.id }, exec)
    const dry = await service.solve({ taskId: second.id, fill: false }, exec)
    check('只解析不填写时页面保持空白', dry.filled === 0 && dry.matched === dry.total, `${dry.matched}/${dry.total} filled=${dry.filled}`)
  }

  console.log('\n== report ==')
  const report = await service.report({}, exec)
  console.log(report)
  check('生成报告文件', report.html.endsWith('.html') && report.csv.endsWith('.csv'))

  console.log('\n== state ==')
  const summary = service.summary()
  console.log(JSON.stringify(summary, null, 1).slice(0, 1200))

  const snapshot = service.snapshot()
  console.log('\nsnapshot bytes:', JSON.stringify(snapshot).length)
  check('状态里有课程与任务', snapshot.courses.length === 8 && snapshot.tasks.length > 0)
  // The tool wrapper owns step recording; exercise the same mechanism here.
  const step = service.begin('ouch_state', {})
  service.finish(step, service.summary(), 12)
  check('时间线记录了步骤', service.snapshot().timeline.length >= 5, String(service.snapshot().timeline.length))
  check('时间线步骤无错误', service.snapshot().timeline.every((item) => item.state === 'ok'))

  console.log('\n== close ==')
  const closed = await service.close({}, exec)
  check('浏览器已关闭', closed.closed === true)
} catch (error) {
  console.error('\nSMOKE FAILED:', error?.stack ?? error)
  process.exitCode = 1
} finally {
  await service?.dispose().catch(() => {})
  server.close()
}
