/**
 * Report artifacts for one workbench run: a shareable single-file HTML page and
 * a per-question CSV. Both read the same snapshot the panel renders, so a report
 * can never disagree with what the user just saw.
 */

const esc = (value) => String(value ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')

const STAGE_LABEL = { FORMATIVE: '形考作业', FINAL: '终考作业', DISCUSSION: '讨论题' }
const RUN_STATUS = { idle: '空闲', running: '执行中', ready: '就绪', done: '已完成', failed: '失败' }
const STATUS_LABEL = {
  pending: '未开始',
  generated: '已出卷',
  answered: '已模拟作答',
  submitted: '已提交判分',
  drafted: '草稿已生成',
}

/** Attempt limit as the platform reports it (999 means unlimited). */
function attemptText(task) {
  const limit = task.submitTimes
  if (limit === null || limit === undefined) return '—'
  if (limit >= 999) return '不限'
  const used = Number.isFinite(task.attemptsUsed) ? `${task.attemptsUsed}/` : ''
  return `${used}${limit} 次`
}

/** Task score: our grading when present, else the platform's final score. */
function scoreText(task) {
  if (task.grade) {
    const pending = task.grade.pending ? `（${task.grade.pending} 题待批改）` : ''
    return `${task.grade.score}/${task.grade.total}${pending}`
  }
  if (Number.isFinite(task.finalScore)) return String(task.finalScore)
  if (Number.isFinite(task.bestScore)) return String(task.bestScore)
  return '—'
}

function clock(value) {
  if (!value) return '—'
  const date = typeof value === 'number' ? new Date(value) : new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  const pad = (number) => String(number).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

const CSS = `
:root{--ink:#1f2329;--muted:#646a73;--line:#e5e6eb;--brand:#1f60c4;--soft:#f6f8fb}
*{box-sizing:border-box}
body{margin:0;background:#f3f5f8;color:var(--ink);font:14px/1.7 "Microsoft YaHei",system-ui,sans-serif}
.wrap{max-width:1120px;margin:0 auto;padding:28px 22px 60px}
header{background:#fff;border:1px solid var(--line);border-radius:12px;padding:22px 24px;margin-bottom:16px}
h1{margin:0 0 6px;font-size:20px}
.sub{color:var(--muted);font-size:12.5px}
.badge{display:inline-block;margin-left:8px;padding:2px 9px;border-radius:999px;background:#eefaf2;border:1px solid #bfe3cd;color:#1a6b3c;font-size:11.5px}
.kpis{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:10px;margin:16px 0}
.kpi{background:#fff;border:1px solid var(--line);border-radius:10px;padding:12px 14px}
.kpi b{display:block;font-size:20px;font-variant-numeric:tabular-nums}
.kpi span{color:var(--muted);font-size:11.5px}
section{background:#fff;border:1px solid var(--line);border-radius:12px;padding:6px 0 0;margin-bottom:16px;overflow:hidden}
h2{font-size:14px;margin:14px 20px 10px}
table{width:100%;border-collapse:collapse;font-size:12.5px}
th,td{padding:8px 12px;border-bottom:1px solid #f0f1f4;text-align:left;vertical-align:top}
th{background:var(--soft);color:var(--muted);font-weight:600;font-size:11.5px;white-space:nowrap}
td.num{font-variant-numeric:tabular-nums;white-space:nowrap}
.tag{display:inline-block;padding:1px 7px;border-radius:5px;font-size:11px;border:1px solid var(--line);color:var(--muted)}
.tag.ok{color:#1a6b3c;border-color:#bfe3cd;background:#eefaf2}
.tag.warn{color:#8a5a00;border-color:#f0dcb4;background:#fff8e8}
.tag.err{color:#a8302c;border-color:#f3c9c7;background:#fdf0ef}
details{border-top:1px solid var(--line)}
summary{cursor:pointer;padding:10px 20px;font-size:13px;font-weight:600}
.qtable{margin:0}
.stem{max-width:520px;white-space:pre-wrap}
.ans{font-family:ui-monospace,Consolas,monospace;color:var(--brand);font-weight:600}
footer{color:var(--muted);font-size:11.5px;margin-top:10px;line-height:1.8}
`

/** Single-file HTML report. */
export function buildHtml(state, options = {}) {
  const tasks = state.tasks ?? []
  const results = state.results ?? {}
  const byCourse = new Map()
  for (const task of tasks) {
    if (!byCourse.has(task.courseName)) byCourse.set(task.courseName, [])
    byCourse.get(task.courseName).push(task)
  }
  const answeredTasks = tasks.filter((task) => task.status === 'answered')
  const stats = state.stats ?? {}
  const totalQuestions = tasks.filter((task) => task.stage !== 'DISCUSSION').length
  const discussionCount = tasks.filter((task) => task.stage === 'DISCUSSION').length

  const kpis = [
    ['课程', state.courses?.length ?? 0, '已同步的真实课程'],
    ['任务', tasks.length, `形考 ${tasks.filter((t) => t.stage === 'FORMATIVE').length} · 终考 ${tasks.filter((t) => t.stage === 'FINAL').length} · 讨论 ${discussionCount}`],
    ['模拟作答', answeredTasks.length, `共 ${totalQuestions} 个可出卷任务`],
    ['题目', stats.questions ?? 0, `已填 ${stats.answered ?? 0} 题`],
    ['答案命中', stats.questions ? `${Math.round(((stats.matched ?? 0) / stats.questions) * 100)}%` : '—', `未命中 ${stats.unmatched ?? 0} 题`],
  ]

  const courseRows = (state.courses ?? []).map((course) => {
    const mine = byCourse.get(course.name) ?? []
    const done = mine.filter((task) => task.status === 'answered' || task.status === 'drafted').length
    return `<tr>
      <td>${esc(course.name)}</td>
      <td class="num">${esc(course.code ?? '—')}</td>
      <td class="num">${course.progress ?? 0}%</td>
      <td class="num">${course.counts?.FORMATIVE ?? 0}</td>
      <td class="num">${course.counts?.FINAL ?? 0}</td>
      <td class="num">${course.counts?.DISCUSSION ?? 0}</td>
      <td class="num">${done}/${mine.length}</td>
      <td>${course.library ? `<span class="tag ok">${esc(course.library.key)} · ${course.library.count} 题</span>` : '<span class="tag warn">答案库未覆盖</span>'}</td>
    </tr>`
  }).join('')

  const taskRows = tasks.map((task) => `<tr>
    <td>${esc(task.courseName)}</td>
    <td>${esc(STAGE_LABEL[task.stage] ?? task.stage)}</td>
    <td>${esc(task.title)}</td>
    <td class="num">${task.questionCount ?? '—'}</td>
    <td class="num">${task.totalPoints ?? '—'}</td>
    <td class="num">${esc(attemptText(task))}</td>
    <td>${esc(task.availabilityLabel ?? task.availability)}</td>
    <td>${esc(STATUS_LABEL[task.status] ?? task.status)}</td>
    <td class="num">${esc(scoreText(task))}</td>
    <td class="num">${task.stage === 'DISCUSSION' ? '—' : `${task.answered ?? 0}/${task.total ?? 0}`}</td>
  </tr>`).join('')

  const detailSections = Object.values(results).map((result) => {
    const grade = state.grades?.[result.taskId] ?? null
    const rows = (result.questions ?? []).map((question) => {
      const badge = question.status === 'filled'
        ? '<span class="tag ok">已填</span>'
        : question.status === 'unmatched'
          ? '<span class="tag err">未命中</span>'
          : question.status === 'mapping-failed'
            ? '<span class="tag warn">选项映射失败</span>'
            : `<span class="tag">${esc(question.status)}</span>`
      const item = grade?.perQuestion?.[question.seq]
      const mark = item
        ? item.status === 'correct'
          ? `<span class="tag ok">正确 ${esc(item.score)}</span>`
          : item.status === 'wrong'
            ? '<span class="tag err">错误</span>'
            : item.status === 'pending'
              ? '<span class="tag warn">待批改</span>'
              : '<span class="tag">—</span>'
        : '—'
      return `<tr>
        <td class="num">${question.seq}</td>
        <td>${esc(question.qtype)}</td>
        <td class="stem">${esc(String(question.stem).slice(0, 220))}</td>
        <td class="ans">${esc((question.answer ?? []).join('')) || esc(question.answerText?.slice(0, 60) ?? '')}</td>
        <td>${esc(question.source?.file ? String(question.source.file).split('/').pop() : '—')}</td>
        <td>${esc(question.tier)}${question.score ? ` ${question.score}` : ''}</td>
        <td>${badge}</td>
        <td>${mark}</td>
      </tr>`
    }).join('')
    const verified = result.verified
    const gradeBadge = grade
      ? `<span class="tag ${grade.wrong > 0 ? 'warn' : 'ok'}">判分 ${grade.score}/${grade.total}${grade.pending ? ` · 待批改 ${grade.pending}` : ''}</span>`
      : ''
    return `<details ${result === Object.values(results)[0] ? 'open' : ''}>
      <summary>${esc(result.courseName)} · ${esc(STAGE_LABEL[result.stage] ?? result.stage)} · ${esc(result.title)}
        <span class="tag ok">${result.stats?.filled ?? 0}/${result.stats?.total ?? 0} 已填</span>
        ${verified ? `<span class="tag ${verified.ok ? 'ok' : 'warn'}">回读 ${verified.ok ? '一致' : `不一致 ${verified.bad}`}</span>` : ''}
        ${gradeBadge}
      </summary>
      <table class="qtable">
        <thead><tr><th>#</th><th>题型</th><th>题干</th><th>答案</th><th>来源</th><th>匹配</th><th>状态</th><th>判分</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </details>`
  }).join('')

  const discussionSections = Object.values(state.discussions ?? {}).map((item) => `<details>
    <summary>${esc(item.courseName)} · 讨论 · ${esc(item.topic)} <span class="tag">草稿</span></summary>
    <div style="padding:0 20px 16px;white-space:pre-wrap;color:#3d4450">${esc(item.draft)}</div>
  </details>`).join('')

  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>国开作业执行报告</title><style>${CSS}</style></head>
<body><div class="wrap">
<header>
  <h1>国开作业执行报告 <span class="badge">模拟运行 · 未写入平台</span></h1>
  <div class="sub">
    学生：${esc(state.student?.name ?? '—')}（${esc(state.student?.account ?? '—')}）
    · 学校：${esc(state.student?.school ?? '—')}
    · 生成时间：${clock(options.generatedAt ?? Date.now())}
    · 运行状态：${esc(RUN_STATUS[state.status] ?? state.status)}
  </div>
</header>
<div class="kpis">${kpis.map(([label, value, hint]) => `<div class="kpi"><b>${esc(value)}</b><span>${esc(label)} · ${esc(hint)}</span></div>`).join('')}</div>
<section>
  <h2>课程与阶段</h2>
  <table><thead><tr><th>课程</th><th>课程代码</th><th>平台进度</th><th>形考</th><th>终考</th><th>讨论</th><th>已处理</th><th>答案库</th></tr></thead>
  <tbody>${courseRows || '<tr><td colspan="8">还没有同步课程</td></tr>'}</tbody></table>
</section>
<section>
  <h2>任务清单</h2>
  <table><thead><tr><th>课程</th><th>阶段</th><th>任务</th><th>题数</th><th>总分</th><th>作答次数</th><th>可执行性</th><th>模拟状态</th><th>得分</th><th>进度</th></tr></thead>
  <tbody>${taskRows || '<tr><td colspan="10">还没有任务</td></tr>'}</tbody></table>
</section>
<section>
  <h2>逐题明细</h2>
  ${detailSections || '<div style="padding:0 20px 18px;color:#646a73">还没有执行模拟答题</div>'}
  ${discussionSections}
</section>
<footer>
  说明：本报告来自本地模拟运行。平台的形考/终考/讨论数据为只读同步；题目来自本地答案库，答题与提交都发生在本地模拟试卷上，
  没有向学习平台写入答案、成绩或帖子。<br>
  只读同步需要打开课程页读取作业结构，平台可能因此记录访问与学习进度；本工具不进入考试、不保存草稿、不交卷、不发帖。<br>
  答案库命中率按题干匹配计算；选项顺序在模拟试卷中被打乱，答案通过选项文本映射得到。
</footer>
</div></body></html>`
}

/** Per-question CSV, with a stable header even for an empty run. */
export function buildCsv(state) {
  const header = ['课程', '阶段', '任务', '题号', '题型', '题干', '答案', '来源', '置信度', '状态', '错误码']
  const lines = [header.join(',')]
  for (const result of Object.values(state.results ?? {})) {
    for (const question of result.questions ?? []) {
      lines.push([
        result.courseName,
        STAGE_LABEL[result.stage] ?? result.stage,
        result.title,
        question.seq,
        question.qtype,
        String(question.stem).replace(/\s+/g, ' ').slice(0, 200),
        (question.answer ?? []).join('') || String(question.answerText ?? '').slice(0, 80),
        question.source?.file ? String(question.source.file).split('/').pop() : '',
        question.tier ?? '',
        question.status ?? '',
        question.status === 'unmatched' ? 'E_ANSWER_EMPTY' : question.status === 'mapping-failed' ? 'E_MAPPING' : 'E_FILL',
      ].map(csvCell).join(','))
    }
  }
  return lines.join('\n')
}

function csvCell(value) {
  const text = String(value ?? '')
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}
