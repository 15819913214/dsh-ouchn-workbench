/**
 * 国开作业 · 工作台 backend — Host half.
 *
 * Registers the model-facing tools that sign in, read the real course catalog,
 * and solve a locally simulated paper, plus the three routes the panel needs:
 * the state snapshot it polls, the live browser frame, the simulated paper, and
 * the generated report.
 *
 * The tool shapes are plain registry objects (no `defineTool` import): a locally
 * linked bundle has no physical node_modules entry for the Harness packages, so a
 * bare import would fail at load. The registry needs `{ name, description,
 * parameters, output, execute }`.
 */
import path from 'node:path'
import { execFile } from 'node:child_process'
import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { WorkbenchService } from './src/service.js'
import { renderPaper } from './src/mock.js'

export const name = 'workbench'

/** Only the tool registry is mandatory; routes are optional. */
export const inject = ['tools']

const packageDir = path.dirname(fileURLToPath(import.meta.url))

const TEXT = (text) => [{ type: 'text', text }]
const OUTPUT_SCHEMA = { type: 'object', additionalProperties: true }

/* ------------------------------------------------------------------ *
 * Model-facing rendering
 * ------------------------------------------------------------------ */

const STAGE_LABEL = { FORMATIVE: '形考', FINAL: '终考', DISCUSSION: '讨论' }

/** 真实作答阶段的中文名，给模型和面板共用。 */
const PHASE_LABEL = {
  queued: '排队中',
  entering: '进入答题页',
  reading: '读取试题',
  filling: '填写答案',
  filled: '已填写未交卷',
  submitting: '交卷中',
  submitted: '已交卷',
  'needs-answers': '缺答案未交卷',
  blocked: '平台不允许作答',
  failed: '失败',
  'fill-failed': '填写失败',
  'verify-failed': '回读不一致',
  'submit-failed': '交卷失败',
  error: '脚本报错',
  video: '刷视频中',
  read: '已读题',
  pending: '待处理',
}

