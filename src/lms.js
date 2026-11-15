/**
 * 国开学习平台 adapter: sign in, list courses, read each stage's activities.
 *
 * Everything here is read-only against the platform. The plugin never submits an
 * answer sheet, starts an attempt, or posts to a forum; the exam it fills is a
 * locally served simulation (`mock.js`).
 */

/** 统一身份认证 entry, the same URL the login page in the panel shows. */
export const LOGIN_ENTRY = 'https://iam.pt.ouchn.cn/am/oauth2/authorize?service=initService&response_type=code'
  + '&client_id=345fcbaf076a4f8a&scope=all'
  + '&redirect_uri=https%3A%2F%2Fmenhu.pt.ouchn.cn%2Fouchnapp%2Fwap%2Flogin%2Findex&decision=Allow'

export const LMS_COURSES = 'https://lms.ouchn.cn/user/courses'

/** Stage routes on a course page; the keys match the reference app's enum. */
export const STAGES = {
  FORMATIVE: { hash: '#/formal-exam', label: '形考任务', tab: '形考任务' },
  FINAL: { hash: '#/final-exam', label: '终考任务', tab: '终考任务' },
  DISCUSSION: { hash: '#/forum-activity', label: '讨论', tab: '讨论' },
}

const LOGIN_SELECTORS = {
  account: ['input[name=name]', '#username', 'input[type=text]'],
  password: ['input[name=pwd]', 'input[type=password]'],
  agree: ['#agreeCheckBox', 'form input[type=checkbox]'],
  submit: ['button[type=submit]', 'form button'],
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Wait until the expression is truthy; returns false on timeout. */
export async function waitFor(session, expression, timeoutMs = 12000, intervalMs = 300) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      if (await session.evaluate(expression)) return true
    } catch { /* a navigation may be in flight */ }
    await sleep(intervalMs)
  }
  return false
}

/** Fill the first selector that exists; returns the selector used. */
async function fillFirst(session, selectors, value) {
  for (const selector of selectors) {
    const exists = await session.evaluate(`Boolean(document.querySelector(${JSON.stringify(selector)}))`)
    if (!exists) continue
    const result = await session.perform({ action: 'fill', selector, value })
    if (result.ok) return selector
  }
  return null
}

/** Click the first selector that exists. */
async function clickFirst(session, selectors) {
  for (const selector of selectors) {
    const exists = await session.evaluate(`Boolean(document.querySelector(${JSON.stringify(selector)}))`)
    if (!exists) continue
    const result = await session.perform({ action: 'click', selector })
    if (result.ok) return selector
  }
  return null
}

/**
 * Sign in if the LMS asks for credentials.
 *
 * The IAM session cookie is not persistent, so a freshly launched browser always
 * starts here; the account is the one configured for the workbench.
 */
export async function ensureLogin(session, options = {}) {
  const account = String(options.account ?? '').trim()
  const password = String(options.password ?? '')
  const where = await session.goto(options.entryUrl || LMS_COURSES)
  if (!/iam\.pt\.ouchn\.cn/.test(where.url)) {
    return { loggedIn: true, already: true, url: where.url, title: where.title }
  }
  if (!account || !password) {
    return { loggedIn: false, reason: 'no-credentials', url: where.url, title: where.title }
  }

  const pageText = await session.evaluate('(document.body ? document.body.innerText : "")')
  if (/验证码|滑块|拖动验证/.test(pageText)) {
    return { loggedIn: false, reason: 'captcha', url: where.url, title: where.title }
  }

  const usedAccount = await fillFirst(session, LOGIN_SELECTORS.account, account)
  const usedPassword = await fillFirst(session, LOGIN_SELECTORS.password, password)
  if (!usedAccount || !usedPassword) {
    return { loggedIn: false, reason: 'form-not-found', url: where.url, title: where.title }
  }
  await clickFirst(session, LOGIN_SELECTORS.agree)
  const submitted = await clickFirst(session, LOGIN_SELECTORS.submit)
  if (!submitted) return { loggedIn: false, reason: 'submit-not-found', url: where.url, title: where.title }

  const deadline = Date.now() + 45000
  while (Date.now() < deadline) {
    await sleep(600)
    const now = await session.where()
    if (!/iam\.pt\.ouchn\.cn/.test(now.url)) {
      return { loggedIn: true, already: false, url: now.url, title: now.title }
    }
    const text = await session.evaluate('(document.body ? document.body.innerText : "")').catch(() => '')
    if (/验证码|滑块|拖动验证/.test(text)) return { loggedIn: false, reason: 'captcha', url: now.url, title: now.title }
    if (/密码错误|账号或密码有误|用户不存在/.test(text)) {
      return { loggedIn: false, reason: 'bad-credentials', url: now.url, title: now.title, detail: text.slice(0, 120) }
    }
  }
  const stuck = await session.where()
  return { loggedIn: false, reason: 'timeout', url: stuck.url, title: stuck.title }
}

