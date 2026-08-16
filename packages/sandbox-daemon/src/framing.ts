/**
 * Newline-delimited base64 framing for remote command/pty output.
 * Each non-empty line is one base64-encoded byte chunk; the reserved
 * EOF_MARKER line signals end-of-stream. Mirrors the E2B POC framing so the
 * k8s adapters can reuse the same decoder semantics.
 */
import { EOF_MARKER } from './protocol.js'

const BASE64_LINE = /^[A-Za-z0-9+/]*={0,2}$/

/** Encode one byte chunk as a single framed line (base64 + newline). */
export function encodeFrame(chunk: Uint8Array): string {
  return Buffer.from(chunk).toString('base64') + '\n'
}

/**
 * Incremental frame decoder. Feed raw wire text via push(); decoded data
 * chunks are appended to the caller-provided array; the EOF marker line sets
 * eofReceived and never appears in the output. Malformed lines throw.
 */
export class FrameDecoder {
  private buffer = ''
  private eof = false

  get eofReceived(): boolean {
    return this.eof
  }

  push(chunk: string, out: Uint8Array[]): void {
    this.buffer += chunk
    let nl: number
    while ((nl = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, nl)
      this.buffer = this.buffer.slice(nl + 1)
      if (line === '') continue
      if (line === EOF_MARKER) {
        this.eof = true
        continue
      }
      if (!BASE64_LINE.test(line) || line.length % 4 !== 0) {
        throw new Error(`invalid base64 frame: ${JSON.stringify(line.slice(0, 32))}`)
      }
      const bytes = Buffer.from(line, 'base64')
      if (bytes.toString('base64') !== line) {
        throw new Error(`non-canonical base64 frame: ${JSON.stringify(line.slice(0, 32))}`)
      }
      out.push(new Uint8Array(bytes))
    }
  }
}

/** Decode a complete framed stream (all data frames; EOF marker consumed). */
export function decodeFrames(wire: string): Uint8Array[] {
  const decoder = new FrameDecoder()
  const out: Uint8Array[] = []
  decoder.push(wire, out)
  return out
}