function format(value) {
  if (!value || typeof value !== 'object') return String(value ?? '')
  const lines = []
  const push = (label, text) => { if (text !== undefined && text !== null && text !== '') lines.push(`${label}: ${text}`) }

  if (value.summary && typeof value.summary === 'object') return format(value.summary)

  // 真实作答的单任务结果：阶段、平台分数、缺答案清单，比通用字段更直接。
  if (value.action && ['run', 'video', 'discussion'].includes(value.action) && (value.phase || value.note)) {
    if (value.task) push('任务', `${value.task.course} · ${value.task.title}`)
    if (value.phase) push('阶段', PHASE_LABEL[value.phase] ?? value.phase)
    if (value.score !== undefined && value.score !== null) push('平台判分', `${value.score} 分`)
    if (value.answered !== undefined && value.total) push('作答', `${value.answered}/${value.total} 题`)
    if (value.note) push('结果', value.note)
    if (Array.isArray(value.missing) && value.missing.length) {
      lines.push('', '缺答案（未交卷）:')
      for (const item of value.missing) lines.push(`- #${item.seq}（${item.type}）${item.stem}`)
    }
    if (Array.isArray(value.failed) && value.failed.length) {
      lines.push('', '填写失败:')
      for (const item of value.failed) lines.push(`- #${item.seq} ${item.note}`)
    }
    if (Array.isArray(value.detail) && value.detail.length) {
      const fromLibrary = value.detail.filter((item) => item.source && item.source.startsWith('题库')).length
      const fromAi = value.detail.filter((item) => item.source === '人工答案').length
      push('来源', `题库 ${fromLibrary} · 人工/AI ${fromAi} · 合计 ${value.detail.length}`)
    }
    return lines.join('\n')
  }

  if (value.url) push('页面', value.url)
  if (value.title) push('标题', value.title)
  if (value.student) push('学生', `${value.student.name ?? ''} ${value.student.account ?? ''}`.trim())
  if (value.courses !== undefined && Array.isArray(value.list)) {
    push('课程', `${value.courses} 门`)
    for (const course of value.list) {
      const counts = course.counts ?? {}
      lines.push(`- ${course.name}（形考 ${counts.FORMATIVE ?? 0} · 终考 ${counts.FINAL ?? 0} · 讨论 ${counts.DISCUSSION ?? 0}）`
        + `${course.library ? ` 答案库 ${course.library.count} 题` : ' 答案库未覆盖'}`)
    }
  } else if (value.courses !== undefined) {
    push('课程', `${value.courses} 门`)
  }
  if (value.tasks !== undefined) push('任务', `${value.tasks} 个`)
  if (value.byAvailability) push('可执行性', Object.entries(value.byAvailability).map(([key, count]) => `${key} ${count}`).join(' · '))
  if (Array.isArray(value.uncovered) && value.uncovered.length) push('答案库未覆盖', value.uncovered.join('、'))
  if (value.paperId) push('试卷', value.paperId)
  if (value.count !== undefined && value.paperId) push('题目数', value.count)
  if (value.warning) push('注意', value.warning)
  if (value.total !== undefined && value.matched !== undefined) {
    push('匹配', `${value.matched}/${value.total}`)
    if (value.filled !== undefined) push('填写', `${value.filled} 题`)
    if (value.verified) push('回读', value.verified.ok ? '全部一致' : `不一致 ${value.verified.bad} 题`)
  }
  if (value.score !== undefined && value.total !== undefined) {
    push('判分', `${value.score} / ${value.total} 分 · 对 ${value.correct} · 错 ${value.wrong}${value.pending ? ` · 待批改 ${value.pending}` : ''}`)
  }
  if (Array.isArray(value.suspect) && value.suspect.length) {
    push('题库可能有误', `第 ${value.suspect.join('、')} 题（平台没给分）`)
  }
  if (Array.isArray(value.results) && value.results.length) {
    lines.push('', value.action === 'run' || value.ran !== undefined ? '任务结果:' : '动作:')
    for (const entry of value.results) {
      if (entry.id) {
        lines.push(`- ${entry.course} · ${STAGE_LABEL[entry.stage] ?? entry.stage} · ${entry.title} → ${entry.phase}${entry.score !== null && entry.score !== undefined ? ` ${entry.score} 分` : ''} ${entry.note ?? ''}`.trim())
      } else {
        lines.push(`- #${entry.index} ${entry.action} ${entry.ok ? 'OK' : 'FAIL'} ${entry.note}`.trim())
      }
    }
  }
  if (Array.isArray(value.missing) && value.missing.length) {
    lines.push('', '缺答案:')
    for (const item of value.missing) lines.push(`- #${item.seq}（${item.type}）${item.stem}`)
  }
  if (Array.isArray(value.questions) && value.questions.length) {
    lines.push('', '试题:')
    for (const question of value.questions) {
      lines.push(`- #${question.seq} [${question.type}] ${question.points ?? ''}分 ${question.stem}`)
      for (const option of question.options ?? []) lines.push(`    ${option}`)
      if (question.hasUpload) lines.push('    （该题要求上传附件）')
    }
  }
  if (Array.isArray(value.failures) && value.failures.length) {
    lines.push('未解决:')
    for (const failure of value.failures) lines.push(`- #${failure.seq} ${failure.status} ${failure.note ?? ''} ${failure.stem ?? ''}`.trim())
  }
  if (value.html) push('报告', value.html)
  if (value.answerUrl) push('在线查看', value.answerUrl)
  if (value.draft && value.topic) {
    push('讨论主题', value.topic)
    lines.push('', value.draft)
  }
  if (Array.isArray(value.items) && value.items.length) {
    lines.push('', '任务:')
    for (const task of value.items.slice(0, 30)) {
      lines.push(`- ${task.id} ${task.course} · ${STAGE_LABEL[task.stage] ?? task.stage} · ${task.title} · ${task.status}/${task.availability ?? ''}`.trim())
    }
    if (value.items.length > 30) lines.push(`… 共 ${value.items.length} 个任务；把 taskId 传给 ouch_exam，完整清单在执行台面板里看`)
  }
  if (Array.isArray(value.elements) && value.elements.length) {
    lines.push('', '元素:')
    for (const element of value.elements.slice(0, 40)) {
      lines.push(`- [${element.ref}] <${element.tag}> ${element.text}${element.href ? ` href=${element.href}` : ''}`)
    }
  }
  if (typeof value.text === 'string' && value.text) lines.push('', '正文:', value.text)
  if (value.kind === 'eval') lines.push('', `eval 结果（${value.chars ?? 0} 字符）:`, String(value.value))
  if (value.hint) lines.push('', `下一步: ${value.hint}`)
  if (lines.length === 0) return JSON.stringify(value).slice(0, 1500)
  return lines.join('\n')
}

