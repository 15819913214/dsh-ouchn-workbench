/**
 * 国开学习平台 · 真实作答适配层。
 *
 * `lms.js` 只读课程结构，`mock.js` 在本地生成模拟试卷；这一层做的是**真正写入**
 * 平台：进入考试、读真实试题、填写答案、交卷并读回平台判分，播放视频解锁前置
 * 条件，以及在讨论区发帖。
 *
 * 每个导出函数都只依赖 `BrowserSession`（CDP 桥），并把"页面上到底发生了什么"
 * 翻译成普通 JSON，交给 `service.js` 记账和展示。
 */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/* ------------------------------------------------------------------ *
 * 页面脚本：读题 / 填题 / 读结果 / 播放视频 / 论坛
 * ------------------------------------------------------------------ */

/** 把 HTML 变成一行纯文本。 */
const PLAIN = `(value) => String(value || '')
  .replace(/<br\\s*\\/?>/gi, ' ')
  .replace(/<\\/(p|div|li|h\\d|tr)>/gi, ' ')
  .replace(/<[^>]+>/g, '')
  .replace(/&nbsp;/g, ' ')
  .replace(/&amp;/g, '&')
  .replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>')
  .replace(/\\s+/g, ' ')
  .trim()`

/**
 * 读整卷。
 *
 * 平台试卷每道题都挂在 Angular scope 上（`subject`），比解析 DOM 更稳：
 * 类型、题干、选项 id、已选状态、分值都是结构化字段，选项 id 才是填题时要点的
 * 值（页面上 `input[value]` 就是它）。
 */
export const EXAM_READ_SCRIPT = `(() => {
  const plain = ${PLAIN}
  const heads = Array.from(document.querySelectorAll('.subject-head'))
  const questions = []
  // 阅读理解的小题既是父题的 sub_subjects，也会单独渲染成 .subject-head，
  // 同一个 subject 会出现两次；按 subjectId 去重，只保留第一次。
  const seen = new Set()
  for (const head of heads) {
    let scope
    try { scope = window.angular.element(head).scope() } catch (error) { continue }
    const parent = scope && scope.subject
    if (!parent || !parent.type) continue
    // 题干说明不是题；阅读理解大题本身也不算题，它的 sub_subjects 才是。
    if (parent.type === 'text') continue
    const children = Array.isArray(parent.sub_subjects) && parent.sub_subjects.length > 0 ? parent.sub_subjects : null
    const list = children ?? [parent]
    const box = head.closest('.subject') || head.closest('[ng-repeat]') || head.parentElement
    for (const subject of list) {
      if (!subject || !subject.type || subject.type === 'text' || subject.type === 'analysis') continue
      if (seen.has(subject.id)) continue
      seen.add(subject.id)
      const indexNode = head.querySelector('.subject-resort-index')
      const indexText = indexNode ? String(indexNode.innerText || '').replace(/[^0-9]/g, '') : ''
      const ordered = (subject.options || []).slice().sort((left, right) => (left.sort || 0) - (right.sort || 0))
      const options = ordered.map((option, position) => ({
        letter: String.fromCharCode(65 + position),
        id: option.id,
        text: plain(option.content),
        checked: option.checked === true,
        answered: subject.answeredOption === option.id,
      }))
      const editor = box ? box.querySelector('[contenteditable="true"]') : null
      const textarea = box ? box.querySelector('textarea') : null
      const blank = box ? box.querySelector('input[type="text"]') : null
      const text = editor ? String(editor.innerText || '').trim()
        : (textarea ? String(textarea.value || '').trim() : (blank ? String(blank.value || '').trim() : ''))
      questions.push({
        // 题号只在同一组内连续（阅读理解的小题会从 1 重新编号），所以用"页面顺序"
        // 当唯一键，另存 label 给人看。
        seq: questions.length + 1,
        label: Number(indexText) || questions.length + 1,
        nested: Boolean(children),
        subjectId: subject.id,
        type: subject.type,
        stem: plain(subject.description),
        points: Number(subject.point || 0),
        options,
        answeredOption: subject.answeredOption || null,
        checkedCount: options.filter((option) => option.checked).length,
        text,
        textLength: text.length,
        hasEditor: Boolean(editor),
      hasUpload: Boolean(box && box.querySelector('.add-attachment-btn')),
      })
    }
  }
  const progressMatch = String(document.body.innerText || '').match(/答题进度[:：]\\s*(\\d+)\\s*\\/\\s*(\\d+)/)
  const scoreMatch = String(document.body.innerText || '').match(/试卷得分[:：]?\\s*([0-9.]+|未评分)/)
  return {
    url: location.href,
    questions,
    progress: progressMatch ? { answered: Number(progressMatch[1]), total: Number(progressMatch[2]) } : null,
    scoreText: scoreMatch ? scoreMatch[1] : null,
  }
})()`

