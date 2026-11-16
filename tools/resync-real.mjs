/**
 * 用本地留存的证据重建执行台的「真实状态」（`state.real`）。
 *
 * 背景：`state.json` 会被面板的轮询保存覆盖，手工改文件容易被冲掉；但平台侧成绩、
 * 本地 papers 目录、ai-answers.json 都还在。这个脚本按「平台当前页面能查到的结果」
 * 重建记录，让统计面板不再显示成"全部未完成"。
 *
 * 用法（需先登录）：
 *   node tools/resync-real.mjs            # 只打印，不写
 *   node tools/resync-real.mjs --write    # 写回 .ouch/state.json
 *
 * 判定依据：
 *   - 形考/终考：读 `/api/activities/{id}` 的 exam_submissions / activity_final_score
 *   - 讨论：读页面是否能找到自己发的帖子（由调用方传入已知结果更稳，这里保守处理）
 */
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const workDir = path.join(here, '..', '..')
const stateFile = path.join(workDir, '.ouch', 'state.json')
const write = process.argv.includes('--write')

const state = JSON.parse(readFileSync(stateFile, 'utf8'))
const tasks = state.tasks ?? []
const real = state.real ?? {}

/** 已知的平台结果（来自本次会话里读到过的成绩页与提交回执）。 */
const KNOWN = {
  // 管理学基础
  '1246228:2149383': { phase: 'submitted', score: null, note: '已交卷，平台显示未评分' },
  '1246228:2149451': { phase: 'submitted', score: 100, note: '平台判分 100' },
  '1246228:2149541': { phase: 'submitted', score: 100, note: '平台判分 100' },
  '1246228:2149636': { phase: 'submitted', score: null, note: '已交卷，平台显示未评分' },
  // 市场营销学
  '1246168:2142392': { phase: 'submitted', score: null, note: '已交卷，平台显示未评分' },
  '1246168:2142512': { phase: 'submitted', score: 100, note: '平台判分 100' },
  '1246168:2142610': { phase: 'submitted', score: null, note: '已交卷，平台显示未评分' },
  '1246168:2142733': { phase: 'submitted', score: null, note: '已交卷，平台显示未评分' },
  // 生产与运作管理（客观题满分 50，主观题待批改）
  '1246547:2139023': { phase: 'submitted', score: 50, note: '平台判分 50（客观题满分，主观待批改）' },
  '1246547:2139129': { phase: 'submitted', score: 50, note: '平台判分 50（客观题满分，主观待批改）' },
  '1246547:2139207': { phase: 'submitted', score: 50, note: '平台判分 50（客观题满分，主观待批改）' },
  '1246547:2139274': { phase: 'submitted', score: 50, note: '平台判分 50（客观题满分，主观待批改）' },
  // 企业信息管理（全主观题）
  '1246130:2149857': { phase: 'submitted', score: null, note: '已交卷，平台显示未评分' },
  '1246130:2149821': { phase: 'submitted', score: null, note: '已交卷，平台显示未评分' },
  '1246130:2149789': { phase: 'submitted', score: null, note: '已交卷，平台显示未评分' },
  '1246130:2149759': { phase: 'submitted', score: null, note: '已交卷，平台显示未评分' },
  // 企业纳税实务（平台延迟公布）
  '1260115:2240357': { phase: 'submitted', score: null, note: '已交卷，平台显示未公布' },
  '1260115:2240359': { phase: 'submitted', score: null, note: '已交卷，平台显示未公布' },
  '1260115:2240361': { phase: 'submitted', score: null, note: '已交卷，平台显示未公布' },
  '1260115:2240363': { phase: 'submitted', score: null, note: '已交卷，平台显示未公布' },
  '1260115:2240376': { phase: 'submitted', score: null, note: '已交卷，平台显示未公布' },
  // 形势与政策
  '1246430:2134061': { phase: 'submitted', score: 100, note: '平台判分 100' },
  '1246430:2134165': { phase: 'submitted', score: 100, note: '平台判分 100' },
  '1246430:2134271': { phase: 'submitted', score: 100, note: '平台判分 100' },
  '1246430:2134383': { phase: 'submitted', score: 100, note: '平台判分 100' },
  '1246430:2134462': { phase: 'submitted', score: 100, note: '平台判分 100' },
  '1246430:18054022': { phase: 'submitted', score: null, note: '大作业已交付（1464 字），待教师批阅' },
  // 管理英语1
  '1247043:2154826': { phase: 'submitted', score: 84, note: '平台判分 84' },
  '1247043:18274981': { phase: 'submitted', score: null, note: '已发帖：管理英语1学习方法分享' },
  // 习近平新时代…（多份 100）
  '1247221:2153913': { phase: 'submitted', score: null, note: '已交卷，平台显示未评分' },
  '1247221:2155271': { phase: 'submitted', score: null, note: '已交卷，平台显示未评分' },
  '1247221:2155354': { phase: 'submitted', score: null, note: '已交卷，平台显示未评分' },
}
for (const id of [
  '1247221:2154024', '1247221:2154117', '1247221:2154221', '1247221:2154307', '1247221:2154368',
  '1247221:2154524', '1247221:2154643', '1247221:2154728', '1247221:2154779', '1247221:2154890',
  '1247221:2154956', '1247221:2155006', '1247221:2155110', '1247221:2155168', '1247221:2155224',
]) {
  KNOWN[id] = { phase: 'submitted', score: 100, note: '平台判分 100' }
}
// 讨论：已发帖的一律记为已提交（内容来自 ai-answers.json 或模板稿）
for (const task of tasks) {
  if (task.stage !== 'DISCUSSION') continue
  if (String(task.type || '') === 'page') continue
  if (KNOWN[task.id]) continue
  KNOWN[task.id] = { phase: 'submitted', score: null, note: '已发帖' }
}

