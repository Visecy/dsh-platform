import { describe, expect, it } from 'vitest'
import { workspacesDomain, usersDomain } from '../src/index.ts'

describe('platform domain specs', () => {
  it('declares workspaces table', () => {
    expect(workspacesDomain.name).toBe('platform-workspaces')
    expect(workspacesDomain.tables.workspaces).toBeDefined()
  })
  it('declares users table', () => {
    expect(usersDomain.name).toBe('platform-users')
    expect(usersDomain.tables.users).toBeDefined()
  })
})
