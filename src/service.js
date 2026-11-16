/**
 * The workbench backend: one browser, one catalog of real platform courses and
 * activities, and one simulated exam per task.
 *
 * Responsibilities split cleanly:
 *   - `lms.js`  reads the platform (courses, activities) — read-only;
 *   - `answers.js` owns the answer bank and option mapping;
 *   - `mock.js` builds and renders the paper the agent actually answers;
 *   - this file keeps the state the console renders and records every step.
 */
import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { AnswerLibrary, mapOptions } from './answers.js'
import { BrowserSession } from './browser.js'
import { ensureLogin, fetchCourseActivities, fetchCourses } from './lms.js'
import { READ_ANSWERS_SCRIPT, READ_PAPER_SCRIPT, buildPaper, fillScript, renderPaper } from './mock.js'
import { RealEngine } from './real.js'
import { buildCsv, buildHtml } from './report.js'
import { enterExam, openForum, readCompleteness, readExam } from './live.js'

const MAX_TIMELINE = 140
const MAX_TEXT = 200_000
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const STAGE_LABEL = { FORMATIVE: '形考作业', FINAL: '终考作业', DISCUSSION: '讨论题' }

const TOOL_LABEL = {
  ouch_open: '打开平台',
  ouch_page: '读取页面',
  ouch_act: '页面操作',
  ouch_login: '登录平台',
  ouch_sync: '同步课程',
  ouch_exam: '生成模拟试卷',
  ouch_solve: '模拟答题',
  ouch_submit: '提交判分',
  ouch_discussion: '讨论题草稿',
  ouch_real: '真实作答',
  ouch_run: '批量跑作业',
  ouch_library: '答案库',
  ouch_state: '读取状态',
  ouch_report: '生成报告',
  ouch_close: '结束执行',
}

let stepSeq = 0

/**
 * Availability of one activity, mirroring the reference app's stage rules.
 *
 * The platform's `is_open` flag is not reliable on its own (list rows carry it as
 * false for read activities too), so openness is derived from the start/end
 * timestamps the activity model always has.
 */
function availabilityOf(activity) {
  if (activity.submitted) return { availability: 'COMPLETED', label: '已完成' }
  const now = Date.now()
  if (activity.endTime && Date.parse(activity.endTime) < now) return { availability: 'EXPIRED', label: '已截止' }
  if (activity.isClosed) return { availability: 'EXPIRED', label: '已关闭' }
  if (activity.startTime && Date.parse(activity.startTime) > now) return { availability: 'NOT_OPEN', label: '未开放' }
  if (activity.submitTimes === 0) return { availability: 'EXHAUSTED', label: '次数用尽' }
  if (/实践|上传附件|教师评阅|小组作业|虚拟仿真/.test(`${activity.title} ${activity.description ?? ''}`)) {
    return { availability: 'SKIPPED', label: '不支持自动' }
  }
  return { availability: 'ACTIONABLE', label: '可模拟' }
}

/** Everything the console shows about one run, in one plain-JSON object. */
export function emptyState() {
  return {
    rev: 0,
    shotRev: 0,
    status: 'idle',
    phase: null,
    mode: 'simulation',
    student: null,
    browser: { open: false, url: null, title: null, startedAt: null },
    courses: [],
    tasks: [],
    papers: {},
    results: {},
    grades: {},
    discussions: {},
    timeline: [],
    stats: { courses: 0, tasks: 0, papers: 0, questions: 0, answered: 0, matched: 0, unmatched: 0, verified: 0, drafts: 0, graded: 0, correct: 0, wrong: 0, pending: 0, elapsedMs: 0 },
    // 真实写入平台的进度（一个任务一条）与运行中发现的脚本缺陷。
    real: {},
    defects: [],
    realStats: { done: 0, submitted: 0, blocked: 0, failed: 0, needsAnswers: 0, scored: 0, scoreSum: 0 },
    // 一键执行的状态机：running/paused/total/done/current，面板据此显示 暂停/继续/停止。
    run: { running: false, paused: false, startedAt: null, finishedAt: null, total: 0, done: 0, note: null },
    // 逐级热更新：当前科目 → 当前作业 → 当前题号。
    current: null,
    library: { total: 0, courses: 0, builtAt: null },
    report: null,
    startedAt: null,
    finishedAt: null,
    error: null,
  }
}

export class WorkbenchService {
  constructor(ctx, options = {}) {
    this.ctx = ctx
    this.packageDir = options.packageDir
    // `dataDir` lets a user keep the answer bank somewhere stable (for example
    // D:\ouchn-data) instead of inside the plugin package, which an update
    // replaces.
    this.dataDir = options.dataDir ? path.resolve(String(options.dataDir)) : path.join(options.packageDir, 'data')
    this.fallbackWorkDir = options.workDir || process.cwd()
    this.account = String(options.account ?? '').trim()
    this.password = String(options.password ?? '')
    this.headless = options.headless === true

    this.answerLibrary = new AnswerLibrary(this.dataDir)
    this.state = emptyState()
    this.browser = null
    this.realEngine = new RealEngine(this)
    this.paperCache = new Map()
    this.shot = null
    this.saveTimer = null
    this.disposed = false
    this.loaded = false

    // The library is cheap to read and makes the console useful before any run.
    try {
      const stats = this.answerLibrary.stats()
      this.state.library = { total: stats.total, courses: stats.courses, builtAt: stats.builtAt }
    } catch { /* a missing library is reported by ouch_library instead */ }
  }

  /* ---------------------------------------------------------------- *
   * Paths, state, persistence
   * ---------------------------------------------------------------- */

  /** Working directory of the calling session; artifacts land under it. */
  workDir(exec) {
    try {
      const directory = typeof this.ctx.get === 'function' ? this.ctx.get('workingDirectory') : undefined
      const session = exec?.agent?.session
      if (directory && session && typeof directory.get === 'function') return directory.get(session)
      if (directory && typeof directory.defaultDirectory === 'string') return directory.defaultDirectory
    } catch { /* fall through */ }
    return this.fallbackWorkDir
  }

  baseDir(exec) {
    const primary = path.join(this.workDir(exec), '.ouch')
    if (exec) return primary
    // 面板首次轮询（还没有 tool 调用）时没有 session exec：如果宿主 cwd 不是工作区，
    // 退回到插件目录旁边的工作区 .ouch，保证重启后一打开面板就能看到上次的数据。
    try {
      if (existsSync(path.join(primary, 'state.json'))) return primary
      const sibling = path.join(this.packageDir, '..', '.ouch')
      if (existsSync(path.join(sibling, 'state.json'))) return sibling
    } catch { /* fall through */ }
    return primary
  }

  stateFile(exec) {
    return path.join(this.baseDir(exec), 'state.json')
  }

  /** Load a previous console state once, so a page reload keeps its data. */
  async hydrate(exec) {
    if (exec) this.lastExec = exec
    if (this.loaded) return
    this.loaded = true
    try {
      const file = this.stateFile(exec)
      if (!existsSync(file)) return
      const raw = JSON.parse(await readFile(file, 'utf8'))
      if (!raw || typeof raw !== 'object') return
      // A step recorded before hydration (the tool call that triggered it) must
      // survive: it belongs to this process, not to the saved timeline.
      const liveTimeline = this.state.timeline
      this.state = { ...emptyState(), ...raw, browser: { open: false, url: null, title: null, startedAt: null }, shotRev: 0 }
      // The catalog and per-task results survive a restart; the timeline belongs
      // to the process that produced it, and a step left "running" by a crash
      // must not look alive in the new one.
      this.state.timeline = liveTimeline
      if (this.state.status === 'running' && liveTimeline.length === 0) this.state.status = 'idle'
      for (const [id, paper] of Object.entries(raw.papers ?? {})) this.paperCache.set(id, paper)
      this.bump(false)
    } catch { /* a corrupt state file must never block a run */ }
  }

