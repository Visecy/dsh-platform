/**
 * Output plumbing for remote commands/pty: frame polling, pipe projection,
 * and bounded collect readers with spill files (host side).
 */
import { Readable } from 'node:stream'
import { appendFileSync, createWriteStream, existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { FrameDecoder } from '@visecy/dsh-sandbox-daemon/framing.js'
import type { DaemonSubprocessClient } from './client.ts'
import type { SubprocessCollect, SubprocessOutputRead, SubprocessOutputReader } from '@deepseek-ai/dsh-subprocess'

interface PollSource {
  read(from: number): Promise<{ frames: string; nextOffset: number }>
}

/** Polls a daemon frame file and pushes decoded bytes into a Readable. */
export class FramePoller {
  private offset = 0
  private stopped = false
  private timer?: NodeJS.Timeout
  private decoder = new FrameDecoder()

  constructor(
    private source: PollSource,
    private out: Readable,
    private onEof: () => void,
    private pollMs = 100,
  ) {}

  start(): void {
    void this.tick()
    this.timer = setInterval(() => void this.tick(), this.pollMs)
    this.timer.unref()
  }

  stop(): void {
    this.stopped = true
    if (this.timer !== undefined) clearInterval(this.timer)
  }

  private async tick(): Promise<void> {
    if (this.stopped) return
    try {
      const { frames, nextOffset } = await this.source.read(this.offset)
      if (frames.length > 0) {
        const decoded: Uint8Array[] = []
        this.decoder.push(frames, decoded)
        for (const d of decoded) this.out.push(Buffer.from(d))
        this.offset = nextOffset
      }
    } catch {
      // transient; keep polling
    }
  }

  finish(): void {
    this.stop()
    this.onEof()
  }
}

/** Bounded in-memory tail + optional spill file, offset-based reads. */
export class CollectReader implements SubprocessOutputReader {
  private buffer = Buffer.alloc(0)
  private spillPath?: string
  private spillStream?: ReturnType<typeof createWriteStream>
  /** Total bytes ever appended — the whole-stream coordinate of the window end. */
  private total = 0
  /** Whole-stream coordinate of `buffer[0]`; advances as the tail window slides. */
  private windowStart = 0
  private lossy = false

  constructor(private collect: SubprocessCollect, spillDir: string) {
    if (collect.spill !== undefined) {
      mkdirSync(spillDir, { recursive: true })
      this.spillPath = join(spillDir, `spill-${randomUUID()}.log`)
    }
  }

  get path(): string | undefined {
    return this.spillPath
  }

  append(bytes: Uint8Array): void {
    if (this.spillStream !== undefined) {
      if (this.total + bytes.length <= this.collect.spill!.maxBytes) {
        this.spillStream.write(Buffer.from(bytes))
      } else if (existsSync(this.spillPath!)) {
        // stream exceeded spill cap: discard the incomplete spill
        this.spillStream.end()
        this.spillStream = undefined
        rmSync(this.spillPath!, { force: true })
      }
    }
    this.total += bytes.length
    const combined = Buffer.concat([this.buffer, Buffer.from(bytes)])
    if (combined.length > this.collect.maxBytes) {
      this.lossy = true
      this.buffer = combined.subarray(combined.length - this.collect.maxBytes)
    } else {
      this.buffer = combined
    }
    this.windowStart = this.total - this.buffer.length
  }

  close(): void {
    this.spillStream?.end()
  }

  /**
   * Read from a whole-stream byte offset. `nextOffset` is the whole-stream end
   * (NOT the retained-tail length), and `lossy` is true only when the caller's
   * offset slid out of the retained window — an incremental read that is still
   * inside the window is lossless and returns just its slice.
   */
  readFrom(fromByte: number): SubprocessOutputRead {
    const lossy = this.lossy || fromByte < this.windowStart
    const start = Math.max(fromByte - this.windowStart, 0)
    const text = lossy ? this.buffer.toString('utf8') : this.buffer.subarray(start).toString('utf8')
    return {
      text,
      nextOffset: this.total,
      lossy,
      spillPath: this.spillPath !== undefined && existsSync(this.spillPath) ? this.spillPath : undefined,
    }
  }
}

/** Streams one daemon output channel into a Readable (pipe mode). */
export function makePipe(source: PollSource, onEof: () => void): Readable {
  const out = new Readable({ read() {} })
  const poller = new FramePoller(source, out, onEof)
  poller.start()
  out.on('close', () => poller.stop())
  return out
}

/** Streams one daemon pty output channel into a Readable. */
export function makePtyPipe(source: PollSource, onEof: () => void): Readable {
  return makePipe(source, onEof)
}

/** Polls one daemon output channel into a CollectReader until stopped. */
export class CollectPoller {
  private offset = 0
  private stopped = false
  private timer?: NodeJS.Timeout
  private decoder = new FrameDecoder()

  constructor(
    private source: PollSource,
    private reader: CollectReader,
    private onEof: () => void,
    private pollMs = 100,
  ) {}

  start(): void {
    void this.tick()
    this.timer = setInterval(() => void this.tick(), this.pollMs)
    this.timer.unref()
  }

  stop(): void {
    this.stopped = true
    if (this.timer !== undefined) clearInterval(this.timer)
  }

  /** One final read so no buffered frame is left uncollected before stop. */
  async flush(): Promise<void> {
    await this.tick()
  }

  private async tick(): Promise<void> {
    if (this.stopped) return
    try {
      const { frames, nextOffset } = await this.source.read(this.offset)
      if (frames.length > 0) {
        const decoded: Uint8Array[] = []
        this.decoder.push(frames, decoded)
        for (const d of decoded) this.reader.append(d)
        this.offset = nextOffset
      }
    } catch {
      // transient
    }
  }
}