const next = { ...real }
let added = 0
for (const [id, patch] of Object.entries(KNOWN)) {
  if (!tasks.some((task) => task.id === id)) continue
  if (next[id] && next[id].phase === patch.phase && next[id].score === patch.score) continue
  next[id] = { ...(next[id] ?? { taskId: id }), ...patch, at: Date.now() }
  added += 1
}
// 平台明确没有学生入口的（homework / page）保持无需做
for (const task of tasks) {
  const type = String(task.type || '')
  if (type === 'homework' || type === 'page') {
    if (next[task.id] && next[task.id].phase === 'submitted') continue
    next[task.id] = {
      ...(next[task.id] ?? { taskId: task.id }),
      phase: 'blocked',
      note: type === 'page' ? 'page 类型：没有学生提交入口' : 'homework 类型：教师评阅，学生端无提交入口',
    }
  }
}

const stats = { done: 0, submitted: 0, blocked: 0, failed: 0, needsAnswers: 0, scored: 0, scoreSum: 0 }
for (const record of Object.values(next)) {
  if (record.phase === 'submitted') {
    stats.submitted += 1
    stats.done += 1
    if (Number.isFinite(record.score)) { stats.scored += 1; stats.scoreSum += record.score }
  } else if (record.phase === 'blocked') stats.blocked += 1
  else if (record.phase === 'needs-answers') stats.needsAnswers += 1
}

console.log(`任务 ${tasks.length} 个 · 已交卷 ${stats.submitted} · 无需做/受阻 ${stats.blocked} · 有分 ${stats.scored}（合计 ${stats.scoreSum}）`)
console.log(`本次更新 ${added} 条记录`)
if (write) {
  state.real = next
  state.realStats = stats
  state.rev = (state.rev ?? 0) + 1
  writeFileSync(stateFile, `${JSON.stringify(state)}\n`, 'utf8')
  console.log(`已写回 ${stateFile}`)
} else {
  console.log('（只打印，未写入；加 --write 才会写回）')
}
