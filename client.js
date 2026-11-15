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

      const load = useCallback(async () => {
        try {
          const response = await fetch(`/ouch/state?rev=${revRef.current}`, { cache: 'no-store' })
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
        load()
        const timer = window.setInterval(load, 1600)
        return () => { alive.current = false; window.clearInterval(timer) }
      }, [load])

      return { snapshot, error, reload: load }
    }

    /** The live platform frame served by the Host route. */
    function LiveFrame({ snapshot, t }) {
      const [broken, setBroken] = useState(false)
      const shotRev = snapshot?.shotRev ?? 0
      const hasBrowser = snapshot?.browser?.open === true
      useEffect(() => { setBroken(false) }, [shotRev])

      return h('div', { style: S.live },
        h('div', { style: S.shotWrap },
          hasBrowser && shotRev > 0 && !broken
            ? h('img', {
              key: shotRev,
              src: `/ouch/shot?v=${shotRev}`,
              style: S.shot,
              alt: t('platform'),
              onError: () => setBroken(true),
            })
            : h('div', { style: S.empty },
              h('div', { style: { fontSize: 12, color: C.ink, fontWeight: 600 } }, hasBrowser ? t('shotUnavailable') : t('browserClosed')),
              h('div', null, hasBrowser ? '—' : t('browserClosedHint')),
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

    /**
     * The execution timeline: one compact row per tool call on a continuous rail.
     *
     * A row reads left to right — state dot, what ran, what it produced, how long
     * it took (bar scaled to the slowest step), and when. The newest row is kept
     * in view, so a live run always shows its latest step without scrolling.
     */
    function Timeline({ steps, t, scrollRef }) {
      if (steps.length === 0) {
        return h('div', { style: S.hint },
          h('div', { style: S.hintStrong }, t('noRun')),
          h('div', null, t('noRunHint')),
        )
      }
      const maxMs = steps.reduce((max, step) => (Number.isFinite(step.ms) ? Math.max(max, step.ms) : max), 0)
      return h('div', { style: S.tlList, ref: scrollRef },
        steps.map((step, index) => {
          const ok = step.state === 'ok'
          const failed = step.state === 'error'
          const running = step.state === 'running'
          const tone = failed ? C.error : running ? '#5b8cff' : C.ok
          const share = maxMs > 0 && Number.isFinite(step.ms) ? Math.max(3, Math.round((step.ms / maxMs) * 100)) : 3
          return h('div', { key: step.id, style: S.tlRow, title: step.detail || '' },
            h('div', { style: S.tlRail },
              h('i', {
                style: {
                  ...S.tlLine,
                  top: index === 0 ? '50%' : 0,
                  bottom: index === steps.length - 1 ? '50%' : 0,
                },
              }),
              h('i', { style: { ...S.tlDot, background: tone, boxShadow: running ? `0 0 0 3px rgba(91,140,255,.18)` : 'none' } }),
            ),
            h('div', { style: S.tlLabel }, step.label ?? step.tool),
            h('div', { style: S.tlNote }, step.note || step.detail || ''),
            h('div', { style: S.tlBarCell },
              h('div', { style: S.tlBarTrack }, h('i', { style: { ...S.tlBarFill, width: `${share}%`, background: tone } })),
              h('span', { style: S.tlMs }, Number.isFinite(step.ms) ? elapsed(step.ms) : (running ? '…' : '—')),
            ),
            h('div', { style: S.tlTime }, clock(step.at)),
          )
        }),
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

    /** The full-page console. */
    function Console(props) {
      const t = props.t
      const { snapshot, error, reload } = useConsoleState()
      const [courseId, setCourseId] = useState(null)
      const [stage, setStage] = useState('ALL')
      const [taskId, setTaskId] = useState(null)
      const [layout, setLayout] = useState(loadLayout)

      useEffect(() => { saveLayout(layout) }, [layout])

      const courses = snapshot?.courses ?? []
      const tasks = snapshot?.tasks ?? []

      // Keep a valid selection as the snapshot changes.
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

      const student = snapshot?.student
      const status = STATUS_TONE[snapshot?.status] ?? STATUS_TONE.idle
      const stats = snapshot?.stats ?? {}
      const library = snapshot?.library ?? { total: 0, courses: 0 }
      const grade = activeTask ? (snapshot?.grades?.[activeTask.id] ?? null) : null

      const stageCounts = useMemo(() => {
        const counts = { ALL: 0, FORMATIVE: 0, FINAL: 0, DISCUSSION: 0 }
        for (const task of tasks) {
          if (activeCourse && String(task.courseId) !== String(activeCourse.id)) continue
          counts.ALL += 1
          counts[task.stage] = (counts[task.stage] ?? 0) + 1
        }
        return counts
      }, [tasks, activeCourse])

      const hitRate = stats.questions ? Math.round(((stats.matched ?? 0) / stats.questions) * 100) : 0
      const answeredTasks = tasks.filter((task) => task.status === 'answered').length
      const handledTasks = tasks.filter((task) => task.status !== 'pending').length
      const timeline = snapshot?.timeline ?? []
      const timelineTotal = timeline.reduce((sum, step) => (Number.isFinite(step.ms) ? sum + step.ms : sum), 0)

      // Keep the newest step in view: a live run always shows where it is now.
      const timelineRef = useRef(null)
      useEffect(() => {
        const node = timelineRef.current
        if (node) node.scrollTop = node.scrollHeight
      }, [timeline.length])

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
              h('span', { style: { ...S.chip, color: '#9dbcff', background: 'rgba(91,140,255,.12)', borderColor: 'rgba(91,140,255,.26)' } }, t('simulation')),
              error && snapshot
                ? h('span', { style: { ...S.chip, color: C.error, background: 'rgba(239,122,122,.12)', borderColor: 'rgba(239,122,122,.24)' } }, '连接中断')
                : null,
            ),
            h('div', { style: S.subRow },
              snapshot
                ? `${t('courses')} ${courses.length} · ${t('tasks')} ${tasks.length} · ${t('answered')} ${answeredTasks} · ${t('libraryTotal')} ${library.total}`
                : error ? t('notServed') : '加载中…',
            ),
          ),
          h('div', { style: S.sep }),
          h('div', { style: S.student },
            h('div', { style: S.studentName }, student?.name || t('student')),
            h('div', { style: S.studentSub }, student ? `${student.account ?? ''}${student.school ? ` · ${student.school}` : ''}` : '—'),
          ),
          h('div', { style: S.topRight },
            snapshot?.report
              ? h('a', {
                href: `/ouch/report?file=${encodeURIComponent(String(snapshot.report.html).split(/[\\/]/).pop())}`,
                target: '_blank', rel: 'noreferrer',
                style: { ...S.btn, textDecoration: 'none', display: 'inline-flex', alignItems: 'center' },
              }, t('openReport'))
              : null,
            h('button', { type: 'button', style: S.btn, onClick: () => { reload() } }, t('refresh')),
            h('button', { type: 'button', style: S.btn, onClick: () => props.onBack() }, t('back')),
          ),
        ),

        // ---------------------------------------------------------------- body
        error && !snapshot
          ? h('div', { style: { ...S.card, flex: 1 } },
            h('div', { style: S.hint },
              h('div', { style: S.hintStrong }, t('notServed')),
              h('div', null, t('notServedHint')),
              h('div', { style: { ...S.mono, marginTop: 8, opacity: .8 } }, error),
            ),
          )
          : h('div', {
            style: { flex: 1, minHeight: 0, display: 'grid', gridTemplateRows: `minmax(0,1fr) 6px ${layout.bottomH}px` },
          },
            // ===== top: courses | tasks + questions | platform =====
            h('div', {
              style: { minHeight: 0, display: 'grid', gridTemplateColumns: `${layout.leftW}px 6px minmax(0,1fr) 6px ${layout.rightW}px` },
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
                    h('b', { style: S.cardTitle }, t('tasks')),
                    h('span', { style: S.cardHint }, activeCourse?.name ?? '—'),
                    h('div', { style: { ...S.cardRight, gap: 3 } },
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
                          const statusInfo = TASK_STATUS[task.status] ?? TASK_STATUS.pending
                          const availability = AVAILABILITY_TONE[task.availability] ?? AVAILABILITY_TONE.SKIPPED
                          const attempts = attemptLabel(task, t)
                          const announce = task.announceScore === 'immediate_announce'
                            ? t('immediateScore')
                            : task.announceScore ? t('afterReview') : null
                          const score = task.grade
                            ? `${task.grade.score}/${task.grade.total}`
                            : Number.isFinite(task.finalScore) ? String(task.finalScore) : null
                          return h('div', {
                            key: task.id,
                            style: { ...S.taskItem, ...(on ? S.taskItemOn : null) },
                            onClick: () => setTaskId(task.id),
                            onKeyDown: (event) => {
                              if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setTaskId(task.id) }
                            },
                            role: 'button',
                            tabIndex: 0,
                          },
                            h('div', { style: { ...S.stepIc, ...(on ? S.stepIcRun : null) } }, STAGE_GLYPH[task.stage] ?? '·'),
                            h('div', { style: { minWidth: 0, flex: 1 } },
                              h('div', { style: S.taskTitle }, task.title),
                              h('div', { style: S.taskMeta },
                                h('span', null, task.stageLabel ?? task.stage),
                                task.questionCount ? h('span', null, `${task.questionCount} ${t('questionsUnit')}`) : null,
                                task.totalPoints ? h('span', null, `${task.totalPoints} ${t('points')}`) : null,
                                attempts ? h('span', null, attempts) : null,
                                task.endTime ? h('span', null, `${t('deadline')} ${String(task.endTime).slice(0, 10)}`) : null,
                                announce ? h('span', { style: { color: announce === t('immediateScore') ? C.ok : C.muted } }, announce) : null,
                                task.availability !== 'ACTIONABLE' ? h('span', { style: { color: availability.color } }, task.availabilityLabel) : null,
                              ),
                            ),
                            score
                              ? h('span', {
                                style: {
                                  ...S.badge,
                                  color: task.grade && task.grade.wrong > 0 ? C.error : C.ok,
                                  borderColor: C.line,
                                  background: 'transparent',
                                },
                                title: task.grade ? `正确 ${task.grade.correct} · 错误 ${task.grade.wrong} · 待批改 ${task.grade.pending}` : '',
                              }, `${t('score')} ${score}`)
                              : null,
                            task.total > 0
                              ? h('span', { style: { ...S.monoCell, minWidth: 42, textAlign: 'right' } }, `${task.answered ?? 0}/${task.total}`)
                              : null,
                            h('span', { style: { ...S.badge, ...statusInfo.tone } }, statusInfo.label),
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
                        `${t('total')} ${detail.stats?.total ?? 0} · 匹配 ${detail.stats?.matched ?? 0} · ${t('filledCount')} ${detail.stats?.filled ?? 0}`
                        + (grade ? ` · ${t('score')} ${grade.score}/${grade.total}${grade.pending ? ` · ${t('pendingGrade')} ${grade.pending}` : ''}` : ''),
                      )
                      : detail?.kind === 'paper'
                        ? h('span', { style: S.cardRight }, `${t('paperReady')} · ${t('total')} ${detail.stats?.total ?? 0}`)
                        : grade
                          ? h('span', { style: S.cardRight },
                            `${t('score')} ${grade.score}/${grade.total} · ${t('correct')} ${grade.correct} · ${t('wrong')} ${grade.wrong}${grade.pending ? ` · ${t('pendingGrade')} ${grade.pending}` : ''}`,
                          )
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
                              h('th', { style: { ...S.th, width: 88 } }, t('source')),
                              h('th', { style: { ...S.th, width: 58 } }, t('match')),
                              h('th', { style: { ...S.th, width: 58 } }, t('status')),
                              h('th', { style: { ...S.th, width: 62 } }, t('grade')),
                            )),
                            h('tbody', null, (detail.questions ?? []).map((question) => {
                              const statusInfo = QUESTION_STATUS[question.status] ?? QUESTION_STATUS.matched
                              const raw = Array.isArray(question.answer) ? question.answer : []
                              const asLetters = raw.length > 0 && raw.every((item) => /^[A-Za-z]{1,4}$/.test(String(item).trim()))
                              const letters = asLetters ? raw.join('').toUpperCase() : ''
                              const textAnswer = asLetters ? '' : (raw.join('；') || String(question.answerText ?? ''))
                              const graded = grade?.perQuestion?.[question.seq]
                              const suspect = grade?.suspect?.includes(question.seq)
                              return h('tr', { key: question.seq },
                                h('td', { style: { ...S.td, ...S.monoCell } }, question.seq),
                                h('td', { style: S.td }, question.qtype),
                                h('td', { style: S.td }, h('div', { style: S.stemCell }, question.stem)),
                                h('td', { style: S.td },
                                  letters
                                    ? h('span', { style: S.ansLetters }, letters)
                                    : textAnswer
                                      ? h('span', {
                                        style: { ...S.monoCell, color: C.muted, display: 'block', maxWidth: 88, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
                                        title: textAnswer.slice(0, 400),
                                      }, textAnswer)
                                      : h('span', { style: { ...S.badge, color: C.error, borderColor: 'rgba(239,122,122,.3)' } }, '缺'),
                                ),
                                h('td', { style: { ...S.td, ...S.monoCell }, title: question.source?.file ?? '' },
                                  sourceLabel(question.source?.file, question.tier),
                                ),
                                h('td', { style: { ...S.td, ...S.monoCell } },
                                  question.tier === 'exact' ? '精确'
                                    : question.tier === 'high' ? `高 ${Math.round((question.score ?? 0) * 100)}%`
                                      : question.tier === 'medium' ? `中 ${Math.round((question.score ?? 0) * 100)}%`
                                        : question.tier === 'planned' ? '待答' : question.tier,
                                ),
                                h('td', { style: { ...S.td, color: statusInfo.tone.color } }, statusInfo.label),
                                h('td', { style: { ...S.td, whiteSpace: 'nowrap' } },
                                  graded
                                    ? graded.status === 'correct'
                                      ? h('span', { style: { color: C.ok } }, `${t('correct')} ${graded.score}`)
                                      : graded.status === 'wrong'
                                        ? h('span', { style: { color: C.error }, title: suspect ? '平台未给分，题库答案可能不准确' : '' }, t('wrong'))
                                        : graded.status === 'pending'
                                          ? h('span', { style: { color: C.warn } }, t('pendingGrade'))
                                          : '—'
                                    : '—',
                                ),
                              )
                            })),
                          )
                          : h('div', { style: S.hint },
                            h('div', { style: S.hintStrong }, t('notStarted')),
                            h('div', null, t('notStartedHint')
                              .replace('{course}', activeTask.courseName ?? '')
                              .replace('{task}', activeTask.title ?? '')),
                          ),
                  ),
                ),
              ),

              h(Splitter, { orientation: 'v', label: t('resize'), onDrag: (delta) => setLayout((prev) => ({ ...prev, rightW: clamp(prev.rightW - delta, 280, 640) })) }),

              // -------- live platform frame (no chrome: the picture is the card)
              h('section', { style: { ...S.card, background: '#0f1115' } },
                h(LiveFrame, { snapshot, t }),
                h('div', { style: S.pageInfo },
                  h('div', { style: S.pageInfoRow },
                    h('b', { style: S.pageInfoKey }, t('student')),
                    h('span', { style: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
                      student ? `${student.name ?? ''}${student.account ? ` · ${student.account}` : ''}` : '—'),
                  ),
                  h('div', { style: S.pageInfoRow },
                    h('b', { style: S.pageInfoKey }, t('taskProgress')),
                    h('span', { style: { ...S.mono, color: C.muted } }, `${handledTasks} / ${tasks.length}`),
                  ),
                  h('div', { style: S.pageInfoRow },
                    h('b', { style: S.pageInfoKey }, t('grade')),
                    h('span', { style: { ...S.mono, color: grade ? (grade.wrong > 0 ? C.error : C.ok) : C.muted } },
                      grade ? `${grade.score}/${grade.total} · ${t('correct')} ${grade.correct} · ${t('wrong')} ${grade.wrong}` : '—'),
                  ),
                ),
              ),
            ),

            h(Splitter, { orientation: 'h', label: t('resize'), onDrag: (delta) => setLayout((prev) => ({ ...prev, bottomH: clamp(prev.bottomH - delta, 118, 420) })) }),

            // ===== bottom: timeline | stats =====
            h('div', {
              style: { minHeight: 0, display: 'grid', gridTemplateColumns: `minmax(0,1fr) 6px ${layout.statsW}px` },
            },
              h('section', { style: S.card },
                h('div', { style: S.cardHead },
                  h('b', { style: S.cardTitle }, t('timeline')),
                  h('span', { style: S.cardHint }, `${timeline.length} 步 · 总耗时 ${elapsed(timelineTotal)}`),
                  h('span', { style: S.cardRight },
                    snapshot?.report ? `${t('reports')} · ${String(snapshot.report.html).split(/[\\/]/).pop()}` : t('readonly')),
                ),
                h(Timeline, { steps: timeline, t, scrollRef: timelineRef }),
              ),

              h(Splitter, { orientation: 'v', label: t('resize'), onDrag: (delta) => setLayout((prev) => ({ ...prev, statsW: clamp(prev.statsW - delta, 300, 900) })) }),

              h('section', { style: S.card },
                h('div', { style: S.cardHead },
                  h('b', { style: S.cardTitle }, t('stats')),
                  h('span', { style: S.cardHint }, library.builtAt ? String(library.builtAt).slice(0, 10) : ''),
                  h('span', { style: S.cardRight }, t('readonly')),
                ),
                h('div', { style: S.scroll },
                  h('div', { style: S.kpiGridDense },
                    h(KpiDense, { label: t('courses'), value: formatNumber(courses.length) }),
                    h(KpiDense, { label: t('tasks'), value: formatNumber(tasks.length) }),
                    h(KpiDense, { label: t('questionsShort'), value: formatNumber(stats.questions) }),
                    h(KpiDense, { label: t('filledCount'), value: formatNumber(stats.answered) }),
                    h(KpiDense, { label: t('hitRate'), value: `${hitRate}%`, bar: hitRate }),
                    h(KpiDense, { label: t('graded'), value: formatNumber(stats.graded) }),
                    h(KpiDense, { label: t('correct'), value: formatNumber(stats.correct), color: C.ok }),
                    h(KpiDense, { label: t('wrong'), value: formatNumber(stats.wrong), color: C.error }),
                    h(KpiDense, { label: t('pendingGrade'), value: formatNumber(stats.pending) }),
                    h(KpiDense, { label: t('libraryTotal'), value: formatNumber(library.total) }),
                    h(KpiDense, { label: t('libraryCourses'), value: formatNumber(library.courses) }),
                    h(KpiDense, { label: t('drafts'), value: formatNumber(stats.drafts) }),
                  ),
                ),
              ),
            ),
          ),
      )
    }

    /** Zero-content panel behind the 工作台 row: flips the accordion and returns. */
    function makeTogglePanel(layout) {
      return function TogglePanel() {
        useEffect(() => {
          setUi({ expanded: !uiStore.expanded })
          try { layout.selectPanel(null) } catch { /* ignore */ }
        }, [])
        return null
      }
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
      }, (slotProps) => h(Console, { ...slotProps, t, ctx, onBack: back }))), 'workbench.panel')

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

      ctx.effect(() => {
        let dispose = null
        const sync = () => {
          if (uiStore.expanded) {
            if (dispose === null) {
              dispose = ctx.slots.register({
                name: 'sidebar.panellist',
                id: PANEL_ID,
                order: -29,
                label: () => t('toolOuchn'),
              }, ToolIcon)
            }
            return
          }
          if (dispose !== null) { dispose(); dispose = null }
        }
        const unsubscribe = subscribeUi(sync)
        sync()
        return () => {
          unsubscribe()
          if (dispose !== null) { dispose(); dispose = null }
        }
      }, 'workbench.tool-row')
    }

    return {
      inject: ['slots', 'locale', 'layout', 'sessions', 'uiSession'],
      apply,
    }
  },
})
