/**
 * Minimal Chrome DevTools Protocol client.
 *
 * Written without dependencies on purpose: the Host process runs inside Electron,
 * where adding a websocket package to a locally linked bundle is fragile. This
 * module implements only what the runboard drives: one page target per run, a
 * request/response channel, and an event subscription.
 */
import net from 'node:net'
import { randomBytes } from 'node:crypto'

/** Serialize a websocket client frame (client frames are always masked). */
function encodeFrame(opcode, payload) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8')
  const length = data.length
  let header
  if (length < 126) {
    header = Buffer.alloc(2)
    header[1] = 0x80 | length
  } else if (length < 65536) {
    header = Buffer.alloc(4)
    header[1] = 0x80 | 126
    header.writeUInt16BE(length, 2)
  } else {
    header = Buffer.alloc(10)
    header[1] = 0x80 | 127
    header.writeBigUInt64BE(BigInt(length), 2)
  }
  header[0] = 0x80 | opcode
  const mask = randomBytes(4)
  const masked = Buffer.allocUnsafe(length)
  for (let i = 0; i < length; i += 1) masked[i] = data[i] ^ mask[i % 4]
  return Buffer.concat([header, mask, masked])
}

/** One websocket connection to a DevTools endpoint. */
class Socket {
  constructor(url) {
    this.url = url
    this.socket = null
    this.buffer = Buffer.alloc(0)
    this.upgraded = false
    this.fragment = []
    this.messageHandlers = new Set()
    this.closeHandlers = new Set()
    this.closed = false
  }

  /** Open the connection and complete the HTTP upgrade handshake. */
  connect(timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      const target = new URL(this.url)
      const port = Number(target.port || 80)
      const host = target.hostname
      const path = `${target.pathname}${target.search}`
      const key = randomBytes(16).toString('base64')
      const socket = net.connect({ host, port })
      this.socket = socket
      let settled = false
      const fail = (error) => {
        if (settled) return
        settled = true
        try { socket.destroy() } catch { /* already gone */ }
        reject(error)
      }
      const timer = setTimeout(() => fail(new Error(`devtools websocket handshake timed out (${this.url})`)), timeoutMs)
      socket.setNoDelay(true)
      socket.on('error', (error) => {
        clearTimeout(timer)
        fail(error)
        this.emitClose(error)
      })
      socket.on('close', () => {
        clearTimeout(timer)
        this.closed = true
        if (!settled) fail(new Error('devtools websocket closed before the handshake'))
        this.emitClose(null)
      })
      socket.on('data', (chunk) => {
        if (this.upgraded) {
          this.feed(chunk)
          return
        }
        this.buffer = Buffer.concat([this.buffer, chunk])
        const end = this.buffer.indexOf('\r\n\r\n')
        if (end < 0) return
        const head = this.buffer.subarray(0, end).toString('latin1')
        const rest = this.buffer.subarray(end + 4)
        this.buffer = Buffer.alloc(0)
        if (!/^HTTP\/1\.1 101/i.test(head)) {
          clearTimeout(timer)
          fail(new Error(`devtools websocket upgrade refused: ${head.split('\r\n')[0]}`))
          return
        }
        this.upgraded = true
        clearTimeout(timer)
        settled = true
        resolve()
        if (rest.length > 0) this.feed(rest)
      })
      socket.write(
        `GET ${path} HTTP/1.1\r\n`
        + `Host: ${host}:${port}\r\n`
        + 'Upgrade: websocket\r\n'
        + 'Connection: Upgrade\r\n'
        + `Sec-WebSocket-Key: ${key}\r\n`
        + 'Sec-WebSocket-Version: 13\r\n\r\n',
      )
    })
  }

  /** Split the inbound byte stream into websocket frames. */
  feed(chunk) {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk])
    for (;;) {
      if (this.buffer.length < 2) return
      const first = this.buffer[0]
      const second = this.buffer[1]
      const fin = (first & 0x80) !== 0
      const opcode = first & 0x0f
      const masked = (second & 0x80) !== 0
      let length = second & 0x7f
      let offset = 2
      if (length === 126) {
        if (this.buffer.length < 4) return
        length = this.buffer.readUInt16BE(2)
        offset = 4
      } else if (length === 127) {
        if (this.buffer.length < 10) return
        const big = this.buffer.readBigUInt64BE(2)
        if (big > 0x7fffffffn) { this.destroy(new Error('devtools frame too large')); return }
        length = Number(big)
        offset = 10
      }
      let mask = null
      if (masked) {
        if (this.buffer.length < offset + 4) return
        mask = this.buffer.subarray(offset, offset + 4)
        offset += 4
      }
      if (this.buffer.length < offset + length) return
      let payload = Buffer.from(this.buffer.subarray(offset, offset + length))
      if (mask) for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i % 4]
      this.buffer = this.buffer.subarray(offset + length)
      this.deliver(fin, opcode, payload)
    }
  }

  /** Dispatch one complete frame (handling continuation, ping, close). */
  deliver(fin, opcode, payload) {
    if (opcode === 0x1 || opcode === 0x2) {
      if (fin) this.emitMessage(payload.toString('utf8'))
      else this.fragment = [payload]
      return
    }
    if (opcode === 0x0) {
      this.fragment.push(payload)
      if (fin) {
        const whole = Buffer.concat(this.fragment)
        this.fragment = []
        this.emitMessage(whole.toString('utf8'))
      }
      return
    }
    if (opcode === 0x9) {
      this.write(encodeFrame(0xa, payload))
      return
    }
    if (opcode === 0x8) this.destroy(null)
  }

  write(frame) {
    if (this.closed || this.socket === null) throw new Error('devtools websocket is closed')
    this.socket.write(frame)
  }

  sendText(text) {
    this.write(encodeFrame(0x1, text))
  }

  emitMessage(text) {
    for (const handler of this.messageHandlers) {
      try { handler(text) } catch { /* listener errors must not kill the socket */ }
    }
  }

  emitClose(error) {
    for (const handler of this.closeHandlers) {
      try { handler(error) } catch { /* ignore */ }
    }
  }

  onMessage(handler) {
    this.messageHandlers.add(handler)
    return () => this.messageHandlers.delete(handler)
  }

  onClose(handler) {
    this.closeHandlers.add(handler)
    return () => this.closeHandlers.delete(handler)
  }

  destroy(reason) {
    if (this.closed) return
    this.closed = true
    try { this.socket?.destroy() } catch { /* ignore */ }
    this.emitClose(reason)
  }
}

