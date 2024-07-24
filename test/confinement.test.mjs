/**
 * Where the two documents may live, and what the report may name.
 *
 * This tool opens exactly two files and the operator names both on the command
 * line: neither document can point at a third file, so there is no
 * attacker-supplied path to confine. What the root is for is the report --
 * `location.file` has to be relative, and a document outside the root has no
 * relative name that is not a walk back up the host's filesystem.
 *
 * Confinement is still resolved against **real** paths rather than spellings,
 * because a symlink inside the root pointing outside it spells nothing
 * suspicious, and following one would put an out-of-root path in the report.
 */

import assert from 'node:assert/strict'
import { symlink } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import test from 'node:test'

import { checkRouting, isInside } from '../src/index.mjs'
import { cleanup, makeTree, model, policy, route, runCli, snapshot, task } from './helpers.mjs'

test('a document outside the declared root is a configuration error, not a report', async (t) => {
  const outer = await makeTree({
    'snapshot.json': snapshot({ cheap: model() }),
    'inner/policy.json': policy({ work: task() }, { primary: route() }),
  })
  t.after(() => cleanup(outer))

  await assert.rejects(
    () => checkRouting({
      policy: join(outer, 'inner', 'policy.json'),
      snapshot: join(outer, 'snapshot.json'),
      root: join(outer, 'inner'),
    }),
    /snapshot must lie inside the declared root/,
  )
})

test('a symlink out of the root is followed to its real path and refused there', async (t) => {
  const outer = await makeTree({
    'outside-snapshot.json': snapshot({ cheap: model() }),
    'inner/policy.json': policy({ work: task() }, { primary: route() }),
  })
  t.after(() => cleanup(outer))
  const root = join(outer, 'inner')
  await symlink(join(outer, 'outside-snapshot.json'), join(root, 'innocent.json'))

  // The spelling is entirely inside the root. Only the real path is not.
  await assert.rejects(
    () => checkRouting({ policy: join(root, 'policy.json'), snapshot: join(root, 'innocent.json'), root }),
    /snapshot must lie inside the declared root/,
  )
})

test('a symlink that stays inside the root is read normally', async (t) => {
  const root = await makeTree({
    'real/snapshot.json': snapshot({ cheap: model() }),
    'policy.json': policy({ work: task() }, { primary: route() }),
  })
  t.after(() => cleanup(root))
  await symlink(join(root, 'real', 'snapshot.json'), join(root, 'linked.json'))

  const report = await checkRouting({ policy: join(root, 'policy.json'), snapshot: join(root, 'linked.json'), root })
  assert.equal(report.status, 'pass')
})

test('the same file cannot be both documents', async (t) => {
  const root = await makeTree({ 'both.json': snapshot({ cheap: model() }) })
  t.after(() => cleanup(root))

  await assert.rejects(
    () => checkRouting({ policy: join(root, 'both.json'), snapshot: join(root, 'both.json'), root }),
    /two different files/,
  )
})

test('no reported path is ever absolute, even for a document that is not there', async (t) => {
  const root = await makeTree({ 'policy.json': policy({ work: task() }, { primary: route() }) })
  t.after(() => cleanup(root))

  const report = await checkRouting({ policy: join(root, 'policy.json'), snapshot: join(root, 'absent.json'), root })
  assert.ok(report.findings.length > 0)
  for (const finding of report.findings) {
    assert.equal(isAbsolute(finding.location.file), false, `${finding.location.file} is an absolute host path`)
    assert.equal(finding.location.file.includes(root), false)
  }
  assert.equal(report.findings[0].location.file, 'absent.json')
})

test('the root defaults to the directory holding the policy', async (t) => {
  const root = await makeTree({
    'snapshot.json': snapshot({ cheap: model() }),
    'policy.json': policy({ work: task() }, { primary: route() }),
  })
  t.after(() => cleanup(root))

  const withRoot = runCli(['--policy', join(root, 'policy.json'), '--snapshot', join(root, 'snapshot.json'), '--root', root, '--json'])
  const withoutRoot = runCli(['--policy', join(root, 'policy.json'), '--snapshot', join(root, 'snapshot.json'), '--json'])
  assert.equal(withoutRoot.status, 0)
  assert.equal(withoutRoot.stdout, withRoot.stdout)
})

test('a root that is not a directory is a configuration error', async (t) => {
  const root = await makeTree({
    'snapshot.json': snapshot({ cheap: model() }),
    'policy.json': policy({ work: task() }, { primary: route() }),
  })
  t.after(() => cleanup(root))

  await assert.rejects(
    () => checkRouting({ policy: join(root, 'policy.json'), snapshot: join(root, 'snapshot.json'), root: join(root, 'policy.json') }),
    /Root must be a directory/,
  )
})

test('isInside compares whole path segments, not string prefixes', () => {
  assert.equal(isInside('/a/root', '/a/root'), true)
  assert.equal(isInside('/a/root', '/a/root/child'), true)
  assert.equal(isInside('/a/root', '/a/rootsibling/child'), false)
  assert.equal(isInside('/a/root', '/a'), false)
})
