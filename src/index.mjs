/**
 * model-routing-policy-checker
 *
 * Checks a model routing policy against a supplied capability and pricing
 * snapshot: does each route's model actually support what the task needs, is it
 * authorised for the task's data, does it fit the context and the budget, and
 * does the fallback graph terminate.
 *
 * Four properties are structural rather than incidental:
 *
 * 1. **Price never rescues capability.** The cheapest model in the snapshot is
 *    rejected for a task it cannot do, and the finding says so with its price
 *    attached, because "but it was cheaper" is the argument this check exists
 *    to end.
 * 2. **Missing model metadata is unknown, never permission.** A route naming a
 *    model the snapshot does not describe -- or describes with a field missing
 *    -- makes the run `incomplete`, produces no routing decision at all, and
 *    exits 2. It is never reported as a model that passed, and never as a model
 *    that failed.
 * 3. **A cyclic fallback graph fails.** `cheap -> mid -> cheap` retries forever
 *    at runtime under exactly the conditions that made the first call fail.
 *    Here it is an error and exit 1.
 * 4. **Output is stable.** No clock reading, no locale, no absolute host path
 *    and no object key order reaches stdout, so the same pair of documents
 *    always produces byte-identical output.
 *
 * Nothing is fetched. The snapshot is evidence the operator supplies and dates;
 * this tool makes no provider call at any time, including in its tests.
 */

import { realpath, stat } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'

import { DOCUMENT_RULES, checkEnvelope, isRecord, readJsonDocument } from './document.mjs'
import { routesInCycles, walkChain } from './graph.mjs'
import { POLICY_KEYS, POLICY_SCHEMA_VERSION, validatePolicy } from './policy.mjs'
import {
  MILLISECONDS_PER_DAY, SNAPSHOT_KEYS, SNAPSHOT_SCHEMA_VERSION,
  estimateCallCost, parseDate, roundCost, validateSnapshot,
} from './snapshot.mjs'
import { byCodeUnit, escapePointerSegment, parseFailureDetail, sanitize } from './text.mjs'

export { DOCUMENT_RULES, readJsonDocument } from './document.mjs'
export { routesInCycles, walkChain } from './graph.mjs'
export { POLICY_KEYS, ROUTE_KEYS, TASK_KEYS, validatePolicy } from './policy.mjs'
export {
  MODEL_KEYS, MODEL_STATUSES, REQUIRED_MODEL_KEYS, SNAPSHOT_KEYS,
  estimateCallCost, parseDate, roundCost, validateSnapshot,
} from './snapshot.mjs'
export { CONTROL_CLASSES, byCodeUnit, decodeUtf8, escapePointerSegment, parseFailureDetail, sanitize } from './text.mjs'

export const TOOL_ID = 'model-routing-policy-checker'
export const REPORT_SCHEMA_VERSION = '1'
export const CONFIG_SCHEMA_VERSION = '1'

/**
 * Bounds are part of the contract, not a safety net.
 *
 * `timeoutMs` accepts 0, and 0 means no time at all: the first check fires.
 * That is the only way to prove from outside the process that the flag reaches
 * the evaluation loop, and a documented limit the command line never reaches is
 * a defect this catalog has already shipped once.
 */
export const DEFAULT_LIMITS = Object.freeze({
  maxCapabilities: 32,
  maxDocumentBytes: 1048576,
  maxFallbackDepth: 8,
  maxModels: 500,
  maxRoutes: 500,
  maxTasks: 200,
  timeoutMs: 10000,
})

/**
 * The authoritative rule severity table.
 *
 * Severity decides whether a policy is refused. Spread across construction
 * sites as a literal it drifts silently -- flipping one security-relevant rule
 * to `warning` turns a refusal into a green build -- so every finding takes its
 * severity from here and an unknown rule id throws.
 *
 * This table is the source of truth. It is **not** the guard. Three
 * declarations agreeing with each other -- this table, the README's rule table
 * and an expected-value map written out again in a test -- are all satisfied by
 * one coordinated edit. The guard is `test/severity-outcomes.test.mjs`, which
 * drives each rule through the real command line and asserts the observable
 * outcome as a literal at the assertion site. An edit here has nothing there to
 * agree with, and an exit code cannot be edited at all.
 */
