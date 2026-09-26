/**
 * "Unknown is never a pass", as a property rather than a per-rule case.
 *
 * test/severity-outcomes.test.mjs drives each rule individually. This file
 * guards the two ways that guarantee dies without any individual case noticing:
 * a typo in INCOMPLETE_RULES, which silently disarms one flag; and a code path
 * that emits a routing decision alongside missing evidence.
 */

import assert from 'node:assert/strict'
import { join } from 'node:path'
import test from 'node:test'

import { INCOMPLETE_RULES, RULE_SEVERITY, checkRouting, routingFor, statusFor } from '../src/index.mjs'
import { cleanup, makeTree, model, policy, route, snapshot, task } from './helpers.mjs'

const INCOMPLETE = new Set(INCOMPLETE_RULES)

test('every rule named in INCOMPLETE_RULES is a rule this tool can actually emit', () => {
  // A misspelling here disarms one flag and nothing else changes: the rule
  // still fires, the report still says "fail", and a run with unread inputs
  // exits 1 instead of 2. Nothing in a per-rule test can see that.
  for (const ruleId of INCOMPLETE_RULES) {
    assert.ok(Object.hasOwn(RULE_SEVERITY, ruleId), `INCOMPLETE_RULES names "${ruleId}", which no rule table entry defines`)
  }
  assert.deepEqual([...INCOMPLETE_RULES].sort(), [...INCOMPLETE_RULES], 'the list is kept sorted so a duplicate is visible')
  assert.equal(new Set(INCOMPLETE_RULES).size, INCOMPLETE_RULES.length)
})

const FIXTURES = {
  'an empty policy': {
    'snapshot.json': snapshot({ cheap: model() }),
    'policy.json': policy({}, {}),
  },
  'a model the snapshot does not describe': {
    'snapshot.json': snapshot({ cheap: model() }),
    'policy.json': policy({ work: task() }, { primary: route({ model: 'phantom' }) }),
  },
  'a snapshot that is not JSON': {
    'snapshot.json': '{oops',
    'policy.json': policy({ work: task() }, { primary: route() }),
  },
  'a policy that is not JSON': {
    'snapshot.json': snapshot({ cheap: model() }),
    'policy.json': '{oops',
  },
  'a model entry with a field missing': {
    'snapshot.json': snapshot({ cheap: { capabilities: ['text'], status: 'available' } }),
    'policy.json': policy({ work: task() }, { primary: route() }),
  },
}

for (const [name, files] of Object.entries(FIXTURES)) {
  test(`${name} is incomplete with no routing decision, never a pass`, async (t) => {
    const root = await makeTree(files)
    t.after(() => cleanup(root))

    const report = await checkRouting({ policy: join(root, 'policy.json'), snapshot: join(root, 'snapshot.json'), root })
    assert.equal(report.status, 'incomplete')
    assert.equal(report.routing, null)
    assert.ok(report.summary.unexamined > 0)
    assert.ok(report.findings.some((finding) => INCOMPLETE.has(finding.ruleId)))
  })
}

test('a passing run carries no rule that means evidence was missing', async (t) => {
  const root = await makeTree({
    'snapshot.json': snapshot({ cheap: model() }),
    'policy.json': policy({ work: task() }, { primary: route() }),
  })
  t.after(() => cleanup(root))

  const report = await checkRouting({ policy: join(root, 'policy.json'), snapshot: join(root, 'snapshot.json'), root })
  assert.equal(report.status, 'pass')
  assert.equal(report.summary.unexamined, 0)
  assert.notEqual(report.routing, null)
  for (const finding of report.findings) {
    assert.equal(INCOMPLETE.has(finding.ruleId), false, `a passing run reported "${finding.ruleId}"`)
  }
})

test('a pass is never reached with nothing checked', async (t) => {
  const root = await makeTree({
    'snapshot.json': snapshot({ cheap: model() }),
    'policy.json': policy({}, {}),
  })
  t.after(() => cleanup(root))

  const report = await checkRouting({ policy: join(root, 'policy.json'), snapshot: join(root, 'snapshot.json'), root })
  assert.equal(report.summary.checked, 0)
  assert.notEqual(report.status, 'pass', 'pass with checked: 0 is green on no evidence')
})

test('missing evidence outranks every other count when the status is decided', () => {
  assert.equal(statusFor({ errors: 0, unexamined: 1 }), 'incomplete')
  assert.equal(statusFor({ errors: 9, unexamined: 1 }), 'incomplete', 'errors do not outvote missing evidence')
  assert.equal(statusFor({ errors: 1, unexamined: 0 }), 'fail')
  assert.equal(statusFor({ errors: 0, unexamined: 0 }), 'pass')
})

test('an incomplete status carries no routing decision, whatever the evaluation produced', () => {
  const decided = { asOf: null, snapshotCapturedAt: '2026-09-01', tasks: [{ id: 'work', routedVia: 'primary' }] }
  assert.equal(routingFor('incomplete', decided), null)
  assert.equal(routingFor('fail', decided), decided)
  assert.equal(routingFor('pass', decided), decided)
})
