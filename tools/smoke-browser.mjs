import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { BrowserSession } from '../src/browser.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(here, '..', '..')
const profileDir = path.join(root, '.ouch', 'profile')
const shotDir = path.join(root, '.ouch', 'shots')

const t0 = Date.now()
const session = await BrowserSession.launch({ profileDir, shotDir, headless: false })
console.log('launched in', Date.now() - t0, 'ms')

try {
  const opened = await session.goto('https://lms.ouchn.cn/user/courses')
  console.log('goto ->', opened)

  const snap = await session.snapshot({ maxChars: 700, maxElements: 12 })
  console.log('title:', snap.title)
  console.log('url:', snap.url)
  console.log('text head:', snap.text.split('\n').slice(0, 12).join(' | '))
  console.log('elements:', snap.elements.length)

  const shot = await session.screenshot('smoke')
  console.log('shot:', shot.relative)

  const jpeg = await session.shotDataUrl(50)
  console.log('jpeg bytes:', jpeg.length)

  const value = await session.evaluate('({ courses: Array.from(document.querySelectorAll(\'a[href^="/course/"][href$="/content"]\')).map(a => ({ name: a.innerText.trim(), href: a.getAttribute(\'href\') })) })')
  console.log('courses via eval:', JSON.stringify(value, null, 1))
} finally {
  await session.close()
  console.log('closed')
}