/**
 * 按计划填题。
 *
 * `plan` 的每一项：`{ seq, letters?: string[], text?: string }`。客观题按选项 id 点击
 * 真实 input（Angular 的 ng-change 才认），主观题直接写 simditor 的 contenteditable
 * 并派发 input 事件（平台靠这个把内容同步回 textarea 和模型）。
 */
export function examFillScript(plan) {
  return `(async () => {
    const plan = ${JSON.stringify(plan)}
    const report = []
    const plain = ${PLAIN}
    const heads = Array.from(document.querySelectorAll('.subject-head'))
    const bySeq = new Map()
    const seen = new Set()
    let order = 0
    for (const head of heads) {
      let scope
      try { scope = window.angular.element(head).scope() } catch (error) { continue }
      const parent = scope && scope.subject
      if (!parent || !parent.type || parent.type === 'text') continue
      const children = Array.isArray(parent.sub_subjects) && parent.sub_subjects.length > 0 ? parent.sub_subjects : null
      const list = children ?? [parent]
      for (const subject of list) {
        if (!subject || !subject.type || subject.type === 'text' || subject.type === 'analysis') continue
        if (seen.has(subject.id)) continue
        seen.add(subject.id)
        order += 1
        bySeq.set(order, { head, subject, nested: Boolean(children) })
      }
    }
    for (const item of plan) {
      const target = bySeq.get(Number(item.seq))
      if (!target) { report.push({ seq: item.seq, ok: false, note: '页面上没有这道题' }); continue }
      const { head, subject } = target
      const box = head.closest('.subject') || head.closest('[ng-repeat]') || head.parentElement
      if (item.text) {
        const editor = box.querySelector('[contenteditable="true"]')
        if (editor) {
          editor.focus()
          editor.innerHTML = '<p>' + String(item.text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/\\n/g, '</p><p>') + '</p>'
          editor.dispatchEvent(new InputEvent('input', { bubbles: true, data: 'x' }))
          editor.dispatchEvent(new Event('change', { bubbles: true }))
          editor.blur()
          const written = String(editor.innerText || '').trim().length
          report.push({ seq: item.seq, ok: written > 0, note: written > 0 ? '已写入 ' + written + ' 字' : '写入后为空' })
          continue
        }
        const input = box.querySelector('input[type="text"], textarea')
        if (input) {
          const prototype = input.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
          const setter = Object.getOwnPropertyDescriptor(prototype, 'value').set
          setter.call(input, String(item.text))
          input.dispatchEvent(new Event('input', { bubbles: true }))
          input.dispatchEvent(new Event('change', { bubbles: true }))
          report.push({ seq: item.seq, ok: String(input.value).length > 0, note: '已填入填空框' })
          continue
        }
        report.push({ seq: item.seq, ok: false, note: '没有可写的编辑器' })
        continue
      }
      const letters = (Array.isArray(item.letters) ? item.letters : []).map((value) => String(value).toUpperCase())
      if (letters.length === 0) { report.push({ seq: item.seq, ok: false, note: '没有答案' }); continue }
      // 页面上选项的顺序就是字母顺序；多选题的 input 没有 value 属性，只能按位置点。
      const inputs = Array.from(box.querySelectorAll('li.option input, ol.subject-options input'))
      const multiple = String(subject.type) === 'multiple_selection'
      let clicked = 0
      for (const letter of letters) {
        const index = letter.charCodeAt(0) - 65
        const ordered = (subject.options || []).slice().sort(function (a, b) { return (a.sort || 0) - (b.sort || 0) })
        const option = ordered[index]
        // 阅读理解的小题和父题共用一个容器，按位置找会串题；选项 id 是全局唯一的，
        // 优先用它定位；同一题可能渲染了两份，全部点一遍。
        const candidates = option ? Array.from(document.querySelectorAll('input[value="' + option.id + '"]')) : []
        let input = candidates.length ? candidates[0] : inputs[index]
        for (const node of candidates) {
          if (!node.checked) node.click()
        }
        if (input && !input.checked) {
          input.click()
          if (!input.checked) input.dispatchEvent(new MouseEvent('click', { bubbles: true }))
        }
        if (input && input.checked) { clicked += 1; continue }
        // 兜底：直接改 Angular 模型再通知一次变更（有的皮肤把 input 包在禁用指针的层里）。
        try {
          const scope = window.angular.element(head).scope()
          scope.$apply(function () {
            const options = (subject.options || []).slice().sort(function (a, b) { return (a.sort || 0) - (b.sort || 0) })
            const option = options[index]
            if (!option) return
            if (multiple) option.checked = true
            else subject.answeredOption = option.id
            if (typeof scope.onChangeSubmission === 'function') scope.onChangeSubmission(subject)
          })
          if ((multiple && inputs[index] && inputs[index].checked) || (!multiple && subject.answeredOption)) clicked += 1
        } catch (error) { /* 模型兜底失败就按没选中算 */ }
      }
      report.push({ seq: item.seq, ok: clicked === letters.length, note: '已选 ' + clicked + '/' + letters.length })
    }
    await new Promise((resolve) => setTimeout(resolve, 600))
    const progress = String(document.body.innerText || '').match(/答题进度[:：]\\s*(\\d+)\\s*\\/\\s*(\\d+)/)
    return {
      report,
      progress: progress ? { answered: Number(progress[1]), total: Number(progress[2]) } : null,
    }
  })()`
}

