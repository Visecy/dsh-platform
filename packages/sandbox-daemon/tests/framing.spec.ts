import { describe, expect, it } from 'vitest'
import {
  decodeFrames,
  encodeFrame,
  FrameDecoder,
} from '../src/framing.js'
import { EOF_MARKER } from '../src/protocol.js'

describe('framing', () => {
  it('round-trips a single chunk across arbitrary split points', () => {
    const chunk = new TextEncoder().encode('hello world')
    const wire = encodeFrame(chunk)
    // split the wire into many tiny pieces
    const decoder = new FrameDecoder()
    const frames: Uint8Array[] = []
    for (let i = 0; i < wire.length; i += 3) {
      decoder.push(wire.slice(i, i + 3), frames)
    }
    expect(frames).toHaveLength(1)
    expect(new TextDecoder().decode(frames[0])).toBe('hello world')
  })

  it('preserves binary bytes including newlines and base64 padding', () => {
    const chunk = new Uint8Array([0, 1, 2, 10, 13, 255, 254, 0x80])
    const wire = encodeFrame(chunk)
    const decoder = new FrameDecoder()
    const frames: Uint8Array[] = []
    decoder.push(wire, frames)
    expect(frames).toHaveLength(1)
    expect(Array.from(frames[0])).toEqual(Array.from(chunk))
  })

  it('handles multiple frames in one push and across pushes', () => {
    const a = new TextEncoder().encode('first')
    const b = new TextEncoder().encode('second')
    const wire = encodeFrame(a) + encodeFrame(b)
    const decoder = new FrameDecoder()
    const frames: Uint8Array[] = []
    decoder.push(wire, frames)
    expect(frames).toHaveLength(2)
    expect(new TextDecoder().decode(frames[0])).toBe('first')
    expect(new TextDecoder().decode(frames[1])).toBe('second')

    // split across two pushes
    const decoder2 = new FrameDecoder()
    const frames2: Uint8Array[] = []
    const mid = 4 // cut inside the first frame's base64 body
    decoder2.push(wire.slice(0, mid), frames2)
    expect(frames2).toHaveLength(0)
    decoder2.push(wire.slice(mid), frames2)
    expect(frames2).toHaveLength(2)
  })

  it('emits the eof frame on the marker line', () => {
    const decoder = new FrameDecoder()
    const frames: Uint8Array[] = []
    decoder.push(`${encodeFrame(new TextEncoder().encode('data'))}${EOF_MARKER}\n`, frames)
    expect(frames).toHaveLength(1)
    expect(new TextDecoder().decode(frames[0])).toBe('data')
  })

  it('decodeFrames helper decodes a complete stream', () => {
    const chunks = [new TextEncoder().encode('a'), new TextEncoder().encode('b')]
    const wire = chunks.map((c) => encodeFrame(c)).join('') + EOF_MARKER + '\n'
    const decoded = decodeFrames(wire)
    expect(decoded.map((d) => new TextDecoder().decode(d))).toEqual(['a', 'b'])
  })

  it('rejects malformed base64 lines', () => {
    const decoder = new FrameDecoder()
    const frames: Uint8Array[] = []
    expect(() => decoder.push('%%%not-base64%%%\n', frames)).toThrow()
  })
})
