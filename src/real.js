/**
 * 真实作答引擎：把 live.js 的页面动作接成"一个任务从头到尾"的流水线，并记账。
 *
 * 它刻意不碰 DOM 细节（那是 `live.js` 的事），只做决策：
 *   - 这道题从答案库/人工答案里拿什么；
 *   - 进不去就看看是不是视频前置没完成，先把视频刷了再进；
 *   - 交卷前必须每题都有答案，否则不交（底线）；
 *   - 交完把平台分数、逐题得失、失败原因写回执行台。
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { mapOptions } from './answers.js'
import {
  enterExam, fillExam, postForum, openForum, readCompleteness, readExam, readResult, submitExam, watchVideo,
  inspectHomework,
} from './live.js'

const STAGE_LABEL = { FORMATIVE: '形考', FINAL: '终考', DISCUSSION: '讨论' }

/** 平台题型 → 统一题型。 */
function qtypeOf(subjectType) {
  const value = String(subjectType || '')
  if (value === 'single_selection') return 'single'
  if (value === 'multiple_selection') return 'multiple'
  if (value === 'true_or_false') return 'judge'
  if (value === 'fill_in_blank' || value === 'fill') return 'fill'
  if (value === 'short_answer' || value === 'discussion' || value === 'essay') return 'essay'
  return 'text'
}

export class RealEngine {
  constructor(service) {
    this.service = service
  }

  get state() { return this.service.state }
  get browser() { return this.service.browser }

  /* ---------------------------------------------------------------- *
   * 人工答案：AI 写好的主观题答案与讨论稿
   * ---------------------------------------------------------------- */

  answersFile() {
    return path.join(this.service.baseDir(this.service.lastExec), 'ai-answers.json')
  }

  async loadAnswers() {
    try {
      const raw = await readFile(this.answersFile(), 'utf8')
      const parsed = JSON.parse(raw)
      return parsed && typeof parsed === 'object' ? parsed : {}
    } catch {
      return {}
    }
  }

