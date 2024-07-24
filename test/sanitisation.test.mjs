/**
 * Control characters, on every surface an untrusted string can reach.
 *
 * Stripping C0 and the line/paragraph separators is not sanitising: four tools
 * in this catalog did exactly that and let the C1 range through, where U+0085
 * (NEL) and U+009B (8-bit CSI) forge lines and open escape sequences in a human
 * report, and U+202E reverses displayed text -- which in a tool whose whole job
 * is saying which model a task may use is not a cosmetic problem.
 *
 * The forbidden set is written out here as numbers rather than imported, so
 * this file and `src/text.mjs` are two independent statements of it. And the
 * surfaces are deliberately not just an excerpt field: model, task and route
 * ids, unknown keys (which become JSON Pointers), a status value and a
 * schemaVersion all arrive from the same untrusted documents.
 */

import assert from 'node:assert/strict'
import { join } from 'node:path'
import test from 'node:test'

import { checkRouting, formatReport, sanitize } from '../src/index.mjs'
import { cleanup, makeTree, model, policy, route, runCli, snapshot, task } from './helpers.mjs'

const range = (from, to) => Array.from({ length: to - from + 1 }, (_, index) => from + index)

const FORBIDDEN = [
  ...range(0x0000, 0x001f), // C0
  0x007f, // DEL
  ...range(0x0080, 0x009f), // C1, including U+0085 NEL and U+009B CSI
  0x2028, 0x2029, // line and paragraph separators
  0x200e, 0x200f, ...range(0x202a, 0x202e), ...range(0x2066, 0x2069), // bidi controls
]

const CLASSES = {
  c0: [0x0009, 0x000a, 0x000d, 0x001b],
  del: [0x007f],
  c1: [0x0085, 0x009b],
  lineSeparators: [0x2028, 0x2029],
  bidi: [0x202e, 0x2066],
}

/**
 * Every string the report carries, keys included.
 *
 * Scanning the serialised JSON would not work: `JSON.stringify` escapes a
 * control character inside a value, so a leaked newline arrives at the consumer
 * as the two characters backslash-n and no scan of the serialised text can see
 * it -- while the newlines the serialiser puts *between* lines are structure,
 * not content. The values are what is untrusted, so the values are checked.
 */
function everyString(value, into = []) {
  if (typeof value === 'string') into.push(value)
  else if (Array.isArray(value)) for (const item of value) everyString(item, into)
  else if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      into.push(key)
      everyString(item, into)
    }
  }
  return into
}

function offendingInReport(report) {
  const found = new Set()
  for (const text of everyString(report)) {
    for (const character of text) {
      const code = character.codePointAt(0)
      if (FORBIDDEN.includes(code)) found.add(code)
    }
  }
  return [...found].sort((left, right) => left - right)
}

/**
 * The human report's line count, derived from the report's own structure: one
 * line per finding, a blank line, the summary line, the routing line, and an
 * incomplete note when there is one. A sanitised string that still held a
 * newline -- or a U+0085, or a U+2028 -- would push the count up.
 */
function expectedLineCount(report) {
  return report.findings.length + 3 + (report.summary.unexamined > 0 ? 1 : 0) + 1
}