const COURSE_SCRIPT = `(() => {
  const anchors = Array.from(document.querySelectorAll('a[href^="/course/"][href$="/content"]'))
  const seen = new Set()
  const items = []
  for (const anchor of anchors) {
    const href = anchor.getAttribute('href') || ''
    if (seen.has(href)) continue
    seen.add(href)
    let box = anchor.parentElement
    let text = ''
    for (let depth = 0; depth < 6 && box; depth += 1) {
      const value = box.innerText || ''
      if (/课程代码/.test(value)) { text = value; break }
      box = box.parentElement
    }
    items.push({
      name: (anchor.innerText || anchor.textContent || '').trim(),
      href,
      text: text.replace(/\\s+/g, ' ').trim(),
    })
  }
  return { title: document.title, url: location.href, items }
})()`

/** Read every course the account is enrolled in. */
export async function fetchCourses(session) {
  await session.goto(LMS_COURSES)
  await waitFor(session, 'document.querySelectorAll(\'a[href^="/course/"][href$="/content"]\').length > 0', 20000)
  const raw = await session.evaluate(COURSE_SCRIPT)
  const courses = (raw.items || []).map((item) => {
    const idMatch = item.href.match(/\/course\/(\d+)\/content/)
    const progress = /完成度:\s*([\d.]+)%/.exec(item.text)
    const code = /课程代码:\s*([^\s]+)/.exec(item.text)
    const term = /(\d{4}-\d{4}第\d学期)/.exec(item.text)
    const kind = /(蓝本课子课|省开课|统设课|选修课)/.exec(item.text)
    return {
      id: idMatch ? idMatch[1] : item.href,
      name: item.name,
      href: item.href,
      url: `https://lms.ouchn.cn${item.href}`,
      code: code ? code[1] : null,
      term: term ? term[1] : null,
      kind: kind ? kind[1] : null,
      progress: progress ? Number(progress[1]) : null,
    }
  }).filter((course) => course.name && course.href)
  return { title: raw.title, url: raw.url, courses }
}

const ACTIVITY_SCRIPT = `(() => {
  if (!window.angular) return { ok: false, reason: 'angular missing', items: [] }
  const nodes = Array.from(document.querySelectorAll('a.title'))
  const seen = new Set()
  const items = []
  for (const node of nodes) {
    let scope
    try { scope = window.angular.element(node).scope() } catch (error) { continue }
    const activity = scope && scope.activity
    if (!activity || seen.has(activity.id)) continue
    seen.add(activity.id)
    items.push(activity)
  }
  return { ok: true, count: items.length, items }
})()`

/**
 * Read every activity of a course in one page visit.
 *
 * The stage tabs all render from the same syllabus list, and that list holds
 * each activity's model, so one visit to the 形考 tab yields the 形考, 终考 and
 * forum rows together. A course without 形考 renders no rows at all, so the
 * caller may need to open another tab and retry.
 */