  /** Persist after a quiet moment. */
  scheduleSave(exec) {
    if (this.saveTimer) clearTimeout(this.saveTimer)
    const file = this.stateFile(exec)
    this.stateFileRef = file
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      this.persist(file).catch(() => { /* persistence is best-effort */ })
    }, 500)
    if (this.saveTimer.unref) this.saveTimer.unref()
  }

  /** Write the state atomically. */
  async persist(file) {
    const temp = `${file}.tmp`
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(temp, `${JSON.stringify(this.state)}\n`, 'utf8')
    await rename(temp, file)
  }

  /** Bump the revision the panel polls on, and optionally persist. */
  bump(persist = true, exec) {
    this.state.rev += 1
    if (persist) this.scheduleSave(exec ?? this.lastExec)
  }

  /** Public state for the panel: no browser handle, no image bytes. */
  snapshot() {
    const state = this.state
    const timeline = state.timeline.slice(-MAX_TIMELINE)
    return {
      ...state,
      timeline,
      library: state.library,
      shotRev: state.shotRev,
      browser: { ...state.browser, open: Boolean(this.browser && !this.browser.closed) },
    }
  }

  /** Compact textual status for the model. */
  summary() {
    const state = this.state
    const byStage = { FORMATIVE: 0, FINAL: 0, DISCUSSION: 0 }
    for (const task of state.tasks) byStage[task.stage] = (byStage[task.stage] ?? 0) + 1
    const done = state.tasks.filter((task) => task.status === 'answered').length
    return {
      status: state.status,
      phase: state.phase,
      student: state.student,
      browser: { open: Boolean(this.browser && !this.browser.closed), url: state.browser.url },
      courses: state.courses.length,
      tasks: state.tasks.length,
      stages: byStage,
      papers: Object.keys(state.papers).length,
      answered: done,
      library: state.library,
      stats: state.stats,
      realStats: state.realStats,
      defects: (state.defects || []).length,
      report: state.report,
    }
  }

  /* ---------------------------------------------------------------- *
   * Timeline
   * ---------------------------------------------------------------- */

  begin(tool, args = {}) {
    stepSeq += 1
    const step = {
      id: `s${Date.now().toString(36)}${stepSeq}`,
      at: Date.now(),
      tool,
      label: TOOL_LABEL[tool] ?? tool,
      detail: describeArgs(tool, args),
      state: 'running',
      note: null,
      ms: null,
    }
    this.state.timeline.push(step)
    if (this.state.timeline.length > MAX_TIMELINE) this.state.timeline.splice(0, this.state.timeline.length - MAX_TIMELINE)
    this.state.status = 'running'
    this.state.startedAt = this.state.startedAt ?? new Date().toISOString()
    this.bump()
    return step
  }

  finish(step, value, ms) {
    step.state = 'ok'
    step.ms = ms
    step.note = describeResult(step.tool, value)
    if (this.state.status === 'running') this.state.status = 'ready'
    this.bump()
  }

  fail(step, error, ms) {
    step.state = 'error'
    step.ms = ms
    step.note = String(error?.message ?? error).slice(0, 200)
    this.state.status = 'failed'
    this.state.error = step.note
    this.bump()
  }

  /* ---------------------------------------------------------------- *
   * Browser
   * ---------------------------------------------------------------- */

  async ensureBrowser(exec) {
    if (this.browser && !this.browser.closed) return this.browser
    const base = this.baseDir(exec)
    this.browser = await BrowserSession.launch({
      profileDir: path.join(base, 'profile'),
      shotDir: path.join(base, 'shots'),
      headless: this.headless,
    })
    this.state.browser = { open: true, url: null, title: null, startedAt: new Date().toISOString() }
    this.bump()
    return this.browser
  }

  /** Refresh the panel's live image. */
  async refreshShot() {
    if (!this.browser || this.browser.closed) return
    try {
      this.shot = await this.browser.shotDataUrl()
      const where = await this.browser.where()
      this.state.browser = { open: true, url: where.url, title: where.title, startedAt: this.state.browser.startedAt }
      this.state.shotRev += 1
      this.bump()
    } catch { /* the panel keeps the previous frame */ }
  }

  /** JPEG bytes of the latest frame, for the panel's image route. */
  shotJpeg() {
    if (typeof this.shot !== 'string') return null
    const comma = this.shot.indexOf(',')
    if (comma < 0) return null
    try { return Buffer.from(this.shot.slice(comma + 1), 'base64') } catch { return null }
  }

  /** The browser-visible application origin the mock paper is served from. */
  origin() {
    try {
      const server = typeof this.ctx.get === 'function' ? this.ctx.get('webServer') : undefined
      if (server && typeof server.getOrigin === 'function') return String(server.getOrigin()).replace(/\/$/, '')
      if (server && Number(server.port)) return `http://127.0.0.1:${server.port}`
    } catch { /* fall through */ }
    const fromEnv = process.env.DSH_WEB_URL
    if (typeof fromEnv === 'string' && /^https?:/.test(fromEnv)) return fromEnv.replace(/\/$/, '')
    return 'http://127.0.0.1:54177'
  }

  /* ---------------------------------------------------------------- *
   * Tools
   * ---------------------------------------------------------------- */

  async open(args, exec) {
    await this.hydrate(exec)
    if (args.headless === true) this.headless = true
    await this.ensureBrowser(exec)
    if (args.url) await this.browser.goto(String(args.url))
    const snapshot = await this.browser.snapshot({ maxChars: Number(args.maxChars ?? 1500), maxElements: Number(args.maxElements ?? 60) })
    await this.refreshShot()
    return {
      url: snapshot.url,
      title: snapshot.title,
      text: snapshot.text,
      elements: snapshot.elements,
      hint: '需要完整页面数据用 ouch_page；要登录并同步课程用 ouch_login / ouch_sync。',
    }
  }

  async page(args, exec) {
    await this.hydrate(exec)
    const browser = await this.ensureBrowser(exec)
    if (args.expression) {
      const value = await browser.evaluate(String(args.expression))
      await this.refreshShot()
      const json = JSON.stringify(value)
      const truncated = json && json.length > MAX_TEXT ? `${json.slice(0, MAX_TEXT)}…` : json
      return { kind: 'eval', value: typeof truncated === 'string' ? JSON.parse(JSON.stringify(truncated)) : value, chars: json?.length ?? 0 }
    }
    const snapshot = await browser.snapshot({
      maxChars: Number(args.maxChars ?? 4000),
      maxElements: Number(args.maxElements ?? 80),
    })
    let screenshot = null
    if (args.screenshot === true) screenshot = (await browser.screenshot('page')).relative
    await this.refreshShot()
    return { ...snapshot, screenshot }
  }

  async act(args, exec) {
    await this.hydrate(exec)
    const browser = await this.ensureBrowser(exec)
    const steps = Array.isArray(args.steps) ? args.steps : []
    if (steps.length === 0) throw new Error('ouch_act 需要 steps')
    if (steps.length > 12) throw new Error('一次最多 12 个动作')
    const results = []
    for (const [index, step] of steps.entries()) {
      const outcome = await browser.perform(step).catch((error) => ({ ok: false, note: String(error?.message ?? error) }))
      results.push({ index, action: String(step.action ?? ''), ok: outcome.ok === true, note: String(outcome.note ?? '').slice(0, 400) })
      if (!outcome.ok) break
    }
    await this.refreshShot()
    return { results, url: this.state.browser.url, title: this.state.browser.title }
  }

  async login(args, exec) {
    await this.hydrate(exec)
    const account = String(args.account ?? this.account).trim()
    const password = String(args.password ?? this.password)
    if (!account || !password) throw new Error('没有配置账号密码：在插件配置里填 account / password')
    await this.ensureBrowser(exec)
    this.state.phase = 'login'
    const result = await ensureLogin(this.browser, { account, password })
    if (!result.loggedIn) {
      throw new Error(loginErrorText(result))
    }
    // The LMS shell renders after the redirect; give it a moment before reading
    // the signed-in name, otherwise the profile falls back to the login account.
    await waitUntil(() => this.browser.evaluate('Boolean(document.querySelector(".current-user-name, .user-name"))'), 8000)
    const profile = await this.readProfile()
    this.state.student = profile
    this.state.phase = null
    this.state.status = 'ready'
    await this.refreshShot()
    return { loggedIn: true, student: profile, url: result.url, title: result.title }
  }

  async readProfile() {
    try {
      const value = await this.browser.evaluate(`(() => {
        const text = (selector) => { const node = document.querySelector(selector); return node ? (node.innerText || '').trim() : '' }
        const title = document.title || ''
        const school = (title.split('-').pop() || '').trim()
        return {
          name: text('.current-user-name') || text('.user-name') || text('.profile .header-item'),
          role: text('.user-role'),
          school: /大学|学院/.test(school) ? school : '',
        }
      })()`)
      return {
        name: value?.name || this.account,
        role: value?.role || '学生',
        school: value?.school || '',
        account: this.account,
      }
    } catch {
      return { name: this.account, role: '学生', school: '', account: this.account }
    }
  }

  async sync(args, exec) {
    await this.hydrate(exec)
    await this.ensureBrowser(exec)
    // A hydrated state remembers the student, but a freshly launched browser has
    // no session; verify the login every time instead of trusting saved state.
    const auth = await ensureLogin(this.browser, {
      account: String(args.account ?? this.account).trim(),
      password: String(args.password ?? this.password),
    })
    if (!auth.loggedIn) throw new Error(loginErrorText(auth))
    if (!this.state.student) this.state.student = await this.readProfile()
    this.state.phase = 'sync'
    const list = await fetchCourses(this.browser)
    const only = args.courseId ? String(args.courseId) : null
    const courses = only ? list.courses.filter((course) => String(course.id) === only) : list.courses
    if (courses.length === 0) throw new Error(`没有同步到课程（platform 返回 ${list.courses.length} 门）`)

    const nextCourses = []
    const tasks = []
    // A re-sync must not forget what this console already did with a task: the
    // catalog is rebuilt from the platform, the progress is ours.
    const previous = new Map(this.state.tasks.map((task) => [task.id, task]))
    for (const course of courses) {
      const libraryHit = this.answerLibrary.resolveCourse(course.name)
      const result = await fetchCourseActivities(this.browser, course.href).catch((error) => ({ ok: false, note: String(error?.message ?? error) }))
      const stages = result.stages ?? { FORMATIVE: [], FINAL: [], DISCUSSION: [] }
      const courseTasks = []
      for (const stage of ['FORMATIVE', 'FINAL', 'DISCUSSION']) {
        for (const activity of stages[stage] ?? []) {
          const state = availabilityOf(activity)
          const id = `${course.id}:${activity.id}`
          const earlier = previous.get(id)
          // Progress survives a re-sync even when the earlier task object did not:
          // a solved result, a built paper, or a discussion draft proves this task
          // was already handled.
          const priorResult = this.state.results[id]
          const priorDraft = this.state.discussions[id]
          const priorGrade = this.state.grades[id]
          const priorPaper = earlier?.paperId ? this.state.papers[earlier.paperId] : null
          let status = earlier?.status ?? 'pending'
          let paperId = earlier?.paperId ?? null
          let answered = earlier?.answered ?? 0
          let total = earlier?.total ?? 0
          if (priorResult) {
            if (status === 'pending') status = (priorResult.stats?.filled ?? 0) > 0 ? 'answered' : 'generated'
            paperId = paperId ?? priorResult.paperId ?? null
            answered = answered || (priorResult.stats?.filled ?? 0)
            total = total || (priorResult.stats?.total ?? 0)
          } else if (priorPaper && status === 'pending') {
            status = 'generated'
            total = total || (priorPaper.questionCount ?? 0)
          }
          if (priorDraft && status === 'pending') status = 'drafted'
          let grade = earlier?.grade ?? null
          if (priorGrade) {
            status = 'submitted'
            grade = {
              score: priorGrade.score,
              total: priorGrade.total,
              correct: priorGrade.correct,
              wrong: priorGrade.wrong,
              pending: priorGrade.pending,
              source: priorGrade.source,
            }
          }
          courseTasks.push({
            id,
            activityId: activity.id,
            courseId: course.id,
            courseName: course.name,
            stage,
            stageLabel: STAGE_LABEL[stage],
            title: activity.title,
            type: activity.type,
            questionCount: activity.questionCount,
            totalPoints: activity.totalPoints,
            scorePercentage: activity.scorePercentage,
            submitTimes: activity.submitTimes,
            attemptsUsed: activity.attemptsUsed ?? null,
            finalScore: activity.finalScore ?? null,
            bestScore: activity.bestScore ?? null,
            announceScore: activity.announceScore ?? null,
            limitMinutes: activity.limitMinutes ?? null,
            submitted: activity.submitted,
            startTime: activity.startTime,
            endTime: activity.endTime,
            description: activity.description,
            availability: state.availability,
            availabilityLabel: state.label,
            library: libraryHit ? { key: libraryHit.key, count: libraryHit.count, score: Number(libraryHit.score.toFixed(2)) } : null,
            status,
            paperId,
            answered,
            total,
            grade,
          })
        }
      }
      tasks.push(...courseTasks)
      nextCourses.push({
        id: course.id,
        name: course.name,
        code: course.code,
        term: course.term,
        kind: course.kind,
        progress: course.progress,
        href: course.href,
        url: course.url,
        library: libraryHit ? { key: libraryHit.key, count: libraryHit.count, score: Number(libraryHit.score.toFixed(2)) } : null,
        counts: {
          FORMATIVE: (stages.FORMATIVE ?? []).length,
          FINAL: (stages.FINAL ?? []).length,
          DISCUSSION: (stages.DISCUSSION ?? []).length,
        },
        ok: Boolean(result.ok),
        note: result.note ?? null,
      })
      if (!only) {
        // Live progress while a full sync walks the courses.
        this.state.courses = nextCourses.slice()
        this.bump()
      }
    }

    // A single-course sync refreshes that course only: replacing the whole
    // catalog with one course would hide every other course from the console.
    if (only && this.state.courses.length > 0) {
      const scoped = new Set(nextCourses.map((course) => String(course.id)))
      const mergedCourses = this.state.courses.map((course) => (
        scoped.has(String(course.id))
          ? (nextCourses.find((fresh) => String(fresh.id) === String(course.id)) ?? course)
          : course
      ))
      for (const course of nextCourses) {
        if (!mergedCourses.some((merged) => String(merged.id) === String(course.id))) mergedCourses.push(course)
      }
      const mergedTasks = []
      for (const course of mergedCourses) {
        const fromScope = tasks.filter((task) => String(task.courseId) === String(course.id))
        if (scoped.has(String(course.id))) mergedTasks.push(...fromScope)
        else mergedTasks.push(...this.state.tasks.filter((task) => String(task.courseId) === String(course.id)))
      }
      this.state.courses = mergedCourses
      this.state.tasks = mergedTasks
    } else {
      this.state.courses = nextCourses
      this.state.tasks = tasks
    }
    this.state.stats.courses = this.state.courses.length
    this.state.stats.tasks = this.state.tasks.length
    this.state.phase = null
    this.state.status = 'ready'
    await this.refreshShot()
    const allTasks = this.state.tasks
    const byAvailability = {}
    for (const task of allTasks) byAvailability[task.availability] = (byAvailability[task.availability] ?? 0) + 1
    return {
      courses: nextCourses.length,
      tasks: only ? allTasks.length : tasks.length,
      byAvailability,
      uncovered: nextCourses.filter((course) => !course.library).map((course) => course.name),
      student: this.state.student,
      list: nextCourses.map((course) => ({
        name: course.name,
        counts: course.counts,
        library: course.library,
        progress: course.progress,
      })),
    }
  }

  /* ---------------------------------------------------------------- *
   * 真实写入平台
   * ---------------------------------------------------------------- */

  /** 登录态会过期，批量作答前确认一次。 */
  async ensureLoggedIn() {
    const auth = await ensureLogin(this.browser, { account: this.account, password: this.password })
    if (!auth.loggedIn) throw new Error(loginErrorText(auth))
    if (!this.state.student) this.state.student = await this.readProfile()
    return auth
  }

  /** 把读到的真实试题落到工作目录，供补写主观题答案。 */
  async dumpPaper(task, paper) {
    try {
      const dir = path.join(this.baseDir(this.lastExec), 'papers')
      await mkdir(dir, { recursive: true })
      const file = path.join(dir, `${String(task.id).replace(':', '-')}.json`)
      await writeFile(file, `${JSON.stringify({
        taskId: task.id,
        course: task.courseName,
        title: task.title,
        stage: task.stage,
        url: paper.url,
        questions: (paper.questions || []).map((question) => ({
          seq: question.seq,
          type: question.type,
          points: question.points,
          stem: question.stem,
          options: question.options,
          hasUpload: question.hasUpload,
        })),
        at: new Date().toISOString(),
      }, null, 2)}\n`, 'utf8')
      return file
    } catch {
      return null
    }
  }

  /** 讨论题兜底模板（与 ouch_discussion 共用）。 */
  draftForTask(task) {
    return draftFor(task)
  }

  /** `ouch_real`：一个任务上的细粒度动作。 */
  async realTool(args, exec) {
    await this.hydrate(exec)
    await this.ensureBrowser(exec)
    const action = String(args.action || 'run')
    const task = this.findTask(args.taskId, args.course, args.stage)
    if (action === 'answers') {
      const store = await this.realEngine.loadAnswers()
      // 支持一次写多门任务：{ batch: { "<taskId>": { discussion, title, "1": "…" } } }
      if (args.batch && typeof args.batch === 'object') {
        let saved = 0
        for (const [key, value] of Object.entries(args.batch)) {
          if (!value || typeof value !== 'object') continue
          const previous = store[key] && typeof store[key] === 'object' ? store[key] : {}
          store[key] = { ...previous, ...value }
          saved += 1
        }
        await this.realEngine.saveAnswers(store)
        return { batch: true, tasks: saved, totalTasks: Object.keys(store).length }
      }
      const key = String(task.id)
      const previous = store[key] && typeof store[key] === 'object' ? store[key] : {}
      const answers = args.answers && typeof args.answers === 'object' ? args.answers : {}
      store[key] = { ...previous, ...answers }
      if (args.title) store[key].title = String(args.title)
      if (args.content) store[key].discussion = String(args.content)
      await this.realEngine.saveAnswers(store)
      return { task: briefTask(task), saved: Object.keys(answers).length, keys: Object.keys(store[key]).slice(0, 20) }
    }

    await this.ensureLoggedIn()
    this.state.phase = 'real'
    this.bump()

    if (action === 'open') {
      let value
      if (task.stage === 'DISCUSSION') value = await openForum(this.browser, task)
      else if (String(task.type) === 'online_video') value = await readCompleteness(this.browser, task.courseId, task.activityId)
      else value = await enterExam(this.browser, task)
      await this.refreshShot()
      this.state.phase = null
      this.bump()
      return { task: briefTask(task), action, value }
    }

    if (action === 'read') {
      const entered = await enterExam(this.browser, task)
      if (!entered.ok) {
        this.state.phase = null
        const record = this.realEngine.real(task.id)
        record.phase = entered.phase || 'failed'
        record.blocked = entered.reason || entered.note || null
        record.note = entered.reason || entered.note || null
        this.realEngine.defect(task, 'enter', record.note)
        this.bump()
        return { task: briefTask(task), ok: false, phase: entered.phase, reason: entered.reason, note: entered.note }
      }
      const paper = await readExam(this.browser)
      const file = await this.dumpPaper(task, paper)
      await this.refreshShot()
      this.state.phase = null
      const record = this.realEngine.real(task.id)
      record.phase = 'read'
      record.questions = paper.questions.length
      record.url = paper.url
      this.bump()
      return {
        task: briefTask(task),
        ok: true,
        file,
        count: paper.questions.length,
        questions: paper.questions.map((question) => ({
          seq: question.seq,
          type: question.type,
          points: question.points,
          stem: question.stem,
          options: question.options.map((option) => `${option.letter}. ${option.text}`),
          hasUpload: question.hasUpload,
        })),
      }
    }

    if (action === 'mark') {
      // 人工在平台做完（或在面板外提交）的任务，用它把结果同步进执行台，
      // 避免统计里一直显示「未完成」。
      const record = this.realEngine.real(task.id)
      record.phase = 'submitted'
      record.score = Number.isFinite(Number(args.score)) ? Number(args.score) : null
      record.note = String(args.note || '人工标记为已提交').slice(0, 200)
      record.at = Date.now()
      this.recomputeRealStats()
      this.bump()
      return { task: briefTask(task), ok: true, phase: 'submitted', note: record.note, score: record.score }
    }

    if (action === 'video') {
      const value = await this.realEngine.runVideo(task, args)
      await this.refreshShot()
      this.state.phase = null
      this.recomputeRealStats()
      return { task: briefTask(task), action, ...value }
    }

    if (action === 'discussion') {
      const value = await this.realEngine.runDiscussion(task, args)
      await this.refreshShot()
      this.state.phase = null
      this.recomputeRealStats()
      return { task: briefTask(task), action, ...value }
    }

    const value = await this.realEngine.runTask(task, { ...args, submit: args.submit !== false })
    await this.refreshShot()
    this.state.phase = null
    this.recomputeRealStats()
    return { task: briefTask(task), action: 'run', ...value }
  }

  /**
   * `ouch_run`：按筛选条件连续跑任务。
   *
   * 每跑一个任务就把状态写进 `state.real`，面板轮询一次就能看到进度；遇到
   * blocked / needs-answers 不中断整批，只记录，方便最后一并处理。
   */
  async runBatch(args, exec) {
    await this.hydrate(exec)
    await this.ensureBrowser(exec)
    await this.ensureLoggedIn()
    const course = args.course ? String(args.course) : null
    const stages = args.stages
      ? String(args.stages).split(',').map((item) => item.trim().toUpperCase()).filter(Boolean)
      : (args.stage ? [String(args.stage).toUpperCase()] : ['FORMATIVE', 'FINAL', 'DISCUSSION'])
    const limit = Number(args.limit) > 0 ? Number(args.limit) : Infinity
    const includeSubmitted = args.includeSubmitted === true
    let candidates = this.state.tasks.filter((task) => stages.includes(task.stage))
    if (course) candidates = candidates.filter((task) => task.courseName.includes(course) || String(task.courseId) === course)
    if (Array.isArray(args.taskIds) && args.taskIds.length) {
      const wanted = new Set(args.taskIds.map(String))
      candidates = candidates.filter((task) => wanted.has(String(task.id)) || wanted.has(String(task.activityId)))
    }
    if (!includeSubmitted) {
      candidates = candidates.filter((task) => {
        const real = this.state.real[task.id]
        return !real || !['submitted', 'filled'].includes(real.phase)
      })
    }
    candidates = candidates.slice(0, limit)

    this.state.phase = 'run'
    this.state.mode = 'live'
    const results = []
    let index = 0
    for (const task of candidates) {
      index += 1
      this.state.current = { taskId: task.id, course: task.courseName, title: task.title, index, total: candidates.length }
      const record = this.realEngine.real(task.id)
      record.phase = 'queued'
      this.bump()
      let outcome
      try {
        outcome = await this.realEngine.runTask(task, { ...args, submit: args.submit !== false })
      } catch (error) {
        outcome = { ok: false, phase: 'error', note: String(error?.message ?? error) }
        this.realEngine.defect(task, 'error', outcome.note)
        record.phase = 'error'
        record.note = outcome.note
      }
      results.push({
        id: task.id, course: task.courseName, stage: task.stage, title: task.title,
        ok: outcome.ok === true, phase: outcome.phase ?? record.phase, note: outcome.note ?? record.note ?? '',
        score: outcome.score ?? record.score ?? null,
      })
      this.recomputeRealStats()
      this.bump()
    }
    this.state.current = null
    this.state.phase = null
    await this.refreshShot()
    const summary = {
      ran: results.length,
      submitted: results.filter((item) => item.phase === 'submitted').length,
      needsAnswers: results.filter((item) => item.phase === 'needs-answers').length,
      blocked: results.filter((item) => item.phase === 'blocked').length,
      failed: results.filter((item) => !item.ok && !['needs-answers', 'blocked'].includes(item.phase)).length,
    }
    return { ...summary, results: results.slice(0, 60) }
  }

  recomputeRealStats() {
    const stats = { done: 0, submitted: 0, blocked: 0, failed: 0, needsAnswers: 0, scored: 0, scoreSum: 0 }
    for (const record of Object.values(this.state.real || {})) {
      if (record.phase === 'submitted') {
        stats.done += 1
        stats.submitted += 1
        if (Number.isFinite(record.score)) { stats.scored += 1; stats.scoreSum += record.score }
      } else if (record.phase === 'blocked') stats.blocked += 1
      else if (record.phase === 'needs-answers') stats.needsAnswers += 1
      else if (['failed', 'error', 'submit-failed', 'fill-failed', 'verify-failed'].includes(record.phase)) stats.failed += 1
    }
    this.state.realStats = stats
  }

  /* ---------------------------------------------------------------- *
   * 账号：退出 / 登录
   * ---------------------------------------------------------------- */

  /**
   * 退出当前账号：清掉浏览器 Cookie 与会话数据，回到平台登录页，并把界面数据清空。
   *
   * 只清本插件自己的状态，不动用户在平台上的任何记录。
   */
  async logout() {
    const browser = this.browser
    if (browser && !browser.closed) {
      try {
        await browser.cdp.call('Network.enable', {}, { timeoutMs: 5000 })
        await browser.cdp.call('Network.clearBrowserCookies', {}, { timeoutMs: 5000 })
      } catch { /* 老版本 CDP 没有 Network 域时忽略 */ }
      try { await browser.goto('https://lms.ouchn.cn/user/courses') } catch { /* 跳转失败也继续清状态 */ }
    }
    // 清界面数据，但保留答案库与缺陷记录（那是本地的，不属于账号）。
    const keep = {
      library: this.state.library,
      defects: this.state.defects,
      papers: {},
    }
    this.state = { ...emptyState(), library: keep.library, defects: keep.defects }
    this.state.status = 'idle'
    this.paperCache.clear()
    this.shot = null
    this.state.shotRev += 1
    this.account = ''
    this.password = ''
    this.bump()
    await this.refreshShot()
    return { ok: true, student: null }
  }

  /**
   * 用面板上输入的账号密码登录，然后同步该学生的课程与任务。
   *
   * 登录态只活在这个浏览器会话里；面板刷新不会丢，DSH 重启会重新要求登录。
   */
  async loginWith(account, password, exec) {
    const user = String(account ?? '').trim()
    const pass = String(password ?? '')
    if (!user || !pass) throw new Error('账号或密码为空')
    this.account = user
    this.password = pass
    await this.hydrate(exec)
    await this.ensureBrowser(exec)
    this.state.phase = 'login'
    this.bump()
    let result
    try {
      result = await this.ensureLoggedIn()
    } finally {
      this.state.phase = null
    }
    this.state.student = await this.readProfile()
    this.bump()
    // 登录成功后顺手同步一次，面板立刻有数据。
    const sync = await this.sync({}, exec).catch((error) => ({ ok: false, error: String(error?.message ?? error) }))
    await this.refreshShot()
    return {
      ok: true,
      student: this.state.student,
      url: result?.url ?? this.state.browser.url,
      courses: Array.isArray(sync?.list) ? sync.list.length : this.state.courses.length,
      tasks: this.state.tasks.length,
      syncError: sync?.ok === false ? sync.error : null,
    }
  }

  /* ---------------------------------------------------------------- *
   * 一键执行：开始 / 暂停 / 继续 / 停止
   * ---------------------------------------------------------------- */

  /** 可自动执行的任务：排除已完成、无需做（homework/page）的任务。 */
  autoCandidates() {
    return this.state.tasks.filter((task) => {
      const real = this.state.real[task.id]
      if (real && real.phase === 'submitted') return false
      const type = String(task.type || '')
      if (type === 'homework' || type === 'page') return false
      if (task.availability === 'EXPIRED' || task.availability === 'NOT_OPEN') return false
      return true
    })
  }

  autoState() {
    return this.state.run ?? { running: false, paused: false, total: 0, done: 0 }
  }

  /** 一键执行是否处于「暂停」——长任务里的填题循环靠它让步。 */
  isPaused() {
    const run = this.state.run
    return Boolean(run && run.running && run.paused)
  }

  /** 开始一键执行（后台跑，面板轮询状态）。 */
  async startAuto(args = {}, exec) {
    await this.hydrate(exec)
    if (this.autoState().running) return { ok: true, already: true, ...this.autoState() }
    await this.ensureBrowser(exec)
    await this.ensureLoggedIn()
    if (!this.state.student) this.state.student = await this.readProfile()
    const tasks = args.taskIds?.length
      ? this.state.tasks.filter((task) => args.taskIds.map(String).includes(String(task.id)))
      : this.autoCandidates()
    this.state.run = {
      running: true,
      paused: false,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      total: tasks.length,
      done: 0,
      note: `开始执行 ${tasks.length} 个任务`,
    }
    this.bump()
    this.autoPromise = this.autoLoop(tasks)
    return { ok: true, started: true, total: tasks.length }
  }

  pauseAuto() {
    const run = this.autoState()
    if (!run.running) return { ok: false, note: '当前没有在跑的任务' }
    this.state.run = { ...run, paused: true, note: '已暂停' }
    this.bump()
    return { ok: true, paused: true }
  }

  resumeAuto() {
    const run = this.autoState()
    if (!run.running) return { ok: false, note: '当前没有在跑的任务' }
    this.state.run = { ...run, paused: false, note: '继续执行' }
    this.bump()
    return { ok: true, paused: false }
  }

  async stopAuto() {
    const run = this.autoState()
    this.state.run = { ...run, running: false, paused: false, finishedAt: new Date().toISOString(), note: '已停止' }
    this.bump()
    return { ok: true, stopped: true }
  }

  /** 后台循环：每个任务之间检查暂停/停止，单个任务失败不中断整批。 */
  async autoLoop(tasks) {
    const results = []
    try {
      for (const task of tasks) {
        while (this.autoState().paused && this.autoState().running) await sleep(600)
        if (!this.autoState().running) break
        this.state.current = {
          taskId: task.id, course: task.courseName, title: task.title,
          stage: task.stage, index: results.length + 1, total: tasks.length, question: null, phase: 'running',
        }
        this.bump()
        let outcome
        try {
          outcome = await this.realEngine.runTask(task, { submit: true })
        } catch (error) {
          outcome = { ok: false, phase: 'error', note: String(error?.message ?? error) }
          this.realEngine.defect(task, 'auto', outcome.note)
        }
        results.push({ id: task.id, phase: outcome.phase, note: outcome.note ?? null, score: outcome.score ?? null })
        this.state.run = {
          ...this.autoState(),
          done: results.length,
          total: tasks.length,
          note: `${task.courseName} · ${task.title} → ${outcome.phase ?? 'unknown'}`,
        }
        this.recomputeRealStats()
        this.bump()
      }
    } finally {
      const run = this.autoState()
      this.state.run = {
        ...run,
        running: false,
        paused: false,
        finishedAt: new Date().toISOString(),
        note: `执行结束：完成 ${run.done}/${run.total}`,
      }
      this.state.current = null
      this.bump()
      this.autoPromise = null
    }
    return results
  }

  /** 逐题热更新：把当前题号写进状态并刷新一帧画面。 */
  async tickQuestion(task, seq, total) {
    this.state.current = {
      ...(this.state.current ?? {}),
      taskId: task.id,
      course: task.courseName,
      title: task.title,
      question: seq,
      questionTotal: total,
      phase: 'answering',
    }
    this.bump(false)
    await this.refreshShot()
  }

  async library(args, exec) {
    await this.hydrate(exec)
    const action = String(args.action ?? 'stats')
    if (action === 'resolve') {
      const hit = this.answerLibrary.resolveCourse(args.course || '')
      return { course: args.course, hit, stats: this.answerLibrary.stats() }
    }
    if (action === 'search') {
      const query = String(args.query ?? '').trim()
      const hit = this.answerLibrary.resolveCourse(args.course || query)
      if (!hit) return { query, found: 0, note: '没有匹配到答案库课程' }
      const answers = this.answerLibrary.loadCourse(hit.slug)
      const matches = answers.find(query, 0.5)
      const sample = answers.records
        .filter((record) => !query || record.s.includes(query))
        .slice(0, Number(args.limit ?? 5))
        .map((record) => ({ stem: record.s.slice(0, 120), qtype: record.q, answer: record.a, source: record.f }))
      return { course: hit.key, count: answers.size, best: matches ? { stem: matches.record.s.slice(0, 120), score: Number(matches.score.toFixed(3)), tier: matches.tier } : null, sample }
    }
    if (action === 'course') {
      const hit = this.answerLibrary.resolveCourse(args.course || '')
      if (!hit) return { found: false }
      const answers = this.answerLibrary.loadCourse(hit.slug)
      const qtypes = {}
      for (const record of answers.records) qtypes[record.q] = (qtypes[record.q] ?? 0) + 1
      return { found: true, key: hit.key, count: answers.size, qtypes, score: Number(hit.score.toFixed(2)) }
    }
    return { ...this.answerLibrary.stats(), note: '用 action=course 查单门课程，action=search 按题干检索' }
  }

  async exam(args, exec) {
    await this.hydrate(exec)
    const task = this.findTask(args.taskId, args.course, args.stage)
    if (task.stage === 'DISCUSSION') throw new Error('讨论题不需要试卷，请用 ouch_discussion')
    const course = this.state.courses.find((item) => String(item.id) === String(task.courseId))
    const hit = this.answerLibrary.resolveCourse(task.courseName)
    if (!hit) throw new Error(`答案库没有覆盖课程《${task.courseName}》，无法生成模拟试卷`)
    task.library = { key: hit.key, count: hit.count, score: Number(hit.score.toFixed(2)) }

    const existing = task.paperId ? this.paperCache.get(task.paperId) : null
    if (existing && args.rebuild !== true) {
      await this.openPaper(existing, exec)
      return { paperId: existing.id, reused: true, task: briefTask(task), count: existing.questionCount, url: this.state.browser.url }
    }

    const answers = this.answerLibrary.loadCourse(hit.slug)
    const { paper, warning } = buildPaper({ task, course, answers, stage: task.stage })
    if (Number.isFinite(args.count) && args.count > 0 && args.count < paper.questionCount) {
      paper.questions = paper.questions.slice(0, args.count)
      paper.questionCount = paper.questions.length
      paper.totalPoints = Number.isFinite(task.totalPoints) ? task.totalPoints : paper.questionCount * (paper.questions[0]?.score ?? 0)
    }
    this.paperCache.set(paper.id, paper)
    this.state.papers[paper.id] = {
      id: paper.id,
      taskId: paper.taskId,
      courseId: paper.courseId,
      courseName: paper.courseName,
      taskTitle: paper.taskTitle,
      stage: paper.stage,
      questionCount: paper.questionCount,
      totalPoints: paper.totalPoints,
      warning: paper.warning,
      createdAt: paper.createdAt,
      questions: paper.questions,
    }
    task.paperId = paper.id
    task.status = 'generated'
    task.total = paper.questionCount
    task.answered = 0
    this.state.stats.papers = Object.keys(this.state.papers).length
    await this.openPaper(paper, exec)
    return {
      paperId: paper.id,
      task: briefTask(task),
      count: paper.questionCount,
      totalPoints: paper.totalPoints,
      warning,
      url: this.state.browser.url,
      hint: '试卷已在浏览器打开：先用 ouch_solve 解析并匹配，再决定是否填写。',
    }
  }

  /** Navigate to a paper's page and wait for it to render. */
  async openPaper(paper, exec) {
    await this.ensureBrowser(exec)
    const url = `${this.origin()}/ouch/mock?paper=${encodeURIComponent(paper.id)}`
    await this.browser.goto(url)
    const ready = await waitUntil(() => this.browser.evaluate('document.querySelectorAll(".q").length'), 15000)
    if (!ready) throw new Error('模拟试卷页面没有渲染出来')
    await this.refreshShot()
  }

  async solve(args, exec) {
    await this.hydrate(exec)
    const task = this.resolvePaperTask(args)
    const paper = this.paperCache.get(task.paperId)
    if (!paper) throw new Error('这个任务还没有生成试卷，请先调用 ouch_exam')
    const fill = args.fill !== false
    const verifyAfter = args.verify !== false
    const onPaper = await this.browser.evaluate('document.querySelectorAll(".q").length').catch(() => 0)
    if (!onPaper) await this.openPaper(paper, exec)

    const page = await this.browser.evaluate(READ_PAPER_SCRIPT)
    const hit = this.answerLibrary.resolveCourse(task.courseName)
    const answers = hit ? this.answerLibrary.loadCourse(hit.slug) : null
    const results = []
    const plan = []
    let matched = 0
    let filled = 0
    let unmatched = 0

    for (const question of page.questions ?? []) {
      const found = answers ? answers.find(question.stem) : null
      const record = found?.record ?? null
      const mapped = record ? mapOptions(record.a, record.o, question.options) : { letters: [], failed: true, note: '答案库未命中' }
      const qtype = question.qtype || record?.q || 'single'
      const answerText = record ? (record.a ?? []).join('；') : ''
      const entry = {
        seq: question.seq,
        qtype,
        stem: question.stem,
        options: question.options,
        answer: mapped.letters,
        answerText,
        source: record ? { file: record.f ?? null, locator: record.l ?? null, stageHint: record.h ?? null } : null,
        tier: found?.tier ?? 'none',
        score: found ? Number(found.score.toFixed(3)) : 0,
        note: mapped.note,
        status: 'matched',
      }
      if (!found || mapped.failed) {
        entry.status = found ? 'mapping-failed' : 'unmatched'
        if (found) matched += 1
        else unmatched += 1
      } else {
        matched += 1
      }

      if (fill && (mapped.letters.length > 0 || answerText)) {
        if (qtype === 'fill' || qtype === 'essay') {
          plan.push({ seq: question.seq, text: answerText.slice(0, 4000) })
        } else {
          plan.push({ seq: question.seq, letters: mapped.letters })
        }
      }
      results.push(entry)
    }

    if (fill && plan.length > 0) {
      const filledReport = await this.browser.evaluate(fillScript(plan))
      const bySeq = new Map((filledReport ?? []).map((item) => [item.seq, item]))
      for (const entry of results) {
        const outcome = bySeq.get(entry.seq)
        if (!outcome) continue
        if (outcome.ok) {
          entry.status = 'filled'
          filled += 1
        } else {
          entry.status = 'fill-failed'
          entry.note = `${entry.note}${entry.note ? '；' : ''}${outcome.note ?? '填写未生效'}`
        }
      }
    }

    let verified = null
    if (verifyAfter) {
      const readback = await this.browser.evaluate(READ_ANSWERS_SCRIPT)
      verified = compareAnswers(results, readback)
    }

    this.state.results[task.id] = {
      taskId: task.id,
      paperId: paper.id,
      courseId: task.courseId,
      courseName: task.courseName,
      stage: task.stage,
      title: task.title,
      at: Date.now(),
      questions: results,
      verified,
      stats: {
        total: results.length,
        matched,
        unmatched,
        filled,
        mappingFailed: results.filter((item) => item.status === 'mapping-failed').length,
        fillFailed: results.filter((item) => item.status === 'fill-failed').length,
      },
    }
    task.answered = results.filter((item) => item.status === 'filled').length
    task.total = results.length
    task.status = fill ? 'answered' : 'generated'
    this.recomputeStats()
    // Filling focuses each field, which leaves the page scrolled mid-paper; the
    // live frame should show the paper from the top.
    await this.browser.evaluate('window.scrollTo({ top: 0, behavior: "instant" })').catch(() => {})
    await this.refreshShot()
    return {
      task: briefTask(task),
      paperId: paper.id,
      total: results.length,
      matched,
      unmatched,
      filled,
      verified: verified ? { ok: verified.ok, bad: verified.bad } : null,
      failures: results.filter((item) => item.status === 'unmatched' || item.status === 'mapping-failed' || item.status === 'fill-failed').slice(0, 5)
        .map((item) => ({ seq: item.seq, status: item.status, stem: item.stem.slice(0, 60), note: item.note })),
    }
  }

  /**
   * Grade the current paper and record per-question results.
   *
   * Without `items` the paper grades itself: objective questions are compared
   * with the answer they were built from, subjective ones stay 待批改. With
   * `items` (the platform's per-question scores) the result becomes the real
   * one — a wrong platform score on a question the library answered means the
   * library answer is suspect, which is what the console flags in red.
   */
  async submit(args, exec) {
    await this.hydrate(exec)
    const task = this.findTask(args.taskId, args.course, args.stage)
    const paper = task.paperId ? (this.paperCache.get(task.paperId) ?? this.state.papers[task.paperId]) : null
    if (!paper) throw new Error('这个任务还没有生成试卷，请先调用 ouch_exam')
    await this.ensureBrowser(exec)
    const onPaper = await this.browser.evaluate('document.querySelectorAll(".q").length').catch(() => 0)
    if (!onPaper) await this.openPaper(paper, exec)
    const readback = await this.browser.evaluate(READ_ANSWERS_SCRIPT)
    const bySeq = new Map((readback.items ?? []).map((item) => [item.seq, item]))
    const platformItems = Array.isArray(args.items) && args.items.length > 0 ? args.items : null

    const perQuestion = {}
    const marks = []
    const suspect = []
    let correct = 0
    let wrong = 0
    let pending = 0
    let earned = 0
    let possible = 0

    // Per-question points are rounded for display, so a 100-point paper of 30
    // questions must be graded with the exact share, otherwise the earned total
    // can never reach the paper total. Every question — including one awaiting
    // review — counts toward the paper total.
    const count = (paper.questions ?? []).length || 1
    const paperTotal = Number(paper.totalPoints) || 0
    const exactMax = paperTotal > 0 ? paperTotal / count : 0

    for (const question of paper.questions ?? []) {
      const shown = bySeq.get(question.seq)
      const shownMax = Number(question.score) || Math.round(exactMax * 10) / 10
      const max = exactMax > 0 ? exactMax : shownMax
      possible += max
      const record = (status, score) => {
        perQuestion[question.seq] = { status, score: Math.round(score * 10) / 10, max: Math.round(max * 10) / 10 }
        marks.push({ seq: question.seq, status, score: Math.round(score * 10) / 10, max: Math.round(max * 10) / 10 })
      }
      if (platformItems) {
        const given = platformItems.find((item) => Number(item.seq) === question.seq)
        if (!given) { record('unknown', 0); continue }
        const score = Number(given.score) || 0
        const gained = max > 0 ? score >= max * 0.999 : score > 0
        if (gained) { correct += 1; earned += max; record('correct', max) } else {
          wrong += 1
          // The library supplied this answer, so a zero here implicates the bank.
          if ((question.answer ?? []).length > 0) suspect.push(question.seq)
          record('wrong', score)
        }
        continue
      }
      if (question.qtype === 'fill' || question.qtype === 'essay') {
        pending += 1
        record('pending', 0)
        continue
      }
      const planned = [...(question.answer ?? [])].map((value) => String(value).toUpperCase()).sort().join('')
      const actual = [...(shown?.letters ?? [])].map((value) => String(value).toUpperCase()).sort().join('')
      if (planned.length > 0 && planned === actual) {
        correct += 1
        earned += max
        record('correct', max)
      } else {
        wrong += 1
        if (planned) suspect.push(question.seq)
        record('wrong', 0)
      }
    }

    const grade = {
      taskId: task.id,
      paperId: paper.id,
      at: Date.now(),
      source: platformItems ? 'platform' : 'simulated',
      score: Math.round(earned * 10) / 10,
      total: Math.round(possible * 10) / 10,
      correct,
      wrong,
      pending,
      suspect,
      perQuestion,
    }
    this.state.grades[task.id] = grade
    task.grade = { score: grade.score, total: grade.total, correct, wrong, pending, source: grade.source }
    task.status = 'submitted'
    task.answered = Object.values(perQuestion).filter((item) => item.status === 'correct' || item.status === 'wrong').length

    await this.browser.evaluate(`(() => {
      var summary = ${JSON.stringify({ score: grade.score, total: grade.total, correct, wrong, pending })}
      if (typeof window.__ouchGrade === 'function') window.__ouchGrade(${JSON.stringify(marks)}, summary)
      document.body.dataset.ouchSubmitted = '1'
      return true
    })()`).catch(() => {})
    await this.browser.evaluate('window.scrollTo({ top: 0, behavior: "instant" })').catch(() => {})
    this.recomputeStats()
    await this.refreshShot()
    return {
      task: briefTask(task),
      score: grade.score,
      total: grade.total,
      correct,
      wrong,
      pending,
      suspect,
      source: grade.source,
      note: grade.source === 'platform'
        ? '按平台返回的逐题分数判分；红色题目说明题库答案与平台不一致'
        : '模拟判分：客观题按题库答案比对，主观题标记待批改',
    }
  }

  async discussion(args, exec) {
    await this.hydrate(exec)
    const task = this.findTask(args.taskId, args.course, args.stage)
    if (task.stage !== 'DISCUSSION') throw new Error('这个任务不是讨论题')
    const topic = task.title
    const provided = String(args.content ?? '').trim()
    const draft = provided || draftFor(task)
    this.state.discussions[task.id] = {
      taskId: task.id,
      courseId: task.courseId,
      courseName: task.courseName,
      topic,
      draft,
      status: provided ? 'drafted' : 'template',
      at: Date.now(),
    }
    task.status = 'drafted'
    this.recomputeStats()
    return { task: briefTask(task), topic, draft, note: '只生成草稿，没有向平台发帖' }
  }

  async report(args, exec) {
    await this.hydrate(exec)
    const dir = path.join(this.workDir(exec), 'reports')
    await mkdir(dir, { recursive: true })
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-')
    const htmlPath = path.join(dir, `${stamp}-ouchen-workbench.html`)
    const csvPath = path.join(dir, `${stamp}-ouchen-workbench.csv`)
    // Building the report is not an outstanding action: show the run as settled
    // instead of "running" just because this call is inside a timeline step.
    const previousStatus = this.state.status
    if (previousStatus === 'running') this.state.status = 'ready'
    const html = buildHtml(this.snapshot(), { generatedAt: new Date().toISOString() })
    const csv = buildCsv(this.snapshot())
    this.state.status = previousStatus
    await writeFile(htmlPath, html, 'utf8')
    await writeFile(csvPath, `${csv}\n`, 'utf8')
    this.reportDir = dir
    this.state.report = { html: htmlPath, csv: csvPath, at: Date.now() }
    this.bump()
    return {
      html: htmlPath,
      csv: csvPath,
      tasks: this.state.tasks.length,
      answered: this.state.tasks.filter((task) => task.status === 'answered').length,
      answerUrl: `${this.origin()}/ouch/report?file=${encodeURIComponent(path.basename(htmlPath))}`,
    }
  }

  async close(args, exec) {
    await this.hydrate(exec)
    if (this.browser) await this.browser.close().catch(() => {})
    this.browser = null
    this.state.browser = { open: false, url: null, title: null, startedAt: null }
    this.state.status = 'done'
    this.state.finishedAt = new Date().toISOString()
    this.shot = null
    this.state.shotRev += 1
    this.bump()
    return { closed: true, ...this.summary() }
  }

  /* ---------------------------------------------------------------- *
   * Helpers
   * ---------------------------------------------------------------- */

  findTask(taskId, course, stage) {
    const tasks = this.state.tasks
    if (!tasks.length) throw new Error('还没有同步课程，请先调用 ouch_sync')
    if (taskId !== undefined && taskId !== null && String(taskId).trim() !== '') {
      const wanted = String(taskId).trim()
      const task = tasks.find((item) => item.id === wanted)
        ?? tasks.find((item) => String(item.activityId) === wanted)
        ?? tasks.find((item) => item.title === wanted)
      if (!task) throw new Error(`没有找到任务：${wanted}（用 ouch_state 查可用的任务 id）`)
      return task
    }
    let task = null
    if (course) {
      const sameCourse = tasks.filter((item) => item.courseName.includes(String(course)))
      task = stage ? sameCourse.find((item) => item.stage === String(stage).toUpperCase()) : sameCourse[0]
    }
    if (!task && stage) {
      task = tasks.find((item) => item.stage === String(stage).toUpperCase() && item.availability === 'ACTIONABLE' && item.status === 'pending')
        ?? tasks.find((item) => item.stage === String(stage).toUpperCase())
    }
    if (!task) {
      task = tasks.find((item) => item.status === 'pending' && item.availability === 'ACTIONABLE' && item.stage !== 'DISCUSSION')
    }
    if (!task) throw new Error('没有找到可执行的任务：请传 taskId，或先确认 ouch_state 里的任务列表')
    return task
  }

  resolvePaperTask(args) {
    return this.findTask(args.taskId, args.course, args.stage)
  }

  recomputeStats() {
    const state = this.state
    let questions = 0
    let answered = 0
    let matched = 0
    let unmatched = 0
    let verified = 0
    for (const result of Object.values(state.results)) {
      questions += result.stats.total
      answered += result.stats.filled
      matched += result.stats.matched
      unmatched += result.stats.unmatched
      if (result.verified?.ok) verified += 1
    }
    state.stats.questions = questions
    state.stats.answered = answered
    state.stats.matched = matched
    state.stats.unmatched = unmatched
    state.stats.verified = verified
    state.stats.drafts = Object.keys(state.discussions).length
    let correct = 0
    let wrong = 0
    let pending = 0
    for (const grade of Object.values(state.grades ?? {})) {
      correct += grade.correct ?? 0
      wrong += grade.wrong ?? 0
      pending += grade.pending ?? 0
    }
    state.stats.graded = Object.keys(state.grades ?? {}).length
    state.stats.correct = correct
    state.stats.wrong = wrong
    state.stats.pending = pending
    const start = state.startedAt ? Date.parse(state.startedAt) : null
    if (start) state.stats.elapsedMs = Date.now() - start
    this.bump()
  }

  async dispose() {
    this.disposed = true
    // Flush a pending save first: the console must reopen on the state the user
    // last saw, including a step that finished moments before shutdown.
    if (this.saveTimer) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
    }
    if (this.stateFileRef) await this.persist(this.stateFileRef).catch(() => {})
    if (this.browser) await this.browser.close().catch(() => {})
    this.browser = null
  }
}