export const RULE_SEVERITY = Object.freeze({
  'authority-not-granted': 'error',
  'budget-exceeded': 'error',
  'capability-unsupported': 'error',
  'context-too-small': 'error',
  'document-malformed': 'error',
  'document-not-json': 'error',
  'document-not-utf8': 'error',
  'document-schema-unsupported': 'error',
  'document-too-large': 'error',
  'document-unknown-key': 'error',
  'document-unreadable': 'error',
  'fallback-cycle': 'error',
  'fallback-depth-exceeded': 'error',
  'fallback-missing': 'warning',
  'fallback-task-mismatch': 'error',
  'fallback-unknown': 'error',
  'identifier-invalid': 'error',
  'model-deprecated': 'warning',
  'model-malformed': 'error',
  'model-metadata-missing': 'error',
  'model-retired': 'error',
  'model-unknown': 'error',
  'no-routes': 'warning',
  'output-cap-too-small': 'error',
  'route-malformed': 'error',
  'route-task-unknown': 'error',
  'route-unreachable': 'warning',
  'snapshot-not-comparable': 'error',
  'snapshot-stale': 'error',
  'task-entry-unknown': 'error',
  'task-malformed': 'error',
  'task-routed': 'info',
  'task-unroutable': 'error',
  'time-budget-exceeded': 'error',
  'too-many-models': 'error',
  'too-many-routes': 'error',
  'too-many-tasks': 'error',
})

/**
 * Rules that mean evidence was not obtained.
 *
 * Any one of these forces `status: "incomplete"`, suppresses the routing
 * decision entirely, and exits 2 -- whatever else the run found. Most are
 * `error` severity, so it would be easy to believe severity alone does the
 * work. It does not: without the flag the run would report `fail` and exit 1,
 * claiming a verdict about models it has no facts about. And `no-routes` is a
 * `warning`, so there the flag is the *only* thing standing between an empty
 * policy and a green build.
 *
 * `snapshot-stale` is here rather than among the failures on purpose. A
 * capability snapshot older than the policy allows is not evidence that the
 * policy is wrong; it is evidence about models as they were, and the honest
 * answer to "is this policy sound today" is that this run cannot tell.
 */
export const INCOMPLETE_RULES = Object.freeze([
  'document-malformed',
  'document-not-json',
  'document-not-utf8',
  'document-schema-unsupported',
  'document-too-large',
  'document-unknown-key',
  'document-unreadable',
  'fallback-depth-exceeded',
  'identifier-invalid',
  'model-malformed',
  'model-metadata-missing',
  'model-unknown',
  'no-routes',
  'route-malformed',
  'snapshot-not-comparable',
  'snapshot-stale',
  'task-malformed',
  'time-budget-exceeded',
  'too-many-models',
  'too-many-routes',
  'too-many-tasks',
])

const INCOMPLETE_SET = new Set(INCOMPLETE_RULES)
const ALLOWED_OPTIONS = Object.freeze(['asOf', 'clock', 'limits', 'policy', 'root', 'snapshot'])
const ALLOWED_CONFIG_KEYS = Object.freeze(['asOf', 'limits', 'schemaVersion'])

/** Rules that make one route unusable for the task it serves. */
export const BLOCKING_RULES = Object.freeze([
  'authority-not-granted',
  'budget-exceeded',
  'capability-unsupported',
  'context-too-small',
  'model-retired',
  'model-unknown',
  'output-cap-too-small',
  'route-task-unknown',
])

const BLOCKING_SET = new Set(BLOCKING_RULES)

/**
 * True when `target` is the real root or lies inside it.
 *
 * Both arguments must already be real paths. This tool opens exactly two files
 * and the operator names both, so there is no attacker-supplied path to
 * confine -- neither document can point at a file. What this check is for is
 * the report: `location.file` has to be relative to a root, and a document
 * outside that root has no relative name that is not a walk back up the host
 * filesystem.
 */
