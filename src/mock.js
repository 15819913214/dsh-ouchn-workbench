/**
 * Simulated exam papers.
 *
 * The plugin never starts a real attempt: opening a 形考/终考 assessment on the
 * platform creates an attempt record, which is exactly the write the workbench
 * must avoid. A paper is therefore built locally from the course's answer bank
 * and served from the plugin's own route, with the real task's question count,
 * options shuffled, and the same DOM shape a real quiz page uses. The agent then
 * solves that page with the very extract → match → map → fill pipeline that a
 * real quiz page would need.
 */
import { mapOptions } from './answers.js'

const TYPE_LABEL = {
  single: '单选题',
  multiple: '多选题',
  judge: '判断题',
  fill: '填空题',
  essay: '简答题',
}

/** Deterministic PRNG so one task always rebuilds the same paper. */
function mulberry32(seed) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let value = state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }
}

function shuffle(list, random) {
  const copy = list.slice()
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1))
    const temporary = copy[index]
    copy[index] = copy[swap]
    copy[swap] = temporary
  }
  return copy
}

function seedOf(text) {
  let hash = 2166136261
  const value = String(text)
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

/** Chinese numerals for a 20-40 point paper's per-question score. */
function perQuestionScore(totalPoints, count) {
  if (!Number.isFinite(totalPoints) || !Number.isFinite(count) || count <= 0) return null
  return Math.round((totalPoints / count) * 10) / 10
}

const esc = (value) => String(value ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')

/**
 * Build one simulated paper for a task.
 *
 * @param {object} options
 * @param {object} options.task      shaped task (title/questionCount/stage/id)
 * @param {object} options.course    platform course
 * @param {object} options.answers   CourseAnswers for the course
 * @param {string} [options.stage]   stage hint used to prefer matching records
 * @returns {{ paper: object, warning: string|null }}
 */
export function buildPaper({ task, course, answers, stage }) {
  const random = mulberry32(seedOf(`${task.courseId}:${task.id}`))
  const pool = answers.forStage(stage ?? task.stage)
  const wanted = Number.isFinite(task.questionCount) && task.questionCount > 0 ? task.questionCount : Math.min(pool.length, 20)
  const take = Math.min(wanted, pool.length)
  const picked = shuffle(pool, random).slice(0, take)
  const scoreEach = perQuestionScore(task.totalPoints, take)

  const questions = picked.map((record, index) => {
    const qtype = normalizeType(record.q)
    const original = record.o && typeof record.o === 'object' ? record.o : {}
    let options = {}
    if (qtype === 'judge') {
      // Judge rows carry 对/错 or 正确/错误; keep the bank's own wording.
      const texts = Object.values(original)
      options = { A: texts[0] || '对', B: texts[1] || '错' }
    } else if (qtype === 'single' || qtype === 'multiple') {
      const entries = shuffle(Object.entries(original), random)
      entries.forEach(([, text], position) => {
        options[String.fromCharCode(65 + position)] = String(text)
      })
      if (Object.keys(options).length === 0) options = { A: '正确', B: '错误' }
    }
    const mapped = mapOptions(record.a, original, options)
    return {
      seq: index + 1,
      qtype,
      typeLabel: TYPE_LABEL[qtype] ?? '题目',
      stem: record.s,
      options,
      answer: mapped.letters,
      answerText: (record.a || []).join('；'),
      answerFailed: mapped.failed && (qtype === 'single' || qtype === 'multiple' || qtype === 'judge'),
      score: scoreEach,
      source: {
        file: record.f ?? null,
        locator: record.l ?? null,
        stageHint: record.h ?? null,
      },
    }
  })

  const warning = wanted > take
    ? `答案库只有 ${pool.length} 道可用题，试卷按 ${take} 题生成（任务实际 ${wanted} 题）`
    : null

  return {
    paper: {
      id: `paper-${task.id}-${Date.now().toString(36)}`,
      taskId: task.id,
      courseId: task.courseId,
      courseName: course?.name ?? task.courseName ?? '',
      taskTitle: task.title,
      stage: task.stage,
      questionCount: questions.length,
      totalPoints: Number.isFinite(task.totalPoints) ? task.totalPoints : questions.length * (scoreEach ?? 0),
      limitMinutes: Number.isFinite(task.limitMinutes) ? task.limitMinutes : null,
      deadline: task.endTime ?? null,
      createdAt: new Date().toISOString(),
      questions,
      warning,
    },
    warning,
  }
}

function normalizeType(value) {
  const type = String(value ?? '').toLowerCase()
  if (type === 'single' || type === 'multiple' || type === 'judge' || type === 'fill' || type === 'essay') return type
  return 'single'
}

/* ------------------------------------------------------------------ *
 * The served page
 * ------------------------------------------------------------------ */

const CSS = `
:root{--ink:#1f2329;--muted:#646a73;--line:#e5e6eb;--brand:#1f60c4;--brand-soft:#eaf1fd;--warn:#b8621b}
*{box-sizing:border-box}
body{margin:0;background:#f3f5f8;color:var(--ink);font:14px/1.65 "Microsoft YaHei","PingFang SC",system-ui,sans-serif}
header{position:sticky;top:0;z-index:20;display:flex;align-items:center;gap:14px;height:56px;padding:0 20px;background:#fff;border-bottom:1px solid var(--line);box-shadow:0 1px 3px rgba(15,23,42,.05)}
header .brand{display:flex;align-items:center;gap:8px;font-weight:700;color:var(--brand)}
header .brand i{display:block;width:22px;height:22px;border-radius:6px;background:linear-gradient(135deg,#2f74e0,#123a7a)}
header .titles{min-width:0;flex:1}
header .titles b{display:block;font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
header .titles span{display:block;color:var(--muted);font-size:11.5px}
.chip{font-size:11px;padding:3px 9px;border-radius:999px;border:1px solid var(--line);color:var(--muted);white-space:nowrap}
.chip.sim{color:#1a6b3c;border-color:#bfe3cd;background:#eefaf2}
.chip.time{font-variant-numeric:tabular-nums;color:#8a5a00;border-color:#f0dcb4;background:#fff8e8}
.wrap{display:grid;grid-template-columns:minmax(0,1fr) 236px;gap:18px;max-width:1180px;margin:18px auto 60px;padding:0 18px;align-items:start}
.paper{background:#fff;border:1px solid var(--line);border-radius:10px;overflow:hidden}
.paper-head{padding:18px 22px;border-bottom:1px solid var(--line);background:linear-gradient(180deg,#fbfcfe,#fff)}
.paper-head h1{margin:0 0 6px;font-size:17px}
.paper-head p{margin:0;color:var(--muted);font-size:12px}
.paper-head .meta{margin-top:10px;display:flex;gap:16px;flex-wrap:wrap;color:var(--muted);font-size:12px}
.q{padding:18px 22px;border-bottom:1px solid #f0f1f4;scroll-margin-top:72px}
.q:last-child{border-bottom:0}
.q-head{display:flex;align-items:center;gap:8px;margin-bottom:8px}
.q-no{font-weight:700;color:var(--brand)}
.q-type{font-size:11px;color:#fff;background:var(--brand);border-radius:4px;padding:1px 6px}
.q-type.judge{background:#8a5cf5}
.q-type.multiple{background:#0f9d7a}
.q-type.fill,.q-type.essay{background:#c2703a}
.q-score{margin-left:auto;color:var(--muted);font-size:12px}
.q-stem{white-space:pre-wrap;word-break:break-word}
.q-stem img{max-width:100%}
.opts{margin-top:10px;display:flex;flex-direction:column;gap:8px}
.opt{display:flex;gap:10px;align-items:flex-start;padding:9px 12px;border:1px solid var(--line);border-radius:8px;cursor:pointer;background:#fff}
.opt:hover{border-color:#c8d6ee;background:#fafcff}
.opt input{margin-top:3px;accent-color:var(--brand)}
.opt-key{font-weight:700;color:var(--muted);min-width:14px}
.opt.on{border-color:var(--brand);background:var(--brand-soft)}
.blank{width:100%;min-height:40px;padding:10px 12px;border:1px solid var(--line);border-radius:8px;font:inherit;resize:vertical}
.blank.long{min-height:96px}
.side{position:sticky;top:74px;background:#fff;border:1px solid var(--line);border-radius:10px;padding:14px}
.side h3{margin:0 0 10px;font-size:13px}
.side .stat{display:flex;justify-content:space-between;font-size:12px;color:var(--muted);margin-bottom:10px}
.side .stat b{color:var(--ink);font-variant-numeric:tabular-nums}
.card-grid{display:grid;grid-template-columns:repeat(5,1fr);gap:6px}
.card-grid a{display:flex;align-items:center;justify-content:center;height:28px;border-radius:6px;border:1px solid var(--line);color:var(--muted);font-size:12px;text-decoration:none}
.card-grid a.done{background:var(--brand);border-color:var(--brand);color:#fff}
.submit{width:100%;margin-top:14px;height:38px;border:0;border-radius:8px;background:var(--brand);color:#fff;font-weight:600;cursor:pointer}
.submit:hover{background:#17509f}
.note{margin-top:10px;font-size:11px;color:var(--warn);line-height:1.5}
.banner{display:none;margin:0 18px;padding:10px 14px;border-radius:8px;background:#eefaf2;border:1px solid #bfe3cd;color:#1a6b3c;font-size:12.5px}
body[data-ouch-submitted="1"] .banner{display:block}
.grade-banner{display:none;margin:8px 18px 0;padding:10px 14px;border-radius:8px;background:#eef4ff;border:1px solid #c6d7f5;color:#1f4f9c;font-size:12.5px}
.q[data-grade="correct"]{border-left:3px solid #1a9c6b;background:#f6fdf9}
.q[data-grade="wrong"]{border-left:3px solid #d04a45;background:#fff7f7}
.q[data-grade="pending"]{border-left:3px solid #c9a227;background:#fffdf4}
.q-mark{display:none;margin-left:8px;font-size:12px;font-weight:600;white-space:nowrap}
.q[data-grade] .q-mark{display:inline-block}
.q[data-grade="correct"] .q-mark{color:#1a9c6b}
.q[data-grade="wrong"] .q-mark{color:#d04a45}
.q[data-grade="pending"] .q-mark{color:#b58a1a}
.dlg{position:fixed;inset:0;background:rgba(15,23,42,.42);display:none;align-items:center;justify-content:center;z-index:50}
.dlg.on{display:flex}
.dlg-box{width:340px;background:#fff;border-radius:12px;padding:20px;text-align:center}
.dlg-box h4{margin:0 0 8px;font-size:15px}
.dlg-box p{margin:0 0 16px;color:var(--muted);font-size:12.5px}
.dlg-actions{display:flex;gap:10px}
.dlg-actions button{flex:1;height:34px;border-radius:8px;border:1px solid var(--line);background:#fff;cursor:pointer}
.dlg-actions button.primary{background:var(--brand);border-color:var(--brand);color:#fff}
`

const SCRIPT = `
(function () {
  var cards = Array.prototype.slice.call(document.querySelectorAll('.card-grid a'))
  function state() {
    var answered = 0
    document.querySelectorAll('.q').forEach(function (q) {
      var inputs = q.querySelectorAll('input,textarea')
      var filled = false
      inputs.forEach(function (input) {
        if (input.type === 'radio' || input.type === 'checkbox') { if (input.checked) filled = true }
        else if (input.value && input.value.trim()) filled = true
      })
      if (filled) answered += 1
      var card = document.querySelector('.card-grid a[data-target="' + q.dataset.q + '"]')
      if (card) card.classList.toggle('done', filled)
    })
    var counter = document.getElementById('answered')
    if (counter) counter.textContent = String(answered)
    return answered
  }
  document.addEventListener('change', function () { state(); })
  document.addEventListener('input', function () { state(); })
  document.querySelectorAll('.opt').forEach(function (opt) {
    var input = opt.querySelector('input')
    if (!input) return
    input.addEventListener('change', function () {
      if (input.type === 'radio') {
        opt.parentElement.querySelectorAll('.opt').forEach(function (other) { other.classList.remove('on') })
      }
      opt.classList.toggle('on', input.checked)
      state()
    })
  })
  var submit = document.getElementById('submit')
  if (submit) submit.addEventListener('click', function () {
    document.getElementById('dlg').classList.add('on')
  })
  var cancel = document.getElementById('cancel')
  if (cancel) cancel.addEventListener('click', function () { document.getElementById('dlg').classList.remove('on') })
  var confirm = document.getElementById('confirm')
  if (confirm) confirm.addEventListener('click', function () {
    document.getElementById('dlg').classList.remove('on')
    document.body.dataset.ouchSubmitted = '1'
    state()
  })

  // Called by the Host after it grades the paper: mark each question and show
  // the summary. Kept on window so the tool can invoke it with evaluated JSON.
  window.__ouchGrade = function (items, summary) {
    var correct = 0, wrong = 0, pending = 0, earned = 0, total = 0
    ;(items || []).forEach(function (item) {
      var q = document.querySelector('.q[data-q="' + item.seq + '"]')
      if (!q) return
      q.dataset.grade = item.status
      var mark = q.querySelector('.q-mark')
      if (mark) {
        mark.textContent = item.status === 'correct'
          ? '✓ ' + (item.score || 0) + ' 分'
          : item.status === 'wrong' ? '✗ 0 分' : '待批改'
      }
      if (item.status === 'correct') { correct += 1; earned += Number(item.score) || 0 }
      else if (item.status === 'wrong') wrong += 1
      else if (item.status === 'pending') pending += 1
      total += Number(item.max) || 0
    })
    // The Host's summary is authoritative; the sums above only fill gaps.
    var s = summary || {}
    var use = function (given, fallback) { return typeof given === 'number' ? given : fallback }
    var showScore = use(s.score, Math.round(earned * 10) / 10)
    var showTotal = use(s.total, Math.round(total * 10) / 10)
    var banner = document.getElementById('grade')
    if (banner) {
      banner.innerHTML = '判分结果：正确 <b>' + use(s.correct, correct) + '</b> 题 · 错误 <b>' + use(s.wrong, wrong) + '</b> 题'
        + (use(s.pending, pending) ? ' · 待批改 <b>' + use(s.pending, pending) + '</b> 题' : '')
        + ' · 已得 <b>' + showScore + '</b> / ' + showTotal + ' 分'
      banner.style.display = 'block'
    }
    document.body.dataset.ouchSubmitted = '1'
    return true
  }
  state()
})()
`

/** Render a paper as a self-contained exam page. */
export function renderPaper(paper, options = {}) {
  const remaining = paper.questionCount
  const questions = paper.questions.map((question) => {
    const blocks = []
    const keys = Object.keys(question.options || {})
    const typeClass = question.qtype === 'judge' ? 'judge' : question.qtype
    let body = ''
    if (question.qtype === 'single' || question.qtype === 'judge' || question.qtype === 'multiple') {
      const inputType = question.qtype === 'multiple' ? 'checkbox' : 'radio'
      body = `<div class="opts">${keys.map((key) => `
        <label class="opt"><input type="${inputType}" name="q${question.seq}" value="${esc(key)}"><span class="opt-key">${esc(key)}</span><span class="opt-text">${esc(question.options[key])}</span></label>`).join('')}
      </div>`
    } else {
      const long = question.qtype === 'essay' || (question.answerText || '').length > 60
      body = `<textarea class="blank${long ? ' long' : ''}" name="q${question.seq}" placeholder="请在此作答"></textarea>`
    }
    blocks.push(`<section class="q" id="q${question.seq}" data-q="${question.seq}" data-type="${esc(question.qtype)}">
      <div class="q-head">
        <span class="q-no">${question.seq}.</span>
        <span class="q-type ${typeClass}">${esc(question.typeLabel)}</span>
        <span class="q-score">${question.score ? `${question.score} 分` : ''}</span>
        <span class="q-mark"></span>
      </div>
      <div class="q-stem">${esc(question.stem)}</div>
      ${body}
    </section>`)
    return blocks.join('')
  }).join('')

  const nav = paper.questions.map((question) => `<a href="#q${question.seq}" data-target="${question.seq}">${question.seq}</a>`).join('')
  const title = `${paper.courseName} · ${paper.taskTitle}`

  return `<!doctype html>
<html lang="zh-CN"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · 模拟答题</title>
<style>${CSS}</style>
</head><body>
<header>
  <div class="brand"><i></i>国家开放大学 · 模拟答题</div>
  <div class="titles"><b>${esc(paper.taskTitle)}</b><span>${esc(paper.courseName)}</span></div>
  <span class="chip sim">模拟环境 · 不写入平台</span>
  <span class="chip time" id="clock">${paper.limitMinutes ? `限时 ${paper.limitMinutes} 分钟` : '不限时'}</span>
</header>
<div class="banner" id="banner">模拟提交已完成：本次作答只保存在本地执行台，没有向学习平台写入任何答案或成绩。</div>
<div class="grade-banner" id="grade"></div>
<div class="wrap">
  <main class="paper">
    <div class="paper-head">
      <h1>${esc(paper.taskTitle)}</h1>
      <p>${esc(paper.courseName)}${paper.deadline ? ` · 平台截止 ${String(paper.deadline).slice(0, 10)}` : ''}</p>
      <div class="meta">
        <span>题目数量 ${remaining}</span>
        <span>总分 ${paper.totalPoints}</span>
        <span>试卷号 ${esc(paper.id)}</span>
      </div>
    </div>
    ${questions}
  </main>
  <aside class="side">
    <h3>答题卡</h3>
    <div class="stat"><span>已作答</span><span><b id="answered">0</b> / ${remaining}</span></div>
    <div class="card-grid">${nav}</div>
    <button class="submit" id="submit" type="button">提交（模拟）</button>
    <div class="note">提交只改变本地状态，不会调用平台的交卷接口。</div>
  </aside>
</div>
<div class="dlg" id="dlg"><div class="dlg-box">
  <h4>确认提交本次模拟作答？</h4>
  <p>这是本地模拟试卷，提交后执行台会记录作答结果，平台端不受影响。</p>
  <div class="dlg-actions"><button id="cancel" type="button">再检查一下</button><button class="primary" id="confirm" type="button">确认提交</button></div>
</div></div>
<script>${SCRIPT}</script>
</body></html>`
}

/** Read the answers currently marked on a rendered paper. */
export const READ_ANSWERS_SCRIPT = `(() => {
  const result = []
  document.querySelectorAll('.q').forEach((node) => {
    const seq = Number(node.dataset.q)
    const checked = Array.from(node.querySelectorAll('input:checked')).map((input) => input.value).sort()
    const text = Array.from(node.querySelectorAll('textarea')).map((area) => area.value.trim()).filter(Boolean).join('\\n')
    result.push({ seq, qtype: node.dataset.type, letters: checked, text, answered: checked.length > 0 || text.length > 0 })
  })
  return { answered: result.filter((item) => item.answered).length, total: result.length, items: result, submitted: document.body.dataset.ouchSubmitted === '1' }
})()`

/** Extract the questions of a rendered paper (the solver's input). */
export const READ_PAPER_SCRIPT = `(() => {
  const questions = []
  document.querySelectorAll('.q').forEach((node) => {
    const options = {}
    node.querySelectorAll('.opt').forEach((label) => {
      const input = label.querySelector('input')
      const key = input ? input.value : ''
      const text = (label.querySelector('.opt-text') || {}).textContent || ''
      if (key) options[key] = text.trim()
    })
    questions.push({
      seq: Number(node.dataset.q),
      qtype: node.dataset.type,
      stem: ((node.querySelector('.q-stem') || {}).innerText || '').trim(),
      options,
    })
  })
  return { count: questions.length, questions }
})()`

/**
 * Fill a whole paper in one page evaluation.
 *
 * Clicking option by option over CDP costs a round trip per question; a single
 * script does the same work — click only the planned option, dispatch the events
 * the page listens for, and read the control back — and reports what stuck.
 * `plan` items are `{ seq, letters, text }`.
 */
export function fillScript(plan) {
  return `(() => {
    const plan = ${JSON.stringify(plan)}
    const report = []
    for (const item of plan) {
      const root = document.querySelector('[data-q="' + item.seq + '"]')
      if (!root) { report.push({ seq: item.seq, ok: false, note: '页面上没有这道题' }); continue }
      if (item.text) {
        const area = root.querySelector('textarea') || root.querySelector('input[type=text]')
        if (!area) { report.push({ seq: item.seq, ok: false, note: '没有可填写的文本框' }); continue }
        const prototype = area.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
        const setter = Object.getOwnPropertyDescriptor(prototype, 'value').set
        area.focus()
        if (setter) setter.call(area, item.text)
        else area.value = item.text
        area.dispatchEvent(new Event('input', { bubbles: true }))
        area.dispatchEvent(new Event('change', { bubbles: true }))
        report.push({ seq: item.seq, ok: area.value.trim().length > 0, read: String(area.value).slice(0, 30) })
        continue
      }
      let ok = true
      for (const letter of item.letters) {
        const input = root.querySelector('input[value="' + letter + '"]')
        if (!input) { ok = false; continue }
        if (!input.checked) input.click()
        if (!input.checked) ok = false
      }
      const checked = Array.from(root.querySelectorAll('input:checked')).map((input) => input.value).sort()
      report.push({ seq: item.seq, ok, letters: checked })
    }
    return report
  })()`
}
