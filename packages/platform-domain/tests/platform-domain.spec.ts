import { describe, expect, it } from 'vitest'
import { workspacesDomain, usersDomain } from '../src/index.ts'

describe('platform domain specs', () => {
  it('declares workspaces table', () => {
    expect(workspacesDomain.name).toBe('platform_workspaces')
    expect(workspacesDomain.tables.workspaces).toBeDefined()
  })
  it('declares users table', () => {
    expect(usersDomain.name).toBe('platform_users')
    expect(usersDomain.tables.users).toBeDefined()
  })
})
