/**
 * The decoding and ordering primitives.
 *
 * The decoding test is the one that matters: a tool in this catalog inferred
 * "not UTF-8" from a U+FFFD in decoded text, and then disabled that guard for a
 * file that legitimately contained one. The decoder has to decide, and the
 * decoded text never gets a vote.
 */

import assert from 'node:assert/strict'
import { join } from 'node:path'
import test from 'node:test'

import { byCodeUnit, checkRouting, decodeUtf8, escapePointerSegment } from '../src/index.mjs'
import { cleanup, makeTree, model, policy, route, snapshot, task } from './helpers.mjs'

test('byCodeUnit orders by UTF-16 code unit, which is not collation order', () => {
  assert.equal(byCodeUnit('Z', 'a'), -1)
  assert.equal(byCodeUnit('a', 'Z'), 1)
  assert.equal(byCodeUnit('a-b', 'a_b'), -1)
  assert.equal(byCodeUnit('README', 'assets'), -1)
  assert.equal(byCodeUnit('same', 'same'), 0)
})

test('decoding is strict, and a legitimate U+FFFD is not a decoding failure', () => {
  const decoded = decodeUtf8(new TextEncoder().encode('a � b'))
  assert.equal(decoded.ok, true)
  assert.equal(decoded.text, 'a � b')

  assert.equal(decodeUtf8(new Uint8Array([0xc3, 0x28])).ok, false)
  assert.equal(decodeUtf8(new Uint8Array([0xff])).reason, 'not-utf8')
})

test('a document that legitimately contains U+FFFD is read, not refused', async (t) => {
  const root = await makeTree({
    'snapshot.json': snapshot({ cheap: model() }),
    'policy.json': policy({ work: task() }, { primary: route() }).replace('"work"', '"work�"'),
  })
  t.after(() => cleanup(root))

  // The replacement character makes the task id invalid, which is a *validation*
  // verdict about a document that decoded cleanly -- not a decoding failure.
  const report = await checkRouting({ policy: join(root, 'policy.json'), snapshot: join(root, 'snapshot.json'), root })
  assert.equal(report.findings.some((finding) => finding.ruleId === 'document-not-utf8'), false)
  assert.equal(report.findings.some((finding) => finding.ruleId === 'identifier-invalid'), true)
})

test('pointer segments are escaped per RFC 6901 and then sanitised', () => {
  assert.equal(escapePointerSegment('a/b'), 'a~1b')
  assert.equal(escapePointerSegment('a~b'), 'a~0b')
  assert.equal(escapePointerSegment('a~/b'), 'a~0~1b')
  assert.equal(escapePointerSegment('plain'), 'plain')
})
