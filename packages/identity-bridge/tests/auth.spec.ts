/**
 * The sidecar's identity headers are this package's only identity input, and
 * reading them is a pure function. Authorization and per-user state are
 * explicitly out of scope — `currentUser` answers "who does the sidecar say
 * this is", nothing more.
 */
import { describe, expect, it } from 'vitest'
import { currentUser } from '../src/index.ts'

describe('currentUser', () => {
  it('reads the sidecar user and groups headers', () => {
    expect(currentUser({
      headers: { 'x-forwarded-user': 'alice', 'x-forwarded-groups': 'dsh-admins,devs' },
    })).toEqual({ id: 'alice', groups: ['dsh-admins', 'devs'] })
  })

  it('reports no groups when the group header is absent', () => {
    expect(currentUser({ headers: { 'x-forwarded-user': 'alice' } })).toEqual({ id: 'alice', groups: [] })
  })

  it('honours configured header names', () => {
    expect(currentUser(
      { headers: { 'x-custom-user': 'bob', 'x-custom-groups': 'ops' } },
      { user: 'x-custom-user', groups: 'x-custom-groups' },
    )).toEqual({ id: 'bob', groups: ['ops'] })
    expect(currentUser({ headers: { 'x-forwarded-user': 'alice' } }, { user: 'x-custom-user', groups: 'x-custom-groups' }))
      .toBeUndefined()
  })

  it('has no principal without a user header', () => {
    expect(currentUser({ headers: {} })).toBeUndefined()
    expect(currentUser({ headers: { 'x-forwarded-groups': 'devs' } })).toBeUndefined()
  })

  it('has no principal for a blank user header', () => {
    expect(currentUser({ headers: { 'x-forwarded-user': '   ' } })).toBeUndefined()
  })

  it('ignores empty group entries', () => {
    expect(currentUser({ headers: { 'x-forwarded-user': 'alice', 'x-forwarded-groups': 'devs, ,admins,' } }))
      .toEqual({ id: 'alice', groups: ['devs', 'admins'] })
  })

  it('joins the array form of a repeated header', () => {
    expect(currentUser({ headers: { 'x-forwarded-user': ['alice', 'bob'] } })).toEqual({ id: 'alice,bob', groups: [] })
  })
})