const SURFACES = {
  'model id': (hostile) => ({
    'snapshot.json': snapshot({ cheap: model(), [`bad${hostile}id`]: model() }),
    'policy.json': policy({ work: task() }, { primary: route() }),
  }),
  'task id': (hostile) => ({
    'snapshot.json': snapshot({ cheap: model() }),
    'policy.json': policy({ work: task(), [`bad${hostile}id`]: task() }, { primary: route() }),
  }),
  'route id': (hostile) => ({
    'snapshot.json': snapshot({ cheap: model() }),
    'policy.json': policy({ work: task() }, { primary: route(), [`bad${hostile}id`]: route() }),
  }),
  'unknown model key': (hostile) => ({
    'snapshot.json': snapshot({ cheap: model({ [`k${hostile}`]: 1 }) }),
    'policy.json': policy({ work: task() }, { primary: route() }),
  }),
  'unknown task key': (hostile) => ({
    'snapshot.json': snapshot({ cheap: model() }),
    'policy.json': policy({ work: task({ [`k${hostile}`]: 1 }) }, { primary: route() }),
  }),
  'unknown route key': (hostile) => ({
    'snapshot.json': snapshot({ cheap: model() }),
    'policy.json': policy({ work: task() }, { primary: route({ [`k${hostile}`]: 1 }) }),
  }),
  'unknown top-level key': (hostile) => ({
    'snapshot.json': snapshot({ cheap: model() }, { [`k${hostile}`]: 1 }),
    'policy.json': policy({ work: task() }, { primary: route() }),
  }),
  'unknown defaults key': (hostile) => ({
    'snapshot.json': snapshot({ cheap: model() }),
    'policy.json': policy({ work: task() }, { primary: route() }, { defaults: { [`k${hostile}`]: 1 } }),
  }),
  'model status': (hostile) => ({
    'snapshot.json': snapshot({ cheap: model({ status: `live${hostile}` }) }),
    'policy.json': policy({ work: task() }, { primary: route() }),
  }),
  schemaVersion: (hostile) => ({
    'snapshot.json': JSON.stringify({ schemaVersion: `1${hostile}`, capturedAt: '2026-09-01', models: { cheap: model() } }),
    'policy.json': policy({ work: task() }, { primary: route() }),
  }),
}

for (const [className, samples] of Object.entries(CLASSES)) {
  for (const code of samples) {
    test(`${className} U+${code.toString(16).padStart(4, '0').toUpperCase()} never reaches the report, from any surface`, async (t) => {
      const hostile = String.fromCodePoint(code)
      for (const [surface, build] of Object.entries(SURFACES)) {
        const root = await makeTree(build(hostile))
        t.after(() => cleanup(root))
        const report = await checkRouting({ policy: join(root, 'policy.json'), snapshot: join(root, 'snapshot.json'), root })
        // Something must actually be reported about the hostile value,
        // otherwise this test would pass on a tool that said nothing at all.
        assert.ok(report.findings.length > 0, `${surface} produced no finding to sanitise`)
        assert.deepEqual(offendingInReport(report), [], `${surface} leaked into the JSON report`)
        assert.equal(
          formatReport(report).split('\n').length,
          expectedLineCount(report),
          `${surface} forged a line in the human report`,
        )
      }
    })
  }
}

test('a model id carrying a newline cannot forge a line in the human report', async (t) => {
  const root = await makeTree({
    'snapshot.json': snapshot({
      cheap: model(),
      'x\nERROR   forged.json/0 fake-rule this line was written by the snapshot': model(),
    }),
    'policy.json': policy({ work: task() }, { primary: route() }),
  })
  t.after(() => cleanup(root))

  const report = await checkRouting({ policy: join(root, 'policy.json'), snapshot: join(root, 'snapshot.json'), root })
  const human = formatReport(report)
  assert.equal(human.split('\n').some((line) => line.startsWith('ERROR   forged.json')), false)
  assert.match(human, /identifier-invalid/)
})

test('the process boundary is sanitised too, not only the library', async (t) => {
  const root = await makeTree({
    'snapshot.json': snapshot({ cheap: model(), [`bad${String.fromCodePoint(0x0085)}id`]: model() }),
    'policy.json': policy({ work: task() }, { primary: route() }),
  })
  t.after(() => cleanup(root))

  const result = runCli(['--policy', join(root, 'policy.json'), '--snapshot', join(root, 'snapshot.json'), '--root', root, '--json'])
  assert.equal(result.status, 2)
  assert.deepEqual(offendingInReport(JSON.parse(result.stdout)), [])
})

test('sanitize bounds its output and marks the cut', () => {
  assert.equal(sanitize('x'.repeat(200)).length, 163)
  assert.ok(sanitize('x'.repeat(200)).endsWith('...'))
  assert.equal(sanitize('a  b\tc'), 'a b c')
  assert.throws(() => sanitize('x', 0), TypeError)
})
