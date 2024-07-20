/**
 * The fallback graph traversals.
 *
 * Both of these have to terminate on a cyclic policy even though the policy
 * itself would not, so the cycle cases are the point rather than an edge case.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { routesInCycles, walkChain } from '../src/index.mjs'

const routes = (entries) => new Map(Object.entries(entries).map(([id, fallbackTo]) => [id, { id, fallbackTo }]))

test('a chain is walked in order and ends where the fallbacks end', () => {
  const walk = walkChain('a', routes({ a: 'b', b: 'c', c: null }), 8)
  assert.deepEqual(walk.chain, ['a', 'b', 'c'])
  assert.equal(walk.missing, null)
  assert.equal(walk.cycle, null)
  assert.equal(walk.depthExceeded, false)
})

test('a chain that falls back to nothing names what was missing', () => {
  const walk = walkChain('a', routes({ a: 'ghost' }), 8)
  assert.deepEqual(walk.chain, ['a'])
  assert.equal(walk.missing, 'ghost')
})

test('a cyclic chain terminates and names the route it came back to', () => {
  const walk = walkChain('a', routes({ a: 'b', b: 'a' }), 8)
  assert.deepEqual(walk.chain, ['a', 'b'])
  assert.equal(walk.cycle, 'a')
  assert.equal(walk.depthExceeded, false)
})

test('a chain longer than the limit stops at the limit and says so', () => {
  const walk = walkChain('a', routes({ a: 'b', b: 'c', c: 'd', d: null }), 2)
  assert.deepEqual(walk.chain, ['a', 'b'])
  assert.equal(walk.depthExceeded, true)
  assert.equal(walk.cycle, null)
})

test('an entry that names no route walks nothing', () => {
  const walk = walkChain('ghost', routes({ a: null }), 8)
  assert.deepEqual(walk.chain, [])
  assert.equal(walk.missing, 'ghost')
})

test('every route on a cycle is found, in code-unit order', () => {
  const cyclic = routesInCycles(routes({ Zed: 'alpha', alpha: 'Zed', straight: 'terminal', terminal: null }))
  assert.deepEqual(cyclic, ['Zed', 'alpha'])
})

test('a self-referencing route is a cycle of one', () => {
  assert.deepEqual(routesInCycles(routes({ loop: 'loop' })), ['loop'])
})

test('a chain that merely rejoins another is not a cycle', () => {
  // Two routes falling back to the same third route share a suffix without
  // either being able to reach itself, and neither is a cycle.
  assert.deepEqual(routesInCycles(routes({ a: 'c', b: 'c', c: null })), [])
})

test('a dangling fallback is not mistaken for a cycle', () => {
  assert.deepEqual(routesInCycles(routes({ a: 'ghost' })), [])
})
