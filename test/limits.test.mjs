/**
 * Every documented limit, enforced from the command line.
 *
 * A documented limit the CLI never wires through is a defect this catalog has
 * already shipped: a config key was accepted and silently ignored because no
 * clock ever reached the walk. So each limit below is driven as a flag, not as
 * a library argument, and each is checked to change the verdict.
 *
 * The other half is refusing what was not documented. A one-character typo in a
 * limit name must not turn a real failure into a green run.
 */

import assert from 'node:assert/strict'
import { join } from 'node:path'
import test from 'node:test'

import { DEFAULT_LIMITS, checkRouting, validateAsOf, validateConfig, validateLimits } from '../src/index.mjs'
import { cleanup, findingsFor, makeTree, model, policy, route, runCli, runReport, snapshot, task } from './helpers.mjs'

const TREE = {
  'snapshot.json': snapshot({ cheap: model(), mid: model({ inputPricePerMillion: 3 }) }),
  'policy.json': policy(
    { work: task({ requires: ['text'] }), other: task({ entry: 'second' }) },
    { primary: route({ fallbackTo: 'chained' }), chained: route(), second: route({ task: 'other', model: 'mid' }) },
  ),
}

const CASES = [
  ['--max-capabilities', '0', 'task-malformed'],
  ['--max-document-bytes', '20', 'document-too-large'],
  ['--max-fallback-depth', '1', 'fallback-depth-exceeded'],
  ['--max-models', '1', 'too-many-models'],
  ['--max-routes', '2', 'too-many-routes'],
  ['--max-tasks', '1', 'too-many-tasks'],
  ['--timeout-ms', '0', 'time-budget-exceeded'],
]

test('every documented limit is reachable from the command line and changes the verdict', async (t) => {
  const root = await makeTree(TREE)
  t.after(() => cleanup(root))

  const clean = runReport(root)
  assert.equal(clean.status, 0)
  assert.equal(clean.report.status, 'pass')

  for (const [flag, value, ruleId] of CASES) {
    // --max-capabilities has a minimum of 1 as a flag value, so it is driven at
    // 1 against a task that requires two capabilities.
    const args = flag === '--max-capabilities' ? [flag, '1'] : [flag, value]
    const subject = flag === '--max-capabilities'
      ? await makeTree({
        ...TREE,
        'policy.json': policy(
          { work: task({ requires: ['text', 'vision'] }) },
          { primary: route() },
        ),
      })
      : root
    if (subject !== root) t.after(() => cleanup(subject))

    const { report, status } = runReport(subject, args)
    assert.ok(findingsFor(report, ruleId).length > 0, `${flag} ${args[1]} did not produce ${ruleId}`)
    assert.equal(report.status, 'incomplete', `${flag} ${args[1]} did not make the run incomplete`)
    assert.equal(status, 2, `${flag} ${args[1]} did not exit 2`)
    assert.equal(report.routing, null)
  }
})

test('the limit flags cover every documented limit, with nothing left unwired', () => {
  const flagged = CASES.map(([flag]) => flag.replace(/^--/, '').replace(/-([a-z])/g, (_, letter) => letter.toUpperCase()))
  assert.deepEqual(flagged.sort(), Object.keys(DEFAULT_LIMITS).sort())
})

test('the snapshot age limit is enforced, and requires the date it is measured against', async (t) => {
  const root = await makeTree({
    ...TREE,
    'policy.json': policy(
      { work: task() },
      { primary: route() },
      { defaults: { maxSnapshotAgeDays: 30 } },
    ),
  })
  t.after(() => cleanup(root))

  // No clock is read anywhere in this tool, so a policy that asks for an age
  // check and is given no date to measure against is a configuration error --
  // not a check that quietly does nothing.
  const noDate = runReport(root)
  assert.equal(noDate.status, 2)
  assert.equal(noDate.stdout, '', 'a run that never had a subject reports nothing')
  assert.match(noDate.stderr, /--as-of is required/)

  const fresh = runReport(root, ['--as-of', '2026-09-20'])
  assert.equal(fresh.status, 0)
  assert.equal(fresh.report.status, 'pass')

  // 2026-09-01 plus 30 days is 2026-10-01, so that date is the last one inside
  // the limit and the next is the first one outside it.
  assert.equal(runReport(root, ['--as-of', '2026-10-01']).report.status, 'pass')
  const stale = runReport(root, ['--as-of', '2026-10-02'])
  assert.equal(stale.report.status, 'incomplete')
  assert.equal(stale.status, 2)
  assert.match(stale.report.findings[0].message, /31 day\(s\) old/)
})