/** 视频页：把播放器里的 <video> 找出来并快进播放。 */
export function videoPlayScript(rate) {
  return `(async () => {
    const video = document.querySelector('.mvp-player-content video') || document.querySelector('video')
    if (!video) return { ok: false, note: '页面上还没有播放器' }
    video.muted = true
    video.playbackRate = ${JSON.stringify(Number(rate) || 16)}
    try { await video.play() } catch (error) { return { ok: false, note: '播放被拒绝：' + error.message } }
    await new Promise((resolve) => setTimeout(resolve, 1200))
    return {
      ok: true,
      duration: Math.round(video.duration || 0),
      position: Math.round(video.currentTime || 0),
      paused: video.paused === true,
      rate: video.playbackRate,
    }
  })()`
}

/** 视频页：读播放进度。 */
export const VIDEO_STATE_SCRIPT = `(() => {
  const video = document.querySelector('.mvp-player-content video') || document.querySelector('video')
  if (!video) return { ok: false }
  return {
    ok: true,
    duration: Math.round(video.duration || 0),
    position: Math.round(video.currentTime || 0),
    paused: video.paused === true,
    ended: video.ended === true,
    rate: video.playbackRate,
  }
})()`

/** 论坛页：把当前可见的帖子正文读出来（用于"已有同学作答就复用"）。 */
export const FORUM_READ_SCRIPT = `(() => {
  const plain = ${PLAIN}
  const nodes = Array.from(document.querySelectorAll('[class*="post"], [class*="topic"], .article, li'))
  const posts = []
  const seen = new Set()
  for (const node of nodes) {
    const text = plain(node.innerText)
    if (text.length < 40 || seen.has(text.slice(0, 60))) continue
    if (!/\\d+\\s*(分钟|小时|天)前|刚刚/.test(text)) continue
    seen.add(text.slice(0, 60))
    posts.push(text.slice(0, 600))
    if (posts.length >= 8) break
  }
  const titleInput = Array.from(document.querySelectorAll('input[type="text"], input:not([type])'))
    .filter((input) => input.getBoundingClientRect().height > 0)
  return {
    url: location.href,
    posts,
    hasEditor: Array.from(document.querySelectorAll('[contenteditable="true"]')).some((node) => node.getBoundingClientRect().height > 0 && node.innerText.trim().length >= 0),
    textInputs: titleInput.length,
  }
})()`

/** 论坛页：填标题与正文（发表帖子弹窗里）。 */
export function forumFillScript(title, body) {
  return `(() => {
    const inputs = Array.from(document.querySelectorAll('input[type="text"], input:not([type])'))
      .filter((input) => input.getBoundingClientRect().height > 0)
    const titleInput = inputs[inputs.length - 1]
    if (!titleInput) return { ok: false, note: '没有标题输入框' }
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    setter.call(titleInput, ${JSON.stringify(title)})
    titleInput.dispatchEvent(new Event('input', { bubbles: true }))
    titleInput.dispatchEvent(new Event('change', { bubbles: true }))
    const editor = Array.from(document.querySelectorAll('[contenteditable="true"]'))
      .find((node) => node.getBoundingClientRect().height > 0)
    if (!editor) return { ok: false, note: '没有正文编辑器' }
    editor.focus()
    editor.innerHTML = '<p>' + String(${JSON.stringify(body)}).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/\\n/g, '</p><p>') + '</p>'
    editor.dispatchEvent(new InputEvent('input', { bubbles: true, data: 'x' }))
    editor.dispatchEvent(new Event('change', { bubbles: true }))
    editor.blur()
    return { ok: String(editor.innerText || '').trim().length > 0, title: titleInput.value.slice(0, 40), bodyLength: String(editor.innerText || '').trim().length }
  })()`
}

