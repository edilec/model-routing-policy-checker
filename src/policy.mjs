/**
 * The routing policy: tasks, their needs, and the fallback graph.
 *
 * A policy is a small state machine. Each **route** names one model for one
 * task and optionally the route to fall back to; each **task** names the route
 * it enters at. That shape is deliberate: it makes the fallback relation an
 * explicit edge between named nodes rather than an ordered list, which is what
 * lets a cycle be a thing the checker can find instead of a thing the runtime
 * discovers at three in the morning.
 */

import { isRecord } from './document.mjs'
import { ID_PATTERN, NAME_PATTERN } from './snapshot.mjs'
import { byCodeUnit, escapePointerSegment, sanitize } from './text.mjs'

export const POLICY_SCHEMA_VERSION = '1'
export const POLICY_KEYS = Object.freeze(['defaults', 'routes', 'schemaVersion', 'tasks'])
export const DEFAULTS_KEYS = Object.freeze(['maxCostPerCallUsd', 'maxSnapshotAgeDays'])
export const TASK_KEYS = Object.freeze([
  'authority', 'entry', 'expectedInputTokens', 'expectedOutputTokens', 'maxCostPerCallUsd', 'requires',
])
export const REQUIRED_TASK_KEYS = Object.freeze(['entry', 'expectedInputTokens', 'expectedOutputTokens'])
export const ROUTE_KEYS = Object.freeze(['fallbackTo', 'model', 'task'])

function isStringArray(value, pattern) {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string' && pattern.test(entry))
}

/**
 * Validate a parsed policy document.
 *
 * Returns `{ defaults, tasks, routes, problems }`, with tasks and routes
 * ordered by id using code units rather than by the JSON object's own key
 * order. Key order is an accident of how the file was written; a report that
 * depended on it would change when somebody reformatted the policy.
 */