/** Request/response + event channel over one DevTools page websocket. */
export class Cdp {
  constructor(socket) {
    this.socket = socket
    this.nextId = 1
    this.pending = new Map()
    this.listeners = new Set()
    socket.onMessage((text) => this.receive(text))
    socket.onClose((error) => this.failAll(error ?? new Error('devtools connection closed')))
  }

  /** Connect to a `webSocketDebuggerUrl` returned by the DevTools HTTP endpoint. */
  static async connect(webSocketDebuggerUrl, timeoutMs = 15000) {
    const socket = new Socket(webSocketDebuggerUrl)
    await socket.connect(timeoutMs)
    return new Cdp(socket)
  }

  receive(text) {
    let message
    try { message = JSON.parse(text) } catch { return }
    if (typeof message.id === 'number' && this.pending.has(message.id)) {
      const entry = this.pending.get(message.id)
      this.pending.delete(message.id)
      clearTimeout(entry.timer)
      if (message.error) entry.reject(new Error(`${entry.method}: ${message.error.message ?? 'protocol error'}`))
      else entry.resolve(message.result ?? {})
      return
    }
    if (typeof message.method === 'string') {
      for (const listener of this.listeners) {
        try { listener(message) } catch { /* ignore */ }
      }
    }
  }

  failAll(error) {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer)
      entry.reject(error)
    }
    this.pending.clear()
  }

  /** Call one protocol method. */
  call(method, params = {}, options = {}) {
    const timeoutMs = options.timeoutMs ?? 30000
    return new Promise((resolve, reject) => {
      const id = this.nextId++
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${method} timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer, method })
      try {
        this.socket.sendText(JSON.stringify({ id, method, params }))
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(error)
      }
    })
  }

  /** Subscribe to protocol events. */
  on(listener) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Resolve with the first matching protocol event. */
  once(method, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        off()
        reject(new Error(`timed out waiting for ${method}`))
      }, timeoutMs)
      const off = this.on((message) => {
        if (message.method !== method) return
        clearTimeout(timer)
        off()
        resolve(message.params ?? {})
      })
    })
  }

  close() {
    this.failAll(new Error('devtools connection closed'))
    this.socket.destroy(null)
  }
}
