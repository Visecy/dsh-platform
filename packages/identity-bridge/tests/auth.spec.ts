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

  // Guard for a security-relevant trap: `X-Auth-Request-*` is the nginx
  // auth_request RESPONSE family. oauth2-proxy sets it on the browser response
  // (`--set-xauthrequest`) and — measured against the real v7.15.5 binary — it
  // does NOT strip client-supplied `X-Auth-Request-*` from the upstream
  // request. So in this topology that family is CLIENT-CONTROLLABLE and must
  // never be read as identity; only `x-forwarded-*` (which the proxy strips
  // before injecting the verified principal) is evidence. The original design
  // planned to read `X-Auth-Request-*`; that would have been a live
  // impersonation hole, and this assertion is what keeps it from coming back.
  it('never treats client-controllable x-auth-request-* headers as identity', () => {
    expect(currentUser({
      headers: {
        'x-auth-request-user': 'dsh-admin',
        'x-auth-request-groups': 'dsh-admins,devs',
        'x-auth-request-email': 'admin@example.test',
      },
    })).toBeUndefined()
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