/** Poll a predicate until it is truthy. */
async function waitUntil(check, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await check().catch(() => 0)
    if (value) return value
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  return null
}

function briefTask(task) {
  return {
    id: task.id,
    course: task.courseName,
    stage: task.stage,
    title: task.title,
    status: task.status,
    paperId: task.paperId,
    answered: task.answered,
    total: task.total,
    grade: task.grade ?? null,
  }
}

function describeArgs(tool, args) {
  if (tool === 'ouch_open') return String(args.url ?? '复用浏览器').slice(0, 90)
  if (tool === 'ouch_sync') return args.courseId ? `课程 ${args.courseId}` : '全部课程'
  if (tool === 'ouch_exam') return String(args.taskId ?? args.course ?? '').slice(0, 60)
  if (tool === 'ouch_solve') return args.fill === false ? '只解析不填写' : '解析并填写'
  if (tool === 'ouch_discussion') return String(args.taskId ?? '').slice(0, 60)
  if (tool === 'ouch_page') return args.expression ? `eval ${String(args.expression).slice(0, 50)}` : String(args.mode ?? 'both')
  if (tool === 'ouch_act') return `${Array.isArray(args.steps) ? args.steps.length : 0} 个动作`
  return ''
}

function describeResult(tool, value) {
  if (!value || typeof value !== 'object') return null
  if (tool === 'ouch_login') return `已登录：${value.student?.name ?? ''}`
  if (tool === 'ouch_sync') return `${value.courses} 门课程 · ${value.tasks} 个任务`
  if (tool === 'ouch_run') return `跑 ${value.ran} 个任务 · 交卷 ${value.submitted} · 缺答案 ${value.needsAnswers} · 受阻 ${value.blocked}`
  if (tool === 'ouch_real') {
    if (value.action === 'read') return `读到 ${value.count ?? 0} 题`
    if (value.phase === 'submitted') return `已交卷${Number.isFinite(value.score) ? ` ${value.score} 分` : ''}`
    return value.note ?? value.phase ?? null
  }
  if (tool === 'ouch_exam') return `试卷 ${value.count} 题${value.warning ? '（题库不足）' : ''}`
  if (tool === 'ouch_solve') return `匹配 ${value.matched}/${value.total} · 填写 ${value.filled}`
  if (tool === 'ouch_submit') return `得分 ${value.score}/${value.total} · 对 ${value.correct} 错 ${value.wrong}${value.pending ? ` · 待批改 ${value.pending}` : ''}`
  if (tool === 'ouch_report') return '报告已生成'
  if (tool === 'ouch_discussion') return '草稿已生成'
  if (tool === 'ouch_close') return '浏览器已关闭'
  if (tool === 'ouch_page') return value.title ? String(value.title).slice(0, 60) : null
  if (tool === 'ouch_act') return `${(value.results ?? []).filter((item) => item.ok).length}/${(value.results ?? []).length} 成功`
  return null
}

