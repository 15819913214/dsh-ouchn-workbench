/**
 * 离线渲染冒烟：用真实 react-dom/server 渲染执行台的统计面板与登录卡片，
 * 保证「改完前端至少能渲染出东西」，而不是等用户点开插件才发现是白屏。
 *
 * 用法：node tools/render-console.mjs
 */
import { readFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(here, '..')
const source = await readFile(path.join(root, 'client.js'), 'utf8')

// react / react-dom/server 从工作区的 .preview/node_modules 借，避免插件目录里再装一份。
const requireFromPreview = createRequire(path.join(root, '..', '.preview', 'package.json'))
const React = requireFromPreview('react')
const { renderToStaticMarkup } = requireFromPreview('react-dom/server')

let entry = null
const sandbox = {
  window: { __ModuleLoader__: { load(definition) { entry = definition } } },
  location: { href: 'http://127.0.0.1:51627/' },
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
  confirm: () => false,
  console,
  URL,
  Date,
}
sandbox.globalThis = sandbox
sandbox.window.localStorage = sandbox.localStorage
vm.createContext(sandbox)
vm.runInContext(source, sandbox, { filename: 'client.js' })

if (!entry) {
  console.error('FAIL client.js 没有调用 __ModuleLoader__.load')
  process.exit(1)
}

const factory = entry.factory((name) => {
  if (name === 'react') return React
  return requireFromPreview(name)
})
const { __test: T } = factory
if (!T) {
  console.error('FAIL 没有导出 __test')
  process.exit(1)
}

const h = React.createElement
const sampleAgg = {
  courses: 2,
  total: 4,
  ok: 1,
  bad: 1,
  noneed: 2,
  per: [
    {
      course: { id: '1', name: '测试课程 A' },
      ok: 1, bad: 1, noneed: 0,
      items: [
        { task: { id: 't1', title: '形考任务一', stage: 'FORMATIVE', type: 'exam' }, cls: { kind: 'ok', score: 100 } },
        { task: { id: 't2', title: '形考任务二', stage: 'FORMATIVE', type: 'exam' }, cls: { kind: 'bad', reason: '未完成作答（没有作答记录）' } },
      ],
    },
    {
      course: { id: '2', name: '测试课程 B' },
      ok: 0, bad: 0, noneed: 2,
      items: [
        { task: { id: 't3', title: '学习记录', stage: 'FORMATIVE', type: 'homework' }, cls: { kind: 'noneed', reason: '无需做作业' } },
        { task: { id: 't4', title: '课程讨论区', stage: 'DISCUSSION', type: 'page' }, cls: { kind: 'noneed', reason: '无需做作业' } },
      ],
    },
  ],
}

const checks = []
function check(name, fn) {
  try {
    const value = fn()
    checks.push([name, true, value])
  } catch (error) {
    checks.push([name, false, String(error?.message ?? error)])
  }
}

check('StatsPanel 渲染出四个统计项', () => {
  const html = renderToStaticMarkup(h(T.StatsPanel, { agg: sampleAgg, run: { running: false }, current: null, onOpen: () => {} }))
  for (const token of ['作业统计', '科目总数', '作业数量', '正常', '异常', '测试课程 A']) {
    if (!html.includes(token)) throw new Error(`输出里没有「${token}」`)
  }
  return `${html.length} 字节`
})

check('LoginCard 渲染出账号密码输入框', () => {
  const html = renderToStaticMarkup(h(T.LoginCard, { onSubmit: () => {}, busy: false, notice: null }))
  for (const token of ['登录国开学习平台', '学号 / 登录名', '密码', '登录并同步']) {
    if (!html.includes(token)) throw new Error(`输出里没有「${token}」`)
  }
  return `${html.length} 字节`
})

check('taskClass 口径：未完成与分数不够才是异常', () => {
  const cases = [
    [{ type: 'exam' }, null, 'bad'],
    [{ type: 'exam' }, { phase: 'submitted', score: 100 }, 'ok'],
    [{ type: 'exam' }, { phase: 'submitted', score: 59 }, 'bad'],
    [{ type: 'exam' }, { phase: 'submitted', score: null }, 'ok'],
    [{ type: 'homework' }, null, 'noneed'],
    [{ type: 'page' }, null, 'noneed'],
    [{ type: 'exam' }, { phase: 'blocked', note: '平台限制' }, 'bad'],
  ]
  for (const [task, real, want] of cases) {
    const got = T.taskClass(task, real).kind
    if (got !== want) throw new Error(`${JSON.stringify(task)}/${JSON.stringify(real)} 期望 ${want}，实际 ${got}`)
  }
  return `${cases.length} 个用例通过`
})

check('Modal 渲染出标题与内容', () => {
  const html = renderToStaticMarkup(h(T.Modal, { title: '异常作业', subtitle: '共 4 个作业', onClose: () => {} }, h('div', null, '明细内容')))
  for (const token of ['异常作业', '共 4 个作业', '明细内容', '关闭']) {
    if (!html.includes(token)) throw new Error(`输出里没有「${token}」`)
  }
  return `${html.length} 字节`
})

check('Console 首屏不崩且保留关键按钮', () => {
  const t = (key) => ({
    toolOuchn: '国开作业', dashboard: '执行台', refresh: '刷新', back: '返回会话',
    courses: '课程', all: '全部', tasks: '任务', questions: '题目明细', questionsShort: '题目',
    platform: '平台画面', live: '实时', library: '答案库', student: '学生', total: '共',
    questionsUnit: '题', points: '分', deadline: '截止', attempts: '作答次数',
    noCourses: '还没有同步课程', noCoursesHint: '—', noTasks: '没有任务', noTask: '选择一个任务',
    noTaskHint: '—', notServed: '执行台后端没有响应', notServedHint: '—',
    noDiscussion: '—', discussionTitle: '讨论题草稿', discussionHint: '—',
    notStarted: '还没有生成试卷', notStartedHint: '—', paperReady: '已出卷',
    openReport: '查看报告', coverage: '覆盖', uncovered: '未覆盖',
    libraryTotal: '题库条目', libraryCourses: '覆盖课程', filledCount: '已填写',
    coursesUnit: '门', tasksUnit: '个', score: '分数', correct: '对', wrong: '错',
    pendingGrade: '待批改', grade: '判分', filled: '已填',
  })[key] ?? key
  const html = renderToStaticMarkup(h(T.Console, { t, onBack: () => {} }))
  for (const token of ['国开作业', '刷新', '打开日志', '同步 GitHub', '作业统计', '科目总数']) {
    if (!html.includes(token)) throw new Error(`输出里没有「${token}」`)
  }
  return `${html.length} 字节`
})

check('错误边界接住渲染异常并给出恢复入口', () => {
  const t = (key) => (key === 'toolOuchn' ? '国开作业' : key)
  const html = renderToStaticMarkup(h(T.PanelBoundary, null, h('div', null, '正常内容')))
  if (!html.includes('正常内容')) throw new Error('正常子树没有渲染')
  // 服务端渲染不会触发 getDerivedStateFromError，这里直接检查边界类的契约。
  const next = T.PanelBoundary.getDerivedStateFromError(new Error('boom'))
  if (!next || !(next.error instanceof Error)) throw new Error('getDerivedStateFromError 没有返回 error')
  if (typeof T.SafeConsole !== 'function') throw new Error('缺少 SafeConsole 包装')
  const crashed = renderToStaticMarkup(h(T.SafeConsole, { t, onBack: () => {} }))
  if (crashed.length < 100) throw new Error('SafeConsole 渲染结果异常')
  return '正常子树 + 边界契约 + SafeConsole 均在'
})

check('右栏与统计区并列：网格列数与子元素一一对应', () => {
  const source = readFileSync(path.join(root, 'client.js'), 'utf8')
  // 黑屏回归：网格必须正好是 左栏 | 分隔条 | 任务 | 右栏 四列。
  const grid = source.match(/gridTemplateColumns: `\$\{layout\.leftW\}px 6px minmax\(0,1fr\) ([^`]+)`/)
  if (!grid) throw new Error('没找到主网格定义')
  if (grid[1].includes('6px')) throw new Error(`主网格里还留着多余的分隔列：${grid[1]}`)
  const liveSection = source.match(/live platform frame \+ 统计区[\s\S]{0,160}/)
  if (!liveSection) throw new Error('没找到右栏注释锚点')
  if (!/minWidth: 0/.test(liveSection[0])) throw new Error('右栏容器缺少 minWidth: 0，容易被压成 0 宽')
  if (!/position: 'absolute', inset: 0, margin: 'auto'/.test(source)) throw new Error('截图没有使用绝对定位自适应')
  return grid[1]
})

let failed = 0
for (const [name, ok, detail] of checks) {
  if (!ok) failed += 1
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
}
if (failed) {
  console.error(`${failed} 项渲染检查失败`)
  process.exit(1)
}
console.log('全部渲染检查通过')