export function isInside(realRoot, target) {
  return target === realRoot || target.startsWith(realRoot.endsWith(sep) ? realRoot : realRoot + sep)
}

/**
 * The real path of `path`, or the closest thing to it that exists.
 *
 * `realpath` fails outright on a file that is not there, which is precisely the
 * case a report has to describe. Resolving the containing directory instead
 * keeps a missing input's reported name relative to the root rather than
 * turning it into a walk back up the host's filesystem -- which is what
 * happened on macOS, where the temporary directory is reached through a
 * symlink.
 */
async function realOrNearest(path) {
  try {
    return await realpath(path)
  } catch {
    // fall through to the containing directory
  }
  try {
    return join(await realpath(dirname(path)), basename(path))
  } catch {
    return resolve(path)
  }
}

function relativePosix(realRoot, target) {
  return relative(realRoot, target).split(sep).join('/')
}

/**
 * The documented sort key, exported so a test can pin each half of it.
 *
 * `message` and `evidence` are the fourth and fifth keys because the first
 * three do not separate every row: several capabilities can be missing from one
 * route under one rule at one pointer, and two unknown keys on one model share
 * a pointer prefix. Without the extra keys those rows tie, and their order
 * falls back to whichever upstream loop inserted them.
 */
export function compareFindingRows(left, right) {
  return byCodeUnit(left.location.file, right.location.file)
    || byCodeUnit(left.location.pointer ?? '', right.location.pointer ?? '')
    || byCodeUnit(left.ruleId, right.ruleId)
    || byCodeUnit(left.message, right.message)
    || byCodeUnit(left.evidence ?? '', right.evidence ?? '')
}

export function validateLimits(overrides = {}) {
  if (!isRecord(overrides)) throw new TypeError('Limits must be an object')
  const limits = { ...DEFAULT_LIMITS }
  for (const [name, value] of Object.entries(overrides)) {
    if (!Object.hasOwn(DEFAULT_LIMITS, name)) throw new TypeError(`Unknown limit "${sanitize(name, 60)}"`)
    const minimum = name === 'timeoutMs' ? 0 : 1
    if (!Number.isInteger(value) || value < minimum) {
      throw new TypeError(`Limit "${name}" must be an integer of ${minimum} or more`)
    }
    limits[name] = value
  }
  return Object.freeze(limits)
}

export function validateAsOf(asOf) {
  if (asOf === undefined || asOf === null) return null
  if (parseDate(asOf) === null) {
    throw new TypeError(`asOf must be a real calendar date in YYYY-MM-DD form, not "${sanitize(String(asOf), 40)}"`)
  }
  return asOf
}

export function validateConfig(config) {
  if (!isRecord(config)) throw new TypeError('Configuration must be a JSON object')
  if (config.schemaVersion !== CONFIG_SCHEMA_VERSION) {
    throw new TypeError(`Unsupported configuration schemaVersion: ${sanitize(String(config.schemaVersion ?? 'missing'), 40)}`)
  }
  for (const key of Object.keys(config)) {
    if (!ALLOWED_CONFIG_KEYS.includes(key)) {
      throw new TypeError(`Unknown configuration key "${sanitize(key, 60)}"; this tool accepts ${ALLOWED_CONFIG_KEYS.join(', ')}`)
    }
  }
  return Object.freeze({
    asOf: validateAsOf(config.asOf),
    limits: validateLimits(config.limits ?? {}),
  })
}

export async function loadConfigFile(path) {
  const result = await readJsonDocument(resolve(path), 'configuration file', DEFAULT_LIMITS.maxDocumentBytes)
  if (result.problem !== undefined) throw new TypeError(result.problem.message)
  return validateConfig(result.document)
}

/**
 * The status a run's counts imply.
 *
 * Missing evidence outranks everything: a run that could not obtain the facts
 * it needs has no verdict to give, whatever the rest of the policy looked like.
 */
export function statusFor({ errors, unexamined }) {
  if (unexamined > 0) return 'incomplete'
  return errors > 0 ? 'fail' : 'pass'
}

