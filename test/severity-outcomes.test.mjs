/**
 * Severity, pinned behaviourally.
 *
 * A frozen `ruleId -> severity` table is a good source of truth and a bad
 * guard: when the test keeps its own expected-value map, the guarantee is three
 * declarations agreeing with each other and one coordinated edit passes. One
 * tool in this catalog had 40 of 52 error rules survive exactly that flip.
 *
 * So every assertion here writes its expectation out as a literal at the
 * assertion site -- the severity string, the status string, the exit code, and
 * whether a routing decision came back -- and takes nothing from a table, a
 * parameter or an import. For the rules whose severity decides the verdict it
 * cannot be argued with at all, because an exit code is not editable.
 *
 * Every rule the tool can emit appears exactly once. The closing test asserts
 * that, so a rule added without an outcome test fails the suite.
 */

import assert from 'node:assert/strict'
import { join } from 'node:path'
import test from 'node:test'

import { RULE_SEVERITY } from '../src/index.mjs'
import { cleanup, findingFor, makeTree, model, policy, route, runCli, runReport, snapshot, task } from './helpers.mjs'

const covered = new Set()

async function exercise(t, ruleId, files, args = []) {
  covered.add(ruleId)
  const root = await makeTree(files)
  t.after(() => cleanup(root))
  return { ...runReport(root, args), root }
}

const sound = (over = {}) => ({
  'snapshot.json': snapshot({ cheap: model() }),
  'policy.json': policy({ work: task() }, { primary: route() }),
  ...over,
})

test('authority-not-granted is an error that fails the run and exits 1', async (t) => {
  const { report, status } = await exercise(t, 'authority-not-granted', sound({
    'policy.json': policy({ work: task({ authority: ['regulated'] }) }, { primary: route() }),
  }))
  assert.equal(findingFor(report, 'authority-not-granted').severity, 'error')
  assert.equal(report.status, 'fail')
  assert.equal(status, 1)
})

test('budget-exceeded is an error that fails the run and exits 1', async (t) => {
  const { report, status } = await exercise(t, 'budget-exceeded', sound({
    'policy.json': policy({ work: task({ maxCostPerCallUsd: 0.0000001 }) }, { primary: route() }),
  }))
  assert.equal(findingFor(report, 'budget-exceeded').severity, 'error')
  assert.equal(report.status, 'fail')
  assert.equal(status, 1)
})

test('capability-unsupported is an error that fails the run and exits 1', async (t) => {
  const { report, status } = await exercise(t, 'capability-unsupported', sound({
    'policy.json': policy({ work: task({ requires: ['vision'] }) }, { primary: route() }),
  }))
  assert.equal(findingFor(report, 'capability-unsupported').severity, 'error')
  assert.equal(report.status, 'fail')
  assert.equal(status, 1)
})

test('context-too-small is an error that fails the run and exits 1', async (t) => {
  const { report, status } = await exercise(t, 'context-too-small', sound({
    'snapshot.json': snapshot({ cheap: model({ maxContextTokens: 10 }) }),
  }))
  assert.equal(findingFor(report, 'context-too-small').severity, 'error')
  assert.equal(report.status, 'fail')
  assert.equal(status, 1)
})

test('document-malformed is an error that makes the run incomplete and exits 2', async (t) => {
  const { report, status } = await exercise(t, 'document-malformed', sound({ 'policy.json': '[]' }))
  assert.equal(findingFor(report, 'document-malformed').severity, 'error')
  assert.equal(report.status, 'incomplete')
  assert.equal(status, 2)
  assert.equal(report.routing, null)
})

test('document-not-json is an error that makes the run incomplete and exits 2', async (t) => {
  const { report, status } = await exercise(t, 'document-not-json', sound({ 'policy.json': '{"schemaVersion": "1",' }))
  assert.equal(findingFor(report, 'document-not-json').severity, 'error')
  assert.equal(report.status, 'incomplete')
  assert.equal(status, 2)
  assert.equal(report.routing, null)
})

test('document-not-utf8 is an error that makes the run incomplete and exits 2', async (t) => {
  const { report, status } = await exercise(t, 'document-not-utf8', sound({
    'snapshot.json': new Uint8Array([0x7b, 0xff, 0xfe, 0x7d]),
  }))
  assert.equal(findingFor(report, 'document-not-utf8').severity, 'error')
  assert.equal(report.status, 'incomplete')
  assert.equal(status, 2)
  assert.equal(report.routing, null)
})

test('document-schema-unsupported is an error that makes the run incomplete and exits 2', async (t) => {
  const { report, status } = await exercise(t, 'document-schema-unsupported', sound({
    'snapshot.json': JSON.stringify({ schemaVersion: '2', capturedAt: '2026-09-01', models: { cheap: model() } }),
  }))
  assert.equal(findingFor(report, 'document-schema-unsupported').severity, 'error')
  assert.equal(report.status, 'incomplete')
  assert.equal(status, 2)
  assert.equal(report.routing, null)
})