export async function fetchCourseActivities(session, courseHref) {
  const base = String(courseHref || '').replace(/\/content.*$/, '/ng')
  const attempts = [STAGES.FORMATIVE, STAGES.FINAL, STAGES.DISCUSSION]
  let last = null
  for (const spec of attempts) {
    await session.goto(`https://lms.ouchn.cn${base}${spec.hash}`)
    let ready = await waitFor(session, 'document.querySelectorAll("a.title").length > 0', 12000)
    if (!ready) {
      await session.evaluate(`(() => {
        const tab = Array.from(document.querySelectorAll('a')).find((node) => (node.innerText || '').trim() === ${JSON.stringify(spec.tab)})
        if (tab) tab.click()
        return Boolean(tab)
      })()`)
      ready = await waitFor(session, 'document.querySelectorAll("a.title").length > 0', 8000)
    }
    const raw = await session.evaluate(ACTIVITY_SCRIPT)
    const where = await session.where()
    last = { ok: Boolean(raw.ok) && ready, url: where.url, items: raw.items ?? [], reason: raw.reason ?? null }
    if (last.items.length > 0) break
  }
  if (!last || last.items.length === 0) {
    return { ok: false, items: [], note: '没有读到课程活动，可能课程为空或页面结构变化' }
  }
  const activities = last.items.map((item) => shapeActivity(item))
  const stages = { FORMATIVE: [], FINAL: [], DISCUSSION: [] }
  for (const activity of activities) {
    if (activity.isFinal) stages.FINAL.push(activity)
    else if (activity.isDiscussion) stages.DISCUSSION.push(activity)
    else if (activity.isFormative) stages.FORMATIVE.push(activity)
  }
  for (const list of Object.values(stages)) list.sort((left, right) => (left.sort ?? 0) - (right.sort ?? 0))
  return { ok: true, stages, activities, note: null }
}

/** A forum board that only carries notices is not a discussion task. */
const NOTICE_TITLE = /公告|通知|须知|导学|课程介绍/

/** Strip an activity model down to what the console needs. */
export function shapeActivity(activity) {
  const data = activity?.data && typeof activity.data === 'object' ? activity.data : {}
  const type = String(activity?.type || data.type || '').trim() || 'activity'
  const title = String(activity?.title || activity?.name || '(未命名)').trim()
  const isFormative = Boolean(activity?.is_formative)
  const isFinal = Boolean(activity?.is_final)
  const isForum = type === 'forum'
  const isDiscussion = !isFinal && (isForum || /讨论/.test(title)) && !NOTICE_TITLE.test(title)
  const stage = isFinal ? 'FINAL' : isDiscussion ? 'DISCUSSION' : isFormative ? 'FORMATIVE' : 'OTHER'
  return {
    id: String(activity?.id ?? title),
    uniqueKey: activity?.unique_key || `${type}-${activity?.id ?? title}`,
    title,
    type,
    stage,
    isFormative,
    isFinal,
    isDiscussion,
    questionCount: finiteOrNull(activity?.subjects_count ?? data.subjects_count),
    totalPoints: finiteOrNull(activity?.total_points ?? data.total_points),
    scorePercentage: finiteOrNull(activity?.score_percentage),
    submitTimes: finiteOrNull(activity?.submit_times),
    // Scoring facts the console shows next to a task: how many attempts are
    // allowed, whether the platform announces a score immediately, and the score
    // it already returned (null until an attempt is submitted or reviewed).
    finalScore: finiteOrNull(activity?.activity_final_score ?? activity?.final_score),
    bestScore: bestSubmissionScore(activity?.exam_submissions),
    announceScore: String(activity?.announce_score_status ?? '').trim() || null,
    scorePublished: activity?.score_published === true,
    canShowScore: activity?.can_show_score !== false,
    limitMinutes: finiteOrNull(activity?.limit_time) ?? finiteOrNull(activity?.limitMinutes),
    submissionStatus: activity?.submission_status ?? null,
    attemptsUsed: Array.isArray(activity?.exam_submissions) ? activity.exam_submissions.length : null,
    submitted: Boolean(activity?.submitted || activity?.hasSubmitted || data.submitted),
    startTime: activity?.start_time ?? null,
    endTime: activity?.end_time ?? null,
    submitStartTime: activity?.submit_start_time ?? null,
    isOpen: Boolean(activity?.is_open),
    isClosed: Boolean(activity?.is_closed),
    isStarted: Boolean(activity?.is_started),
    completionCriterion: activity?.completion_criterion ?? null,
    moduleId: activity?.module_id ?? null,
    sort: finiteOrNull(activity?.sort),
    description: stripHtml(activity?.description ?? data.description ?? ''),
  }
}

/** Highest score across a student's submissions, or null when none exists. */
function bestSubmissionScore(submissions) {
  if (!Array.isArray(submissions) || submissions.length === 0) return null
  let best = null
  for (const item of submissions) {
    const value = Number(item?.score ?? item?.final_score ?? item?.total_score)
    if (Number.isFinite(value) && (best === null || value > best)) best = value
  }
  return best
}

function stripHtml(html) {  return String(html ?? '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function finiteOrNull(value) {
  if (value === null || value === undefined || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