  async saveAnswers(store) {
    const file = this.answersFile()
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, `${JSON.stringify(store, null, 2)}\n`, 'utf8')
  }

  /** 给某任务的人工答案：`{ "3": "……", "discussion": {...} }`。 */
  aiFor(store, task) {
    const direct = store[task.id]
    if (direct && typeof direct === 'object') return direct
    const byStem = (store.byStem && typeof store.byStem === 'object') ? store.byStem : {}
    return { __byStem: byStem }
  }

  /* ---------------------------------------------------------------- *
   * 记账
   * ---------------------------------------------------------------- */

  real(taskId) {
    const state = this.state
    if (!state.real) state.real = {}
    if (!state.real[taskId]) {
      state.real[taskId] = {
        taskId, phase: 'pending', score: null, total: null, answered: 0, questions: 0,
        note: null, at: null, url: null, blocked: null, attempts: null, watched: null,
      }
    }
    return state.real[taskId]
  }

  defect(task, kind, note) {
    const state = this.state
    if (!state.defects) state.defects = []
    state.defects.push({
      id: `d${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`,
      taskId: task ? task.id : null,
      course: task ? task.courseName : null,
      title: task ? task.title : null,
      kind,
      note: String(note || '').slice(0, 300),
      at: new Date().toISOString(),
    })
    if (state.defects.length > 200) state.defects.splice(0, state.defects.length - 200)
  }

  /* ---------------------------------------------------------------- *
   * 单任务流水线
   * ---------------------------------------------------------------- */

  async runTask(task, options = {}) {
    if (task.stage === 'DISCUSSION') return this.runDiscussion(task, options)
    if (String(task.type) === 'homework') return this.runHomework(task, options)
    if (!Number.isFinite(Number(task.activityId))) {
      this.defect(task, 'task', '任务没有 activityId，无法定位平台活动')
      return { ok: false, note: '任务没有 activityId' }
    }
    return this.runExam(task, options)
  }

  /** 作业类活动（学习记录/学习行为评价/大作业）：先看有没有学生提交入口。 */
  async runHomework(task, options = {}) {
    const record = this.real(task.id)
    record.phase = 'entering'
    record.at = Date.now()
    this.service.bump()
    const page = await inspectHomework(this.browser, task)
    record.url = page.url
    if (page.hasForm && options.answers) {
      record.phase = 'blocked'
      record.note = '作业页有提交表单，但当前版本还没实现文件/附件上传，已记录'
      this.defect(task, 'homework', record.note)
      this.service.bump()
      return { ok: false, phase: 'blocked', note: record.note }
    }
    record.phase = 'blocked'
    record.note = page.teacherOnly
      ? 'homework 类型：教师评阅 100%，学生端无提交入口（我的作业：尚未提交作业）'
      : 'homework 类型：没有找到可提交的表单'
    this.service.bump()
    return { ok: false, phase: 'blocked', note: record.note, submitted: page.submitted }
  }

  async runExam(task, options = {}) {
    const record = this.real(task.id)
    const submit = options.submit !== false
    const store = await this.loadAnswers()
    const ai = options.answers ? { ...options.answers } : this.aiFor(store, task)

    record.phase = 'entering'
    record.at = Date.now()
    this.service.bump()

    let entered = await enterExam(this.browser, task)
    if (!entered.ok && entered.phase === 'blocked') {
      const unlock = await this.tryUnlock(task, entered.reason)
      record.watched = unlock
      if (unlock && unlock.ok) entered = await enterExam(this.browser, task)
    }
    if (!entered.ok && entered.phase === 'submitted') {
      // 已经交过卷：读一下结果页里的分数。
      const result = await readResult(this.browser)
      const score = Number(result.scoreText)
      record.phase = 'submitted'
      record.score = Number.isFinite(score) ? score : null
      record.note = Number.isFinite(score) ? '平台已有作答记录' : '平台已有作答记录（未评分）'
      record.url = result.url
      this.service.bump()
      return { ok: true, phase: 'submitted', score: record.score, note: record.note }
    }
    if (!entered.ok) {
      record.phase = entered.phase === 'blocked' ? 'blocked' : 'failed'
      record.blocked = entered.reason || entered.note || null
      record.note = entered.reason || entered.note || '进入答题页失败'
      record.url = entered.url || null
      this.defect(task, record.phase === 'blocked' ? 'blocked' : 'enter', record.note)
      this.service.bump()
      return { ok: false, phase: record.phase, note: record.note, reason: record.blocked }
    }

    record.phase = 'reading'
    record.url = entered.url
    this.service.bump()
    const paper = await readExam(this.browser)
    record.questions = paper.questions.length
    const plan = []
    const detail = []
    const missing = []
    const library = this.service.answerLibrary.resolveCourse(task.courseName)
    const answers = library ? this.service.answerLibrary.loadCourse(library.slug) : null
    const byStem = ai && ai.__byStem ? ai.__byStem : {}

    for (const question of paper.questions) {
      const type = qtypeOf(question.type)
      const pageOptions = {}
      for (const option of question.options) pageOptions[option.letter] = option.text
      let letters = []
      let text = ''
      let source = null
      let note = null

      if (type === 'single' || type === 'multiple' || type === 'judge') {
        const hit = answers ? answers.find(question.stem) : null
        if (hit) {
          const mapped = mapOptions(hit.record.a, hit.record.o, pageOptions)
          if (!mapped.failed && mapped.letters.length > 0) {
            letters = mapped.letters
            source = `题库·${hit.tier}`
          } else {
            note = mapped.note || '选项映射失败'
          }
        } else {
          note = '题库未覆盖'
        }
        // 题库没命中时，允许人工/AI 直接给字母答案（"C" 或 "A,B,C"）。
        if (letters.length === 0) {
          const own = (ai && ai[String(question.seq)]) || byStem[normalizeKey(question.stem)] || ''
          const picked = (String(own).toUpperCase().match(/[A-F]/g) || []).slice(0, 6)
          if (picked.length > 0) {
            letters = picked
            source = '人工答案'
            note = null
          }
        }
      } else {
        const own = (ai && ai[String(question.seq)]) || byStem[normalizeKey(question.stem)] || ''
        if (own) {
          text = String(own)
          source = '人工答案'
        } else if (answers) {
          const hit = answers.find(question.stem)
          if (hit && (hit.record.q === 'essay' || hit.record.q === 'fill')) {
            text = (hit.record.a || []).join('；')
            source = `题库·${hit.tier}`
          }
        }
        if (!text) note = '缺少主观题答案'
      }

      if (letters.length > 0) plan.push({ seq: question.seq, letters })
      else if (text) plan.push({ seq: question.seq, text })
      else missing.push({ seq: question.seq, type, stem: question.stem.slice(0, 90), note })

      detail.push({
        seq: question.seq, type, stem: question.stem.slice(0, 120), points: question.points,
        letters, textLength: text.length, source, note,
        hasUpload: question.hasUpload,
      })
    }

    record.answered = plan.length
    record.total = paper.questions.length
    if (missing.length > 0) {
      // 有题没答案：把题目交给调用方（agent）去补，绝不交卷。
      record.phase = 'needs-answers'
      record.note = `${missing.length} 道题缺少答案，未交卷`
      record.detail = detail
      record.missing = missing
      this.service.dumpPaper(task, paper)
      this.service.bump()
      return { ok: false, phase: 'needs-answers', missing, detail, total: paper.questions.length, url: paper.url }
    }

    record.phase = 'filling'
    this.service.bump()
    let filled = await fillExam(this.browser, plan)
    let failed = (filled.report || []).filter((item) => !item.ok)

    // 平台的 Angular 组件在每次选择后会重渲染，整卷一次性填容易点到旧节点；
    // 对没填上的题逐题补填一遍再校验。
    for (let round = 0; round < 2 && failed.length > 0; round += 1) {
      const retry = plan.filter((item) => failed.some((bad) => Number(bad.seq) === Number(item.seq)))
      if (retry.length === 0) break
      for (const item of retry) {
        // 一次只填一道：Angular 重渲染后旧节点会失效，逐题评估才能保证真的点上。
        const one = await fillExam(this.browser, [item])
        if ((one.report || []).every((entry) => entry.ok)) {
          failed = failed.filter((bad) => Number(bad.seq) !== Number(item.seq))
        }
      }
    }
    if (failed.length > 0) {
      record.phase = 'fill-failed'
      record.note = `${failed.length} 道题没填进去`
      record.detail = detail
      this.defect(task, 'fill', failed.map((item) => `#${item.seq} ${item.note}`).join('；'))
      this.service.bump()
      return { ok: false, phase: 'fill-failed', failed, detail }
    }

    // 回读校验：逐题必须真的填上；有漏的就按题干顺序定位再补一遍。
    let verify = await readExam(this.browser)
    const isAnswered = (question) => (
      qtypeOf(question.type) === 'single' || qtypeOf(question.type) === 'multiple' || qtypeOf(question.type) === 'judge'
        ? Boolean(question.answeredOption || question.checkedCount > 0)
        : question.textLength > 0
    )
    let unanswered = (verify.questions || []).filter((question) => !isAnswered(question))
    for (let round = 0; round < 2 && unanswered.length > 0; round += 1) {
      const seqs = new Set(unanswered.map((question) => Number(question.seq)))
      const retry = plan.filter((item) => seqs.has(Number(item.seq)))
      if (retry.length === 0) break
      for (const item of retry) await fillExam(this.browser, [item])
      verify = await readExam(this.browser)
      unanswered = (verify.questions || []).filter((question) => !isAnswered(question))
    }
    const filledCount = (verify.questions || []).length - unanswered.length
    record.answered = filledCount
    record.total = verify.questions.length
    if (filledCount < verify.questions.length) {
      record.phase = 'verify-failed'
      record.note = `回读只确认 ${filledCount}/${verify.questions.length} 题`
      record.detail = detail
      this.defect(task, 'verify', record.note)
      this.service.bump()
      return { ok: false, phase: 'verify-failed', detail, note: record.note }
    }
    record.note = `已作答 ${filledCount}/${verify.questions.length} 题`

    if (!submit) {
      record.phase = 'filled'
      record.detail = detail
      this.service.bump()
      return { ok: true, phase: 'filled', filled: filledCount, detail }
    }

    record.phase = 'submitting'
    this.service.bump()
    const submitted = await submitExam(this.browser)
    if (!submitted.ok) {
      record.phase = 'submit-failed'
      record.note = submitted.note
      record.detail = detail
      this.defect(task, 'submit', submitted.note)
      this.service.bump()
      return { ok: false, phase: 'submit-failed', note: submitted.note, detail }
    }
    const result = await readResult(this.browser)
    const score = Number(result.scoreText)
    record.phase = 'submitted'
    record.score = Number.isFinite(score) ? score : null
    record.note = Number.isFinite(score)
      ? `平台判分 ${score}`
      : (result.scoreText === '未评分' ? '已交卷，平台显示未评分' : '已交卷')
    record.url = result.url
    record.detail = detail
    record.perQuestion = result.questions
    record.submittedAt = new Date().toISOString()
    writeBack(record, detail)
    this.service.bump()
    return {
      ok: true, phase: 'submitted', score: record.score, note: record.note,
      answered: filledCount, total: verify.questions.length, detail,
    }
  }

  /** 进不去考试时，看看是不是视频前置没看完，先把视频刷了。 */
  async tryUnlock(task, reason) {
    const prerequisites = await this.readPrerequisites(task)
    if (prerequisites.length === 0) return null
    const done = []
    for (const prerequisite of prerequisites) {
      if (prerequisite.completed) continue
      if (prerequisite.type !== 'online_video') continue
      const watched = await watchVideo(this.browser, {
        courseId: task.courseId,
        activityId: prerequisite.activityId,
      }, { rate: 16, need: 80, maxMs: 240000 })
      done.push({ activityId: prerequisite.activityId, ...watched })
    }
    return done.length ? { ok: done.every((item) => item.ok), items: done, reason } : null
  }

  /** 读某个活动的前置条件（视频/作业等）。 */
  async readPrerequisites(task) {
    const value = await this.browser.evaluate(`fetch(${JSON.stringify(`https://lms.ouchn.cn/api/activities/${task.activityId}`)}, { credentials: 'include' })
      .then((response) => response.json())
      .then((json) => (json && json.prerequisites) || [])
      .catch(() => [])`)
    return (value || []).map((item) => ({
      activityId: String(item.activity_id || ''),
      type: item.activity_type,
      title: item.title,
      completed: Boolean(item.completion_criterion && item.completion_criterion.has_completed),
    })).filter((item) => item.activityId)
  }

  async runDiscussion(task, options = {}) {
    const record = this.real(task.id)
    record.phase = 'entering'
    record.at = Date.now()
    this.service.bump()
    const store = await this.loadAnswers()
    const ai = this.aiFor(store, task)
    const forum = await openForum(this.browser, task)
    record.url = forum.url
    if (!forum.canPost) {
      record.phase = 'blocked'
      record.note = '讨论页没有"发表帖子"按钮（可能已截止或只有教师能发）'
      this.defect(task, 'blocked', record.note)
      this.service.bump()
      return { ok: false, phase: 'blocked', note: record.note }
    }
    // 内容优先级：人工/AI 稿 > 已有同学的答案（复用省时） > 模板。
    const provided = options.content || (ai && (ai.discussion || ai.body)) || ''
    let body = String(provided || '').trim()
    let source = body ? '人工/AI 稿' : ''
    if (!body && Array.isArray(forum.posts) && forum.posts.length > 0) {
      const longest = forum.posts
        .map((post) => String(post).replace(/^[^：:]{0,20}[:：]/, '').trim())
        .sort((left, right) => right.length - left.length)[0] || ''
      body = longest.slice(0, 700)
      source = '复用同学答案'
    }
    if (!body) {
      body = this.service.draftForTask(task)
      source = '模板草稿'
    }
    const title = (options.title || (ai && ai.title) || `关于「${task.title.replace(/^讨论主题[一二三四五六七八九十]+[:：]/, '').slice(0, 18)}」的学习体会`).slice(0, 50)
    const posted = await postForum(this.browser, task, { title, body })
    record.phase = posted.ok ? 'submitted' : 'failed'
    record.note = posted.ok ? `已发帖：${title}（${source}）` : posted.note
    record.posted = posted.ok
    record.source = source
    record.at = Date.now()
    if (!posted.ok) this.defect(task, 'forum', posted.note)
    this.service.bump()
    return { ok: posted.ok, phase: record.phase, note: record.note, title, bodyLength: body.length, source }
  }

  /** 单独刷一个视频任务。 */
  async runVideo(task, options = {}) {
    const record = this.real(task.id)
    record.phase = 'video'
    this.service.bump()
    if (task.type !== 'online_video' && !/视频|音视频/.test(String(task.type))) {
      record.note = '这个任务不是视频，无法用视频流程处理'
      this.service.bump()
      return { ok: false, note: record.note }
    }
    const watched = await watchVideo(this.browser, task, { rate: options.rate, need: options.need, maxMs: options.maxMs })
    record.phase = watched.ok ? 'submitted' : 'failed'
    record.note = watched.ok
      ? `视频完成度 ${watched.after}%（要求 ${watched.need}%）`
      : `视频只到 ${watched.after ?? 0}%（要求 ${watched.need}%）`
    if (!watched.ok) this.defect(task, 'video', record.note)
    this.service.bump()
    return { ok: watched.ok, ...watched, note: record.note }
  }
}

/** 主观题答案按题干归一化后检索时用的键。 */
function normalizeKey(stem) {
  return String(stem || '')
    .replace(/[\s　·，。、；：？！“”‘’（）《》【】,.;:?!"'()<>[\]{}…—–\-_/\\|+*=&^%$#@~`]+/g, '')
    .slice(0, 80)
}

/** 交卷后把主观题的作答摘要写进本地记录，便于回写题库。 */
function writeBack(record, detail) {
  record.sources = detail.reduce((acc, item) => {
    const key = item.source || 'missing'
    acc[key] = (acc[key] || 0) + 1
    return acc
  }, {})
}