/* ------------------------------------------------------------------ *
 * 页面地址
 * ------------------------------------------------------------------ */

export const URLS = {
  examIntro: (courseId, activityId) => `https://lms.ouchn.cn/course/${courseId}/learning-activity#/exam/${activityId}`,
  examTake: (examId) => `https://lms.ouchn.cn/exam/${examId}/subjects#/take`,
  activityFull: (courseId, activityId) => `https://lms.ouchn.cn/course/${courseId}/learning-activity/full-screen#/${activityId}`,
  // 作业类活动（学习记录、学习行为评价、大作业）没有 exam 路由，必须用 full-screen 的
  // activity 路由，否则平台返回"未找到资源/没有权限"。
  homework: (courseId, activityId) => `https://lms.ouchn.cn/course/${courseId}/learning-activity/full-screen#/${activityId}`,
  forum: (courseId, activityId) => `https://lms.ouchn.cn/course/${courseId}/learning-activity/full-screen#/${activityId}`,
  reads: (courseId) => `https://lms.ouchn.cn/api/course/${courseId}/activity-reads-for-user`,
  activity: (activityId) => `https://lms.ouchn.cn/api/activities/${activityId}`,
}

/**
 * 打开作业类活动，判断学生端到底有没有提交入口。
 *
 * 平台把「学习记录 / 学习行为评价 / 大作业」都做成 homework，评分方式是「教师评阅
 * 100%」，学生端只有一个「我的作业」页签，多数课程没有可提交的表单。这里把页面事实
 * 读出来，交给上层决定是记录还是提交，而不是笼统判失败。
 */
export async function inspectHomework(session, task) {
  await session.goto(URLS.homework(task.courseId, task.activityId))
  await waitFor(session, 'Boolean(document.body && document.body.innerText.length > 200)', 15000)
  await sleep(600)
  const page = await session.evaluate(`(() => {
    const text = String(document.body.innerText || '').replace(/\\s+/g, ' ')
    const hasForm = Boolean(document.querySelector('[contenteditable="true"], textarea, input[type="file"]'))
    const submitted = /已提交作业|已批阅|得分[:：]/.test(text) && !/尚未提交作业/.test(text)
    return {
      url: location.href,
      text: text.slice(-600),
      hasForm,
      submitted,
      teacherOnly: /教师评阅\\s*100/.test(text),
      notSubmitted: /尚未提交作业/.test(text),
    }
  })()`)
  return page
}


/* ------------------------------------------------------------------ *
 * 考试：进入 / 读卷 / 填卷 / 交卷 / 读结果
 * ------------------------------------------------------------------ */

/** 在页面里轮询一个条件。 */
async function waitFor(session, expression, timeoutMs = 15000, intervalMs = 350) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await session.evaluate(expression).catch(() => false)
    if (value) return value
    await sleep(intervalMs)
  }
  return false
}

/** 给页面上某个元素临时打 id，便于用真实的鼠标点击它。 */
async function tagElement(session, finder, id) {
  const expression = `(() => {
    const found = (${finder})
    if (!found) return false
    found.id = ${JSON.stringify(id)}
    return true
  })()`
  return session.evaluate(expression)
}

const CLICK_BY_TEXT = (text, tags = 'button,a,span,div') => `(() => {
  const wanted = ${JSON.stringify(text)}
  const candidates = Array.from(document.querySelectorAll(${JSON.stringify(tags)}))
  const hit = candidates.filter((node) => {
    const label = (node.innerText || '').trim()
    if (label !== wanted) return false
    const rect = node.getBoundingClientRect()
    return rect.width > 0 && rect.height > 0
  })
  return hit.length ? hit[hit.length - 1] : null
})()`

/**
 * 打开任务页并进入答题界面。
 *
 * 返回状态机里的阶段：`intro`（等待开始）、`take`（在答题页）、`blocked`（平台
 * 给出不可作答的原因）、`submitted`（已交卷，显示成绩或待批改）。
 */