/**
 * The routing decision a status permits.
 *
 * An `incomplete` run never carries one, however far the evaluation got. A
 * routing decision computed from a snapshot with a hole in it looks exactly
 * like a routing decision computed from a complete one, which is the whole
 * reason this gate exists rather than a comment asking people to check.
 */
export function routingFor(status, routing) {
  return status === 'incomplete' ? null : routing
}

function makeFinding(ruleId, message, location, extra = {}) {
  const severity = RULE_SEVERITY[ruleId]
  if (severity === undefined) throw new TypeError(`Unknown rule id "${ruleId}"`)
  const pointer = location.pointer === undefined || location.pointer === '' ? undefined : location.pointer
  return {
    ruleId,
    severity,
    message,
    location: pointer === undefined ? { file: location.file } : { file: location.file, pointer },
    ...extra,
  }
}

/**
 * Check one route against the task it serves and the model it names.
 *
 * Returns findings. The order of the checks below is the order the findings are
 * generated in, not the order they are reported in -- the report is sorted
 * afterwards -- but the *capability* check comes first deliberately, so that
 * when a route fails for several reasons at once the message a reader sees
 * first names the thing the model fundamentally cannot do.
 */
function checkRoute(route, task, model, policyFile) {
  const findings = []
  const pointer = `/routes/${escapePointerSegment(route.id)}`
  const price = `${model.inputPricePerMillion} in / ${model.outputPricePerMillion} out per million tokens`

  const missingCapabilities = task.requires.filter((needed) => !model.capabilities.includes(needed))
  if (missingCapabilities.length > 0) {
    findings.push(makeFinding(
      'capability-unsupported',
      `Route "${route.id}" sends task "${task.id}" to model "${model.id}", which does not support ${missingCapabilities.map((name) => `"${sanitize(name, 40)}"`).join(', ')}. Price is not a substitute for capability: this model is ${price} and it still cannot do the work.`,
      { file: policyFile, pointer: `${pointer}/model` },
      { model: model.id, task: task.id, missing: missingCapabilities.map((name) => sanitize(name, 40)) },
    ))
  }

  const neededContext = task.expectedInputTokens + task.expectedOutputTokens
  if (model.maxContextTokens < neededContext) {
    findings.push(makeFinding(
      'context-too-small',
      `Route "${route.id}" sends task "${task.id}" to model "${model.id}", whose context is ${model.maxContextTokens} tokens against the ${neededContext} the task expects to use (${task.expectedInputTokens} in, ${task.expectedOutputTokens} out).`,
      { file: policyFile, pointer: `${pointer}/model` },
      { model: model.id, task: task.id },
    ))
  }
  if (model.maxOutputTokens < task.expectedOutputTokens) {
    findings.push(makeFinding(
      'output-cap-too-small',
      `Route "${route.id}" sends task "${task.id}" to model "${model.id}", which caps output at ${model.maxOutputTokens} tokens against the ${task.expectedOutputTokens} the task expects.`,
      { file: policyFile, pointer: `${pointer}/model` },
      { model: model.id, task: task.id },
    ))
  }

  const missingAuthority = task.authority.filter((needed) => !model.authorisedFor.includes(needed))
  if (missingAuthority.length > 0) {
    findings.push(makeFinding(
      'authority-not-granted',
      `Route "${route.id}" sends task "${task.id}", which needs authority ${missingAuthority.map((name) => `"${sanitize(name, 40)}"`).join(', ')}, to model "${model.id}", which is not granted it. An authority absent from the snapshot is a denial, not an omission.`,
      { file: policyFile, pointer: `${pointer}/model` },
      { model: model.id, task: task.id, missing: missingAuthority.map((name) => sanitize(name, 40)) },
    ))
  }

  const cost = estimateCallCost(model, task)
  if (task.maxCostPerCallUsd !== null && cost > task.maxCostPerCallUsd) {
    findings.push(makeFinding(
      'budget-exceeded',
      `Route "${route.id}" costs an estimated ${cost} per call on model "${model.id}", above the ${task.maxCostPerCallUsd} task "${task.id}" allows. The estimate is the task's own expected token counts against the snapshot's prices; it is not a bill.`,
      { file: policyFile, pointer: `${pointer}/model` },
      { model: model.id, task: task.id, estimatedCostUsd: cost },
    ))
  }

  if (model.status === 'retired') {
    findings.push(makeFinding(
      'model-retired',
      `Route "${route.id}" names model "${model.id}", which the snapshot marks retired.`,
      { file: policyFile, pointer: `${pointer}/model` },
      { model: model.id, task: task.id },
    ))
  } else if (model.status === 'deprecated') {
    findings.push(makeFinding(
      'model-deprecated',
      `Route "${route.id}" names model "${model.id}", which the snapshot marks deprecated. It still routes; plan the replacement.`,
      { file: policyFile, pointer: `${pointer}/model` },
      { model: model.id, task: task.id },
    ))
  }

  return { findings, cost }
}

