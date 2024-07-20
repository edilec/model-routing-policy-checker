/**
 * Fixture helpers shared by the suite.
 *
 * Every fixture lives in a fresh temporary directory: a test that writes into
 * the repository leaves the next run a different subject, and this tool's whole
 * claim is that the same subject produces the same bytes.
 *
 * The builders below carry defaults that are deliberately *sound*, so a test
 * changes exactly one thing and the finding it gets is about that thing.
 */

import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const BIN = fileURLToPath(new URL('../bin/model-routing-policy-checker.mjs', import.meta.url))

export async function makeTree(files) {
  const root = await mkdtemp(join(tmpdir(), 'model-routing-policy-checker-'))
  for (const name of Object.keys(files).sort()) {
    const path = join(root, name)
    await mkdir(dirname(path), { recursive: true })
    const content = files[name]
    await writeFile(path, content instanceof Uint8Array ? content : String(content))
  }
  return root
}

export async function cleanup(root) {
  await rm(root, { recursive: true, force: true })
}

/** A model entry that satisfies every check, unless a test overrides part of it. */
export function model(over = {}) {
  return {
    capabilities: ['text'],
    maxContextTokens: 32768,
    maxOutputTokens: 4096,
    inputPricePerMillion: 0.25,
    outputPricePerMillion: 1.25,
    authorisedFor: ['internal'],
    status: 'available',
    ...over,
  }
}

/** A task that any default model can serve. */
export function task(over = {}) {
  return {
    requires: ['text'],
    authority: ['internal'],
    expectedInputTokens: 1000,
    expectedOutputTokens: 100,
    entry: 'primary',
    ...over,
  }
}

export function route(over = {}) {
  return { task: 'work', model: 'cheap', ...over }
}

export function snapshot(models, extra = {}) {
  return JSON.stringify({ schemaVersion: '1', capturedAt: '2026-09-01', models, ...extra }, null, 2)
}

export function policy(tasks, routes, extra = {}) {
  return JSON.stringify({ schemaVersion: '1', tasks, routes, ...extra }, null, 2)
}

/** The smallest sound pair: one task, one model, one route. */
export function soundTree(over = {}) {
  return {
    'snapshot.json': snapshot({ cheap: model() }),
    'policy.json': policy({ work: task() }, { primary: route() }),
    ...over,
  }
}

export function runCli(args) {
  const result = spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8' })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

/**
 * Run the real CLI over a fixture and parse the JSON report.
 *
 * Deliberately through the process boundary rather than the library: an exit
 * code is the one assertion nobody can satisfy by editing a table, and the JSON
 * on stdout is what a consumer actually receives.
 */
export function runReport(root, args = []) {
  const result = runCli([
    '--policy', join(root, 'policy.json'),
    '--snapshot', join(root, 'snapshot.json'),
    '--root', root, '--json', ...args,
  ])
  return { ...result, report: result.stdout === '' ? null : JSON.parse(result.stdout) }
}

export function findingsFor(report, ruleId) {
  return report.findings.filter((finding) => finding.ruleId === ruleId)
}

export function findingFor(report, ruleId) {
  const matches = findingsFor(report, ruleId)
  if (matches.length === 0) throw new Error(`no finding for rule "${ruleId}"`)
  return matches[0]
}