export async function enterExam(session, task) {
  const trace = []
  const intro = URLS.examIntro(task.courseId, task.activityId)
  await session.goto(intro)
  // 单页应用在 readyState 之后才去拉活动详情，正文一开始只有百来字，
  // 所以要等"开始答题 / 继续答题"这个入口真的渲染出来。
  const linkReady = await waitFor(session, `(() => {
    const hits = Array.from(document.querySelectorAll('a, button')).filter((node) => {
      const label = (node.innerText || '').trim()
      if (!['开始答题', '继续答题', '再次答题'].includes(label)) return false
      const rect = node.getBoundingClientRect()
      return rect.width > 0 && rect.height > 0
    })
    return hits.length > 0
  })()`, 20000)
  const state = await session.evaluate(`(() => {
    const text = String(document.body.innerText || '').replace(/\\s+/g, ' ')
    return { url: location.href, text: text.slice(-1200) }
  })()`)
  trace.push({ step: 'loaded', url: state.url, len: state.text.length, link: Boolean(linkReady) })
  if (/未到|尚未开始|不能作答|无法进入|没有权限|已结束|已关闭|您不是此学习活动的指定参与人员/.test(state.text)) {
    return { ok: false, phase: 'blocked', reason: pickReason(state.text), url: state.url, trace }
  }
  if (!linkReady) {
    // 没有入口：可能已经交过卷（只剩成绩/答题记录），也可能页面结构变了。
    const submitted = /试卷得分|答题记录|已提交|查看成绩/.test(state.text)
    return {
      ok: false,
      phase: submitted ? 'submitted' : 'blocked',
      reason: submitted ? null : pickReason(state.text) || '页面上找不到开始答题入口',
      url: state.url,
      trace,
    }
  }

  // 点入口链接，等考试须知弹窗。
  const linkId = await session.evaluate(`(() => {
    const hits = Array.from(document.querySelectorAll('a, button')).filter((node) => {
      const label = (node.innerText || '').trim()
      if (!['开始答题', '继续答题', '再次答题'].includes(label)) return false
      const rect = node.getBoundingClientRect()
      return rect.width > 0 && rect.height > 0
    })
    if (!hits.length) return null
    const target = hits[hits.length - 1]
    target.id = 'wb-start-link'
    return target.innerText.trim()
  })()`)
  await session.perform({ action: 'click', selector: '#wb-start-link' })
  trace.push({ step: 'link-click', label: linkId })

  const popupReady = await waitFor(session, `Boolean(document.querySelector('input[name="confirm"]'))`, 8000)
  trace.push({ step: 'popup', ready: Boolean(popupReady) })
  // 勾选"我已知晓考试要求"。复选框是隐藏的，点 label 没用，必须点到 input 本身。
  const agreeState = await session.evaluate(`(() => {
    const box = document.querySelector('input[name="confirm"]')
    if (!box) return 'missing'
    box.id = 'wb-agree'
    return box.checked ? 'already' : 'tagged'
  })()`)
  trace.push({ step: 'agree', state: agreeState })
  if (agreeState === 'tagged') {
    await session.perform({ action: 'click', selector: '#wb-agree' })
    await sleep(250)
    let ok = Boolean(await session.evaluate(`(() => { const box = document.querySelector('input[name="confirm"]'); return Boolean(box && box.checked) })()`))
    if (!ok) {
      await session.evaluate(`(() => { const box = document.querySelector('input[name="confirm"]'); if (box && !box.checked) { box.click(); return true } return false })()`)
      await sleep(250)
      ok = Boolean(await session.evaluate(`(() => { const box = document.querySelector('input[name="confirm"]'); return Boolean(box && box.checked) })()`))
    }
    trace.push({ step: 'agree-click', checked: ok })
    if (!ok) return { ok: false, phase: 'intro', reason: '勾不上"我已知晓考试要求"，开始按钮无法启用', url: state.url, trace }
    await sleep(300)
  }

  // 弹窗里的按钮才是真正开始答题的那个。勾选后弹窗有时会被关掉，那就再点一次
  // 入口把弹窗叫回来（复选框状态会保留）。
  const popupVisible = `Boolean(document.querySelector('.popup-content') && document.querySelector('.popup-content').getBoundingClientRect().height > 0)`
  if (!(await session.evaluate(popupVisible))) {
    await session.evaluate(`(() => {
      const hits = Array.from(document.querySelectorAll('a, button')).filter((node) => {
        const label = (node.innerText || '').trim()
        return ['开始答题', '继续答题', '再次答题'].includes(label) && node.getBoundingClientRect().height > 0
      })
      if (!hits.length) return false
      hits[hits.length - 1].id = 'wb-start-link'
      return true
    })()`)
    await session.perform({ action: 'click', selector: '#wb-start-link' })
    await waitFor(session, popupVisible, 8000)
    await sleep(300)
  }
  trace.push({ step: 'popup-visible', ok: Boolean(await session.evaluate(popupVisible)) })

  const target = await waitFor(session, `(() => {
    const popup = document.querySelector('.popup-content')
    const scope = popup && popup.getBoundingClientRect().height > 0 ? popup : document
    const hits = Array.from(scope.querySelectorAll('button, a.button')).filter((b) => {
      const label = (b.innerText || '').trim()
      return /开始答题|继续答题|再次答题/.test(label) && !b.disabled && b.getBoundingClientRect().height > 0
    })
    if (!hits.length) return false
    const hit = hits[hits.length - 1]
    hit.id = 'wb-start'
    return true
  })()`, 8000)
  trace.push({ step: 'start-ready', ready: Boolean(target) })
  if (!target) return { ok: false, phase: 'intro', reason: '开始答题按钮一直是禁用的（可能缺前置条件或测试未开放）', url: state.url, trace }
  const startClick = await session.perform({ action: 'click', selector: '#wb-start' })
  trace.push({ step: 'start-click', ok: startClick.ok === true, note: startClick.note })

  let arrived = await waitFor(session, `location.href.indexOf('/subjects') > 0 || Boolean(document.querySelector('.subject-head'))`, 22000)
  trace.push({ step: 'arrived', ok: Boolean(arrived) })
  if (!arrived) {
    await sleep(1500)
    const confirmClick = await session.evaluate(`(() => {
      const hits = Array.from(document.querySelectorAll('button')).filter((b) => {
        const label = (b.innerText || '').trim()
        return /^(确定|确认|继续|进入)$/.test(label) && b.getBoundingClientRect().height > 0 && !b.disabled
      })
      if (!hits.length) return null
      const hit = hits[hits.length - 1]
      hit.id = 'wb-dialog-confirm'
      return hit.innerText.trim()
    })()`)
    trace.push({ step: 'dialog', found: Boolean(confirmClick) })
    if (confirmClick) await session.perform({ action: 'click', selector: '#wb-dialog-confirm' })
    arrived = await waitFor(session, `location.href.indexOf('/subjects') > 0 || Boolean(document.querySelector('.subject-head'))`, 15000)
    trace.push({ step: 'arrived2', ok: Boolean(arrived) })
  }
  const after = await session.evaluate('({ url: location.href, text: String(document.body.innerText || "").replace(/\\s+/g, " ").slice(0, 300) })')
  if (!arrived) {
    const now = await session.evaluate(`(() => {
      const box = document.querySelector('input[name="confirm"]')
      const hit = Array.from(document.querySelectorAll('button')).find((b) => /继续答题|开始答题/.test((b.innerText || '').trim()))
      return { checked: Boolean(box && box.checked), disabled: hit ? hit.disabled : null }
    })()`)
    trace.push({ step: 'after', ...now })
    return { ok: false, phase: 'blocked', reason: pickReason(after.text) || '点了开始答题但没有进入答题页', url: after.url, trace }
  }
  return { ok: true, phase: 'take', url: after.url, trace }
}