/* ------------------------------------------------------------------ *
 * Tool definitions
 * ------------------------------------------------------------------ */

/** One registry-ready tool: service call + step bookkeeping + readable output. */
function tool(definition) {
  const { name: toolName, description, parameters, run } = definition
  return {
    name: toolName,
    description,
    parameters,
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => TEXT(format(value)),
    },
    async execute(args, exec) {
      const input = args && typeof args === 'object' ? args : {}
      const service = definition.service()
      const step = service.begin(toolName, input)
      const started = Date.now()
      try {
        const value = await run(service, input, exec)
        service.finish(step, value, Date.now() - started)
        return value
      } catch (error) {
        service.fail(step, error, Date.now() - started)
        throw error
      }
    },
  }
}

function createTools(getService) {
  return [
    tool({
      service: getService,
      name: 'ouch_open',
      description: '启动（或复用）执行台浏览器并打开一个网址，返回页面正文与可交互元素。'
        + '平台的登录与同步用 ouch_login / ouch_sync；只有需要看某个具体页面时才用它。',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: '要打开的 http/https 网址；省略则只复用当前页面。' },
          headless: { type: 'boolean', description: '是否无头运行，默认 false，可以在屏幕上看到浏览器。' },
          maxChars: { type: 'number', description: '正文最多返回多少字符，默认 1500。' },
          maxElements: { type: 'number', description: '最多返回多少个可交互元素，默认 60。' },
        },
      },
      run: (service, args, exec) => service.open(args, exec),
    }),
    tool({
      service: getService,
      name: 'ouch_page',
      description: '读取执行台浏览器当前页面：正文、可交互元素（ref）、滚动位置；'
        + '或给 expression 直接在页面里求值并拿到完整 JSON 结果（适合从页面对象里批量取数据）。',
      parameters: {
        type: 'object',
        properties: {
          expression: { type: 'string', description: '在页面里执行的 JS 表达式，返回完整 JSON 值；省略则读取页面快照。' },
          maxChars: { type: 'number', description: '正文最多返回多少字符，默认 4000。' },
          maxElements: { type: 'number', description: '最多返回多少个可交互元素，默认 80。' },
          screenshot: { type: 'boolean', description: '是否另存一张 PNG 截图。' },
        },
      },
      run: (service, args, exec) => service.page(args, exec),
    }),
    tool({
      service: getService,
      name: 'ouch_act',
      description: '在执行台浏览器里按顺序执行页面动作（goto/click/fill/check/press/scroll/wait/reload/back），一次最多 12 个。'
        + 'check 专门用来点选单选/复选并回读是否真的选中。页面变化后旧 ref 失效，需要新引用时用 ouch_page。',
      parameters: {
        type: 'object',
        properties: {
          steps: {
            type: 'array',
            description: '按顺序执行的动作，失败会立即停止。',
            items: {
              type: 'object',
              additionalProperties: true,
              properties: {
                action: { type: 'string', enum: ['goto', 'click', 'check', 'fill', 'press', 'scroll', 'wait', 'reload', 'back', 'screenshot'] },
                ref: { type: 'string', description: 'ouch_page 返回的元素引用，如 r3。' },
                selector: { type: 'string', description: 'CSS 选择器。' },
                text: { type: 'string', description: '按可见文本定位。' },
                value: { type: 'string', description: 'fill 的值。' },
                url: { type: 'string', description: 'goto 的网址。' },
                key: { type: 'string', description: 'press 的按键。' },
                ms: { type: 'number', description: 'wait 的毫秒数。' },
                direction: { type: 'string', enum: ['up', 'down'] },
                amount: { type: 'number' },
                note: { type: 'string' },
              },
              required: ['action'],
            },
          },
        },
        required: ['steps'],
      },
      run: (service, args, exec) => service.act(args, exec),
    }),
    tool({
      service: getService,
      name: 'ouch_login',
      description: '用插件配置里的账号登录国开统一身份认证，并读出学生姓名/学校。登录态不持久，新进程需要重新登录一次。',
      parameters: {
        type: 'object',
        properties: {
          account: { type: 'string', description: '登录名；默认用插件配置的账号。' },
          password: { type: 'string', description: '密码；默认用插件配置的密码。' },
        },
      },
      run: (service, args, exec) => service.login(args, exec),
    }),
    tool({
      service: getService,
      name: 'ouch_sync',
      description: '同步真实的课程与作业结构：登录 → 我的课程 → 逐门课读取形考作业、终考作业、讨论题（只读，不进入任何考试）。'
        + '返回课程数、任务数、可执行性统计和答案库覆盖情况。',
      parameters: {
        type: 'object',
        properties: {
          courseId: { type: 'string', description: '只同步某一门课程（LMS 课程 id）；省略则同步全部。' },
        },
      },
      run: (service, args, exec) => service.sync(args, exec),
    }),
    tool({
      service: getService,
      name: 'ouch_exam',
      description: '为一个任务生成模拟试卷并在执行台浏览器里打开：题目来自本地答案库，选项顺序被打乱，题数按任务真实题数。'
        + '平台端不会创建任何答题记录。之后用 ouch_solve 作答。',
      parameters: {
        type: 'object',
        properties: {
          taskId: { type: 'string', description: '任务 id（ouch_state 返回，形如 1246228:2149383），也可以传任务标题。' },
          course: { type: 'string', description: '不给 taskId 时，按课程名取第一个可执行任务。' },
          stage: { type: 'string', description: '阶段：FORMATIVE / FINAL / DISCUSSION。', enum: ['FORMATIVE', 'FINAL', 'DISCUSSION'] },
          count: { type: 'number', description: '只取前 N 题（用于演示或分页）。' },
          rebuild: { type: 'boolean', description: 'true 时重新抽卷，否则复用已生成的试卷。' },
        },
      },
      run: (service, args, exec) => service.exam(args, exec),
    }),
    tool({
      service: getService,
      name: 'ouch_solve',
      description: '作答当前模拟试卷：从页面读取题干与选项 → 到答案库匹配 → 把答案映射到打乱后的选项 → 逐题点选/填写 → 回读校验。'
        + 'fill=false 时只解析匹配不填写。',
      parameters: {
        type: 'object',
        properties: {
          taskId: { type: 'string', description: '任务 id；省略时用最后打开的试卷。' },
          fill: { type: 'boolean', description: '是否真的在页面上点选/填写，默认 true。' },
          verify: { type: 'boolean', description: '填写后是否回读校验，默认 true。' },
        },
      },
      run: (service, args, exec) => service.solve(args, exec),
    }),
    tool({
      service: getService,
      name: 'ouch_submit',
      description: '提交当前模拟试卷并判分：客观题按题库答案比对，主观题记「待批改」，并在页面上逐题标出正确/错误。'
        + '传 items（平台返回的逐题分数）时改用平台结果判分——平台没给分而题库有答案的题会被标红，说明题库答案可能不符。',
      parameters: {
        type: 'object',
        properties: {
          taskId: { type: 'string', description: '任务 id；省略时用最后打开的试卷。' },
          items: {
            type: 'array',
            description: '平台逐题分数：[{seq, score, max}]。省略则本地模拟判分。',
            items: {
              type: 'object',
              additionalProperties: true,
              properties: {
                seq: { type: 'number', description: '题号' },
                score: { type: 'number', description: '该题得分' },
                max: { type: 'number', description: '该题满分' },
              },
              required: ['seq', 'score'],
            },
          },
        },
      },
      run: (service, args, exec) => service.submit(args, exec),
    }),
    tool({
      service: getService,
      name: 'ouch_discussion',
      description: '处理讨论题：为讨论任务生成一份可用的发言草稿（只存本地，不发帖）。传 content 可用你自己的稿子替换模板。',
      parameters: {
        type: 'object',
        properties: {
          taskId: { type: 'string', description: '讨论任务的 id 或标题。' },
          content: { type: 'string', description: '自定义发言内容；省略则按讨论主题生成结构化草稿。' },
        },
        required: ['taskId'],
      },
      run: (service, args, exec) => service.discussion(args, exec),
    }),
    tool({
      service: getService,
      name: 'ouch_real',
      description: '真实写入平台：open 打开任务页看状态；read 进入考试并读真实试题（同时把题目落盘）；'
        + 'answers 保存主观题/讨论稿的人工答案；run 进入→读题→作答→回读校验→交卷→读平台判分；'
        + 'video 播放视频补完成度解锁前置；discussion 在讨论区发帖。'
        + '题目没有全部拿到答案时不会交卷。',
      parameters: {
        type: 'object',
        properties: {
          taskId: { type: 'string', description: '任务 id（ouch_state 返回）' },
          course: { type: 'string', description: '不给 taskId 时按课程名取任务' },
          stage: { type: 'string', description: 'FORMATIVE / FINAL / DISCUSSION', enum: ['FORMATIVE', 'FINAL', 'DISCUSSION'] },
          action: { type: 'string', description: 'open / read / answers / run / video / discussion', enum: ['open', 'read', 'answers', 'run', 'video', 'discussion'] },
          submit: { type: 'boolean', description: 'action=run 时是否交卷，默认 true' },
          answers: { type: 'object', description: 'action=answers：{ "题号": "答案文本" }；run 时也可直接传 { seq, letters|text } 数组' },
          batch: { type: 'object', description: 'action=answers：一次写多个任务 { "<taskId>": { discussion: "…", title: "…", "1": "…" } }' },
          title: { type: 'string', description: '讨论帖标题' },
          content: { type: 'string', description: '讨论帖正文（也可传给 answers 保存）' },
          rate: { type: 'number', description: '视频倍速，默认 16' },
          need: { type: 'number', description: '需要的视频完成度百分比，默认 80' },
        },
      },
      run: (service, args, exec) => service.realTool(args, exec),
    }),
    tool({
      service: getService,
      name: 'ouch_run',
      description: '批量跑真实作业：按课程/阶段筛选，逐个任务进入平台作答并在全部题目都有答案时交卷；'
        + '遇到未开放、无权限、缺答案只记录不中断。跑完返回逐任务结果。',
      parameters: {
        type: 'object',
        properties: {
          course: { type: 'string', description: '只跑某门课（课程名片段或课程 id）' },
          stage: { type: 'string', description: '只跑某个阶段', enum: ['FORMATIVE', 'FINAL', 'DISCUSSION'] },
          stages: { type: 'string', description: '多个阶段，逗号分隔，如 FORMATIVE,FINAL' },
          taskIds: { type: 'array', description: '只跑这些任务 id', items: { type: 'string' } },
          limit: { type: 'number', description: '最多跑几个任务' },
          submit: { type: 'boolean', description: '是否交卷，默认 true' },
          includeSubmitted: { type: 'boolean', description: '是否包含已交卷的任务重跑' },
          answers: { type: 'array', description: '可选的作答计划 [{seq, letters?, text?}]，只对当个任务有效时用 ouch_real' },
        },
      },
      run: (service, args, exec) => service.runBatch(args, exec),
    }),
    tool({
      service: getService,
      name: 'ouch_library',
      description: '查看本地答案库：action=stats 全局统计；action=course 某门课的题量/题型；action=search 按题干检索与试匹配。',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['stats', 'course', 'search'], description: '默认 stats。' },
          course: { type: 'string', description: '课程名（可用平台课程名，会做模糊匹配）。' },
          query: { type: 'string', description: 'search 时的题干片段。' },
          limit: { type: 'number', description: 'search 返回条数，默认 5。' },
        },
      },
      run: (service, args, exec) => service.library(args, exec),
    }),
    tool({
      service: getService,
      name: 'ouch_state',
      description: '读取执行台状态：学生、课程/任务统计、每个任务的 id 与状态（出卷/已答/草稿）、答案库规模、报告路径。'
        + '决定下一步做哪个任务前先看它。',
      parameters: { type: 'object', properties: {} },
      run: async (service, _args, exec) => {
        await service.hydrate(exec)
        const summary = service.summary()
        return {
          ...summary,
          items: service.state.tasks.map((task) => ({
            id: task.id,
            course: task.courseName,
            stage: task.stage,
            title: task.title,
            status: task.status,
            availability: task.availabilityLabel,
            answered: task.answered,
            total: task.total,
          })),
        }
      },
    }),
    tool({
      service: getService,
      name: 'ouch_report',
      description: '把本次执行写成报告：单文件 HTML（可分享）+ 逐题 CSV，返回本地路径和一个可在浏览器打开的地址。',
      parameters: { type: 'object', properties: {} },
      run: (service, args, exec) => service.report(args, exec),
    }),
    tool({
      service: getService,
      name: 'ouch_close',
      description: '结束本次执行：关闭执行台浏览器并写入完成状态（报告请先用 ouch_report 生成）。',
      parameters: { type: 'object', properties: {} },
      run: (service, args, exec) => service.close(args, exec),
    }),
  ]
}

