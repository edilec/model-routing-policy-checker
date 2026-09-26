/**
 * Dates and money.
 *
 * Both are places where a plausible-looking implementation is wrong in a way no
 * verdict makes visible: `Date.UTC` rolls 2026-02-30 forward into March instead
 * of refusing it, and an unrounded floating-point sum fails a budget it appears
 * to meet.
 */

import assert from 'node:assert/strict'
import { join } from 'node:path'
import test from 'node:test'

import {
  MODEL_STATUSES, REQUIRED_MODEL_KEYS, checkRouting, estimateCallCost, parseDate, roundCost,
} from '../src/index.mjs'
import { cleanup, findingFor, makeTree, model, policy, route, snapshot, task } from './helpers.mjs'

test('a date is a real calendar date or it is nothing', () => {
  assert.equal(parseDate('2026-09-01'), Date.UTC(2026, 8, 1))
  assert.equal(parseDate('2026-02-29'), null, '2026 is not a leap year, so this is not a date')
  assert.equal(parseDate('2024-02-29'), Date.UTC(2024, 1, 29), '2024 is a leap year, so this is')
  assert.equal(parseDate('2026-02-30'), null, 'Date.UTC would roll this into March rather than refuse it')
  assert.equal(parseDate('2026-13-01'), null)
  assert.equal(parseDate('2026-9-1'), null, 'the format is fixed-width')
  assert.equal(parseDate('yesterday'), null)
  assert.equal(parseDate(20260901), null)
  assert.equal(parseDate(undefined), null)
})

test('a call cost is the task token counts against the snapshot prices, rounded once', () => {
  const priced = { inputPricePerMillion: 3, outputPricePerMillion: 15 }
  assert.equal(estimateCallCost(priced, { expectedInputTokens: 1000000, expectedOutputTokens: 0 }), 3)
  assert.equal(estimateCallCost(priced, { expectedInputTokens: 0, expectedOutputTokens: 1000000 }), 15)
  assert.equal(estimateCallCost(priced, { expectedInputTokens: 12000, expectedOutputTokens: 1500 }), 0.0585)
  assert.equal(estimateCallCost(priced, { expectedInputTokens: 0, expectedOutputTokens: 0 }), 0)
})

test('the number in the report and the number in the comparison are the same number', () => {
  // 0.1 + 0.2 is the canonical example; the point here is that whatever the
  // unrounded sum is, the value compared against a budget is the value printed.
  assert.equal(roundCost(0.1 + 0.2), 0.3)
  assert.equal(roundCost(1 / 3), 0.333333)
  assert.equal(roundCost(0), 0)
})

test('a budget is judged against the rounded cost, so the report explains the verdict', async (t) => {
  const root = await makeTree({
    'snapshot.json': snapshot({ cheap: model({ inputPricePerMillion: 1, outputPricePerMillion: 2 }) }),
    // 10000 in at 1 per million is 0.01; 0 out. The budget is exactly 0.01.
    'policy.json': policy(
      { work: task({ expectedInputTokens: 10000, expectedOutputTokens: 0, maxCostPerCallUsd: 0.01 }) },
      { primary: route() },
    ),
  })
  t.after(() => cleanup(root))

  const report = await checkRouting({ policy: join(root, 'policy.json'), snapshot: join(root, 'snapshot.json'), root })
  assert.equal(report.status, 'pass', 'a cost exactly at the budget is within it')
  assert.equal(report.routing.tasks[0].estimatedCostUsd, 0.01)
})

test('an authority absent from the snapshot is a denial, not an omission', async (t) => {
  const bare = model()
  delete bare.authorisedFor
  const root = await makeTree({
    'snapshot.json': snapshot({ cheap: bare }),
    'policy.json': policy({ work: task({ authority: ['internal'] }) }, { primary: route() }),
  })
  t.after(() => cleanup(root))

  // authorisedFor is the one optional model field, and it defaults closed. The
  // alternative is a snapshot that omits the field routing every task it likes.
  assert.equal(REQUIRED_MODEL_KEYS.includes('authorisedFor'), false)
  const report = await checkRouting({ policy: join(root, 'policy.json'), snapshot: join(root, 'snapshot.json'), root })
  assert.equal(report.status, 'fail')
  assert.equal(findingFor(report, 'authority-not-granted').severity, 'error')
  assert.match(findingFor(report, 'authority-not-granted').message, /denial, not an omission/)
})

test('a model status outside the declared set is refused rather than assumed available', async (t) => {
  assert.deepEqual([...MODEL_STATUSES], ['available', 'deprecated', 'retired'])
  const root = await makeTree({
    'snapshot.json': snapshot({ cheap: model({ status: 'ga' }) }),
    'policy.json': policy({ work: task() }, { primary: route() }),
  })
  t.after(() => cleanup(root))

  const report = await checkRouting({ policy: join(root, 'policy.json'), snapshot: join(root, 'snapshot.json'), root })
  assert.equal(report.status, 'incomplete')
  assert.equal(report.routing, null)
})
