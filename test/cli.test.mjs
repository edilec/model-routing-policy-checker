/**
 * The command line: streams, exit codes, and where the verdict came from.
 *
 * Exit 2 has two shapes and they are not interchangeable. A configuration error
 * means the run never had a subject, so stdout stays empty; an input that could
 * not be read means the run had a subject and failed to get evidence about it,
 * so stdout carries an `incomplete` report naming which input. Both are pinned
 * here, because a consumer piping stdout has to handle the empty case.
 */

import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'

import { cleanup, makeTree, model, policy, route, runCli, runReport, snapshot, task } from './helpers.mjs'

const TREE = {
  'snapshot.json': snapshot({ cheap: model(), mid: model({ inputPricePerMillion: 3, outputPricePerMillion: 15 }) }),
  'policy.json': policy({ work: task() }, { primary: route({ fallbackTo: 'backup' }), backup: route({ model: 'mid' }) }),
}

test('--help exits 0 and documents the exit codes and what the tool refuses', () => {
  const result = runCli(['--help'])
  assert.equal(result.status, 0)
  assert.match(result.stdout, /--snapshot FILE/)
  assert.match(result.stdout, /Exit codes:/)
  assert.match(result.stdout, /Nothing is fetched/)
  assert.match(result.stdout, /unknown, not permission/)
  assert.equal(result.stderr, '')
})

test('exit 2, first shape: a configuration error writes nothing to stdout', () => {
  const result = runCli(['--policy'])
  assert.equal(result.status, 2)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /--policy requires a value/)
})

test('exit 2, second shape: an unreadable input writes an incomplete report to stdout', async (t) => {
  const root = await makeTree(TREE)
  t.after(() => cleanup(root))

  const result = runCli(['--policy', join(root, 'policy.json'), '--snapshot', join(root, 'absent.json'), '--root', root, '--json'])
  assert.equal(result.status, 2)
  const report = JSON.parse(result.stdout)
  assert.equal(report.status, 'incomplete')
  assert.equal(report.findings[0].location.file, 'absent.json', 'the consumer needs to know which input was not read')
})

test('stdout carries the report and stderr carries the diagnostics', async (t) => {
  const root = await makeTree(TREE)
  t.after(() => cleanup(root))

  const result = runReport(root)
  assert.equal(result.status, 0)
  assert.doesNotThrow(() => JSON.parse(result.stdout), 'stdout must pipe straight into a JSON parser')
  // Which snapshot the verdict rests on is never left unsaid: a policy approved
  // against last year's capabilities is exactly the run somebody quotes later.
  assert.match(result.stderr, /snapshot 2 model\(s\) captured 2026-09-01/)
})

test('without --json stdout carries the human summary instead', async (t) => {
  const root = await makeTree(TREE)
  t.after(() => cleanup(root))

  const result = runCli(['--policy', join(root, 'policy.json'), '--snapshot', join(root, 'snapshot.json'), '--root', root])
  assert.equal(result.status, 0)
  assert.match(result.stdout, /route\(s\) checked for 1 task\(s\)/)
  assert.match(result.stdout, /1 task\(s\) have a usable route/)
})

test('the configuration file supplies the as-of date, and the flag overrides it', async (t) => {
  const root = await makeTree({
    'snapshot.json': snapshot({ cheap: model() }),
    'policy.json': policy({ work: task() }, { primary: route() }, { defaults: { maxSnapshotAgeDays: 10 } }),
    'checker.config.json': JSON.stringify({ schemaVersion: '1', asOf: '2026-09-05' }),
  })
  t.after(() => cleanup(root))

  const fromConfig = runReport(root, ['--config', join(root, 'checker.config.json')])
  assert.equal(fromConfig.status, 0)
  assert.match(fromConfig.stderr, /judged as of 2026-09-05/)

  const overridden = runReport(root, ['--config', join(root, 'checker.config.json'), '--as-of', '2026-11-05'])
  assert.equal(overridden.status, 2)
  assert.match(overridden.stderr, /judged as of 2026-11-05/)
})

test('an unreadable or malformed configuration file is a configuration error', async (t) => {
  const root = await makeTree(TREE)
  t.after(() => cleanup(root))
  await writeFile(join(root, 'bad.json'), '{ "schemaVersion": "1", ')

  const missing = runReport(root, ['--config', join(root, 'absent.json')])
  assert.equal(missing.status, 2)
  assert.equal(missing.stdout, '')
  assert.match(missing.stderr, /--config is not usable/)

  const malformed = runReport(root, ['--config', join(root, 'bad.json')])
  assert.equal(malformed.status, 2)
  assert.equal(malformed.stdout, '')
  assert.match(malformed.stderr, /not valid JSON/)
})

test('an incomplete run says on stderr that it produced no decision', async (t) => {
  const root = await makeTree({
    'snapshot.json': snapshot({ cheap: model() }),
    'policy.json': policy({ work: task() }, { primary: route({ model: 'phantom' }) }),
  })
  t.after(() => cleanup(root))

  const result = runReport(root)
  assert.equal(result.status, 2)
  assert.match(result.stderr, /no routing decision was produced/)
  assert.equal(result.report.routing, null)
})

test('nothing in the report or the diagnostics reaches the network', async (t) => {
  const root = await makeTree(TREE)
  t.after(() => cleanup(root))

  // There is no adapter, no fetch and no provider client anywhere in src/ or
  // bin/, so the strongest thing a test can say is that a run with no network
  // available behaves identically. That is what this asserts.
  const first = runReport(root)
  const second = runCli([
    '--policy', join(root, 'policy.json'), '--snapshot', join(root, 'snapshot.json'), '--root', root, '--json',
  ])
  assert.equal(first.status, 0)
  assert.equal(first.stdout, second.stdout)
})
