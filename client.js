/**
 * 国开作业 · 执行台 — Client half.
 *
 * A 工作台 accordion in the left navigation and its tool 国开作业. Opening the
 * tool shows one full-page console: the student and the live platform frame, the
 * real courses with their 形考/终考/讨论 tasks, the question detail of the selected
 * task, the answer library and run statistics, and the execution timeline.
 *
 * The console is read-only: everything it shows comes from `/ouch/state`, which
 * the Host backend produces from the real platform sync and the simulated exam.
 */
window.__ModuleLoader__.load({
  id: 'dsh-workbench',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useRef, useCallback, useMemo } = React

    const NS = 'workbench'
    const PANEL_ID = 'workbench'
    const TOGGLE_PANEL_ID = 'workbench-toggle'

    /**
     * 前端构建戳。每次改客户端代码就把它改掉：`dsh-client-hmr` 轮询到 client.js
     * 的 mtime/size 变化后会把整个模块重新执行一遍，页面不用刷新就能拿到新 UI，
     * 这里顺便向 Host 报到一次，方便用 `.ouch/client-boots.jsonl` 验证热更新真的发生了。
     */
    const CLIENT_BUILD = '2026-11-17T01:20+08:00'
    try {
      fetch('/ouch/client-boot', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ build: CLIENT_BUILD, at: Date.now(), href: String(location.href) }),
      }).catch(() => {})
    } catch { /* 报到只是诊断，失败不影响面板 */ }

    const LOGIN_URL = 'https://iam.pt.ouchn.cn/am/oauth2/authorize?service=initService&response_type=code'
      + '&client_id=345fcbaf076a4f8a&scope=all'
      + '&redirect_uri=https%3A%2F%2Fmenhu.pt.ouchn.cn%2Fouchnapp%2Fwap%2Flogin%2Findex&decision=Allow'

    const STAGES = [
      { key: 'FORMATIVE', label: '形考', full: '形考作业' },
      { key: 'FINAL', label: '终考', full: '终考作业' },
      { key: 'DISCUSSION', label: '讨论', full: '讨论题' },
    ]

    const ZH = {
      title: '工作台',
      toolOuchn: '国开作业',
      dashboard: '执行台',
      back: '返回会话',
      refresh: '刷新',
      simulation: '模拟模式 · 不写入平台',
      readonly: '只读 · 由对话中的 agent 执行',
      courses: '课程',
      all: '全部',
      tasks: '任务',
      questions: '题目明细',
      questionsShort: '题目',
      platform: '平台画面',
      live: '实时',
      library: '答案库',
      stats: '执行统计',
      timeline: '执行时间线',
      student: '学生',
      noCourses: '还没有同步课程',
      noCoursesHint: '在对话里说「登录国开平台并同步全部课程」，这里会列出真实课程、形考/终考/讨论任务和模拟试卷。',
      noTasks: '这门课程在所选阶段没有任务',
      noTask: '选择一个任务',
      noTaskHint: '选中左侧任务后，这里显示题目、答案来源和模拟填写状态。',
      notServed: '执行台后端没有响应',
      notServedHint: '插件后端没有启动或页面是从文件打开的；刷新页面，或在桌面端重启一次。',
      answered: '已作答',
      pending: '待作答',
      unmatched: '未命中',
      mappingFailed: '选项映射失败',
      filled: '已填',
      answer: '答案',
      source: '来源',
      match: '匹配',
      status: '状态',
      type: '题型',
      stem: '题干',
      seq: '#',
      total: '共',
      questionsUnit: '题',
      points: '分',
      minutes: '分钟',
      deadline: '截止',
      attempts: '作答次数',
      notStarted: '还没有生成试卷',
      paperReady: '已出卷',
      notStartedHint: '在对话里说「模拟作答《{course}》{task}」，我会生成一份本地模拟试卷并在浏览器里作答。',
      discussionTitle: '讨论题草稿',
      discussionHint: '草稿只保存在本地，没有向平台发帖。',
      noDiscussion: '这个讨论任务还没有生成草稿',
      openPlatform: '在浏览器打开平台',
      browserClosed: '浏览器未启动',
      browserClosedHint: '执行台浏览器尚未运行，同步课程或生成试卷后这里会显示平台画面。',
      shotUnavailable: '暂时没有画面',
      coverage: '覆盖',
      uncovered: '未覆盖',
      libraryTotal: '题库条目',
      libraryCourses: '覆盖课程',
      hitRate: '命中率',
      filledCount: '已填写',
      verified: '回读一致',
      drafts: '讨论草稿',
      elapsed: '耗时',
      coursesUnit: '门',
      tasksUnit: '个',
      empty: '—',
      runId: '运行',
      syncedAt: '同步',
      courseCode: '课程代码',
      progress: '平台进度',
      taskProgress: '作答进度',
      copyHint: '提示：在对话里让我执行',
      stepOk: '完成',
      stepError: '失败',
      stepRunning: '运行中',
      reports: '报告',
      openReport: '打开报告',
      resize: '拖动调整大小',
      attempts: '{n} 次机会',
      unlimitedAttempts: '不限次数',
      score: '得分',
      grade: '判分',
      graded: '已判分',
      correct: '正确',
      wrong: '错误',
      pendingGrade: '待批改',
      immediateScore: '即时出分',
      afterReview: '批改后公布',
      address: '地址',
      frame: '画面',
      noRun: '还没有执行记录',
      noRunHint: '在对话里让我登录、同步或模拟作答，每一步都会记在这里。',
    }

    const EN = {
      title: 'Workbench',
      toolOuchn: 'OUCHN homework',
      dashboard: 'Console',
      back: 'Back to chat',
      refresh: 'Refresh',
      simulation: 'Simulation · no platform writes',
      readonly: 'Read-only · driven by the agent in chat',
      courses: 'Courses',
      all: 'All',
      tasks: 'Tasks',
      questions: 'Questions',
      questionsShort: 'Questions',
      platform: 'Platform',
      live: 'Live',
      library: 'Answer library',
      stats: 'Run stats',
      timeline: 'Execution timeline',
      student: 'Student',
      noCourses: 'No courses synced yet',
      noCoursesHint: 'Ask me in chat to sign in and sync courses; real courses, 形考/终考/讨论 tasks and simulated papers appear here.',
      noTasks: 'This course has no tasks for the selected stage',
      noTask: 'Select a task',
      noTaskHint: 'Pick a task on the left to see its questions, answer sources and simulated fill state.',
      notServed: 'The console backend is not responding',
      notServedHint: 'The plugin host is not running, or the page was opened from a file. Reload the page or restart the desktop app.',
      answered: 'Answered',
      pending: 'Pending',
      unmatched: 'Unmatched',
      mappingFailed: 'Mapping failed',
      filled: 'Filled',
      answer: 'Answer',
      source: 'Source',
      match: 'Match',
      status: 'Status',
      type: 'Type',
      stem: 'Stem',
      seq: '#',
      total: 'of',
      questionsUnit: '',
      points: 'pts',
      minutes: 'min',
      deadline: 'Due',
      attempts: 'Attempts',
      notStarted: 'No paper yet',
      paperReady: 'Paper ready',
      notStartedHint: 'Ask me in chat to simulate “{course} · {task}”; I will build a local paper and answer it in the browser.',
      discussionTitle: 'Discussion draft',
      discussionHint: 'The draft stays local; nothing was posted.',
      noDiscussion: 'No draft for this discussion task yet',
      openPlatform: 'Open platform in browser',
      browserClosed: 'Browser not started',
      browserClosedHint: 'The console browser is not running yet; the platform frame appears after a sync or a paper.',
      shotUnavailable: 'No frame yet',
      coverage: 'Covered',
      uncovered: 'Not covered',
      libraryTotal: 'Questions',
      libraryCourses: 'Courses',
      hitRate: 'Hit rate',
      filledCount: 'Filled',
      verified: 'Verified',
      drafts: 'Drafts',
      elapsed: 'Elapsed',
      coursesUnit: '',
      tasksUnit: '',
      empty: '—',
      runId: 'Run',
      syncedAt: 'Synced',
      courseCode: 'Course code',
      progress: 'Platform progress',
      taskProgress: 'Progress',
      copyHint: 'Ask in chat to run',
      stepOk: 'Done',
      stepError: 'Failed',
      stepRunning: 'Running',
      reports: 'Reports',
      openReport: 'Open report',
      resize: 'Drag to resize',
      attempts: '{n} attempts',
      unlimitedAttempts: 'Unlimited',
      score: 'Score',
      grade: 'Grade',
      graded: 'Graded',
      correct: 'Correct',
      wrong: 'Wrong',
      pendingGrade: 'Pending review',
      immediateScore: 'Instant score',
      afterReview: 'After review',
      address: 'URL',
      frame: 'Frame',
      noRun: 'No run yet',
      noRunHint: 'Ask me to sign in, sync, or simulate a paper; every step lands here.',
    }

    const DICTS = { zh: ZH, en: EN, ja: EN, es: EN, fr: EN, de: EN, ru: EN, pt: EN }

    /** Accordion state shared by the section row and the tool row. */
    const uiStore = { expanded: false, listeners: new Set() }
    function setUi(patch) {
      Object.assign(uiStore, patch)
      for (const listener of uiStore.listeners) listener()
    }
    function subscribeUi(listener) {
      uiStore.listeners.add(listener)
      return () => { uiStore.listeners.delete(listener) }
    }

    /**
     * Pane sizes the console remembers between sessions.
     *
     * Every visible pane has a drag handle, so the numbers are whatever the user
     * last dragged them to; the defaults are the layout that reads best at
     * 1440×900.
     */
    const LAYOUT_KEY = 'workbench.layout.v1'
    const DEFAULT_LAYOUT = { leftW: 264, rightW: 500, taskH: 258, bottomH: 224, statsW: 600 }
    const clamp = (value, min, max) => Math.max(min, Math.min(max, value))

    function loadLayout() {
      try {
        const raw = window.localStorage.getItem(LAYOUT_KEY)
        if (!raw) return DEFAULT_LAYOUT
        return { ...DEFAULT_LAYOUT, ...JSON.parse(raw) }
      } catch {
        return DEFAULT_LAYOUT
      }
    }

    function saveLayout(layout) {
      try { window.localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout)) } catch { /* storage may be unavailable */ }
    }

    /** Workbench glyph: a frame split into a rail and two panes. */
    function WorkbenchIcon(props) {
      const size = typeof props?.size === 'number' ? props.size : 16
      return h('svg', {
        viewBox: '0 0 16 16', width: size, height: size, fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': true,
      },
        h('rect', { x: 1.7, y: 2.6, width: 12.6, height: 10.8, rx: 2 }),
        h('path', { d: 'M5.4 2.6v10.8' }),
        h('path', { d: 'M9.9 2.6v10.8' }),
      )
    }

    /** The section row's chevron, following the accordion state. */
    function SectionIcon() {
      const expanded = React.useSyncExternalStore(subscribeUi, () => uiStore.expanded)
      return h('svg', {
        viewBox: '0 0 16 16', width: 16, height: 16, fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': true,
      },
        h('path', { d: 'M5.6 3.4L10.2 8l-4.6 4.6', style: { transform: expanded ? 'rotate(90deg)' : 'none', transformBox: 'fill-box', transformOrigin: 'center', transition: 'transform 120ms ease' } }),
      )
    }

    /** The tool row's glyph: a browser window with a tick. */
    function ToolIcon() {
      return h('svg', {
        viewBox: '0 0 16 16', width: 16, height: 16, fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': true,
      },
        h('rect', { x: 1.8, y: 2.8, width: 12.4, height: 10.4, rx: 2.2 }),
        h('path', { d: 'M1.8 6.1h12.4' }),
        h('path', { d: 'M5.2 10.4l1.6 1.6 3-3.1' }),
      )
    }

    const C = {
      brand: '#4d7dff',
      brandStrong: '#2f63e6',
      ok: 'var(--dsw-alias-state-success-primary)',
      warn: '#d9944a',
      error: 'var(--dsw-alias-state-error-primary)',
      ink: 'var(--dsw-alias-label-primary)',
      muted: 'var(--dsw-alias-label-secondary)',
      line: 'var(--dsw-alias-border-l1)',
      line2: 'var(--dsw-alias-border-l2)',
      layer1: 'var(--dsw-alias-bg-layer-1)',
      layer2: 'var(--dsw-alias-bg-layer-2)',
      base: 'var(--dsw-alias-bg-base)',
    }

    const S = {
      page: {
        position: 'fixed', inset: 0, zIndex: 9000, display: 'flex', flexDirection: 'column',
        gap: 10, boxSizing: 'border-box', padding: 'calc(var(--dsh-frame-top-clearance, 0px) + 10px) 14px 12px',
        background: C.base, color: C.ink, overflow: 'hidden',
        font: '400 13px/1.5 var(--dsw-font-family, system-ui, sans-serif)',
      },
      top: { display: 'flex', alignItems: 'center', gap: 11, minHeight: 40, flex: '0 0 auto' },
      avatar: {
        width: 34, height: 34, borderRadius: 10, flex: '0 0 auto',
        background: 'linear-gradient(135deg,#3f6ef2,#1b2a5e)', color: '#fff',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontWeight: 700, fontSize: 14, boxShadow: '0 4px 14px rgba(47,109,240,.28)',
      },
      titleWrap: { minWidth: 0 },
      titleRow: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 14, fontWeight: 650 },
      subRow: { color: C.muted, fontSize: 11.5, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
      sep: { width: 1, height: 26, background: C.line, flex: '0 0 auto' },
      student: { display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0 },
      studentName: { fontSize: 12.5, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
      studentSub: { color: C.muted, fontSize: 11, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
      topRight: { marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8, flex: '0 0 auto' },
      btn: {
        height: 28, padding: '0 11px', borderRadius: 8, border: `1px solid ${C.line2}`,
        background: C.layer1, color: C.ink, cursor: 'pointer',
        font: '500 11.5px/1 var(--dsw-font-family, system-ui, sans-serif)', whiteSpace: 'nowrap',
      },
      chip: {
        display: 'inline-flex', alignItems: 'center', gap: 5, height: 24, padding: '0 9px',
        borderRadius: 999, border: '1px solid transparent', fontSize: 11, whiteSpace: 'nowrap',
      },
      grid: { flex: 1, minHeight: 0, display: 'grid', gap: 10, gridTemplateRows: 'minmax(0,1fr) 154px' },
      main: { minHeight: 0, display: 'grid', gap: 10 },
      card: {
        background: C.layer1, border: `1px solid ${C.line}`, borderRadius: 12,
        minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden',
      },
      cardHead: { display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px 9px', borderBottom: `1px solid ${C.line}`, flex: '0 0 auto' },
      cardTitle: { fontSize: 12, fontWeight: 650 },
      cardHint: { color: C.muted, fontSize: 10.5 },
      cardRight: { marginLeft: 'auto', color: C.muted, fontSize: 10.5, display: 'flex', gap: 6, alignItems: 'center' },
      scroll: { flex: 1, minHeight: 0, overflow: 'auto' },
      pad: { padding: '8px 10px' },
      courseItem: {
        display: 'flex', flexDirection: 'column', gap: 5, padding: '9px 10px', borderRadius: 9,
        border: '1px solid transparent', cursor: 'pointer', marginBottom: 4, background: 'transparent', outline: 'none', boxShadow: 'none',
      },
      courseItemOn: { background: 'rgba(77,125,255,.10)', border: '1px solid rgba(77,125,255,.32)' },
      courseName: { fontSize: 12.5, fontWeight: 600, lineHeight: 1.35, wordBreak: 'break-word' },
      courseMeta: { display: 'flex', alignItems: 'center', gap: 6, color: C.muted, fontSize: 10.5 },
      stageChips: { display: 'flex', gap: 4, flexWrap: 'wrap' },
      stageChip: {
        fontSize: 10, padding: '1px 6px', borderRadius: 5,
        border: `1px solid ${C.line}`, color: C.muted, background: C.layer2,
      },
      stageChipActive: { color: '#cfe0ff', border: '1px solid rgba(91,140,255,.35)', background: 'rgba(91,140,255,.14)' },
      tabs: { display: 'flex', gap: 4, alignItems: 'center' },
      tab: {
        height: 24, padding: '0 9px', borderRadius: 7, border: '1px solid transparent',
        background: 'transparent', color: C.muted, cursor: 'pointer',
        font: '500 11px/1 var(--dsw-font-family, system-ui, sans-serif)',
      },
      tabOn: { background: C.layer2, borderColor: C.line, color: C.ink },
      taskItem: {
        display: 'flex', alignItems: 'center', gap: 9, padding: '8px 10px', borderRadius: 8,
        border: '1px solid transparent', cursor: 'pointer', marginBottom: 4, outline: 'none', boxShadow: 'none',
      },
      taskItemOn: { background: 'rgba(77,125,255,.09)', border: '1px solid rgba(77,125,255,.3)' },
      taskTitle: { fontSize: 12.5, fontWeight: 550, minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
      taskMeta: { display: 'flex', gap: 8, rowGap: 2, flexWrap: 'wrap', color: C.muted, fontSize: 10.5, marginTop: 1 },
      badge: {
        fontSize: 10, padding: '1px 6px', borderRadius: 5, border: '1px solid transparent', whiteSpace: 'nowrap',
      },
      table: { width: '100%', borderCollapse: 'collapse', fontSize: 11.5 },
      th: {
        position: 'sticky', top: 0, zIndex: 2, textAlign: 'left', fontWeight: 600, color: C.muted,
        background: C.layer1, borderBottom: `1px solid ${C.line}`, padding: '7px 8px', fontSize: 10.5, whiteSpace: 'nowrap',
      },
      td: { borderBottom: '1px dashed var(--dsw-alias-border-l1)', padding: '7px 8px', verticalAlign: 'top' },
      stemCell: { display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden', whiteSpace: 'pre-wrap' },
      mono: { font: '400 11px/1.5 var(--dsw-font-family-mono, ui-monospace, monospace)' },
      splitV: { position: 'relative', cursor: 'col-resize', display: 'flex', alignItems: 'center', justifyContent: 'center', touchAction: 'none' },
      splitH: { position: 'relative', cursor: 'row-resize', display: 'flex', alignItems: 'center', justifyContent: 'center', touchAction: 'none' },
      splitGripV: { width: 2, height: '100%', borderRadius: 2, transition: 'background 120ms ease' },
      splitGripH: { width: '100%', height: 2, borderRadius: 2, transition: 'background 120ms ease' },
      pageInfo: { flex: '0 0 auto', borderTop: `1px solid ${C.line}`, padding: '7px 10px', display: 'flex', flexDirection: 'column', gap: 3 },
      pageInfoRow: { display: 'flex', gap: 7, alignItems: 'center', minWidth: 0, fontSize: 10.5 },
      pageInfoKey: { color: C.muted, flex: '0 0 46px', fontWeight: 400, whiteSpace: 'nowrap' },
      ansLetters: { font: '600 12px/1.4 var(--dsw-font-family-mono, ui-monospace, monospace)', color: '#8fb4ff', letterSpacing: '.5px' },
      live: { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' },
      shotWrap: { flex: 1, minHeight: 0, overflow: 'hidden', background: '#0f1115', position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center' },
      shot: { width: '100%', height: 'auto', display: 'block', background: '#fff' },
      empty: { position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'center', justifyContent: 'center', textAlign: 'center', padding: 16, color: C.muted, fontSize: 11.5, background: C.layer2 },
      kpiGrid: { display: 'grid', gridTemplateColumns: 'repeat(2,minmax(0,1fr))', gap: 7, padding: '9px 10px' },
      kpiGridDense: { display: 'grid', gridTemplateColumns: 'repeat(4,minmax(0,1fr))', gap: 6, padding: '8px 10px' },      kpiDense: { border: `1px solid ${C.line}`, borderRadius: 7, padding: '4px 7px', background: C.layer2, minWidth: 0 },
      kpiValueDense: { fontSize: 13.5, fontWeight: 650, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', lineHeight: 1.35 },
      kpi: { border: `1px solid ${C.line}`, borderRadius: 8, padding: '7px 9px', background: C.layer2, minWidth: 0 },
      kpiKey: { color: C.muted, fontSize: 10 },
      kpiValue: { fontSize: 15, fontWeight: 650, marginTop: 1, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
      kpiSub: { color: C.muted, fontSize: 9.5, marginTop: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
      bar: { height: 4, borderRadius: 2, background: C.line, marginTop: 5, overflow: 'hidden' },
      barFill: { display: 'block', height: '100%', borderRadius: 2, background: 'linear-gradient(90deg,#4d7dff,#7aa2ff)' },
      timeline: { display: 'flex', gap: 8, overflowX: 'auto', overflowY: 'hidden', padding: '9px 10px', height: '100%' },
      tlList: { flex: 1, minHeight: 0, overflowY: 'auto', padding: '4px 10px 6px' },
      tlRow: {
        display: 'grid', gridTemplateColumns: '14px minmax(64px,0.7fr) minmax(0,1.6fr) 104px 55px',
        alignItems: 'center', gap: 9, padding: '3px 0', minHeight: 26,
      },
      tlRail: { position: 'relative', alignSelf: 'stretch', display: 'flex', alignItems: 'center', justifyContent: 'center' },
      tlLine: { position: 'absolute', left: 6, width: 1, background: C.line },
      tlDot: { width: 7, height: 7, borderRadius: '50%', position: 'relative', zIndex: 1, flex: '0 0 auto' },
      tlLabel: { fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
      tlNote: { fontSize: 11, color: C.muted, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
      tlBarCell: { display: 'flex', alignItems: 'center', gap: 6, justifyContent: 'flex-end' },
      tlBarTrack: { width: 58, height: 4, borderRadius: 2, background: C.line, overflow: 'hidden', flex: '0 0 auto' },
      tlBarFill: { display: 'block', height: '100%', borderRadius: 2 },
      tlMs: { color: C.muted, font: '400 10px/1.4 var(--dsw-font-family-mono, ui-monospace, monospace)', minWidth: 38, textAlign: 'right' },
      tlTime: { color: C.muted, font: '400 10px/1.4 var(--dsw-font-family-mono, ui-monospace, monospace)', textAlign: 'right' },
      stepIc: {
        width: 18, height: 18, borderRadius: 5, display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontSize: 9.5, fontWeight: 700, background: C.layer1, color: C.muted, border: `1px solid ${C.line2}`, flex: '0 0 auto',
      },
      stepIcOk: { color: C.ok, borderColor: 'rgba(71,199,154,.3)', background: 'rgba(71,199,154,.12)' },
      stepIcErr: { color: C.error, borderColor: 'rgba(239,122,122,.3)', background: 'rgba(239,122,122,.12)' },
      stepIcRun: { color: '#cfe0ff', borderColor: 'rgba(91,140,255,.4)', background: 'rgba(91,140,255,.14)' },
      hint: { padding: '10px 12px', color: C.muted, fontSize: 11.5, lineHeight: 1.6 },
      hintStrong: { color: C.ink, fontSize: 12.5, fontWeight: 600, marginBottom: 3 },
      spin: { width: 10, height: 10, borderRadius: '50%', border: '2px solid rgba(91,140,255,.25)', borderTopColor: '#5b8cff', display: 'inline-block', animation: 'wbspin 1s linear infinite' },
      progressMini: { height: 4, borderRadius: 2, background: C.line, overflow: 'hidden', marginTop: 2 },
      monoCell: { color: C.muted, font: '400 10.5px/1.4 var(--dsw-font-family-mono, ui-monospace, monospace)', whiteSpace: 'nowrap' },
    }

    const KEYFRAMES = '@keyframes wbspin{to{transform:rotate(360deg)}}'
    const STAGE_GLYPH = { FORMATIVE: '形', FINAL: '终', DISCUSSION: '讨' }

    const pad = (value) => String(value).padStart(2, '0')
    const clock = (ts) => {
      if (!ts) return '—'
      const date = new Date(ts)
      if (Number.isNaN(date.getTime())) return '—'
      return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
    }
    const dayTime = (ts) => {
      if (!ts) return '—'
      const date = new Date(ts)
      if (Number.isNaN(date.getTime())) return '—'
      return `${date.getMonth() + 1}.${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
    }
    const elapsed = (ms) => {
      if (!Number.isFinite(ms) || ms < 0) return '—'
      const total = Math.floor(ms / 1000)
      if (total < 60) return `${total}s`
      const minutes = Math.floor(total / 60)
      if (minutes < 60) return `${minutes}m ${pad(total % 60)}s`
      return `${Math.floor(minutes / 60)}h ${pad(minutes % 60)}m`
    }

    /** Status colours for the header pill and step icons. */
    const STATUS_TONE = {
      idle: { color: C.muted, background: C.layer2, border: C.line, label: '空闲' },
      running: { color: '#9dbcff', background: 'rgba(91,140,255,.14)', border: 'rgba(91,140,255,.28)', label: '运行中' },
      ready: { color: C.ok, background: 'rgba(71,199,154,.12)', border: 'rgba(71,199,154,.24)', label: '就绪' },
      done: { color: C.ok, background: 'rgba(71,199,154,.12)', border: 'rgba(71,199,154,.24)', label: '已完成' },
      failed: { color: C.error, background: 'rgba(239,122,122,.12)', border: 'rgba(239,122,122,.24)', label: '失败' },
    }

    const AVAILABILITY_TONE = {
      ACTIONABLE: { color: '#9dbcff', background: 'rgba(91,140,255,.14)', border: 'rgba(91,140,255,.28)' },
      COMPLETED: { color: C.ok, background: 'rgba(71,199,154,.12)', border: 'rgba(71,199,154,.24)' },
      EXPIRED: { color: C.muted, background: C.layer2, border: C.line },
      NOT_OPEN: { color: C.warn, background: 'rgba(217,148,74,.12)', border: 'rgba(217,148,74,.26)' },
      SKIPPED: { color: C.muted, background: C.layer2, border: C.line },
      EXHAUSTED: { color: C.error, background: 'rgba(239,122,122,.12)', border: 'rgba(239,122,122,.24)' },
    }

    const TASK_STATUS = {
      pending: { label: '待开始', tone: { color: C.muted, background: C.layer2, borderColor: C.line } },
      generated: { label: '已出卷', tone: { color: '#9dbcff', background: 'rgba(91,140,255,.14)', borderColor: 'rgba(91,140,255,.28)' } },
      answered: { label: '已模拟作答', tone: { color: C.ok, background: 'rgba(71,199,154,.12)', borderColor: 'rgba(71,199,154,.24)' } },
      submitted: { label: '已提交判分', tone: { color: '#e0b64f', background: 'rgba(224,182,79,.12)', borderColor: 'rgba(224,182,79,.3)' } },
      drafted: { label: '草稿已生成', tone: { color: C.warn, background: 'rgba(217,148,74,.12)', borderColor: 'rgba(217,148,74,.26)' } },
    }

    const QUESTION_STATUS = {
      filled: { label: '已填', tone: { color: C.ok } },
      matched: { label: '已匹配', tone: { color: '#9dbcff' } },
      planned: { label: '待作答', tone: { color: C.muted } },
      unmatched: { label: '未命中', tone: { color: C.error } },
      'mapping-failed': { label: '映射失败', tone: { color: C.warn } },
      'fill-failed': { label: '填写失败', tone: { color: C.error } },
    }

    function chip(text, tone, extra) {
      return h('span', { style: { ...S.chip, ...tone, ...extra } }, text)
    }

    /** Poll the Host state snapshot. */
    function useConsoleState() {
      const [snapshot, setSnapshot] = useState(null)
      const [error, setError] = useState(null)
      const revRef = useRef(-1)
      const alive = useRef(true)

      const load = useCallback(async (force) => {
        try {
          // force=true 时忽略本地 rev，让「刷新」按钮一定拿到完整快照。
          const rev = force === true ? -1 : revRef.current
          const response = await fetch(`/ouch/state?rev=${rev}`, { cache: 'no-store' })
          if (!response.ok) throw new Error(`HTTP ${response.status}`)
          const data = await response.json()
          if (!alive.current) return
          if (data && data.same) {
            revRef.current = data.rev
            return
          }
          revRef.current = typeof data?.rev === 'number' ? data.rev : 0
          setSnapshot(data)
          setError(null)
        } catch (failure) {
          if (!alive.current) return
          setError(String(failure?.message ?? failure))
        }
      }, [])

      useEffect(() => {
        alive.current = true
        load(false)
        const timer = window.setInterval(() => { load(false) }, 1600)
        return () => { alive.current = false; window.clearInterval(timer) }
      }, [load])

      return { snapshot, error, reload: load }
    }

    /** The live platform frame served by the Host route. */
    function LiveFrame({ snapshot, t }) {
      const [broken, setBroken] = useState(false)
      const [loaded, setLoaded] = useState(false)
      const shotRev = snapshot?.shotRev ?? 0
      const hasBrowser = snapshot?.browser?.open === true
      useEffect(() => { setBroken(false); setLoaded(false) }, [shotRev])
      // 极窄时不画图：整条 6px 的图片只会显示成一条黑边，不如明确提示。
      const [narrow, setNarrow] = useState(false)
      const wrapRef = useRef(null)
      useEffect(() => {
        const node = wrapRef.current
        if (!node || typeof ResizeObserver === 'undefined') return undefined
        const observer = new ResizeObserver((entries) => {
          const box = entries[0]?.contentRect
          if (box) setNarrow(box.width < 80 || box.height < 60)
        })
        observer.observe(node)
        return () => observer.disconnect()
      }, [])

      return h('div', { style: S.live },
        h('div', { ref: wrapRef, style: S.shotWrap },
          hasBrowser && shotRev > 0 && !broken && !narrow
            ? h('img', {
              key: shotRev,
              src: `/ouch/shot?v=${shotRev}`,
              style: {
                // 绝对定位 + contain：图片始终完整落在容器内，容器变宽变窄都跟着缩放，
                // 既不会被压成一条，也不会把容器撑高。
                position: 'absolute', inset: 0, margin: 'auto',
                maxWidth: '100%', maxHeight: '100%', width: 'auto', height: 'auto',
                objectFit: 'contain', opacity: loaded ? 1 : 0, transition: 'opacity 120ms ease',
                background: '#fff', display: 'block',
              },
              alt: t('platform'),
              onLoad: () => setLoaded(true),
              onError: () => setBroken(true),
            })
            : h('div', { style: S.empty },
              h('div', { style: { fontSize: 12, color: C.ink, fontWeight: 600 } },
                hasBrowser ? (narrow ? '画面区域过窄' : broken ? t('shotUnavailable') : t('shotUnavailable')) : t('browserClosed')),
              h('div', null, hasBrowser ? '拖动分隔条把右栏拉宽，或稍等一帧画面刷新' : t('browserClosedHint')),
              h('a', {
                href: LOGIN_URL,
                target: '_blank',
                rel: 'noreferrer',
                style: { marginTop: 4, color: '#9dbcff', fontSize: 11.5, textDecoration: 'none' },
              }, `${t('openPlatform')} ↗`),
            ),
        ),
      )
    }

    /** One compact metric in the run-data grid. */
    function KpiDense({ label, value, bar, color }) {
      return h('div', { style: S.kpiDense },
        h('div', { style: S.kpiKey }, label),
        h('div', { style: { ...S.kpiValueDense, ...(color ? { color } : null) } }, value),
        typeof bar === 'number' ? h('div', { style: S.bar }, h('i', { style: { ...S.barFill, width: `${Math.max(0, Math.min(100, bar))}%` } })) : null,
      )
    }

    /**
     * A drag handle between two panes.
     *
     * Pointer capture keeps the drag alive while the cursor crosses another pane;
     * the callback receives incremental deltas so the parent can clamp them.
     */
    function Splitter({ orientation, onDrag, label }) {
      const [active, setActive] = useState(false)
      const onPointerDown = (event) => {
        if (event.button !== 0) return
        event.preventDefault()
        const element = event.currentTarget
        const vertical = orientation === 'v'
        let last = vertical ? event.clientX : event.clientY
        setActive(true)
        try { element.setPointerCapture(event.pointerId) } catch { /* ignore */ }
        document.body.style.userSelect = 'none'
        document.body.style.cursor = vertical ? 'col-resize' : 'row-resize'
        const move = (moveEvent) => {
          const position = vertical ? moveEvent.clientX : moveEvent.clientY
          const delta = position - last
          if (delta === 0) return
          last = position
          onDrag(delta)
        }
        const end = () => {
          setActive(false)
          element.removeEventListener('pointermove', move)
          element.removeEventListener('pointerup', end)
          element.removeEventListener('pointercancel', end)
          document.body.style.userSelect = ''
          document.body.style.cursor = ''
        }
        element.addEventListener('pointermove', move)
        element.addEventListener('pointerup', end)
        element.addEventListener('pointercancel', end)
      }
      return h('div', {
        role: 'separator',
        title: label,
        onPointerDown,
        style: orientation === 'v' ? S.splitV : S.splitH,
      }, h('i', { style: { ...(orientation === 'v' ? S.splitGripV : S.splitGripH), background: active ? '#5b8cff' : C.line } }))
    }

    /** Attempt limit in the platform's terms (999 = unlimited). */
    function attemptLabel(task, t) {
      const limit = task.submitTimes
      if (!Number.isFinite(limit)) return null
      if (limit >= 999) return t('unlimitedAttempts')
      return String(t('attempts')).replace('{n}', String(limit))
    }

    /** Thousands separators for counts; em dash for anything unknown. */
    function formatNumber(value) {
      const number = Number(value)
      if (!Number.isFinite(number)) return '—'
      return number.toLocaleString('en-US')
    }

    /** A short, readable answer-source label from a library file path. */
    function sourceLabel(file, tier) {
      if (!file) return tier === 'planned' ? '题库预排' : '—'
      const base = String(file).split(/[\\/]/).pop().replace(/\.(docx?|pdf|txt|md|xlsx|csv)$/i, '')
      const tidy = base.replace(/^(?:\d{3,4}|地|省|统|网)[-—]?/, '').replace(/【[^】]*】/g, '').trim()
      return (tidy || base).slice(0, 12)
    }

    /** 小徽标。 */
    function Chip({ tone, children }) {
      return h('span', { style: { ...S.chip, ...(tone || null) } }, children)
    }

    /** 通用弹窗：统计明细、日志都用它。 */
    function Modal({ title, subtitle, onClose, children, width }) {
      return h('div', {
        style: {
          position: 'fixed', inset: 0, zIndex: 9600, background: 'rgba(6,9,16,.62)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24,
        },
        onClick: onClose,
      },
        h('div', {
          style: {
            width: width || 760, maxWidth: '92vw', maxHeight: '84vh', display: 'flex', flexDirection: 'column',
            background: C.layer1, border: `1px solid ${C.line2}`, borderRadius: 14, overflow: 'hidden',
            boxShadow: '0 24px 60px rgba(0,0,0,.45)',
          },
          onClick: (event) => event.stopPropagation(),
        },
          h('div', {
            style: { display: 'flex', alignItems: 'center', gap: 10, padding: '11px 16px', borderBottom: `1px solid ${C.line}` },
          },
            h('b', { style: { fontSize: 13.5 } }, title),
            subtitle ? h('span', { style: { color: C.muted, fontSize: 11.5 } }, subtitle) : null,
            h('button', { type: 'button', style: { ...S.btn, marginLeft: 'auto' }, onClick: onClose }, '关闭'),
          ),
          h('div', { style: { overflow: 'auto', padding: '10px 16px 18px' } }, children),
        ),
      )
    }

    /** 作业归类：正常 / 异常 / 无需做。异常只看「未完成作答」和「分数不够」。 */
    const PASS_SCORE = 60
    function taskClass(task, real) {
      const type = String(task?.type || '')
      if (type === 'homework' || type === 'page') return { kind: 'noneed', reason: '无需做作业（平台无学生提交入口）' }
      if (!real) return { kind: 'bad', reason: '未完成作答（没有作答记录）' }
      if (real.phase === 'submitted') {
        const score = Number.isFinite(real.score) ? real.score : null
        if (score !== null && score < PASS_SCORE) return { kind: 'bad', reason: `分数不够（${score} 分）` }
        return { kind: 'ok', score, pending: score === null }
      }
      if (real.phase === 'blocked') return { kind: 'bad', reason: real.note || '平台限制，未完成作答' }
      if (real.phase === 'needs-answers') return { kind: 'bad', reason: real.note || '缺答案，未交卷' }
      if (['failed', 'error', 'submit-failed', 'fill-failed', 'verify-failed'].includes(real.phase)) {
        return { kind: 'bad', reason: `${real.note || '执行失败'}（${real.phase}）` }
      }
      return { kind: 'bad', reason: `未完成作答（${real.phase}）` }
    }

    /** 登录卡片：退出后 / 首次打开时显示。 */
    function LoginCard({ onSubmit, busy, notice }) {
      const box = {
        height: 34, padding: '0 11px', borderRadius: 8, border: `1px solid ${C.line2}`,
        background: C.layer2, color: C.ink, fontSize: 12.5, outline: 'none',
      }
      const [account, setAccount] = useState('')
      const [password, setPassword] = useState('')
      return h('div', { style: { flex: 1, minHeight: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' } },
        h('div', {
          style: {
            width: 430, maxWidth: '92vw', display: 'flex', flexDirection: 'column', gap: 11,
            background: C.layer1, border: `1px solid ${C.line2}`, borderRadius: 14, padding: 22,
          },
        },
          h('div', { style: { fontSize: 15, fontWeight: 700 } }, '登录国开学习平台'),
          h('div', { style: { color: C.muted, fontSize: 11.5, lineHeight: 1.7 } },
            '登录后会自动同步该学生的课程与作业，并展示在下方。账号密码只在本次浏览器会话里使用，不写进仓库。'),
          h('input', {
            value: account, placeholder: '学号 / 登录名', autoFocus: true, style: box,
            onChange: (event) => setAccount(event.target.value),
          }),
          h('input', {
            value: password, type: 'password', placeholder: '密码', style: box,
            onChange: (event) => setPassword(event.target.value),
            onKeyDown: (event) => { if (event.key === 'Enter') onSubmit(account, password) },
          }),
          h('button', {
            type: 'button', disabled: busy,
            style: {
              ...S.btn, height: 34, background: C.brandStrong, color: '#fff', borderColor: 'transparent',
              fontWeight: 650, opacity: busy ? 0.7 : 1,
            },
            onClick: () => onSubmit(account, password),
          }, busy ? '登录中…' : '登录并同步'),
          notice ? h('div', { style: { color: C.warn, fontSize: 11.5 } }, notice) : null,
        ),
      )
    }

    /** 浏览器下方的统计区：科目数、作业数、正常、异常（数字可点开明细）。 */
    function StatsPanel({ agg, run, current, onOpen }) {
      const tile = (label, value, tone, key) => h('div', {
        style: {
          border: `1px solid ${C.line}`, borderRadius: 8, padding: '6px 9px', background: C.layer2,
          minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2,
        },
      },
        h('div', { style: { color: C.muted, fontSize: 10.5 } }, label),
        h('button', {
          type: 'button',
          disabled: !key,
          style: {
            border: 0, background: 'transparent', padding: 0, textAlign: 'left', cursor: key ? 'pointer' : 'default',
            color: tone || C.ink, fontSize: 17, fontWeight: 700, fontVariantNumeric: 'tabular-nums',
            textDecoration: key ? 'underline dotted' : 'none', textUnderlineOffset: 3,
          },
          onClick: key ? () => onOpen(key) : undefined,
          title: key ? '点击查看明细' : '',
        }, formatNumber(value)),
      )
      return h('section', {
        style: { ...S.card, flex: '0 0 auto', maxHeight: 220, display: 'flex', flexDirection: 'column' },
      },
        h('div', { style: S.cardHead },
          h('b', { style: S.cardTitle }, '作业统计'),
          h('span', { style: S.cardHint },
            run?.running
              ? `执行中 ${run.done}/${run.total}${run.paused ? '（已暂停）' : ''}`
              : agg.courses ? `${agg.courses} 门课 · ${agg.total} 个作业` : '—'),
        ),
        h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(4,minmax(0,1fr))', gap: 6, padding: '8px 10px' } },
          tile('科目总数', agg.courses),
          tile('作业数量', agg.total, C.ink, 'tasks'),
          tile('正常', agg.ok, C.ok, 'ok'),
          tile('异常', agg.bad, agg.bad ? C.error : C.muted, 'bad'),
        ),
        current
          ? h('div', { style: { padding: '0 10px 6px', color: C.muted, fontSize: 11 } },
            `当前：${current.course || ''} · ${current.title || ''}${current.question ? ` · 第 ${current.question} 题` : ''}`)
          : null,
        h('div', { style: { overflow: 'auto', padding: '0 10px 10px', minHeight: 0 } },
          agg.per.length === 0
            ? h('div', { style: { color: C.muted, fontSize: 11.5 } }, '还没有同步课程')
            : agg.per.map((row) => h('div', {
              key: row.course.id,
              style: { display: 'flex', alignItems: 'center', gap: 6, padding: '3px 0', borderTop: `1px solid ${C.line}`, fontSize: 11.5 },
            },
              h('span', { style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, row.course.name),
              h('span', { style: { color: C.muted, fontVariantNumeric: 'tabular-nums' } }, `${row.ok + row.bad + row.noneed} 个`),
              h('span', { style: { color: C.ok, fontVariantNumeric: 'tabular-nums' } }, `正常 ${row.ok}`),
              h('span', { style: { color: row.bad ? C.error : C.muted, fontVariantNumeric: 'tabular-nums' } }, `异常 ${row.bad}`),
            )),
        ),
      )
    }

    /** The full-page console. */
    function Console(props) {
      const t = props.t
      const { snapshot, error, reload } = useConsoleState()
      const [courseId, setCourseId] = useState(null)
      const [stage, setStage] = useState('ALL')
      const [taskId, setTaskId] = useState(null)
      const [layout, setLayout] = useState(loadLayout)
      const [pushState, setPushState] = useState('idle')
      const [pushNote, setPushNote] = useState('')
      const [modal, setModal] = useState(null)
      const [diag, setDiag] = useState(null)
      const [busy, setBusy] = useState('')
      const [notice, setNotice] = useState('')

      useEffect(() => { saveLayout(layout) }, [layout])

      // 兜底热更新：Host 回报的 client.js 构建戳一变就自动重载页面。
      useEffect(() => {
        let baseline = null
        let stopped = false
        const timer = setInterval(async () => {
          if (stopped) return
          try {
            const response = await fetch('/ouch/ui-stamp', { cache: 'no-store' })
            if (!response.ok) return
            const data = await response.json()
            const stamp = String(data?.stamp ?? '')
            if (!stamp) return
            if (baseline === null) { baseline = stamp; return }
            if (stamp !== baseline) { stopped = true; window.location.reload() }
          } catch { /* 网络抖动忽略 */ }
        }, 4000)
        return () => { stopped = true; clearInterval(timer) }
      }, [])

      const api = useCallback(async (path, body) => {
        const response = await fetch(path, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body || {}),
        })
        const data = await response.json().catch(() => ({}))
        if (!response.ok || data?.ok === false) throw new Error(data?.error || `HTTP ${response.status}`)
        return data
      }, [])

      const courses = snapshot?.courses ?? []
      const tasks = snapshot?.tasks ?? []
      const student = snapshot?.student
      const loggedIn = Boolean(student)
      const run = snapshot?.run ?? { running: false, paused: false }
      const current = snapshot?.current ?? null

      const activeCourse = useMemo(() => {
        if (!courses.length) return null
        return courses.find((course) => String(course.id) === String(courseId)) ?? courses[0]
      }, [courses, courseId])

      const scoped = useMemo(() => {
        if (!activeCourse) return []
        return tasks.filter((task) => String(task.courseId) === String(activeCourse.id))
          .filter((task) => stage === 'ALL' || task.stage === stage)
      }, [tasks, activeCourse, stage])

      const activeTask = useMemo(() => {
        if (!scoped.length) return null
        return scoped.find((task) => task.id === taskId) ?? scoped[0]
      }, [scoped, taskId])

      const detail = useMemo(() => {
        if (!snapshot || !activeTask) return null
        const result = snapshot.results?.[activeTask.id]
        if (result) return { kind: 'result', questions: result.questions, stats: result.stats, verified: result.verified }
        const paper = activeTask.paperId ? snapshot.papers?.[activeTask.paperId] : null
        if (paper) {
          return {
            kind: 'paper',
            questions: (paper.questions ?? []).map((question) => ({
              seq: question.seq,
              qtype: question.qtype,
              stem: question.stem,
              answer: question.answer ?? [],
              answerText: question.answerText ?? '',
              tier: 'planned',
              score: question.score ?? 0,
              source: question.source ?? null,
              status: 'planned',
            })),
            stats: { total: paper.questionCount, matched: 0, filled: 0, unmatched: 0 },
            verified: null,
          }
        }
        const draft = snapshot.discussions?.[activeTask.id]
        if (draft) return { kind: 'draft', draft }
        return null
      }, [snapshot, activeTask])

      const stats = snapshot?.stats ?? {}
      const library = snapshot?.library ?? { total: 0, courses: 0 }
      const grade = activeTask ? (snapshot?.grades?.[activeTask.id] ?? null) : null
      const realMap = snapshot?.real ?? {}
      const realStats = snapshot?.realStats ?? { done: 0, submitted: 0, blocked: 0, failed: 0, needsAnswers: 0, scored: 0, scoreSum: 0 }
      const defects = snapshot?.defects ?? []
      const realOf = (task) => (task ? realMap[task.id] : null) ?? null
      const status = STATUS_TONE[snapshot?.status] ?? STATUS_TONE.idle

      // 统计口径：正常 / 异常 / 无需做，异常只看未完成与分数不够。
      const agg = useMemo(() => {
        const per = courses.map((course) => {
          const list = tasks.filter((task) => String(task.courseId) === String(course.id))
          const items = list.map((task) => ({ task, cls: taskClass(task, realMap[task.id]) }))
          return {
            course,
            items,
            ok: items.filter((item) => item.cls.kind === 'ok').length,
            bad: items.filter((item) => item.cls.kind === 'bad').length,
            noneed: items.filter((item) => item.cls.kind === 'noneed').length,
          }
        })
        return {
          per,
          courses: courses.length,
          total: tasks.length,
          ok: per.reduce((sum, row) => sum + row.ok, 0),
          bad: per.reduce((sum, row) => sum + row.bad, 0),
          noneed: per.reduce((sum, row) => sum + row.noneed, 0),
        }
      }, [courses, tasks, realMap])

      const groupByStage = (items, pick) => STAGES.map((item) => {
        const rows = items.filter((row) => row.task.stage === item.key)
        return rows.length ? { stage: item.full, rows: rows.map((row) => ({ text: pick(row), title: row.task.title })) } : null
      }).filter(Boolean)

      const modalBody = (() => {
        if (modal === 'tasks') {
          const items = agg.per.flatMap((row) => row.items)
          return h('div', null,
            h('div', { style: { color: C.muted, fontSize: 11.5, marginBottom: 8 } }, `共 ${items.length} 个作业，按类型分类`),
            groupByStage(items, (row) => {
              const cls = row.cls
              const tail = cls.kind === 'ok'
                ? (cls.score !== null ? `${cls.score} 分` : '未改分')
                : cls.kind === 'noneed' ? '无需做作业' : cls.reason
              return `${row.task.title} · ${tail}`
            }).map((group) => h('div', { key: group.stage, style: { marginTop: 10 } },
              h('b', { style: { fontSize: 12.5 } }, `${group.stage}（${group.rows.length}）`),
              group.rows.map((row) => h('div', { key: row.title, style: { fontSize: 11.5, color: C.muted, padding: '2px 0' } }, `· ${row.text}`)),
            )),
          )
        }
        if (modal === 'ok') {
          const items = agg.per.flatMap((row) => row.items).filter((row) => row.cls.kind === 'ok' || row.cls.kind === 'noneed')
          return h('div', null,
            h('div', { style: { color: C.muted, fontSize: 11.5, marginBottom: 8 } }, `正常 ${agg.ok} 个 · 无需做作业 ${agg.noneed} 个`),
            groupByStage(items, (row) => {
              if (row.cls.kind === 'noneed') return `${row.task.title} · 无需做作业`
              return `${row.task.title} · ${row.cls.score !== null ? `${row.cls.score} 分` : '未改分'}`
            }).map((group) => h('div', { key: group.stage, style: { marginTop: 10 } },
              h('b', { style: { fontSize: 12.5 } }, group.stage),
              group.rows.map((row) => h('div', { key: row.title, style: { fontSize: 11.5, color: C.muted, padding: '2px 0' } }, `· ${row.text}`)),
            )),
          )
        }
        if (modal === 'bad') {
          const items = agg.per.flatMap((row) => row.items).filter((row) => row.cls.kind === 'bad')
          return h('div', null,
            h('div', { style: { color: C.muted, fontSize: 11.5, marginBottom: 8 } }, `异常 ${items.length} 个：未完成作答 / 分数不够`),
            items.length === 0
              ? h('div', { style: { color: C.ok, fontSize: 12 } }, '没有异常作业')
              : groupByStage(items, (row) => `${row.task.title} · ${row.cls.reason}`).map((group) => h('div', { key: group.stage, style: { marginTop: 10 } },
                h('b', { style: { fontSize: 12.5, color: C.error } }, group.stage),
                group.rows.map((row) => h('div', { key: row.title, style: { fontSize: 11.5, color: C.muted, padding: '2px 0' } }, `· ${row.text}`)),
              )),
          )
        }
        if (modal === 'log') {
          return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
            diag
              ? h('div', { style: { fontSize: 11.5, color: C.muted, whiteSpace: 'pre-wrap', fontFamily: 'ui-monospace, monospace' } },
                JSON.stringify(diag, null, 2).slice(0, 6000))
              : h('div', { style: { color: C.muted, fontSize: 12 } }, '读取中…'),
            !diag
              ? h('button', {
                type: 'button',
                style: S.btn,
                onClick: () => { fetch('/ouch/diag').then((response) => response.json()).then(setDiag).catch(() => {}) },
              }, '重新读取')
              : null,
          )
        }
        return null
      })()

      const openDiag = useCallback(() => {
        setDiag(null)
        setModal('log')
        fetch('/ouch/diag', { cache: 'no-store' })
          .then((response) => response.json())
          .then(setDiag)
          .catch((failure) => setDiag({ ok: false, error: String(failure?.message ?? failure) }))
      }, [])

      const doLogout = useCallback(async () => {
        if (!window.confirm('退出当前账号？退出后会清空界面数据，浏览器回到平台登录页。')) return
        setBusy('logout')
        try {
          await api('/ouch/logout')
          setNotice('已退出账号')
          await reload(true)
        } catch (failure) {
          setNotice(String(failure?.message ?? failure))
        } finally { setBusy('') }
      }, [api, reload])

      const doLogin = useCallback(async (account, password) => {
        setBusy('login')
        setNotice('')
        try {
          const data = await api('/ouch/login', { account, password })
          setNotice(`已登录：${data?.student?.name ?? account} · 课程 ${data?.courses ?? 0} · 任务 ${data?.tasks ?? 0}`)
          await reload(true)
        } catch (failure) {
          setNotice(`登录失败：${String(failure?.message ?? failure)}`)
        } finally { setBusy('') }
      }, [api, reload])

      const auto = useCallback(async (action) => {
        setBusy(action)
        try {
          await api('/ouch/auto', { action })
          setNotice(action === 'start' ? '已开始执行' : action === 'pause' ? '已暂停' : action === 'resume' ? '已继续' : '已停止')
          await reload(true)
        } catch (failure) {
          setNotice(`${action} 失败：${String(failure?.message ?? failure)}`)
        } finally { setBusy('') }
      }, [api, reload])

      const pushToGithub = useCallback(async () => {
        setPushState('running')
        setPushNote('')
        try {
          const response = await fetch('/ouch/push', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
          const data = await response.json()
          if (!response.ok || data?.ok === false) throw new Error(data?.error || `HTTP ${response.status}`)
          setPushState('done')
          setPushNote(data.note || `已推送 ${data.commit ?? ''}`.trim())
        } catch (failure) {
          setPushState('error')
          setPushNote(String(failure?.message ?? failure))
        }
      }, [pushState])

      const primaryBtn = {
        ...S.btn, height: 32, padding: '0 14px', fontWeight: 650,
        background: C.brandStrong, color: '#fff', borderColor: 'transparent',
      }
      const stageCounts = { ALL: scoped.length }
      for (const item of STAGES) stageCounts[item.key] = scoped.filter((task) => task.stage === item.key).length

      return h('div', { style: S.page, 'data-workbench-root': '' },
        h('style', null, KEYFRAMES),
        // ---------------------------------------------------------------- header
        h('header', { style: S.top },
          h('div', { style: S.avatar }, '国'),
          h('div', { style: S.titleWrap },
            h('div', { style: S.titleRow },
              `${t('toolOuchn')} · ${t('dashboard')}`,
              h('span', { style: { ...S.chip, color: status.color, background: status.background, borderColor: status.border } },
                h('span', { style: { width: 5, height: 5, borderRadius: '50%', background: 'currentColor' } }),
                status.label,
              ),
              run.running
                ? h(Chip, { tone: { color: run.paused ? C.warn : '#7ee2a8', background: 'rgba(74,222,128,.10)', borderColor: 'rgba(74,222,128,.28)' } },
                  `${run.paused ? '已暂停' : '执行中'} ${run.done}/${run.total}`)
                : null,
              error && snapshot
                ? h('span', { style: { ...S.chip, color: C.error, background: 'rgba(239,122,122,.12)', borderColor: 'rgba(239,122,122,.24)' } }, '连接中断')
                : null,
            ),
            h('div', { style: S.subRow },
              snapshot
                ? `${t('courses')} ${courses.length} · ${t('tasks')} ${tasks.length} · 正常 ${agg.ok} · 异常 ${agg.bad} · ${t('libraryTotal')} ${library.total}`
                : error ? t('notServed') : '加载中…'),
          ),
          h('div', { style: S.sep }),
          h('div', { style: S.student },
            h('div', { style: S.studentName }, student?.name || '未登录'),
            h('div', { style: S.studentSub }, student ? `${student.account ?? ''}${student.school ? ` · ${student.school}` : ''}` : '登录后自动同步课程与作业'),
          ),
          h('div', { style: S.topRight },
            loggedIn
              ? h('button', {
                type: 'button', style: primaryBtn, disabled: busy === 'start' || run.running,
                onClick: () => auto('start'),
              }, run.running ? '执行中…' : '开始执行自动化')
              : null,
            run.running
              ? h('button', {
                type: 'button', style: S.btn, disabled: busy === 'pause',
                onClick: () => auto(run.paused ? 'resume' : 'pause'),
              }, run.paused ? '继续' : '暂停')
              : null,
            run.running
              ? h('button', { type: 'button', style: S.btn, disabled: busy === 'stop', onClick: () => auto('stop') }, '停止')
              : null,
            loggedIn
              ? h('button', { type: 'button', style: S.btn, disabled: busy === 'logout', onClick: doLogout }, '退出账号')
              : null,
            h('button', { type: 'button', style: S.btn, onClick: () => { reload(true) } }, t('refresh')),
            h('button', { type: 'button', style: S.btn, onClick: openDiag, title: '查看面板/后端诊断日志' }, '打开日志'),
            snapshot?.report
              ? h('a', {
                href: `/ouch/report?file=${encodeURIComponent(String(snapshot.report.html).split(/[\\/]/).pop())}`,
                target: '_blank', rel: 'noreferrer',
                style: { ...S.btn, textDecoration: 'none', display: 'inline-flex', alignItems: 'center' },
              }, t('openReport'))
              : null,
            h('button', {
              type: 'button',
              style: {
                ...S.btn,
                borderColor: pushState === 'error' ? 'rgba(239,122,122,.5)' : pushState === 'done' ? 'rgba(74,222,128,.45)' : S.btn.borderColor,
                color: pushState === 'error' ? '#f0a0a0' : pushState === 'done' ? '#7ee2a8' : S.btn.color,
              },
              onClick: pushToGithub,
              title: pushNote || 'git add / commit / push 到 GitHub 仓库',
            }, pushState === 'running' ? '同步中…' : pushState === 'done' ? '已同步' : pushState === 'error' ? '同步失败' : '同步 GitHub'),
            h('button', { type: 'button', style: S.btn, onClick: () => props.onBack() }, t('back')),
          ),
        ),

        notice ? h('div', { style: { fontSize: 11.5, color: C.muted, padding: '0 2px' } }, notice) : null,

        // ---------------------------------------------------------------- body
        error && !snapshot
          ? h('div', { style: { ...S.card, flex: 1 } },
            h('div', { style: S.hint },
              h('div', { style: S.hintStrong }, t('notServed')),
              h('div', null, t('notServedHint')),
              h('div', { style: { ...S.mono, marginTop: 8, opacity: .8 } }, error),
              h('button', { type: 'button', style: { ...S.btn, marginTop: 10 }, onClick: () => reload(true) }, '重新连接'),
            ),
          )
          : !loggedIn && snapshot
            ? h(LoginCard, { onSubmit: doLogin, busy: busy === 'login', notice })
            : h('div', {
              style: {
                flex: 1, minHeight: 0, display: 'grid',
                // 左栏 | 竖分隔条 | 任务+题目 | 右栏。右栏不再有分隔条（统计区固定在浏览器
                // 画面下方），列数必须和子元素一一对应：多留一列 6px 会把右栏挤到 6px 宽，
                // 截图被压成一条、只剩深色底 → 用户看到的就是"黑屏"。
                gridTemplateColumns: `${layout.leftW}px 6px minmax(0,1fr) minmax(360px, 1fr)`,
              },
            },
              // -------- courses
              h('section', { style: S.card },
                h('div', { style: S.cardHead },
                  h('b', { style: S.cardTitle }, t('courses')),
                  h('span', { style: S.cardHint }, `${courses.length} ${t('coursesUnit')}`),
                ),
                h('div', { style: S.scroll },
                  courses.length === 0
                    ? h('div', { style: S.hint },
                      h('div', { style: S.hintStrong }, t('noCourses')),
                      h('div', null, t('noCoursesHint')),
                    )
                    : h('div', { style: S.pad },
                      courses.map((course) => {
                        const on = activeCourse && String(course.id) === String(activeCourse.id)
                        const counts = course.counts ?? {}
                        const total = (counts.FORMATIVE ?? 0) + (counts.FINAL ?? 0) + (counts.DISCUSSION ?? 0)
                        return h('div', {
                          key: course.id,
                          style: { ...S.courseItem, ...(on ? S.courseItemOn : null) },
                          onClick: () => { setCourseId(course.id); setTaskId(null) },
                          onKeyDown: (event) => {
                            if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setCourseId(course.id); setTaskId(null) }
                          },
                          role: 'button',
                          tabIndex: 0,
                        },
                          h('div', { style: S.courseName }, course.name),
                          h('div', { style: S.courseMeta },
                            h('span', null, course.code || '—'),
                            h('span', null, '·'),
                            h('span', null, `${total} ${t('tasksUnit')}`),
                            course.library
                              ? h('span', { style: { color: C.ok } }, `· ${t('coverage')} ${course.library.count}`)
                              : h('span', { style: { color: C.warn } }, `· ${t('uncovered')}`),
                          ),
                          h('div', { style: S.stageChips },
                            STAGES.map((item) => h('span', {
                              key: item.key,
                              style: { ...S.stageChip, ...(on ? S.stageChipActive : null) },
                            }, `${item.label} ${counts[item.key] ?? 0}`)),
                          ),
                          Number.isFinite(course.progress) && course.progress > 0
                            ? h('div', { style: S.progressMini }, h('i', { style: { ...S.barFill, width: `${Math.min(100, course.progress)}%`, display: 'block', height: '100%' } }))
                            : null,
                        )
                      }),
                    ),
                ),
              ),

              h(Splitter, { orientation: 'v', label: t('resize'), onDrag: (delta) => setLayout((prev) => ({ ...prev, leftW: clamp(prev.leftW + delta, 200, 460) })) }),

              // -------- tasks + questions
              h('div', {
                style: { minHeight: 0, display: 'grid', gridTemplateRows: `${layout.taskH}px 6px minmax(0,1fr)` },
              },
                h('section', { style: S.card },
                  h('div', { style: S.cardHead },
                    h('b', { style: S.cardTitle }, activeCourse?.name ?? t('tasks')),
                    h('span', { style: S.cardHint }, `${scoped.length} ${t('tasksUnit')}`),
                    h('div', { style: { marginLeft: 'auto', display: 'flex', gap: 4, flexWrap: 'wrap' } },
                      h('button', {
                        type: 'button',
                        style: { ...S.tab, ...(stage === 'ALL' ? S.tabOn : null) },
                        onClick: () => { setStage('ALL'); setTaskId(null) },
                      }, `${t('all')} ${stageCounts.ALL ?? 0}`),
                      STAGES.map((item) => h('button', {
                        key: item.key,
                        type: 'button',
                        style: { ...S.tab, ...(stage === item.key ? S.tabOn : null) },
                        onClick: () => { setStage(item.key); setTaskId(null) },
                      }, `${item.label} ${stageCounts[item.key] ?? 0}`)),
                    ),
                  ),
                  h('div', { style: S.scroll },
                    scoped.length === 0
                      ? h('div', { style: S.hint }, t('noTasks'))
                      : h('div', { style: S.pad },
                        scoped.map((task) => {
                          const on = activeTask?.id === task.id
                          const real = realOf(task)
                          const cls = taskClass(task, real)
                          const color = cls.kind === 'ok' ? C.ok : cls.kind === 'bad' ? C.error : C.muted
                          const label = cls.kind === 'ok'
                            ? (cls.score !== null ? `已完成 ${cls.score} 分` : '已完成 · 未改分')
                            : cls.kind === 'noneed' ? '无需做作业' : `异常：${cls.reason}`.slice(0, 34)
                          return h('div', {
                            key: task.id,
                            style: { ...S.taskItem, ...(on ? S.taskItemOn : null) },
                            onClick: () => setTaskId(task.id),
                            role: 'button',
                            tabIndex: 0,
                          },
                            h('div', { style: { ...S.stepIc, ...(on ? S.stepIcRun : null) }, title: task.stageLabel }, STAGE_GLYPH[task.stage] ?? '·'),
                            h('div', { style: { minWidth: 0, flex: 1 } },
                              h('div', { style: S.taskTitle }, task.title),
                              h('div', { style: S.taskMeta },
                                h('span', null, task.stageLabel ?? task.stage),
                                task.questionCount ? h('span', null, `${task.questionCount} ${t('questionsUnit')}`) : null,
                                h('span', { style: { color } }, label),
                                task.availability !== 'ACTIONABLE' ? h('span', { style: { color: C.warn } }, task.availabilityLabel) : null,
                              ),
                            ),
                          )
                        }),
                      ),
                  ),
                ),

                h(Splitter, { orientation: 'h', label: t('resize'), onDrag: (delta) => setLayout((prev) => ({ ...prev, taskH: clamp(prev.taskH + delta, 130, 640) })) }),

                h('section', { style: S.card },
                  h('div', { style: S.cardHead },
                    h('b', { style: S.cardTitle }, t('questions')),
                    h('span', { style: S.cardHint },
                      activeTask
                        ? `${activeTask.stageLabel ?? ''} · ${activeTask.title}`
                        : t('noTask'),
                    ),
                    detail?.kind === 'result'
                      ? h('span', { style: S.cardRight },
                        `${t('total')} ${detail.stats?.total ?? 0} · 匹配 ${detail.stats?.matched ?? 0} · ${t('filledCount')} ${detail.stats?.filled ?? 0}`)
                      : detail?.kind === 'paper'
                        ? h('span', { style: S.cardRight }, `${t('paperReady')} · ${t('total')} ${detail.stats?.total ?? 0}`)
                        : grade
                          ? h('span', { style: S.cardRight },
                            `${t('score')} ${grade.score}/${grade.total} · ${t('correct')} ${grade.correct} · ${t('wrong')} ${grade.wrong}`)
                          : null,
                  ),
                  h('div', { style: S.scroll },
                    !activeTask
                      ? h('div', { style: S.hint }, h('div', { style: S.hintStrong }, t('noTask')), h('div', null, t('noTaskHint')))
                      : detail?.kind === 'draft'
                        ? h('div', { style: { padding: '10px 12px' } },
                          h('div', { style: { ...S.cardHint, marginBottom: 6 } }, `${t('discussionTitle')} · ${t('discussionHint')}`),
                          h('div', { style: { whiteSpace: 'pre-wrap', fontSize: 12, lineHeight: 1.7 } }, detail.draft?.draft ?? t('noDiscussion')),
                        )
                        : detail?.kind
                          ? h('table', { style: S.table },
                            h('thead', null, h('tr', null,
                              h('th', { style: { ...S.th, width: 34 } }, t('seq')),
                              h('th', { style: { ...S.th, width: 52 } }, t('type')),
                              h('th', { style: S.th }, t('stem')),
                              h('th', { style: { ...S.th, width: 84 } }, t('answer')),
                              h('th', { style: { ...S.th, width: 74 } }, t('status')),
                            )),
                            h('tbody', null, (detail.questions ?? []).map((question) => h('tr', { key: question.seq },
                              h('td', { style: { ...S.td, ...S.monoCell } }, question.seq),
                              h('td', { style: S.td }, question.qtype),
                              h('td', { style: S.td }, h('div', { style: S.stemCell }, question.stem)),
                              h('td', { style: { ...S.td, ...S.monoCell } },
                                Array.isArray(question.answer) && question.answer.length
                                  ? question.answer.join('')
                                  : (question.answerText ? String(question.answerText).slice(0, 18) : '—')),
                              h('td', { style: { ...S.td, color: (QUESTION_STATUS[question.status] ?? QUESTION_STATUS.matched).tone.color } },
                                (QUESTION_STATUS[question.status] ?? QUESTION_STATUS.matched).label),
                            ))),
                          )
                          : h('div', { style: S.hint },
                            h('div', { style: S.hintStrong }, t('notStarted')),
                            h('div', null, '点「开始执行自动化」后，这里显示逐题作答明细；也可以让对话里的 agent 单跑某个任务。'),
                          ),
                  ),
                ),
              ),

              // -------- live platform frame + 统计区（同一个右栏）
              h('div', { style: { minHeight: 0, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 8 } },
                h('section', { style: { ...S.card, flex: 1, minHeight: 0, background: '#0f1115' } },
                  h(LiveFrame, { snapshot, t }),
                  h('div', { style: S.pageInfo },
                    h('div', { style: S.pageInfoRow },
                      h('b', { style: S.pageInfoKey }, t('student')),
                      h('span', { style: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
                        student ? `${student.name ?? ''}${student.account ? ` · ${student.account}` : ''}` : '—'),
                    ),
                    h('div', { style: S.pageInfoRow },
                      h('b', { style: S.pageInfoKey }, '当前'),
                      h('span', { style: { ...S.mono, color: C.muted } },
                        current ? `${current.course || ''} · ${current.title || ''}${current.question ? ` · 第 ${current.question} 题` : ''}` : '—'),
                    ),
                    h('div', { style: S.pageInfoRow },
                      h('b', { style: S.pageInfoKey }, '执行'),
                      h('span', { style: { ...S.mono, color: C.muted } },
                        run.running ? `${run.paused ? '暂停' : '运行'} ${run.done}/${run.total}` : (run.note || '空闲')),
                    ),
                  ),
                ),
                h(StatsPanel, { agg, run, current, onOpen: (key) => setModal(key) }),
              ),
            ),

        modal ? h(Modal, {
          title: modal === 'tasks' ? '全部作业（按类型分类）'
            : modal === 'ok' ? '正常作业（含未改分 / 无需做）'
              : modal === 'bad' ? '异常作业（未完成 / 分数不够）'
                : '运行日志与诊断',
          subtitle: modal === 'log' ? `client.js ${diag?.clientStamp ?? ''}` : `共 ${tasks.length} 个作业`,
          onClose: () => setModal(null),
          width: modal === 'log' ? 820 : 720,
        }, modalBody) : null,
      )
    }

    /** Zero-content panel behind the 工作台 row: flips the accordion and returns. */
    function makeTogglePanel(layout) {
      return function TogglePanel() {
        useEffect(() => {
          setUi({ expanded: !uiStore.expanded })
          // 展开时直接把执行台选中，避免"点了没反应、要再点一次/刷新"。
          window.setTimeout(() => {
            try { layout.selectPanel(uiStore.expanded ? PANEL_ID : null) } catch { /* ignore */ }
          }, 0)
        }, [])
        return null
      }
    }

    /**
     * 面板级错误边界。
     *
     * 渲染期抛一次（旧构建缺字段、状态 shape 变了、宿主给了非数组字段……）以前就是整页
     * 空白，只能刷新。现在异常落在一张可读卡片里，并给出「重新加载 / 重试渲染」。
     *
     * 注意：边界必须**包在 Console 外面**并且能被两种入口共用（宿主 slot 直接渲染
     * Console、测试台直接渲染 Console），所以导出的是 `SafeConsole`，`apply` 与
     * `__test` 都用它。
     */
    const ComponentBase = React.Component || function ComponentFallback() {}
    class PanelBoundary extends ComponentBase {
      constructor(props) {
        super(props)
        this.state = { error: null }
      }

      static getDerivedStateFromError(error) {
        return { error }
      }

      componentDidCatch(error, info) {
        try { console.error('[workbench] panel crashed', error, info) } catch { /* ignore */ }
      }

      render() {
        if (!this.state.error) return this.props.children
        const message = String(this.state.error?.message ?? this.state.error)
        return h('div', { style: { ...S.page, justifyContent: 'center', alignItems: 'center' } },
          h('div', { style: { ...S.card, maxWidth: 620, padding: 20, gap: 10 } },
            h('div', { style: { fontSize: 15, fontWeight: 700 } }, '执行台渲染出错了'),
            h('div', { style: { color: C.muted, fontSize: 12, whiteSpace: 'pre-wrap' } }, message),
            h('div', { style: { display: 'flex', gap: 8, marginTop: 6 } },
              h('button', { type: 'button', style: { ...S.btn, background: C.brandStrong, color: '#fff', borderColor: 'transparent' }, onClick: () => window.location.reload() }, '重新加载页面'),
              h('button', { type: 'button', style: S.btn, onClick: () => this.setState({ error: null }) }, '重试渲染'),
            ),
          ),
        )
      }
    }

    /** Console + 错误边界：宿主和测试台都用这个，避免任何一条路径白屏。 */
    function SafeConsole(props) {
      return h(PanelBoundary, null, h(Console, props))
    }

    /** Register the accordion rows and the full-page console. */
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, DICTS), 'workbench.copy')
      const t = ctx.locale.bind(NS)

      const back = () => {
        try { ctx.layout?.selectPanel(null) } catch { /* ignore */ }
      }

      ctx.effect(() => ctx.slots.inject('main', () => ctx.slots.register({
        name: 'main',
        key: PANEL_ID,
        locale: NS,
      }, (slotProps) => h(SafeConsole, { ...slotProps, t, ctx, onBack: back }))), 'workbench.panel')

      ctx.effect(() => ctx.slots.inject('main', () => ctx.slots.register({
        name: 'main',
        key: TOGGLE_PANEL_ID,
        locale: NS,
      }, makeTogglePanel(ctx.layout))), 'workbench.toggle-panel')

      ctx.effect(() => ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
        name: 'sidebar.panellist',
        id: TOGGLE_PANEL_ID,
        order: -30,
        label: () => t('title'),
      }, SectionIcon)), 'workbench.section-row')

      // 工具行常驻注册：以前它依赖 uiStore.expanded，重启后如果状态没同步过来，
      // 侧边栏就没有「国开作业」这一行，看起来像插件没加载。
      ctx.effect(() => ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
        name: 'sidebar.panellist',
        id: PANEL_ID,
        order: -29,
        label: () => t('toolOuchn'),
      }, ToolIcon)), 'workbench.tool-row')
    }

    return {
      inject: ['slots', 'locale', 'layout', 'sessions', 'uiSession'],
      apply,
      // 给离线渲染测试用：tools/render-console.mjs 直接渲染这几个纯组件。
      __test: { Console, SafeConsole, StatsPanel, Modal, LoginCard, taskClass, PanelBoundary },
    }
  },
})
