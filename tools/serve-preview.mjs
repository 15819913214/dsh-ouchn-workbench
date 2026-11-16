/**
 * 极小的静态服务器：只给 panel-harness.html 用，把仓库根目录挂出来，
 * 这样浏览器能同时加载 .preview 里的 react UMD 和 workbench/client.js。
 *
 * 用法：node tools/serve-preview.mjs [port]
 */
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(here, '..', '..')
const port = Number(process.argv[2]) || 47831

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.css': 'text/css; charset=utf-8',
}

createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost')
    const rel = decodeURIComponent(url.pathname === '/' ? '/.preview/panel-harness.html' : url.pathname)
    const file = path.normalize(path.join(root, rel))
    if (!file.startsWith(root)) { res.writeHead(403).end('forbidden'); return }
    const body = await readFile(file)
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' })
    res.end(body)
  } catch (error) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    res.end(`not found: ${error?.message ?? error}`)
  }
}).listen(port, '127.0.0.1', () => {
  console.log(`panel harness: http://127.0.0.1:${port}/.preview/panel-harness.html`)
})
