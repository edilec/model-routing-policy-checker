/**
 * The three acceptance criteria, driven through the real command line.
 *
 *   1. A cheap but unsupported model is rejected.
 *   2. Missing model metadata is unknown.
 *   3. Cyclic fallback rules fail.
 *
 * Each is asserted on what the process actually emits -- the exit code, the
 * status, and whether a routing decision came back -- rather than on an
 * internal value, because those three are the only things a caller sees and the
 * only things nobody can edit a table to change.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { cleanup, findingFor, findingsFor, makeTree, model, policy, route, runReport, snapshot, task } from './helpers.mjs'

test('acceptance 1: the cheapest model in the snapshot is rejected for work it cannot do', async (t) => {
  const root = await makeTree({
    'snapshot.json': snapshot({
      bargain: model({ capabilities: ['text'], inputPricePerMillion: 0.05, outputPricePerMillion: 0.2 }),
      capable: model({ capabilities: ['text', 'tool-calling'], inputPricePerMillion: 30, outputPricePerMillion: 150 }),
    }),
    'policy.json': policy(
      { work: task({ requires: ['text', 'tool-calling'] }) },
      { primary: route({ model: 'bargain' }) },
    ),
  })
  t.after(() => cleanup(root))

  const { report, status } = runReport(root)
  assert.equal(status, 1)
  assert.equal(report.status, 'fail')

  const finding = findingFor(report, 'capability-unsupported')
  assert.equal(finding.severity, 'error')
  assert.deepEqual(finding.missing, ['tool-calling'])
  // The price is in the message on purpose: "but it was cheaper" is the
  // argument this check exists to end, so the report says the price out loud
  // and rejects it anyway.
  assert.match(finding.message, /0\.05 in \/ 0\.2 out per million tokens/)
  assert.match(finding.message, /Price is not a substitute for capability/)

  // Proof the fixture really is the cheap-versus-capable case: the rejected
  // model is the cheapest in the snapshot, by a factor of six hundred.
  assert.equal(report.routing.tasks[0].routedVia, null)
  assert.equal(findingsFor(report, 'task-unroutable').length, 1)
})

test('acceptance 1: the same route passes once the snapshot says the model can do the work', async (t) => {
  const root = await makeTree({
    'snapshot.json': snapshot({ bargain: model({ capabilities: ['text', 'tool-calling'], inputPricePerMillion: 0.05 }) }),
    'policy.json': policy({ work: task({ requires: ['text', 'tool-calling'] }) }, { primary: route({ model: 'bargain' }) }),
  })
  t.after(() => cleanup(root))

  const { report, status } = runReport(root)
  assert.equal(status, 0)
  assert.equal(report.status, 'pass')
  assert.equal(findingsFor(report, 'capability-unsupported').length, 0)
  assert.equal(report.routing.tasks[0].routedVia, 'primary')
})

test('acceptance 2: a model the snapshot does not describe is unknown, not a verdict', async (t) => {
  const root = await makeTree({
    'snapshot.json': snapshot({ cheap: model() }),
    'policy.json': policy({ work: task() }, { primary: route({ model: 'never-heard-of-it' }) }),
  })
  t.after(() => cleanup(root))

  const { report, status } = runReport(root)
  assert.equal(status, 2, 'an unknown model is neither approved nor rejected')
  assert.equal(report.status, 'incomplete')
  assert.equal(report.routing, null, 'no routing decision may be produced from a model nobody has facts about')

  const finding = findingFor(report, 'model-unknown')
  assert.equal(finding.severity, 'error')
  assert.match(finding.message, /never approved and never rejected/)
  assert.equal(findingsFor(report, 'task-routed').length, 0)
  assert.equal(findingsFor(report, 'task-unroutable').length, 0, 'unknown is not the same as unroutable')
})

test('acceptance 2: a model entry missing one field is unknown, not permission', async (t) => {
  for (const missing of ['capabilities', 'maxContextTokens', 'maxOutputTokens', 'inputPricePerMillion', 'outputPricePerMillion', 'status']) {
    const partial = model()
    delete partial[missing]
    const root = await makeTree({
      'snapshot.json': snapshot({ cheap: partial }),
      'policy.json': policy({ work: task() }, { primary: route() }),
    })
    t.after(() => cleanup(root))

    const { report, status } = runReport(root)
    assert.equal(status, 2, `a snapshot with no "${missing}" produced a verdict`)
    assert.equal(report.status, 'incomplete')
    assert.equal(report.routing, null)
    assert.equal(findingFor(report, 'model-metadata-missing').severity, 'error')
    assert.match(findingFor(report, 'model-metadata-missing').message, new RegExp(`no "${missing}"`))
    assert.match(findingFor(report, 'model-metadata-missing').message, /unknown, never permission/)
  }
})

test('acceptance 2: one unknown model makes the whole run incomplete, not just its own route', async (t) => {
  const root = await makeTree({
    'snapshot.json': snapshot({ cheap: model() }),
    'policy.json': policy(
      { work: task(), other: task({ entry: 'second' }) },
      { primary: route(), second: route({ task: 'other', model: 'phantom' }) },
    ),
  })
  t.after(() => cleanup(root))

  const { report, status } = runReport(root)
  assert.equal(status, 2)
  assert.equal(report.status, 'incomplete')
  // The other task's route is perfectly sound. Reporting it as routed would be
  // a decision that looks complete and is not.
  assert.equal(report.routing, null)
  assert.equal(findingsFor(report, 'task-routed').length, 0)
})

test('acceptance 3: a cyclic fallback graph fails', async (t) => {
  const root = await makeTree({
    'snapshot.json': snapshot({ cheap: model(), mid: model({ inputPricePerMillion: 3 }) }),
    'policy.json': policy(
      { work: task() },
      {
        primary: route({ fallbackTo: 'secondary' }),
        secondary: route({ model: 'mid', fallbackTo: 'primary' }),
      },
    ),
  })
  t.after(() => cleanup(root))

  const { report, status } = runReport(root)
  assert.equal(status, 1)
  assert.equal(report.status, 'fail')
  assert.notEqual(report.routing, null, 'the documents were read, so there is a verdict to give')

  const cycles = findingsFor(report, 'fallback-cycle')
  assert.deepEqual(cycles.map((finding) => finding.location.pointer), [
    '/routes/primary/fallbackTo',
    '/routes/secondary/fallbackTo',
  ])
  assert.equal(cycles[0].severity, 'error')
})

test('acceptance 3: a three-route cycle fails, and the checker still terminates', async (t) => {
  const root = await makeTree({
    'snapshot.json': snapshot({ cheap: model() }),
    'policy.json': policy(
      { work: task() },
      {
        primary: route({ fallbackTo: 'second' }),
        second: route({ fallbackTo: 'third' }),
        third: route({ fallbackTo: 'primary' }),
      },
    ),
  })
  t.after(() => cleanup(root))

  const { report, status } = runReport(root)
  assert.equal(status, 1)
  assert.equal(report.status, 'fail')
  assert.equal(findingsFor(report, 'fallback-cycle').length, 3)
})

test('acceptance 3: a cycle among routes no task enters still fails', async (t) => {
  const root = await makeTree({
    'snapshot.json': snapshot({ cheap: model() }),
    'policy.json': policy(
      { work: task() },
      {
        primary: route(),
        orphan: route({ fallbackTo: 'orphan-two' }),
        'orphan-two': route({ fallbackTo: 'orphan' }),
      },
    ),
  })
  t.after(() => cleanup(root))

  // Dead policy is where stale routing accumulates until somebody points an
  // entry at it, so a cycle nobody currently reaches is still a cycle.
  const { report, status } = runReport(root)
  assert.equal(status, 1)
  assert.equal(findingsFor(report, 'fallback-cycle').length, 2)
  assert.equal(findingsFor(report, 'route-unreachable').length, 2)
})

test('a sound policy against a complete snapshot passes and exits 0', async (t) => {
  const root = await makeTree({
    'snapshot.json': snapshot({ cheap: model(), mid: model({ inputPricePerMillion: 3, outputPricePerMillion: 15 }) }),
    'policy.json': policy({ work: task() }, { primary: route({ fallbackTo: 'secondary' }), secondary: route({ model: 'mid' }) }),
  })
  t.after(() => cleanup(root))

  const { report, status } = runReport(root)
  assert.equal(status, 0)
  assert.equal(report.status, 'pass')
  assert.equal(report.summary.errors, 0)
  assert.deepEqual(report.routing.tasks, [{
    id: 'work',
    entry: 'primary',
    chain: ['primary', 'secondary'],
    routedVia: 'primary',
    model: 'cheap',
    estimatedCostUsd: 0.000375,
    blockedBy: [],
  }])
})