export function validatePolicy(document, file, limits) {
  const problems = []
  const tasks = new Map()
  const routes = new Map()

  const problem = (ruleId, pointer, message, evidence) => {
    problems.push(evidence === undefined
      ? { ruleId, file, pointer, message }
      : { ruleId, file, pointer, message, evidence })
  }

  const defaults = { maxCostPerCallUsd: null, maxSnapshotAgeDays: null }
  if (document.defaults !== undefined) {
    if (!isRecord(document.defaults)) {
      problem('document-malformed', '/defaults', `${file} has a "defaults" that is not an object.`)
    } else {
      for (const key of Object.keys(document.defaults).sort(byCodeUnit)) {
        if (!DEFAULTS_KEYS.includes(key)) {
          problem(
            'document-unknown-key',
            `/defaults/${escapePointerSegment(key)}`,
            `${file} has unknown default "${sanitize(key, 60)}"; defaults accept ${DEFAULTS_KEYS.join(', ')}.`,
          )
        }
      }
      if (document.defaults.maxCostPerCallUsd !== undefined) {
        const value = document.defaults.maxCostPerCallUsd
        if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
          problem('document-malformed', '/defaults/maxCostPerCallUsd', `${file} needs "maxCostPerCallUsd" as a finite number of 0 or more.`)
        } else defaults.maxCostPerCallUsd = value
      }
      if (document.defaults.maxSnapshotAgeDays !== undefined) {
        const value = document.defaults.maxSnapshotAgeDays
        if (!Number.isInteger(value) || value < 0) {
          problem('document-malformed', '/defaults/maxSnapshotAgeDays', `${file} needs "maxSnapshotAgeDays" as an integer of 0 or more.`)
        } else defaults.maxSnapshotAgeDays = value
      }
    }
  }

  if (!isRecord(document.tasks)) {
    problem('document-malformed', '/tasks', `${file} needs a "tasks" object keyed by task id.`)
    return { defaults, tasks, routes, problems }
  }
  if (!isRecord(document.routes)) {
    problem('document-malformed', '/routes', `${file} needs a "routes" object keyed by route id.`)
    return { defaults, tasks, routes, problems }
  }

  const taskIds = Object.keys(document.tasks).sort(byCodeUnit)
  if (taskIds.length > limits.maxTasks) {
    problem('too-many-tasks', '/tasks', `${file} declares ${taskIds.length} tasks, above the maxTasks limit of ${limits.maxTasks}. None were read.`)
    return { defaults, tasks, routes, problems }
  }
  const routeIds = Object.keys(document.routes).sort(byCodeUnit)
  if (routeIds.length > limits.maxRoutes) {
    problem('too-many-routes', '/routes', `${file} declares ${routeIds.length} routes, above the maxRoutes limit of ${limits.maxRoutes}. None were read.`)
    return { defaults, tasks, routes, problems }
  }

  for (const id of taskIds) {
    const pointer = `/tasks/${escapePointerSegment(id)}`
    if (!ID_PATTERN.test(id)) {
      problem('identifier-invalid', pointer, `Task id "${sanitize(id, 80)}" is not a valid identifier.`, sanitize(id, 80))
      continue
    }
    const raw = document.tasks[id]
    if (!isRecord(raw)) {
      problem('task-malformed', pointer, `Task "${id}" must be a JSON object.`)
      continue
    }

    let rejected = false
    const reject = (ruleId, at, message) => {
      problem(ruleId, at, message)
      rejected = true
    }

    for (const key of Object.keys(raw).sort(byCodeUnit)) {
      if (!TASK_KEYS.includes(key)) {
        reject('task-malformed', `${pointer}/${escapePointerSegment(key)}`, `Task "${id}" carries unknown key "${sanitize(key, 60)}"; a task accepts ${TASK_KEYS.join(', ')}.`)
      }
    }
    for (const key of REQUIRED_TASK_KEYS) {
      if (raw[key] === undefined) reject('task-malformed', `${pointer}/${key}`, `Task "${id}" has no "${key}".`)
    }
    if (rejected) continue

    if (typeof raw.entry !== 'string' || !ID_PATTERN.test(raw.entry)) {
      reject('task-malformed', `${pointer}/entry`, `Task "${id}" needs "entry" as a route id.`)
    }
    for (const key of ['expectedInputTokens', 'expectedOutputTokens']) {
      if (!Number.isInteger(raw[key]) || raw[key] < 0) {
        reject('task-malformed', `${pointer}/${key}`, `Task "${id}" needs "${key}" as an integer of 0 or more.`)
      }
    }
    if (raw.requires !== undefined && !isStringArray(raw.requires, NAME_PATTERN)) {
      reject('task-malformed', `${pointer}/requires`, `Task "${id}" has a "requires" that is not an array of capability names.`)
    }
    if (raw.authority !== undefined && !isStringArray(raw.authority, NAME_PATTERN)) {
      reject('task-malformed', `${pointer}/authority`, `Task "${id}" has an "authority" that is not an array of authority names.`)
    }
    if (raw.maxCostPerCallUsd !== undefined
      && (typeof raw.maxCostPerCallUsd !== 'number' || !Number.isFinite(raw.maxCostPerCallUsd) || raw.maxCostPerCallUsd < 0)) {
      reject('task-malformed', `${pointer}/maxCostPerCallUsd`, `Task "${id}" needs "maxCostPerCallUsd" as a finite number of 0 or more.`)
    }
    if (raw.requires !== undefined && raw.requires.length > limits.maxCapabilities) {
      reject('task-malformed', `${pointer}/requires`, `Task "${id}" requires ${raw.requires.length} capabilities, above the maxCapabilities limit of ${limits.maxCapabilities}.`)
    }
    if (rejected) continue

    tasks.set(id, Object.freeze({
      id,
      entry: raw.entry,
      requires: Object.freeze([...new Set(raw.requires ?? [])].sort(byCodeUnit)),
      authority: Object.freeze([...new Set(raw.authority ?? [])].sort(byCodeUnit)),
      expectedInputTokens: raw.expectedInputTokens,
      expectedOutputTokens: raw.expectedOutputTokens,
      maxCostPerCallUsd: raw.maxCostPerCallUsd ?? defaults.maxCostPerCallUsd,
    }))
  }

  for (const id of routeIds) {
    const pointer = `/routes/${escapePointerSegment(id)}`
    if (!ID_PATTERN.test(id)) {
      problem('identifier-invalid', pointer, `Route id "${sanitize(id, 80)}" is not a valid identifier.`, sanitize(id, 80))
      continue
    }
    const raw = document.routes[id]
    if (!isRecord(raw)) {
      problem('route-malformed', pointer, `Route "${id}" must be a JSON object.`)
      continue
    }

    let rejected = false
    const reject = (at, message) => {
      problem('route-malformed', at, message)
      rejected = true
    }

    for (const key of Object.keys(raw).sort(byCodeUnit)) {
      if (!ROUTE_KEYS.includes(key)) {
        reject(`${pointer}/${escapePointerSegment(key)}`, `Route "${id}" carries unknown key "${sanitize(key, 60)}"; a route accepts ${ROUTE_KEYS.join(', ')}.`)
      }
    }
    if (typeof raw.task !== 'string' || !ID_PATTERN.test(raw.task)) {
      reject(`${pointer}/task`, `Route "${id}" needs "task" as a task id.`)
    }
    if (typeof raw.model !== 'string' || !ID_PATTERN.test(raw.model)) {
      reject(`${pointer}/model`, `Route "${id}" needs "model" as a model id.`)
    }
    if (raw.fallbackTo !== undefined && (typeof raw.fallbackTo !== 'string' || !ID_PATTERN.test(raw.fallbackTo))) {
      reject(`${pointer}/fallbackTo`, `Route "${id}" has a "fallbackTo" that is not a route id.`)
    }
    if (rejected) continue

    routes.set(id, Object.freeze({
      id,
      task: raw.task,
      model: raw.model,
      fallbackTo: raw.fallbackTo ?? null,
    }))
  }

  return { defaults, tasks, routes, problems }
}