test('document-too-large is an error that makes the run incomplete and exits 2', async (t) => {
  const { report, status } = await exercise(t, 'document-too-large', sound(), ['--max-document-bytes', '12'])
  assert.equal(findingFor(report, 'document-too-large').severity, 'error')
  assert.equal(report.status, 'incomplete')
  assert.equal(status, 2)
  assert.equal(report.routing, null)
})

test('document-unknown-key is an error that makes the run incomplete and exits 2', async (t) => {
  const { report, status } = await exercise(t, 'document-unknown-key', sound({
    'policy.json': policy({ work: task() }, { primary: route() }, { route: {} }),
  }))
  assert.equal(findingFor(report, 'document-unknown-key').severity, 'error')
  assert.equal(report.status, 'incomplete')
  assert.equal(status, 2)
  assert.equal(report.routing, null)
})

test('document-unreadable is an error that makes the run incomplete and exits 2', async (t) => {
  covered.add('document-unreadable')
  const root = await makeTree(sound())
  t.after(() => cleanup(root))
  const result = runCli([
    '--policy', join(root, 'policy.json'), '--snapshot', join(root, 'absent.json'),
    '--root', root, '--json',
  ])
  const report = JSON.parse(result.stdout)
  assert.equal(findingFor(report, 'document-unreadable').severity, 'error')
  assert.equal(report.status, 'incomplete')
  assert.equal(result.status, 2)
  assert.equal(report.routing, null)
})

test('fallback-cycle is an error that fails the run and exits 1', async (t) => {
  const { report, status } = await exercise(t, 'fallback-cycle', sound({
    'policy.json': policy({ work: task() }, {
      primary: route({ fallbackTo: 'secondary' }),
      secondary: route({ fallbackTo: 'primary' }),
    }),
  }))
  assert.equal(findingFor(report, 'fallback-cycle').severity, 'error')
  assert.equal(report.status, 'fail')
  assert.equal(status, 1)
})

test('fallback-depth-exceeded is an error that makes the run incomplete and exits 2', async (t) => {
  const { report, status } = await exercise(t, 'fallback-depth-exceeded', sound({
    'policy.json': policy({ work: task() }, {
      primary: route({ fallbackTo: 'second' }),
      second: route({ fallbackTo: 'third' }),
      third: route(),
    }),
  }), ['--max-fallback-depth', '2'])
  assert.equal(findingFor(report, 'fallback-depth-exceeded').severity, 'error')
  assert.equal(report.status, 'incomplete')
  assert.equal(status, 2)
  assert.equal(report.routing, null)
})

test('fallback-missing is a warning: the run still passes and still exits 0', async (t) => {
  const { report, status } = await exercise(t, 'fallback-missing', sound())
  assert.equal(findingFor(report, 'fallback-missing').severity, 'warning')
  assert.equal(report.summary.warnings, 1)
  assert.equal(report.status, 'pass')
  assert.equal(status, 0)
  assert.notEqual(report.routing, null)
})

test('fallback-task-mismatch is an error that fails the run and exits 1', async (t) => {
  const { report, status } = await exercise(t, 'fallback-task-mismatch', sound({
    'policy.json': policy(
      { work: task(), other: task({ entry: 'elsewhere' }) },
      { primary: route({ fallbackTo: 'elsewhere' }), elsewhere: route({ task: 'other' }) },
    ),
  }))
  assert.equal(findingFor(report, 'fallback-task-mismatch').severity, 'error')
  assert.equal(report.status, 'fail')
  assert.equal(status, 1)
})

test('fallback-unknown is an error that fails the run and exits 1', async (t) => {
  const { report, status } = await exercise(t, 'fallback-unknown', sound({
    'policy.json': policy({ work: task() }, { primary: route({ fallbackTo: 'nowhere' }) }),
  }))
  assert.equal(findingFor(report, 'fallback-unknown').severity, 'error')
  assert.equal(report.status, 'fail')
  assert.equal(status, 1)
})

test('identifier-invalid is an error that makes the run incomplete and exits 2', async (t) => {
  const { report, status } = await exercise(t, 'identifier-invalid', sound({
    'snapshot.json': snapshot({ cheap: model(), 'not a valid id': model() }),
  }))
  assert.equal(findingFor(report, 'identifier-invalid').severity, 'error')
  assert.equal(report.status, 'incomplete')
  assert.equal(status, 2)
  assert.equal(report.routing, null)
})

