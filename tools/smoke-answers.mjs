import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { AnswerLibrary, mapOptions, normalize } from '../src/answers.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const dataDir = path.join(here, '..', 'data')
const library = new AnswerLibrary(dataDir)

const stats = library.stats()
console.log('library:', JSON.stringify(stats))

for (const name of ['管理学基础', '形势与政策', '企业信息管理', '企业纳税实务', '管理英语1', '市场营销学', '不存在的课程']) {
  const hit = library.resolveCourse(name)
  console.log(`resolve ${name} ->`, hit ? `${hit.key} (${hit.count}) score=${hit.score.toFixed(2)}` : 'null')
}

const course = library.resolveCourse('管理学基础')
const answers = library.loadCourse(course.slug)
console.log('course size:', answers.size)

// exact after cosmetic edits
const sample = answers.records.find((r) => r.q === 'single')
console.log('\nsample stem:', sample.s)
const cosmetic = `  ${sample.s.replace('(', '（')}  `
const exact = answers.find(cosmetic)
console.log('exact match:', exact?.tier, exact?.score.toFixed(3), 'same record:', exact?.record === sample)

// fuzzy (truncate a few characters)
const fuzzyText = sample.s.slice(0, Math.max(6, sample.s.length - 4))
const fuzzy = answers.find(fuzzyText)
console.log('fuzzy match:', fuzzy?.tier, fuzzy?.score.toFixed(3), 'same record:', fuzzy?.record === sample)

// miss
const miss = answers.find('这道题在任何答案库里都不存在，测试未命中分支。')
console.log('miss:', miss)

// option mapping: stored A..D, page shows the same choices in another order
const stored = { A: '组织资源和组织目标', B: '组织资源和组织活动', C: '组织目标和组织活动', D: '组织中的人' }
const shuffled = { A: '组织中的人', B: '组织目标和组织活动', C: '组织资源和组织目标', D: '组织资源和组织活动' }
console.log('\nmap B (组织资源和组织活动):', mapOptions(['B'], stored, shuffled))
console.log('map A (组织资源和组织目标):', mapOptions(['A'], stored, shuffled))

// judge
const judge = answers.records.find((r) => r.q === 'judge')
console.log('\njudge stem:', judge.s)
console.log('judge answer:', judge.a, judge.o)
console.log('judge map (对/错):', mapOptions(judge.a, judge.o, { A: '正确', B: '错误' }))
console.log('judge map (same order):', mapOptions(judge.a, judge.o, judge.o))

// multiple
const multi = answers.records.find((r) => r.q === 'multiple')
console.log('\nmultiple:', multi.a, mapOptions(multi.a, multi.o, multi.o))

console.log('\nnormalize examples:')
for (const text of ['（1）下列各选项中,( )属于管理的对象。', ' １、测试　句子 ', 'A. 选项']) {
  console.log(JSON.stringify(text), '->', JSON.stringify(normalize(text)))
}