function pickReason(text) {
  const patterns = [
    /该学习活动尚未解锁[^。]*/,
    /未到(?:答题|测试|考试)?(?:开放)?时间[^。]*/,
    /测试(?:尚未|还未)开始[^。]*/,
    /已(?:过|超过)(?:答题|测试|考试)?(?:截止)?时间[^。]*/,
    /您没有权限完成此操作/,
    /允许尝试次数已用完[^。]*/,
    /次数已用完[^。]*/,
  ]
  for (const pattern of patterns) {
    const hit = pattern.exec(String(text || ''))
    if (hit) return hit[0].trim()
  }
  return null
}

/** 读整卷。 */
export async function readExam(session) {
  let last = null
  for (let attempt = 0; attempt < 10; attempt += 1) {
    last = await session.evaluate(EXAM_READ_SCRIPT).catch((error) => ({ error: String(error?.message ?? error) }))
    if (last && Array.isArray(last.questions) && last.questions.length > 0) return last
    // 刚跳转过来时 DOM 还没渲染完，等一下再看。
    await waitFor(session, `document.querySelectorAll('.subject-head').length > 2`, 4000)
    await sleep(500)
  }
  throw new Error(`没有读到试题：页面可能还没渲染完，或不在答题页${last && last.error ? `（${last.error}）` : ''}`)
}

/** 按计划填题，返回逐题结果。 */
export async function fillExam(session, plan) {
  if (!Array.isArray(plan) || plan.length === 0) throw new Error('作答计划为空')
  const result = await session.evaluate(examFillScript(plan))
  return result
}