/**
 * Check a routing policy against a capability and pricing snapshot.
 *
 * Throws a `TypeError` for anything that makes the run impossible to define --
 * a missing document, a root that is not a directory, an unknown limit, a
 * policy that sets `maxSnapshotAgeDays` with no `asOf` to measure against.
 * Those are configuration errors: the run never had a subject, so there is
 * nothing to report about, and the CLI writes nothing to stdout. Everything
 * that is a fact about the documents comes back in the report.
 */
export async function checkRouting(options = {}) {
  if (!isRecord(options)) throw new TypeError('Options must be an object')
  for (const key of Object.keys(options)) {
    if (!ALLOWED_OPTIONS.includes(key)) throw new TypeError(`Unknown option "${sanitize(key, 60)}"`)
  }
  for (const key of ['policy', 'snapshot']) {
    if (typeof options[key] !== 'string' || options[key].trim() === '') {
      throw new TypeError(`A ${key} file is required`)
    }
  }
  const limits = validateLimits(options.limits ?? {})
  const asOf = validateAsOf(options.asOf)
  const clock = options.clock ?? (() => performance.now())
  if (typeof clock !== 'function') throw new TypeError('clock must be a function returning elapsed milliseconds')

  const policyPath = resolve(options.policy)
  const snapshotPath = resolve(options.snapshot)
  const rootPath = options.root === undefined || options.root === null ? dirname(policyPath) : resolve(options.root)

  let realRoot
  try {
    realRoot = await realpath(rootPath)
  } catch (error) {
    throw new TypeError(`Root directory could not be resolved: ${error.code ?? 'unresolvable'}`)
  }
  let rootInfo
  try {
    rootInfo = await stat(realRoot)
  } catch (error) {
    throw new TypeError(`Root directory could not be inspected: ${error.code ?? 'uninspectable'}`)
  }
  if (!rootInfo.isDirectory()) throw new TypeError('Root must be a directory')

  const realPolicy = await realOrNearest(policyPath)
  const realSnapshot = await realOrNearest(snapshotPath)
  for (const [name, target] of [['policy', realPolicy], ['snapshot', realSnapshot]]) {
    if (!isInside(realRoot, target)) {
      throw new TypeError(`The ${name} must lie inside the declared root, so every reported path can be relative to it`)
    }
  }
  const policyFile = relativePosix(realRoot, realPolicy)
  const snapshotFile = relativePosix(realRoot, realSnapshot)
  if (policyFile === snapshotFile) {
    throw new TypeError('The policy and the snapshot must be two different files')
  }

  const started = clock()
  const deadline = () => limits.timeoutMs === 0 || clock() - started > limits.timeoutMs

  const findings = []
  const add = (problem) => {
    findings.push(makeFinding(
      problem.ruleId,
      problem.message,
      { file: problem.file, pointer: problem.pointer },
      problem.evidence === undefined ? {} : { evidence: problem.evidence },
    ))
  }

  const finish = (summaryExtra, routing) => {
    findings.sort(compareFindingRows)
    const errors = findings.filter((finding) => finding.severity === 'error').length
    const warnings = findings.filter((finding) => finding.severity === 'warning').length
    const unexamined = findings.filter((finding) => INCOMPLETE_SET.has(finding.ruleId)).length
    const status = statusFor({ errors, unexamined })
    return {
      schemaVersion: REPORT_SCHEMA_VERSION,
      tool: TOOL_ID,
      status,
      summary: {
        checked: 0,
        models: 0,
        tasks: 0,
        routes: 0,
        routable: 0,
        unroutable: 0,
        ...summaryExtra,
        errors,
        warnings,
        info: findings.length - errors - warnings,
        unexamined,
      },
      routing: routingFor(status, routing),
      findings,
    }
  }

  const snapshotRead = await readJsonDocument(snapshotPath, snapshotFile, limits.maxDocumentBytes)
  const policyRead = await readJsonDocument(policyPath, policyFile, limits.maxDocumentBytes)
  if (snapshotRead.problem !== undefined) add(snapshotRead.problem)
  if (policyRead.problem !== undefined) add(policyRead.problem)
  if (snapshotRead.problem !== undefined || policyRead.problem !== undefined) return finish({}, null)

  for (const problem of checkEnvelope(snapshotRead.document, {
    file: snapshotFile, schemaVersion: SNAPSHOT_SCHEMA_VERSION, keys: SNAPSHOT_KEYS,
  })) add(problem)
  for (const problem of checkEnvelope(policyRead.document, {
    file: policyFile, schemaVersion: POLICY_SCHEMA_VERSION, keys: POLICY_KEYS,
  })) add(problem)
  if (findings.length > 0) return finish({}, null)

  const snapshot = validateSnapshot(snapshotRead.document, snapshotFile, limits)
  const policy = validatePolicy(policyRead.document, policyFile, limits)
  for (const problem of [...snapshot.problems, ...policy.problems]) add(problem)

  if (policy.defaults.maxSnapshotAgeDays !== null) {
    if (asOf === null) {
      throw new TypeError(
        'The policy sets defaults.maxSnapshotAgeDays, so --as-of is required: a snapshot cannot be judged current against a date nobody supplied',
      )
    }
    if (snapshot.capturedAt !== null) {
      const ageDays = Math.round((parseDate(asOf) - snapshot.capturedAt) / MILLISECONDS_PER_DAY)
      if (ageDays < 0) {
        add({
          ruleId: 'snapshot-not-comparable',
          file: snapshotFile,
          pointer: '/capturedAt',
          message: `The snapshot is dated after the supplied as-of date, ${Math.abs(ageDays)} day(s) into its future, so its age cannot be judged.`,
        })
      } else if (ageDays > policy.defaults.maxSnapshotAgeDays) {
        add({
          ruleId: 'snapshot-stale',
          file: snapshotFile,
          pointer: '/capturedAt',
          message: `The snapshot is ${ageDays} day(s) old against a maxSnapshotAgeDays of ${policy.defaults.maxSnapshotAgeDays}. It describes models as they were, so this run cannot say whether the policy is sound now.`,
        })
      }
    }
  }

  const summaryBase = {
    models: snapshot.models.size,
    tasks: policy.tasks.size,
    routes: policy.routes.size,
  }

  if (policy.routes.size === 0) {
    // "pass" with nothing checked is green on no evidence. This is a warning,
    // so the incomplete flag -- not the severity -- is what keeps it off a
    // green build.
    add({
      ruleId: 'no-routes',
      file: policyFile,
      pointer: '/routes',
      message: 'The policy declares no usable routes, so this run has no routing to check and no verdict to give.',
    })
    return finish(summaryBase, null)
  }

  const routeFindings = new Map()
  const routeCosts = new Map()
  for (const id of [...policy.routes.keys()].sort(byCodeUnit)) {
    if (deadline()) {
      add({
        ruleId: 'time-budget-exceeded',
        file: policyFile,
        pointer: '/routes',
        message: `The time budget of ${limits.timeoutMs}ms expired while checking routes, so this run reached no verdict.`,
      })
      return finish(summaryBase, null)
    }
    const route = policy.routes.get(id)
    const pointer = `/routes/${escapePointerSegment(id)}`
    const produced = []

    const task = policy.tasks.get(route.task)
    if (task === undefined) {
      produced.push(makeFinding(
        'route-task-unknown',
        `Route "${id}" serves task "${sanitize(route.task, 80)}", which the policy does not declare.`,
        { file: policyFile, pointer: `${pointer}/task` },
        { evidence: sanitize(route.task, 80) },
      ))
    }
    const model = snapshot.models.get(route.model)
    if (model === undefined) {
      produced.push(makeFinding(
        'model-unknown',
        snapshot.declared.includes(route.model)
          ? `Route "${id}" names model "${sanitize(route.model, 80)}", whose snapshot entry is incomplete or malformed, so nothing about it is usable evidence. An unknown model is never approved and never rejected: it is unknown.`
          : `Route "${id}" names model "${sanitize(route.model, 80)}", which the snapshot does not describe. An unknown model is never approved and never rejected: it is unknown.`,
        { file: policyFile, pointer: `${pointer}/model` },
        { evidence: sanitize(route.model, 80) },
      ))
    }

    if (task !== undefined && model !== undefined) {
      const outcome = checkRoute(route, task, model, policyFile)
      produced.push(...outcome.findings)
      routeCosts.set(id, outcome.cost)
    }

    if (route.fallbackTo !== null) {
      const next = policy.routes.get(route.fallbackTo)
      if (next === undefined) {
        produced.push(makeFinding(
          'fallback-unknown',
          `Route "${id}" falls back to "${sanitize(route.fallbackTo, 80)}", which the policy does not declare, so the chain stops there.`,
          { file: policyFile, pointer: `${pointer}/fallbackTo` },
          { evidence: sanitize(route.fallbackTo, 80) },
        ))
      } else if (next.task !== route.task) {
        produced.push(makeFinding(
          'fallback-task-mismatch',
          `Route "${id}" serves task "${sanitize(route.task, 60)}" but falls back to "${next.id}", which serves "${sanitize(next.task, 60)}". A fallback that changes the task silently answers a different question.`,
          { file: policyFile, pointer: `${pointer}/fallbackTo` },
          { evidence: sanitize(next.task, 60) },
        ))
      }
    }

    routeFindings.set(id, produced)
    findings.push(...produced)
  }

  // Unknown model metadata stops the run here, before a single routing decision
  // is made. Deciding from the routes that did resolve would produce a decision
  // that looks complete and is not.
  if (findings.some((finding) => INCOMPLETE_SET.has(finding.ruleId))) {
    return finish({ ...summaryBase, checked: policy.routes.size }, null)
  }

  for (const id of routesInCycles(policy.routes)) {
    findings.push(makeFinding(
      'fallback-cycle',
      `Route "${sanitize(id, 80)}" can fall back to itself. At runtime that retries forever under exactly the conditions that made the first call fail.`,
      { file: policyFile, pointer: `/routes/${escapePointerSegment(id)}/fallbackTo` },
    ))
  }

  const blocked = new Map()
  for (const [id, produced] of routeFindings) {
    blocked.set(id, produced.filter((finding) => BLOCKING_SET.has(finding.ruleId)).map((finding) => finding.ruleId))
  }

  const reached = new Set()
  const taskRows = []
  for (const id of [...policy.tasks.keys()].sort(byCodeUnit)) {
    const task = policy.tasks.get(id)
    const pointer = `/tasks/${escapePointerSegment(id)}`
    if (!policy.routes.has(task.entry)) {
      findings.push(makeFinding(
        'task-entry-unknown',
        `Task "${id}" enters at route "${sanitize(task.entry, 80)}", which the policy does not declare.`,
        { file: policyFile, pointer: `${pointer}/entry` },
        { evidence: sanitize(task.entry, 80) },
      ))
      taskRows.push({ id, entry: task.entry, chain: [], routedVia: null, model: null, estimatedCostUsd: null, blockedBy: [] })
      continue
    }

    const walk = walkChain(task.entry, policy.routes, limits.maxFallbackDepth)
    for (const routeId of walk.chain) reached.add(routeId)
    if (walk.depthExceeded) {
      findings.push(makeFinding(
        'fallback-depth-exceeded',
        `Task "${id}" has a fallback chain longer than the maxFallbackDepth limit of ${limits.maxFallbackDepth}, so this run did not reach its end.`,
        { file: policyFile, pointer: `${pointer}/entry` },
      ))
    }

    const viable = walk.chain.find((routeId) => blocked.get(routeId).length === 0) ?? null
    const blockedBy = [...new Set(walk.chain.flatMap((routeId) => blocked.get(routeId)))].sort(byCodeUnit)

    if (viable === null) {
      findings.push(makeFinding(
        'task-unroutable',
        `Task "${id}" has no usable route: every route in its chain (${walk.chain.map((routeId) => sanitize(routeId, 40)).join(' -> ') || 'none'}) is blocked by ${blockedBy.join(', ') || 'a broken chain'}.`,
        { file: policyFile, pointer: `${pointer}/entry` },
        { task: id, blockedBy },
      ))
    } else {
      const model = policy.routes.get(viable).model
      findings.push(makeFinding(
        'task-routed',
        `Task "${id}" routes through "${viable}" on model "${model}" at an estimated ${routeCosts.get(viable)} per call${viable === task.entry ? '' : `, after ${walk.chain.indexOf(viable)} blocked route(s)`}.`,
        { file: policyFile, pointer: `${pointer}/entry` },
        { task: id, route: viable, model, estimatedCostUsd: routeCosts.get(viable) },
      ))
      if (walk.chain.length === 1) {
        findings.push(makeFinding(
          'fallback-missing',
          `Task "${id}" has a single route and no fallback, so an outage on model "${model}" takes the task with it.`,
          { file: policyFile, pointer: `${pointer}/entry` },
        ))
      }
    }

    taskRows.push({
      id,
      entry: task.entry,
      chain: walk.chain,
      routedVia: viable,
      model: viable === null ? null : policy.routes.get(viable).model,
      estimatedCostUsd: viable === null ? null : routeCosts.get(viable),
      blockedBy,
    })
  }

  for (const id of [...policy.routes.keys()].sort(byCodeUnit)) {
    if (reached.has(id)) continue
    findings.push(makeFinding(
      'route-unreachable',
      `Route "${id}" is entered by no task and reached by no fallback. Dead policy is where stale model ids accumulate.`,
      { file: policyFile, pointer: `/routes/${escapePointerSegment(id)}` },
    ))
  }

  const routable = taskRows.filter((row) => row.routedVia !== null).length
  return finish({
    ...summaryBase,
    checked: policy.routes.size,
    routable,
    unroutable: taskRows.length - routable,
  }, {
    asOf,
    snapshotCapturedAt: snapshotRead.document.capturedAt ?? null,
    tasks: taskRows,
  })
}

export function formatReport(report) {
  const lines = report.findings.map((finding) =>
    `${finding.severity.toUpperCase().padEnd(7)} ${finding.location.file}${finding.location.pointer ?? ''} ${finding.ruleId} ${finding.message}`)
  lines.push('')
  lines.push(
    `${report.summary.checked} of ${report.summary.routes} route(s) checked for ${report.summary.tasks} task(s) `
    + `against ${report.summary.models} model(s): ${report.summary.errors} error, ${report.summary.warnings} warning, `
    + `${report.summary.info} info, status ${report.status}.`,
  )
  if (report.routing === null) {
    lines.push('No routing decision was produced.')
  } else {
    lines.push(`${report.summary.routable} task(s) have a usable route; ${report.summary.unroutable} do not.`)
  }
  if (report.summary.unexamined > 0) {
    lines.push(`${report.summary.unexamined} piece(s) of evidence were not obtained, so this run is incomplete rather than a verdict.`)
  }
  return `${lines.join('\n')}\n`
}
