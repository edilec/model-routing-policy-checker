/**
 * Ordering, pinned behaviourally.
 *
 * Scanning this tool's own source for `.localeCompare(` is not a determinism
 * test: substituting `Intl.Collator` produces identical collation drift with
 * different source text, so the grep passes while the output quietly becomes
 * machine-dependent.
 *
 * So these tests choose ids and file names whose order genuinely differs
 * between code-unit and collation ordering, push them through the real report
 * path, and assert the exact emitted sequence. Each one also asserts that the
 * collation ordering of the same strings is different, so the fixture is
 * provably able to tell the two apart.
 */

import assert from 'node:assert/strict'
import { join } from 'node:path'
import test from 'node:test'

import { checkRouting, compareFindingRows } from '../src/index.mjs'
import { cleanup, makeTree, model, policy, route, runCli, snapshot, task } from './helpers.mjs'

const collated = (values) => [...values].sort(new Intl.Collator('en').compare)

test('findings sort by pointer using code units, not collation', async (t) => {
  const spare = { README: route(), 'Z-note': route(), 'a-b': route(), 'a-note': route(), a_b: route(), assets: route() }
  const root = await makeTree({
    'snapshot.json': snapshot({ cheap: model() }),
    'policy.json': policy({ work: task({ entry: 'entry-route' }) }, { 'entry-route': route(), ...spare }),
  })
  t.after(() => cleanup(root))

  const report = await checkRouting({ policy: join(root, 'policy.json'), snapshot: join(root, 'snapshot.json'), root })
  const pointers = report.findings
    .filter((finding) => finding.ruleId === 'route-unreachable')
    .map((finding) => finding.location.pointer)

  assert.deepEqual(pointers, [
    '/routes/README',
    '/routes/Z-note',
    '/routes/a-b',
    '/routes/a-note',
    '/routes/a_b',
    '/routes/assets',
  ])
  assert.notDeepEqual(pointers, collated(pointers), 'the fixture must distinguish code-unit ordering from collation')
})

test('findings sort by file using code units, not collation', async (t) => {
  const root = await makeTree({
    'Zulu-policy.json': policy({ work: task() }, { primary: route() }, { rogue: 1 }),
    'alpha-snapshot.json': snapshot({ cheap: model() }, { rogue: 1 }),
  })
  t.after(() => cleanup(root))

  const report = await checkRouting({
    policy: join(root, 'Zulu-policy.json'),
    snapshot: join(root, 'alpha-snapshot.json'),
    root,
  })
  const files = report.findings.map((finding) => finding.location.file)

  assert.deepEqual(files, ['Zulu-policy.json', 'alpha-snapshot.json'])
  assert.notDeepEqual(files, collated(files), 'the fixture must distinguish code-unit ordering from collation')
})

test('the routing decision lists tasks by code unit', async (t) => {
  const tasks = {
    README: task({ entry: 'r-README' }),
    'Z-note': task({ entry: 'r-Z-note' }),
    'a-b': task({ entry: 'r-a-b' }),
    a_b: task({ entry: 'r-a_b' }),
    assets: task({ entry: 'r-assets' }),
  }
  const routes = Object.fromEntries(Object.keys(tasks).map((id) => [`r-${id}`, route({ task: id })]))
  const root = await makeTree({
    'snapshot.json': snapshot({ cheap: model() }),
    'policy.json': policy(tasks, routes),
  })
  t.after(() => cleanup(root))

  const report = await checkRouting({ policy: join(root, 'policy.json'), snapshot: join(root, 'snapshot.json'), root })
  const ids = report.routing.tasks.map((row) => row.id)

  assert.deepEqual(ids, ['README', 'Z-note', 'a-b', 'a_b', 'assets'])
  assert.notDeepEqual(ids, collated(ids), 'the fixture must distinguish code-unit ordering from collation')
})

test('the process boundary emits the same order the library does', async (t) => {
  const root = await makeTree({
    'Zulu-policy.json': policy({ work: task() }, { primary: route() }, { rogue: 1 }),
    'alpha-snapshot.json': snapshot({ cheap: model() }, { rogue: 1 }),
  })
  t.after(() => cleanup(root))

  const result = runCli([
    '--policy', join(root, 'Zulu-policy.json'), '--snapshot', join(root, 'alpha-snapshot.json'),
    '--root', root, '--json',
  ])
  assert.equal(result.status, 2)
  assert.deepEqual(JSON.parse(result.stdout).findings.map((finding) => finding.location.file), [
    'Zulu-policy.json', 'alpha-snapshot.json',
  ])
})

test('each tie-break key of the documented sort is load-bearing', () => {
  const row = (over) => ({
    ruleId: 'route-unreachable',
    severity: 'warning',
    message: 'm',
    location: { file: 'f', pointer: '/p' },
    ...over,
  })

  assert.equal(compareFindingRows(row({ location: { file: 'A' } }), row({ location: { file: 'a' } })), -1)
  assert.equal(compareFindingRows(row({ location: { file: 'f', pointer: '/A' } }), row({ location: { file: 'f', pointer: '/a' } })), -1)
  assert.equal(compareFindingRows(row({ ruleId: 'budget-exceeded' }), row({ ruleId: 'route-unreachable' })), -1)
  assert.equal(compareFindingRows(row({ message: 'A' }), row({ message: 'a' })), -1)
  assert.equal(compareFindingRows(row({ evidence: 'A' }), row({ evidence: 'a' })), -1)
  assert.equal(compareFindingRows(row({}), row({})), 0)
})