test('model-deprecated is a warning: the run still passes and still exits 0', async (t) => {
  const { report, status } = await exercise(t, 'model-deprecated', sound({
    'snapshot.json': snapshot({ cheap: model({ status: 'deprecated' }) }),
  }))
  assert.equal(findingFor(report, 'model-deprecated').severity, 'warning')
  assert.equal(report.status, 'pass')
  assert.equal(status, 0)
  assert.notEqual(report.routing, null)
})

test('model-malformed is an error that makes the run incomplete and exits 2', async (t) => {
  const { report, status } = await exercise(t, 'model-malformed', sound({
    'snapshot.json': snapshot({ cheap: model({ maxContextTokens: 'plenty' }) }),
  }))
  assert.equal(findingFor(report, 'model-malformed').severity, 'error')
  assert.equal(report.status, 'incomplete')
  assert.equal(status, 2)
  assert.equal(report.routing, null)
})

test('model-metadata-missing is an error that makes the run incomplete and exits 2', async (t) => {
  const partial = model()
  delete partial.status
  const { report, status } = await exercise(t, 'model-metadata-missing', sound({
    'snapshot.json': snapshot({ cheap: partial }),
  }))
  assert.equal(findingFor(report, 'model-metadata-missing').severity, 'error')
  assert.equal(report.status, 'incomplete')
  assert.equal(status, 2)
  assert.equal(report.routing, null)
})

test('model-retired is an error that fails the run and exits 1', async (t) => {
  const { report, status } = await exercise(t, 'model-retired', sound({
    'snapshot.json': snapshot({ cheap: model({ status: 'retired' }) }),
  }))
  assert.equal(findingFor(report, 'model-retired').severity, 'error')
  assert.equal(report.status, 'fail')
  assert.equal(status, 1)
})

test('model-unknown is an error that makes the run incomplete and exits 2', async (t) => {
  const { report, status } = await exercise(t, 'model-unknown', sound({
    'policy.json': policy({ work: task() }, { primary: route({ model: 'phantom' }) }),
  }))
  assert.equal(findingFor(report, 'model-unknown').severity, 'error')
  assert.equal(report.status, 'incomplete')
  assert.equal(status, 2)
  assert.equal(report.routing, null)
})

test('no-routes is a warning, and the incomplete flag alone keeps it off a green build', async (t) => {
  const { report, status } = await exercise(t, 'no-routes', sound({
    'policy.json': policy({}, {}),
  }))
  // Severity says warning, so error counting cannot be what refuses this run.
  assert.equal(findingFor(report, 'no-routes').severity, 'warning')
  assert.equal(report.summary.errors, 0)
  // Remove 'no-routes' from INCOMPLETE_RULES and these three lines fail: status
  // becomes "pass", the exit code becomes 0, and an empty policy is a green
  // build.
  assert.equal(report.status, 'incomplete')
  assert.equal(status, 2)
  assert.equal(report.routing, null)
})

test('output-cap-too-small is an error that fails the run and exits 1', async (t) => {
  const { report, status } = await exercise(t, 'output-cap-too-small', sound({
    'snapshot.json': snapshot({ cheap: model({ maxOutputTokens: 1 }) }),
  }))
  assert.equal(findingFor(report, 'output-cap-too-small').severity, 'error')
  assert.equal(report.status, 'fail')
  assert.equal(status, 1)
})

test('route-malformed is an error that makes the run incomplete and exits 2', async (t) => {
  const { report, status } = await exercise(t, 'route-malformed', sound({
    'policy.json': policy({ work: task() }, { primary: route({ weight: 3 }) }),
  }))
  assert.equal(findingFor(report, 'route-malformed').severity, 'error')
  assert.equal(report.status, 'incomplete')
  assert.equal(status, 2)
  assert.equal(report.routing, null)
})

test('route-task-unknown is an error that fails the run and exits 1', async (t) => {
  const { report, status } = await exercise(t, 'route-task-unknown', sound({
    'policy.json': policy({ work: task() }, { primary: route({ task: 'ghost' }) }),
  }))
  assert.equal(findingFor(report, 'route-task-unknown').severity, 'error')
  assert.equal(report.status, 'fail')
  assert.equal(status, 1)
})

test('route-unreachable is a warning: the run still passes and still exits 0', async (t) => {
  const { report, status } = await exercise(t, 'route-unreachable', sound({
    'policy.json': policy({ work: task() }, { primary: route(), spare: route() }),
  }))
  assert.equal(findingFor(report, 'route-unreachable').severity, 'warning')
  assert.equal(report.status, 'pass')
  assert.equal(status, 0)
  assert.notEqual(report.routing, null)
})

