/**
 * Regenerate the report from the saved console state, without a browser.
 *
 * Useful after a display-only change to report.js: the artifact then matches what
 * the current code produces. Usage: node tools/make-report.mjs
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { WorkbenchService } from '../src/service.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const packageDir = path.join(here, '..')
const workspace = path.join(packageDir, '..')

const ctx = {
  get(name) {
    if (name === 'workingDirectory') return { defaultDirectory: workspace }
    return undefined
  },
  effect() {},
  logger: { warn: (message) => console.warn('[warn]', message) },
  tools: { register() {} },
}

const service = new WorkbenchService(ctx, { packageDir })
const exec = { agent: { session: { id: 'report' } } }

try {
  await service.hydrate(exec)
  if (!service.state.courses.length) throw new Error('没有可用的执行台状态：先跑一次 tools/smoke-e2e.mjs')
  const report = await service.report({}, exec)
  console.log(report)
} catch (error) {
  console.error('FAILED:', error?.message ?? error)
  process.exitCode = 1
} finally {
  // Regenerating a report must not rewrite the console state the preview reads.
  service.stateFileRef = null
  if (service.saveTimer) { clearTimeout(service.saveTimer); service.saveTimer = null }
  await service.dispose().catch(() => {})
}
