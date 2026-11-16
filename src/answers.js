/**
 * Answer library: load one course's parsed questions, normalise, match, and map
 * the stored answer onto the options the page actually shows.
 *
 * The library is built by `tools/build-answers.py` from the reference app's
 * parsed index; records keep their raw stem so that build and runtime share one
 * normalisation (this module) instead of two implementations that can drift.
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

/** Punctuation and whitespace that never carry meaning in a stem. */
const STRIP = /[\s\u3000·，。、；：？！“”‘’（）《》〈〉【】,.;:?!"'()<>[\]{}…—–\-_/\\|+*=&^%$#@~`]+/g

/** Leading question numbering: "1.", "（2）", "三、". */
const LEADING_INDEX = /^\s*(?:\d{1,3}\s*[.、．)）]|[（(]\s*\d{1,3}\s*[)）]|[一二三四五六七八九十]{1,3}\s*[、.．])+/

/**
 * 题库里的题干后面常跟着整段排版信息（单独一行的"单选题"、"(3.0分)"、
 * "(难易度:中)"），页面上只有题干本身。这些行不参与匹配，否则同一道题会差出
 * 十几个字符而匹配不上。
 */
const TYPE_LINE = /^\s*(单选题|多选题|判断题|填空题|简答题|论述题|名词解释|计算题|案例分析|不定项选择题)\s*$/
const SCORE_LINE = /^\s*[（(]?\s*\d+(?:\.\d+)?\s*分\s*[)）]?\s*$/
const DIFFICULTY_LINE = /^\s*[（(]?\s*难易度/

/** Normalise a stem or option text for comparison. */
export function normalize(text) {
  let value = String(text ?? '')
  try { value = value.normalize('NFKC') } catch { /* keep the raw text */ }
  value = value.toLowerCase()
  value = value.replace(/<[^>]+>/g, ' ')
  if (/\n/.test(value)) {
    const kept = []
    for (const line of value.split(/\r?\n/)) {
      if (TYPE_LINE.test(line)) break
      if (SCORE_LINE.test(line) || DIFFICULTY_LINE.test(line)) continue
      kept.push(line)
    }
    value = kept.join(' ')
  }
  value = value.replace(LEADING_INDEX, '')
  value = value.replace(STRIP, '')
  return value
}

/** Stable identity of a normalised stem. */
export function stemHash(normalized) {
  return createHash('sha1').update(normalized).digest('hex')
}

/** Character bigram counts, used for the Dice coefficient. */
function bigrams(text) {
  const counts = new Map()
  for (let index = 0; index < text.length - 1; index += 1) {
    const gram = text.slice(index, index + 2)
    counts.set(gram, (counts.get(gram) ?? 0) + 1)
  }
  return counts
}

/** Sørensen–Dice similarity of two strings, 0..1. */
export function similarity(left, right) {
  if (!left || !right) return 0
  if (left === right) return 1
  if (left.length < 2 || right.length < 2) return left === right ? 1 : 0
  const a = bigrams(left)
  const b = bigrams(right)
  let overlap = 0
  for (const [gram, count] of a) {
    const other = b.get(gram)
    if (other) overlap += Math.min(count, other)
  }
  return (2 * overlap) / (left.length - 1 + right.length - 1)
}

/** One course's records plus their precomputed normal forms. */
export class CourseAnswers {
  constructor(key, slug, records) {
    this.key = key
    this.slug = slug
    this.records = records
    this.byHash = new Map()
    for (const record of records) {
      record.norm = normalize(record.s)
      record.hash = stemHash(record.norm)
      if (!this.byHash.has(record.hash)) this.byHash.set(record.hash, record)
    }
  }

  get size() {
    return this.records.length
  }

  /** Records whose stage hint matches, falling back to everything. */
  forStage(stage) {
    const wanted = String(stage ?? '').toUpperCase()
    const filtered = this.records.filter((record) => (record.h || '') === wanted)
    return filtered.length > 0 ? filtered : this.records
  }

  /** Exact hash, then fuzzy scan. Returns `{ record, score, tier }`. */
  find(stem, threshold = 0.8) {
    const norm = normalize(stem)
    if (!norm) return null
    const hash = stemHash(norm)
    const exact = this.byHash.get(hash)
    if (exact) return { record: exact, score: 1, tier: 'exact' }
    let best = null
    let bestScore = 0
    for (const record of this.records) {
      // Length gate: a 200-char essay can never be a 92% match for a 12-char stem.
      const shorter = Math.min(norm.length, record.norm.length)
      const longer = Math.max(norm.length, record.norm.length)
      const ratio = shorter / longer
      if (ratio < 0.5) continue
      // A page often wraps the bank's stem in extra material, or the bank kept a
      // trailing hint the page dropped; containment is stronger evidence than
      // shared bigrams, so give it a calibrated score of its own.
      let score = similarity(norm, record.norm)
      if (ratio >= 0.6 && (norm.includes(record.norm) || record.norm.includes(norm))) {
        score = Math.max(score, 0.9 + 0.08 * ratio)
      }
      if (score > bestScore) {
        bestScore = score
        best = record
        if (score === 1) break
      }
    }
    if (!best || bestScore < threshold) return null
    return { record: best, score: bestScore, tier: bestScore >= 0.95 ? 'high' : 'medium' }
  }
}

/** The answer library rooted at `<plugin>/data`. */
export class AnswerLibrary {
  constructor(dataDir) {
    this.dataDir = dataDir
    this.manifest = null
    this.cache = new Map()
  }

  /**
   * Load the manifest (cached).
   *
   * A full install has `library.json`; the public repository ships only a sample
   * bank with `library.sample.json`, so the sample stays a complete, working
   * fallback instead of a file the code pretends not to see.
   */
  load() {
    if (this.manifest) return this.manifest
    for (const name of ['library.json', 'library.sample.json']) {
      const file = path.join(this.dataDir, name)
      if (!existsSync(file)) continue
      this.manifest = JSON.parse(readFileSync(file, 'utf8'))
      return this.manifest
    }
    throw new Error('答案库清单不存在：data/library.json 或 data/library.sample.json')
  }

  /** Courses the manifest lists *and* that actually have a data file here. */
  availableCourses() {
    return (this.load().courses ?? []).filter((course) => (
      existsSync(path.join(this.dataDir, 'answers', `${course.slug}.jsonl`))
    ))
  }

  /** Every course key the library knows, with its question count. */
  courses() {
    return this.availableCourses().map((course) => ({
      key: course.key,
      slug: course.slug,
      count: course.count,
      qtypes: course.qtypes ?? {},
      stages: course.stages ?? {},
    }))
  }

  /**
   * Find the library course for a platform course name.
   *
   * Name similarity alone is not enough: the library holds both "形势与政策"
   * (39 questions) and "《形势与政策》" (2), and both "企业纳税实务" (1) and
   * "纳税实务" (195). A near-empty key that happens to match the name exactly is
   * worth less than a slightly wider key with a usable bank, so the rank weighs
   * the number of parseable questions against text similarity.
   */
  resolveCourse(name) {
    const wanted = normalize(name)
    if (!wanted) return null
    const courses = this.courses()
    let best = null
    let bestRank = 0
    for (const course of courses) {
      const candidate = normalize(course.key)
      if (!candidate) continue
      let score = 0
      if (candidate === wanted) score = 1
      else if (candidate.includes(wanted) || wanted.includes(candidate)) {
        score = 0.9 * (Math.min(candidate.length, wanted.length) / Math.max(candidate.length, wanted.length)) + 0.1
      } else {
        score = similarity(candidate, wanted)
      }
      if (score < 0.62) continue
      const rank = score * score * (0.4 + 0.6 * Math.min(1, course.count / 60))
      if (rank > bestRank) {
        bestRank = rank
        best = { ...course, score }
      }
    }
    return best
  }

  /** Load one course's records (cached by slug). */
  loadCourse(slug) {
    if (this.cache.has(slug)) return this.cache.get(slug)
    const course = (this.load().courses ?? []).find((item) => item.slug === slug)
    if (!course) throw new Error(`答案库里没有课程：${slug}`)
    const file = path.join(this.dataDir, 'answers', `${slug}.jsonl`)
    const text = readFileSync(file, 'utf8')
    const records = []
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      try { records.push(JSON.parse(line)) } catch { /* skip a corrupt line */ }
    }
    const answers = new CourseAnswers(course.key, slug, records)
    this.cache.set(slug, answers)
    return answers
  }

  /** Statistics for the manifest, for the panel's library card. */
  stats() {
    const courses = this.availableCourses()
    const qtypes = {}
    let total = 0
    for (const course of courses) {
      total += course.count
      for (const [type, count] of Object.entries(course.qtypes ?? {})) {
        qtypes[type] = (qtypes[type] ?? 0) + count
      }
    }
    const manifest = this.load()
    return {
      builtAt: manifest.builtAt ?? null,
      total,
      courses: courses.length,
      qtypes,
      skipped: manifest.skipped ?? {},
      sample: manifest.source === 'sample',
    }
  }
}