test('snapshot-not-comparable is an error that makes the run incomplete and exits 2', async (t) => {
  const { report, status } = await exercise(t, 'snapshot-not-comparable', sound({
    'policy.json': policy({ work: task() }, { primary: route() }, { defaults: { maxSnapshotAgeDays: 30 } }),
  }), ['--as-of', '2026-08-01'])
  assert.equal(findingFor(report, 'snapshot-not-comparable').severity, 'error')
  assert.equal(report.status, 'incomplete')
  assert.equal(status, 2)
  assert.equal(report.routing, null)
})

test('snapshot-stale is an error that makes the run incomplete and exits 2', async (t) => {
  const { report, status } = await exercise(t, 'snapshot-stale', sound({
    'policy.json': policy({ work: task() }, { primary: route() }, { defaults: { maxSnapshotAgeDays: 30 } }),
  }), ['--as-of', '2026-12-01'])
  // A stale snapshot is not evidence that the policy is wrong; it is evidence
  // about models as they were, so the honest answer is that this run cannot
  // tell -- which is incomplete, not fail.
  assert.equal(findingFor(report, 'snapshot-stale').severity, 'error')
  assert.equal(report.status, 'incomplete')
  assert.equal(status, 2)
  assert.equal(report.routing, null)
})

test('task-entry-unknown is an error that fails the run and exits 1', async (t) => {
  const { report, status } = await exercise(t, 'task-entry-unknown', sound({
    'policy.json': policy({ work: task({ entry: 'nowhere' }) }, { primary: route() }),
  }))
  assert.equal(findingFor(report, 'task-entry-unknown').severity, 'error')
  assert.equal(report.status, 'fail')
  assert.equal(status, 1)
})

test('task-malformed is an error that makes the run incomplete and exits 2', async (t) => {
  const { report, status } = await exercise(t, 'task-malformed', sound({
    'policy.json': policy({ work: task({ expectedInputTokens: 'lots' }) }, { primary: route() }),
  }))
  assert.equal(findingFor(report, 'task-malformed').severity, 'error')
  assert.equal(report.status, 'incomplete')
  assert.equal(status, 2)
  assert.equal(report.routing, null)
})

test('task-routed is info: a routed task passes and exits 0', async (t) => {
  const { report, status } = await exercise(t, 'task-routed', sound())
  assert.equal(findingFor(report, 'task-routed').severity, 'info')
  assert.equal(report.status, 'pass')
  assert.equal(status, 0)
  assert.notEqual(report.routing, null)
})

test('task-unroutable is an error that fails the run and exits 1', async (t) => {
  const { report, status } = await exercise(t, 'task-unroutable', sound({
    'policy.json': policy({ work: task({ requires: ['vision'] }) }, { primary: route() }),
  }))
  assert.equal(findingFor(report, 'task-unroutable').severity, 'error')
  assert.equal(report.status, 'fail')
  assert.equal(status, 1)
})

test('time-budget-exceeded is an error that makes the run incomplete and exits 2', async (t) => {
  const { report, status } = await exercise(t, 'time-budget-exceeded', sound(), ['--timeout-ms', '0'])
  assert.equal(findingFor(report, 'time-budget-exceeded').severity, 'error')
  assert.equal(report.status, 'incomplete')
  assert.equal(status, 2)
  assert.equal(report.routing, null)
})

test('too-many-models is an error that makes the run incomplete and exits 2', async (t) => {
  const { report, status } = await exercise(t, 'too-many-models', sound({
    'snapshot.json': snapshot({ cheap: model(), other: model() }),
  }), ['--max-models', '1'])
  assert.equal(findingFor(report, 'too-many-models').severity, 'error')
  assert.equal(report.status, 'incomplete')
  assert.equal(status, 2)
  assert.equal(report.routing, null)
})

test('too-many-routes is an error that makes the run incomplete and exits 2', async (t) => {
  const { report, status } = await exercise(t, 'too-many-routes', sound({
    'policy.json': policy({ work: task() }, { primary: route(), spare: route() }),
  }), ['--max-routes', '1'])
  assert.equal(findingFor(report, 'too-many-routes').severity, 'error')
  assert.equal(report.status, 'incomplete')
  assert.equal(status, 2)
  assert.equal(report.routing, null)
})

test('too-many-tasks is an error that makes the run incomplete and exits 2', async (t) => {
  const { report, status } = await exercise(t, 'too-many-tasks', sound({
    'policy.json': policy({ work: task(), other: task({ entry: 'primary' }) }, { primary: route() }),
  }), ['--max-tasks', '1'])
  assert.equal(findingFor(report, 'too-many-tasks').severity, 'error')
  assert.equal(report.status, 'incomplete')
  assert.equal(status, 2)
  assert.equal(report.routing, null)
})

test('every rule the tool can emit has an outcome test above', () => {
  assert.deepEqual([...covered].sort(), Object.keys(RULE_SEVERITY).sort())
})
