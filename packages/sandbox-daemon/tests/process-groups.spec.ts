import { describe, expect, it } from 'vitest'
import { groupAlive, terminateGroup } from '../src/process-groups.ts'

describe('process-group liveness', () => {
  it('never signals for a group id that has not been published', async () => {
    // pgid 0/-1 would make `kill(-pgid)` address the caller's own process
    // group or PID 1. Both must be inert no-ops.
    expect(groupAlive(0)).toBe(false)
    expect(groupAlive(-1)).toBe(false)
    expect(await terminateGroup(0, 20)).toBe(true)
    expect(await terminateGroup(-1, 20)).toBe(true)
  })

  it('reports an unused group as gone', () => {
    // A very high, almost certainly unused pgid must not be reported alive.
    expect(groupAlive(2 ** 30)).toBe(false)
  })
})