/* ------------------------------------------------------------------ *
 * Option mapping
 * ------------------------------------------------------------------ */

/** Option text preferred over the letter: the page may reorder choices. */
function cleanOption(text) {
  return normalize(text)
}

/** Judge answers appear as 对/错, 正确/错误, 是/否, √/×, true/false. */
const JUDGE_WORDS = {
  对: 'T', 正确: 'T', 是: 'T', '√': 'T', true: 'T', t: 'T',
  错: 'F', 错误: 'F', 否: 'F', '×': 'F', false: 'F', f: 'F',
}

/** Canonical judge polarity of a value, or null when it is not a judge answer. */
function judgePolarity(text) {
  const value = normalize(text)
  return value ? JUDGE_WORDS[value] ?? null : null
}

/**
 * Map a stored answer onto the page's options.
 *
 * `sourceOptions` are the options the answer was recorded against (`{A: '…'}`),
 * `pageOptions` are the ones rendered now. Letters are only trusted when the
 * option text proves they still point at the same choice.
 *
 * @returns {{letters: string[], failed: boolean, note: string, unresolved: string[]}}
 */
export function mapOptions(answer, sourceOptions, pageOptions) {
  const page = pageOptions && typeof pageOptions === 'object' ? pageOptions : {}
  const pageKeys = Object.keys(page)
  const source = sourceOptions && typeof sourceOptions === 'object' ? sourceOptions : {}
  const sourceKeys = Object.keys(source)
  const values = (Array.isArray(answer) ? answer : [answer]).map((item) => String(item ?? '').trim()).filter(Boolean)
  if (values.length === 0) return { letters: [], failed: true, note: '答案为空', unresolved: [] }
  if (pageKeys.length === 0) return { letters: values, failed: false, note: '无选项', unresolved: [] }

  // Stored as letters ("A", "AC") against known original option texts.
  if (values.every((value) => /^[A-Za-z]+$/.test(value))) {
    const wanted = values.join('').toUpperCase().split('')
    const letters = []
    const unresolved = []
    for (const letter of wanted) {
      const text = source[letter]
      if (text !== undefined) {
        const target = bestOption(cleanOption(text), page)
        if (target) letters.push(target)
        else unresolved.push(letter)
        continue
      }
      // No source text: trust the letter only when the page agrees on count/order.
      if (page[letter] !== undefined && sourceKeys.length === pageKeys.length) letters.push(letter)
      else unresolved.push(letter)
    }
    if (unresolved.length === 0) return { letters, failed: false, note: '按选项文本映射', unresolved }
    return { letters, failed: true, note: `选项映射失败：${unresolved.join(',')}`, unresolved }
  }

  // Stored as text (judge: 对/错, fill: a phrase).
  const letters = []
  const unresolved = []
  for (const value of values) {
    const wanted = cleanOption(value)
    if (!wanted) continue
    const polarity = judgePolarity(value)
    if (polarity) {
      const target = pageKeys.find((key) => judgePolarity(page[key]) === polarity)
      if (target) { letters.push(target); continue }
    }
    const target = bestOption(wanted, page)
    if (target) { letters.push(target); continue }
    // A judge option may phrase the same polarity with extra words.
    const loose = pageKeys.find((key) => {
      const option = cleanOption(page[key])
      return option.includes(wanted) || wanted.includes(option)
    })
    if (loose) letters.push(loose)
    else unresolved.push(value)
  }
  if (letters.length === 0) return { letters, failed: true, note: '选项映射失败', unresolved }
  return { letters, failed: unresolved.length > 0, note: unresolved.length ? `未映射：${unresolved.join(',')}` : '按答案文本映射', unresolved }
}

/** Best page option for a normalised text: exact, then containment, then fuzzy. */
function bestOption(normalizedText, page) {
  if (!normalizedText) return null
  const keys = Object.keys(page)
  for (const key of keys) {
    if (cleanOption(page[key]) === normalizedText) return key
  }
  let best = null
  let bestScore = 0
  for (const key of keys) {
    const option = cleanOption(page[key])
    if (!option) continue
    let score = similarity(normalizedText, option)
    if (option.includes(normalizedText) || normalizedText.includes(option)) {
      score = Math.max(score, 0.92 * (Math.min(option.length, normalizedText.length) / Math.max(option.length, normalizedText.length)) + 0.06)
    }
    if (score > bestScore) { bestScore = score; best = key }
  }
  return bestScore >= 0.8 ? best : null
}