/* ------------------------------------------------------------------ *
 * Plugin entry
 * ------------------------------------------------------------------ */

export function apply(ctx, config) {
  const service = new WorkbenchService(ctx, {
    packageDir,
    workDir: readConfig(config, 'workDir', '') || undefined,
    // Optional: an answer bank kept outside the plugin package.
    dataDir: readConfig(config, 'dataDir', '') || undefined,
    // Credentials come from the plugin config or, failing that, the environment,
    // so a shared repository never carries an account.
    account: readConfig(config, 'account', '') || process.env.OUCHN_ACCOUNT || '',
    password: readConfig(config, 'password', '') || process.env.OUCHN_PASSWORD || '',
    headless: readConfig(config, 'headless', false) === true,
  })
  ctx.effect(() => () => { void service.dispose() }, 'workbench.lifetime')

  const getService = () => service
  for (const definition of createTools(getService)) {
    ctx.effect(() => ctx.tools.register(definition), `workbench.tool:${definition.name}`)
  }

  const getServer = () => {
    try { return typeof ctx.get === 'function' ? ctx.get('webServer') : undefined } catch { return undefined }
  }

  /**
   * 面板路由统一在这里注册。
   *
   * 关键点：DSH 重启时 webServer 可能比插件晚就绪。旧实现拿不到 server 就 `return`，
   * 结果工具注册成功、面板路由全 404——表现就是「点插件没反应 / 必须刷新页面」。
   */
  function applyRoutes(server) {
    const route = (routePath, resource, label) => {
      try {
        ctx.effect(() => server.register({ kind: 'exact', path: routePath, resource }), `workbench.route:${label}`)
      } catch (error) {
        try { ctx.logger?.warn?.(`workbench: ${label} route failed: ${error?.message ?? error}`) } catch { /* ignore */ }
      }
    }

    /** Node 风格 handler：resource 形态只吃 GET，POST 路由必须走 handler。 */
    const rawRoute = (routePath, handler, label) => {
      try {
        ctx.effect(() => server.register({ kind: 'exact', path: routePath, handler }), `workbench.route:${label}`)
      } catch (error) {
        try { ctx.logger?.warn?.(`workbench: ${label} route failed: ${error?.message ?? error}`) } catch { /* ignore */ }
      }
    }

    const sendJson = (res, status, value) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(JSON.stringify(value))
    }

    const readBody = async (req) => {
      let raw = ''
      try {
        for await (const chunk of req) raw += chunk
      } catch { /* 读失败就当空 body */ }
      if (!raw) return {}
      try { return JSON.parse(raw) } catch { return {} }
    }

  // The panel polls this. An unchanged revision is answered with two fields so a
  // 1.5 s poll never ships the whole catalog.
    route('/ouch/state', async (request) => {
      // 重启后第一次打开面板时还没有 tool 调用，这里补一次 hydrate，
      // 否则面板会显示 0 门课程、0 个任务，看起来像"插件没数据"。
      try { await service.hydrate() } catch { /* 状态文件坏了也不能挡住面板 */ }
      const url = new URL(request.url, 'http://localhost')
      const rev = Number(url.searchParams.get('rev') ?? '-1')
      if (Number.isFinite(rev) && rev === service.state.rev) {
        return json({ rev, same: true, shotRev: service.state.shotRev })
      }
      return json(service.snapshot())
    }, 'state')

  route('/ouch/shot', async () => {
    const jpeg = service.shotJpeg()
    if (!jpeg) return new Response('no shot', { status: 404 })
    return new Response(jpeg, { headers: { 'content-type': 'image/jpeg', 'cache-control': 'no-store' } })
  }, 'shot')

  route('/ouch/mock', async (request) => {
    const url = new URL(request.url, 'http://localhost')
    const id = url.searchParams.get('paper') ?? ''
    const paper = service.paperCache.get(id) ?? service.state.papers[id]
    if (!paper) return new Response('no paper', { status: 404 })
    return new Response(renderPaper(paper), {
      headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
    })
  }, 'mock')

  route('/ouch/report', async (request) => {
    const url = new URL(request.url, 'http://localhost')
    const name = path.basename(url.searchParams.get('file') ?? '')
    const dir = service.reportDir
    if (!dir || !name.endsWith('.html')) return new Response('no report', { status: 404 })
    try {
      const html = await readFile(path.join(dir, name), 'utf8')
      return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } })
    } catch {
      return new Response('no report', { status: 404 })
    }
  }, 'report')

  /**
   * 前端构建戳：面板每几秒比一次，发现 `client.js` 被改过就自动重载页面。
   * 这是 `dsh-client-hmr` 之外的兜底——HMR 在页面已连接时能把模块热替换掉，
   * 这条轮询保证即使 HMR 没送到（例如面板还没打开过），也不会停留在旧 UI。
   */
  route('/ouch/ui-stamp', async () => {
    try {
      const { statSync } = await import('node:fs')
      const info = statSync(path.join(packageDir, 'client.js'))
      return json({ ok: true, stamp: `${Math.round(info.mtimeMs)}-${info.size}` })
    } catch (error) {
      return json({ ok: false, error: String(error?.message ?? error) }, 500)
    }
  }, 'ui-stamp')

  /**
   * 前端构建报到：客户端模块每被浏览器执行一次（含 dsh-client-hmr 的热替换）就
   * POST 一次。用 `.ouch/client-boots.jsonl` 的时间线就能证明「改代码后不需要刷新
   * 页面」——新 build 戳出现即说明热更新生效。
   */
  rawRoute('/ouch/client-boot', async (req, res) => {
    if (req.method !== 'POST') { sendJson(res, 405, { ok: false, error: '需要 POST' }); return }
    const body = await readBody(req)
    const stamp = {
      at: new Date().toISOString(),
      build: String(body?.build ?? '').slice(0, 64),
      href: String(body?.href ?? '').slice(0, 200),
      clientAt: Number(body?.at ?? 0),
    }
    try {
      const dir = service.baseDir(service.lastExec)
      await mkdir(dir, { recursive: true })
      await appendFile(path.join(dir, 'client-boots.jsonl'), `${JSON.stringify(stamp)}\n`, 'utf8')
    } catch { /* 只是诊断日志 */ }
    sendJson(res, 200, { ok: true, build: stamp.build })
  }, 'client-boot')

  /**
   * 面板上的「退出账号」：清 Cookie、回到登录页、清空界面数据。
   */
  rawRoute('/ouch/logout', async (req, res) => {
    if (req.method !== 'POST') { sendJson(res, 405, { ok: false, error: '需要 POST' }); return }
    try {
      const value = await service.logout()
      sendJson(res, 200, value)
    } catch (error) {
      sendJson(res, 500, { ok: false, error: String(error?.message ?? error) })
    }
  }, 'logout')

  /**
   * 面板上的登录表单：账号密码来自输入框，登录后自动同步一次课程与任务。
   */
  rawRoute('/ouch/login', async (req, res) => {
    if (req.method !== 'POST') { sendJson(res, 405, { ok: false, error: '需要 POST' }); return }
    const body = await readBody(req)
    if (!String(body?.account ?? '').trim() || !String(body?.password ?? '')) {
      sendJson(res, 400, { ok: false, error: '账号或密码为空' })
      return
    }
    try {
      const value = await service.loginWith(body.account, body.password, null)
      sendJson(res, 200, value)
    } catch (error) {
      sendJson(res, 500, { ok: false, error: String(error?.message ?? error) })
    }
  }, 'login')

  /**
   * 一键执行控制：action = start / pause / resume / stop。
   */
  rawRoute('/ouch/auto', async (req, res) => {
    if (req.method !== 'POST') { sendJson(res, 405, { ok: false, error: '需要 POST' }); return }
    const body = await readBody(req)
    const action = String(body?.action ?? 'start')
    try {
      if (action === 'pause') { sendJson(res, 200, service.pauseAuto()); return }
      if (action === 'resume') { sendJson(res, 200, service.resumeAuto()); return }
      if (action === 'stop') { sendJson(res, 200, await service.stopAuto()); return }
      const value = await service.startAuto({ taskIds: body?.taskIds }, null)
      sendJson(res, 200, value)
    } catch (error) {
      sendJson(res, 500, { ok: false, error: String(error?.message ?? error) })
    }
  }, 'auto')

  /**
   * 诊断信息：「打开日志」弹窗用它证明面板/后端到底在什么状态。
   */
  route('/ouch/diag', async () => {
    let boots = []
    try {
      const file = path.join(service.baseDir(service.lastExec), 'client-boots.jsonl')
      const raw = await readFile(file, 'utf8')
      boots = raw.trim().split('\n').slice(-8).map((line) => {
        try { return JSON.parse(line) } catch { return { raw: line.slice(0, 120) } }
      })
    } catch { /* 还没有报到文件 */ }
    let stamp = null
    try {
      const { statSync } = await import('node:fs')
      const info = statSync(path.join(packageDir, 'client.js'))
      stamp = `${Math.round(info.mtimeMs)}-${info.size}`
    } catch { /* ignore */ }
    return json({
      ok: true,
      at: new Date().toISOString(),
      clientStamp: stamp,
      state: {
        rev: service.state.rev,
        status: service.state.status,
        phase: service.state.phase,
        shotRev: service.state.shotRev,
        browser: service.state.browser,
        student: service.state.student,
        run: service.state.run,
        current: service.state.current,
        courses: service.state.courses.length,
        tasks: service.state.tasks.length,
      },
      boots,
    })
  }, 'diag')

  /**
   * 面板上的「同步 GitHub」：在本机把插件目录的改动 add/commit/push 到 origin。
   *
   * 可行性前提是这台机器已经配置好 git 凭据（credential helper 或 SSH key）；插件
   * 不保存任何 token。只允许本机回环地址调用，避免被局域网页面当作推送代理。
   */
  rawRoute('/ouch/push', async (req, res) => {
    if (req.method !== 'POST') { sendJson(res, 405, { ok: false, error: '需要 POST' }); return }
    const remote = String(req.socket?.remoteAddress ?? '')
    if (!/^(127\.0\.0\.1|::1|::ffff:127\.0\.0\.1)$/.test(remote)) {
      sendJson(res, 403, { ok: false, error: '只允许本机调用' })
      return
    }
    const body = await readBody(req)
    const message = String(body?.message ?? '').trim().slice(0, 180) || 'chore: 执行台面板同步'
    const run = promisify(execFile)
    const options = { cwd: packageDir, timeout: 90000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }
    try {
      const status = await run('git', ['status', '--porcelain'], options)
      const dirty = String(status.stdout ?? '').trim().length > 0
      if (dirty) {
        await run('git', ['add', '-A'], options)
        await run('git', ['-c', 'user.name=dsh-workbench', '-c', 'user.email=workbench@local', 'commit', '-m', message], options)
      }
      const push = await run('git', ['push', 'origin', 'HEAD'], options)
      const head = await run('git', ['rev-parse', '--short', 'HEAD'], options)
      const branch = await run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], options)
      sendJson(res, 200, {
        ok: true,
        commit: String(head.stdout ?? '').trim(),
        branch: String(branch.stdout ?? '').trim(),
        note: dirty ? '已提交并推送' : '没有新改动，已确认与远端同步',
        output: String(push.stderr || push.stdout || '').trim().slice(-300),
      })
    } catch (error) {
      const detail = String(error?.stderr || error?.stdout || error?.message || error).trim()
      sendJson(res, 500, { ok: false, error: detail.slice(0, 500) })
    }
  }, 'push')
  }

  // 立刻拿得到就立刻注册；拿不到就等 webServer 就绪（重启后它常比插件晚一步）。
  const readyServer = getServer()
  if (readyServer && typeof readyServer.register === 'function') {
    applyRoutes(readyServer)
  } else {
    let attached = false
    const attach = (candidate) => {
      if (attached) return
      const target = candidate && typeof candidate.register === 'function' ? candidate : getServer()
      if (!target || typeof target.register !== 'function') return
      attached = true
      try { applyRoutes(target) } catch (error) { try { ctx.logger?.warn?.(`workbench: route attach failed: ${error?.message ?? error}`) } catch { /* ignore */ } }
    }
    try {
      if (typeof ctx.inject === 'function') {
        ctx.inject(['webServer'], (sub) => attach(sub && typeof sub.get === 'function' ? sub.get('webServer') : null))
      }
    } catch { /* 老版本宿主没有 ctx.inject */ }
    const timer = setInterval(() => attach(null), 400)
    if (timer.unref) timer.unref()
    try { ctx.effect(() => () => clearInterval(timer), 'workbench.route-retry') } catch { /* ignore */ }
  }
}

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

/** Read a config value with a default, tolerating a missing config object. */
function readConfig(config, key, fallback) {
  if (!config || typeof config !== 'object') return fallback
  const value = config[key]
  return value === undefined || value === null ? fallback : value
}