/** 交卷：点交卷 → 点确认，等待结果页。 */
export async function submitExam(session) {
  const tagged = await tagElement(session, `(() => {
    const nodes = Array.from(document.querySelectorAll('a,button'))
    const hits = nodes.filter((node) => (node.innerText || '').trim() === '交卷' && node.getBoundingClientRect().height > 0)
    return hits.length ? hits[hits.length - 1] : null
  })()`, 'wb-submit')
  if (!tagged) return { ok: false, note: '页面上没有交卷按钮' }
  const first = await session.perform({ action: 'click', selector: '#wb-submit' })
  if (!first.ok) return { ok: false, note: first.note }
  // 确认框里的按钮文案不统一（"确定" / "提交所有答案并结束"），等它出现再点。
  const confirmReady = await waitFor(session, `(() => {
    const hits = Array.from(document.querySelectorAll('button')).filter((node) => {
      const label = (node.innerText || '').trim()
      if (!/^(确定|确认|提交所有答案并结束|提交|结束)$/.test(label)) return false
      return node.getBoundingClientRect().height > 0 && !node.disabled
    })
    if (!hits.length) return false
    hits[hits.length - 1].id = 'wb-confirm'
    return true
  })()`, 8000)
  if (!confirmReady) return { ok: false, note: '交卷确认框没有出现' }
  const confirmed = await session.perform({ action: 'click', selector: '#wb-confirm' })
  if (!confirmed.ok) return { ok: false, note: confirmed.note }
  const arrived = await waitFor(session, `/submission\\//.test(location.href)`, 25000)
  const where = await session.evaluate('({ url: location.href, text: String(document.body.innerText || "").replace(/\\s+/g, " ").slice(0, 400) })')
  if (!arrived) return { ok: false, note: `交卷后没有跳到结果页：${where.text.slice(0, 80)}`, url: where.url }
  return { ok: true, url: where.url }
}

/** 读平台判分：总分、是否已公布、逐题得分。 */
export async function readResult(session) {
  // 结果页先渲染骨架再异步拉逐题数据，等"试卷得分 / 未评分"出现再读，否则会读到 0。
  await waitFor(session, `/(试卷得分|未评分)/.test(String(document.body.innerText || ''))`, 20000)
  await sleep(500)
  const value = await session.evaluate(`(() => {
    const text = String(document.body.innerText || '').replace(/\\s+/g, ' ')
    const score = text.match(/试卷得分[:：]?\\s*([0-9.]+|未评分)/)
    const auto = text.match(/自动判分[:：]?\\s*([0-9.]+)/)
    const questions = []
    document.querySelectorAll('.subject-head').forEach((head) => {
      let scope
      try { scope = window.angular.element(head).scope() } catch (error) { return }
      const subject = scope && scope.subject
      if (!subject || !subject.type || subject.type === 'text') return
      const indexNode = head.querySelector('.subject-resort-index')
      const seq = Number((indexNode ? indexNode.innerText : '').replace(/[^0-9]/g, '')) || questions.length + 1
      const box = head.closest('.subject') || head.parentElement
      const boxText = String(box ? box.innerText : '').replace(/\\s+/g, ' ')
      // 结果页的格式是"单选题 (3 分) 3分"，第二个数字才是这道题的得分。
      const got = boxText.match(/([0-9.]+)\\s*\\/\\s*([0-9.]+)\\s*分/)
        || boxText.match(/[)）]\\s*([0-9.]+)\\s*分/)
        || boxText.match(/得(?:分)?[:：]?\\s*([0-9.]+)/)
      questions.push({
        seq,
        type: subject.type,
        max: Number(subject.point || 0),
        got: got ? Number(got[1]) : null,
        text: boxText.slice(0, 160),
      })
    })
    return {
      url: location.href,
      scoreText: score ? score[1] : null,
      autoText: auto ? auto[1] : null,
      questions,
      text: text.slice(0, 600),
    }
  })()`)
  return value
}

/* ------------------------------------------------------------------ *
 * 视频：刷进度直到满足前置条件
 * ------------------------------------------------------------------ */

/** 读某个活动的完成度（0-100）与状态。 */
export async function readCompleteness(session, courseId, activityId) {
  const value = await session.evaluate(`fetch(${JSON.stringify(URLS.reads(courseId))}, { credentials: 'include' })
    .then((response) => response.json())
    .then((json) => {
      const list = (json && json.activity_reads) || []
      const hit = list.find((item) => String(item.activity_id) === ${JSON.stringify(String(activityId))})
      return hit ? { completeness: Number((hit.data && hit.data.completeness) || 0), status: hit.completeness, at: hit.last_visited_at } : null
    })
    .catch(() => null)`)
  return value
}

/**
 * 播放视频直到完成度达标。
 *
 * 平台按播放器上报的观看向量算完成度，所以不能只改 currentTime，必须真的播：
 * 用 16 倍速从头播到尾，每 20 秒回读一次完成度。
 */
