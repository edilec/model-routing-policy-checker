/**
 * The output contract: the same documents always produce the same bytes.
 *
 * Two things can break that without any test noticing. The first is a clock or
 * an environment reading sneaking into the report -- which is why the only
 * dates this tool handles are the one in the snapshot and the one the caller
 * passes. The second is object key order: JSON preserves the order a file was
 * written in, so a policy whose routes are listed differently is the same
 * policy to a reader and a different one to a loop over `Object.keys`.
 */

import assert from 'node:assert/strict'
import { join } from 'node:path'
import test from 'node:test'

import { cleanup, makeTree, model, policy, route, runCli, snapshot, task } from './helpers.mjs'

const MODELS = {
  cheap: model(),
  mid: model({ capabilities: ['text', 'tool-calling'], inputPricePerMillion: 3, outputPricePerMillion: 15 }),
  large: model({ capabilities: ['text', 'tool-calling', 'vision'], inputPricePerMillion: 15, outputPricePerMillion: 75 }),
}
const TASKS = {
  triage: task({ entry: 'triage-cheap' }),
  tools: task({ requires: ['text', 'tool-calling'], entry: 'tools-mid', maxCostPerCallUsd: 1 }),
}
const ROUTES = {
  'triage-cheap': route({ task: 'triage', fallbackTo: 'triage-mid' }),
  'triage-mid': route({ task: 'triage', model: 'mid' }),
  'tools-mid': route({ task: 'tools', model: 'mid', fallbackTo: 'tools-large' }),
  'tools-large': route({ task: 'tools', model: 'large' }),
}

function reversed(record) {
  const out = {}
  for (const key of Object.keys(record).reverse()) out[key] = record[key]
  return out
}

const run = (root) => runCli([
  '--policy', join(root, 'policy.json'), '--snapshot', join(root, 'snapshot.json'), '--root', root, '--json',
]).stdout

test('two runs over the same documents produce byte-identical stdout', async (t) => {
  const root = await makeTree({ 'snapshot.json': snapshot(MODELS), 'policy.json': policy(TASKS, ROUTES) })
  t.after(() => cleanup(root))

  const first = run(root)
  assert.ok(first.length > 100)
  assert.equal(first, run(root))
})

test('the order the documents list their models, tasks and routes does not reach the output', async (t) => {
  const forward = await makeTree({ 'snapshot.json': snapshot(MODELS), 'policy.json': policy(TASKS, ROUTES) })
  const backward = await makeTree({
    'snapshot.json': snapshot(reversed(MODELS)),
    'policy.json': policy(reversed(TASKS), reversed(ROUTES)),
  })
  t.after(() => cleanup(forward))
  t.after(() => cleanup(backward))

  // Proof the fixture is real: the two files genuinely differ.
  assert.notEqual(snapshot(MODELS), snapshot(reversed(MODELS)))
  assert.notEqual(policy(TASKS, ROUTES), policy(reversed(TASKS), reversed(ROUTES)))
  assert.equal(run(forward), run(backward))
})

test('nothing in the report varies with the wall clock', async (t) => {
  // The snapshot is dated far enough in the past that today's date cannot
  // coincide with it, so finding today's date in the report would mean the tool
  // read a clock rather than the document.
  const root = await makeTree({
    'snapshot.json': snapshot(MODELS, { capturedAt: '2020-01-02' }),
    'policy.json': policy(TASKS, ROUTES),
  })
  t.after(() => cleanup(root))

  const before = run(root)
  const today = new Date().toISOString().slice(0, 10)
  assert.equal(before.includes(today), false, 'a current date reached the report')
  assert.equal(before.includes(root), false, 'an absolute host path reached the report')
  assert.equal(JSON.parse(before).routing.snapshotCapturedAt, '2020-01-02', 'the only date is the one the document supplied')

  await new Promise((resolve) => setTimeout(resolve, 25))
  assert.equal(run(root), before)
})

test('the same documents check the same way from any directory', async (t) => {
  const first = await makeTree({ 'snapshot.json': snapshot(MODELS), 'policy.json': policy(TASKS, ROUTES) })
  const second = await makeTree({ 'snapshot.json': snapshot(MODELS), 'policy.json': policy(TASKS, ROUTES) })
  t.after(() => cleanup(first))
  t.after(() => cleanup(second))

  assert.notEqual(first, second)
  assert.equal(run(first), run(second))
})