function loginErrorText(result) {
  const reasons = {
    'no-credentials': '没有配置账号密码',
    captcha: '登录页要求验证码/滑块，需要人工完成一次登录',
    'form-not-found': '找不到账号密码输入框，页面结构可能变了',
    'submit-not-found': '找不到登录按钮',
    'bad-credentials': '账号或密码不正确',
    timeout: '登录超时：页面没有离开统一身份认证',
  }
  return reasons[result.reason] ?? `登录失败：${result.reason}`
}

/** Compare planned answers with what the page reports. */
function compareAnswers(results, readback) {
  const actual = new Map((readback.items ?? []).map((item) => [item.seq, item]))
  const bad = []
  for (const result of results) {
    const state = actual.get(result.seq)
    if (!state) { bad.push({ seq: result.seq, reason: '页面上没有这道题' }); continue }
    if (result.qtype === 'fill' || result.qtype === 'essay') {
      if (!state.text) bad.push({ seq: result.seq, reason: '文本框为空' })
      continue
    }
    const planned = [...result.answer].sort().join('')
    const shown = [...(state.letters ?? [])].sort().join('')
    if (planned !== shown) bad.push({ seq: result.seq, reason: `计划 ${planned || '空'}，页面 ${shown || '空'}` })
  }
  return { ok: bad.length === 0, bad: bad.length, problems: bad.slice(0, 6), submitted: Boolean(readback.submitted) }
}

/** A discussion draft that only reuses the topic, never posts it. */
function draftFor(task) {
  const topic = task.title.replace(/\s+/g, ' ').trim()
  const summary = (task.description || '').replace(/\s+/g, ' ').trim().slice(0, 160)
  return [
    `主题：${topic}`,
    '',
    summary ? `我已阅读课程材料中关于「${topic}」的说明：${summary}` : `结合本课程的学习，我谈几点对「${topic}」的理解。`,
    '',
    '一、核心观点。这个概念强调目标与环境之间的匹配，管理者需要在资源有限的条件下做出取舍。',
    '',
    '二、结合实践。在所在单位的实际工作中，类似情形表现为流程与人员配置的重新安排，先明确目标，再调整分工。',
    '',
    '三、学习收获。通过本主题的学习，我更清楚地理解了课程知识在工作场景中的落点，也会在后续实践中继续验证。',
  ].join('\n')
}