export async function watchVideo(session, task, options = {}) {
  const rate = Number(options.rate) || 16
  const want = Number(options.need) || 80
  const maxMs = Number(options.maxMs) || 240000
  await session.goto(URLS.activityFull(task.courseId, task.activityId))
  const ready = await waitFor(session, `Boolean(document.querySelector('.mvp-player-content video') || document.querySelector('video'))`, 20000)
  if (!ready) return { ok: false, note: '视频页没有加载出播放器' }
  const started = await session.evaluate(videoPlayScript(rate))
  if (!started.ok) return { ok: false, note: started.note }
  const before = await readCompleteness(session, task.courseId, task.activityId)
  const deadline = Date.now() + maxMs
  let last = before
  while (Date.now() < deadline) {
    await sleep(20000)
    const state = await session.evaluate(VIDEO_STATE_SCRIPT)
    if (state && state.ok && state.paused && !state.ended) {
      // 页面失焦会暂停，重新播。
      await session.evaluate(videoPlayScript(rate))
    }
    last = await readCompleteness(session, task.courseId, task.activityId)
    if (last && last.completeness >= want) break
    if (state && state.ok && state.ended && last && last.completeness < want) {
      // 播到结尾但完成度不够：再从头播一遍（有的课程要求重复观看）。
      await session.evaluate(videoPlayScript(rate))
    }
  }
  const after = last || before
  return {
    ok: Boolean(after && after.completeness >= want),
    before: before ? before.completeness : null,
    after: after ? after.completeness : null,
    need: want,
    duration: started.duration,
  }
}

/* ------------------------------------------------------------------ *
 * 讨论区
 * ------------------------------------------------------------------ */

/** 打开讨论页并读现有帖子。 */
export async function openForum(session, task) {
  await session.goto(URLS.forum(task.courseId, task.activityId))
  // 讨论页的正文也是异步加载的：先只渲染左侧目录，必须等"发表帖子"出现。
  await waitFor(session, `Array.from(document.querySelectorAll('button,a.button')).some((node) => (node.innerText || '').trim() === '发表帖子')`, 15000)
  await sleep(300)
  const page = await session.evaluate(`(() => {
    const text = String(document.body.innerText || '').replace(/\\s+/g, ' ')
    const posts = []
    document.querySelectorAll('li, [class*="post"], [class*="reply"]').forEach((node) => {
      const value = String(node.innerText || '').replace(/\\s+/g, ' ').trim()
      if (value.length < 80) return
      if (!/\\d+\\s*(分钟|小时|天)前|刚刚/.test(value)) return
      if (posts.some((item) => item.startsWith(value.slice(0, 40)))) return
      posts.push(value.slice(0, 700))
    })
    return {
      url: location.href,
      text: text.slice(0, 400),
      posts: posts.slice(0, 6),
      canPost: Array.from(document.querySelectorAll('button,a.button')).some((node) => (node.innerText || '').trim() === '发表帖子'),
      mine: /杨海飞/.test(text),
    }
  })()`)
  return page
}

/** 在讨论页发一条帖子。 */
export async function postForum(session, task, entry) {
  const title = String(entry.title || '').slice(0, 60) || `对「${String(task.title).slice(0, 20)}」的理解`
  const body = String(entry.body || '').trim()
  if (!body) return { ok: false, note: '没有正文' }
  const opened = await tagElement(session, CLICK_BY_TEXT('发表帖子'), 'wb-post')
  if (!opened) return { ok: false, note: '没有"发表帖子"按钮' }
  const click = await session.perform({ action: 'click', selector: '#wb-post' })
  if (!click.ok) return { ok: false, note: click.note }
  await sleep(1200)
  const filled = await session.evaluate(forumFillScript(title, body))
  if (!filled.ok) return { ok: false, note: filled.note }
  const saved = await tagElement(session, CLICK_BY_TEXT('保存'), 'wb-save')
  if (!saved) return { ok: false, note: '没有保存按钮' }
  const saveClick = await session.perform({ action: 'click', selector: '#wb-save' })
  if (!saveClick.ok) return { ok: false, note: saveClick.note }
  await sleep(2500)
  const after = await session.evaluate(`(() => {
    const text = String(document.body.innerText || '').replace(/\\s+/g, ' ')
    return { posted: text.indexOf(${JSON.stringify(title.slice(0, 12))}) >= 0, text: text.slice(0, 300) }
  })()`)
  return { ok: after.posted, title, bodyLength: body.length, note: after.posted ? '已发帖' : '提交后没有在列表里看到这条帖子的标题' }
}