test('a misspelled limit is refused rather than ignored', () => {
  assert.throws(() => validateLimits({ maxModel: 1 }), /Unknown limit "maxModel"/)
  assert.throws(() => validateLimits({ maxModels: 0 }), /integer of 1 or more/)
  assert.throws(() => validateLimits({ timeoutMs: -1 }), /integer of 0 or more/)
  assert.equal(validateLimits({ timeoutMs: 0 }).timeoutMs, 0, 'zero is a legal time budget and means no time at all')
  assert.deepEqual(validateLimits(), DEFAULT_LIMITS)
})

test('a misspelled configuration key is refused rather than ignored', () => {
  assert.throws(() => validateConfig({ schemaVersion: '1', asOff: '2026-09-01' }), /Unknown configuration key "asOff"/)
  assert.throws(() => validateConfig({ schemaVersion: '2' }), /Unsupported configuration schemaVersion/)
  assert.throws(() => validateConfig({ schemaVersion: '1', limits: { maxModel: 2 } }), /Unknown limit/)
  assert.equal(validateConfig({ schemaVersion: '1' }).asOf, null)
})

test('an as-of that is not a real date is a configuration error', () => {
  assert.throws(() => validateAsOf('2026-02-30'), /real calendar date/)
  assert.throws(() => validateAsOf('today'), /real calendar date/)
  assert.equal(validateAsOf('2026-09-01'), '2026-09-01')
  assert.equal(validateAsOf(undefined), null)
})

test('an unknown option and a repeated option are configuration errors with an empty stdout', async (t) => {
  const root = await makeTree(TREE)
  t.after(() => cleanup(root))
  const base = ['--policy', join(root, 'policy.json'), '--snapshot', join(root, 'snapshot.json'), '--root', root]

  const unknown = runCli([...base, '--max-modelz', '3'])
  assert.equal(unknown.status, 2)
  assert.equal(unknown.stdout, '')
  assert.match(unknown.stderr, /Unknown option "--max-modelz"/)

  const repeated = runCli([...base, '--snapshot', join(root, 'snapshot.json')])
  assert.equal(repeated.status, 2)
  assert.equal(repeated.stdout, '')
  assert.match(repeated.stderr, /--snapshot was given more than once/)

  const missing = runCli(['--policy', join(root, 'policy.json')])
  assert.equal(missing.status, 2)
  assert.equal(missing.stdout, '')
  assert.match(missing.stderr, /--snapshot is required/)
})

test('an unknown library option is refused rather than ignored', async (t) => {
  const root = await makeTree(TREE)
  t.after(() => cleanup(root))
  await assert.rejects(
    () => checkRouting({ policy: join(root, 'policy.json'), snapshot: join(root, 'snapshot.json'), root, asof: '2026-09-01' }),
    /Unknown option "asof"/,
  )
})

test('a limit given on the command line overrides the same limit in the configuration file', async (t) => {
  const root = await makeTree({
    ...TREE,
    'checker.config.json': JSON.stringify({ schemaVersion: '1', limits: { maxModels: 500 } }),
  })
  t.after(() => cleanup(root))

  assert.equal(runReport(root, ['--config', join(root, 'checker.config.json')]).report.status, 'pass')
  const overridden = runReport(root, ['--config', join(root, 'checker.config.json'), '--max-models', '1'])
  assert.equal(overridden.report.status, 'incomplete')
  assert.equal(overridden.status, 2)
})
