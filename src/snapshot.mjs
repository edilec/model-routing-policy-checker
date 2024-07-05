/**
 * The capability and pricing snapshot.
 *
 * The snapshot is **supplied**, never fetched. This tool makes no provider
 * call, at any time, including in its tests: what a model can do and what it
 * costs is evidence the operator brings, dated, and this file's job is to check
 * that the evidence is complete enough to reason from.
 *
 * That last clause is the whole design. A model a route names but the snapshot
 * does not describe is not a cheap model, an expensive model or an unsuitable
 * one -- it is an **unknown** model, and a routing policy cannot be approved
 * against a model nobody has any facts about. Same for a model the snapshot
 * lists with a field missing. Both make the run incomplete rather than
 * producing a verdict.
 */

import { isRecord } from './document.mjs'
import { byCodeUnit, escapePointerSegment, sanitize } from './text.mjs'

export const SNAPSHOT_SCHEMA_VERSION = '1'
export const SNAPSHOT_KEYS = Object.freeze(['capturedAt', 'models', 'schemaVersion'])

/**
 * Every field a model entry must carry, and the shape it must have.
 *
 * All six are required. A snapshot that omits `maxOutputTokens` for one model
 * is not a snapshot that permits any output length, it is a snapshot that does
 * not say -- and "does not say" is the one answer this tool refuses to treat as
 * permission.
 */
export const MODEL_KEYS = Object.freeze([
  'authorisedFor', 'capabilities', 'inputPricePerMillion', 'maxContextTokens',
  'maxOutputTokens', 'outputPricePerMillion', 'status',
])
export const REQUIRED_MODEL_KEYS = Object.freeze([
  'capabilities', 'inputPricePerMillion', 'maxContextTokens',
  'maxOutputTokens', 'outputPricePerMillion', 'status',
])

export const MODEL_STATUSES = Object.freeze(['available', 'deprecated', 'retired'])

export const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/
export const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/

const DATE = /^\d{4}-\d{2}-\d{2}$/

/**
 * A calendar date as a UTC day number, or null.
 *
 * The round trip is what rejects `2026-02-30`: `Date.UTC` rolls it forward to
 * March instead of refusing, so the only way to know the caller wrote a real
 * date is to format the result back and compare. No clock is read here -- the
 * only dates this tool handles are the one in the snapshot and the one the
 * caller passes as `--as-of`.
 */
export function parseDate(value) {
  if (typeof value !== 'string' || !DATE.test(value)) return null
  const [year, month, day] = value.split('-').map(Number)
  const stamp = Date.UTC(year, month - 1, day)
  if (!Number.isFinite(stamp)) return null
  const formatted = new Date(stamp).toISOString().slice(0, 10)
  return formatted === value ? stamp : null
}

export const MILLISECONDS_PER_DAY = 86400000

function isStringArray(value, pattern) {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string' && pattern.test(entry))
}

/**
 * Validate a parsed snapshot document.
 *
 * Returns `{ capturedAt, models, problems }`. `models` holds only the entries
 * complete enough to reason from; every other model id is reported and is then
 * *unknown*, not absent.
 */
export function validateSnapshot(document, file, limits) {
  const problems = []
  const models = new Map()
  const declared = []

  const problem = (ruleId, pointer, message, evidence) => {
    problems.push(evidence === undefined
      ? { ruleId, file, pointer, message }
      : { ruleId, file, pointer, message, evidence })
  }

  if (!isRecord(document.models)) {
    problem('document-malformed', '/models', `${file} needs a "models" object keyed by model id.`)
    return { capturedAt: null, models, declared, problems }
  }

  const capturedAt = parseDate(document.capturedAt)
  if (capturedAt === null) {
    problem(
      'document-malformed',
      '/capturedAt',
      `${file} needs a "capturedAt" date in YYYY-MM-DD form; a capability snapshot with no date cannot be judged current.`,
    )
  }

  const ids = Object.keys(document.models).sort(byCodeUnit)
  if (ids.length > limits.maxModels) {
    problem(
      'too-many-models',
      '/models',
      `${file} describes ${ids.length} models, above the maxModels limit of ${limits.maxModels}. None were read.`,
    )
    return { capturedAt, models, declared, problems }
  }

  for (const id of ids) {
    const pointer = `/models/${escapePointerSegment(id)}`
    if (!ID_PATTERN.test(id)) {
      problem(
        'identifier-invalid',
        pointer,
        `Model id "${sanitize(id, 80)}" is not a valid identifier; ids are 1-80 characters of letters, digits, dot, dash, colon or underscore and start with a letter or digit.`,
        sanitize(id, 80),
      )
      continue
    }
    declared.push(id)
    const raw = document.models[id]
    if (!isRecord(raw)) {
      problem('model-malformed', pointer, `Model "${id}" must be a JSON object.`)
      continue
    }

    let rejected = false
    const reject = (ruleId, at, message) => {
      problem(ruleId, at, message)
      rejected = true
    }

    for (const key of Object.keys(raw).sort(byCodeUnit)) {
      if (!MODEL_KEYS.includes(key)) {
        reject(
          'model-malformed',
          `${pointer}/${escapePointerSegment(key)}`,
          `Model "${id}" carries unknown key "${sanitize(key, 60)}"; a model entry accepts ${MODEL_KEYS.join(', ')}.`,
        )
      }
    }

    for (const key of REQUIRED_MODEL_KEYS) {
      if (raw[key] === undefined) {
        reject(
          'model-metadata-missing',
          `${pointer}/${key}`,
          `Model "${id}" has no "${key}". A missing fact about a model is unknown, never permission: no route may be approved against it.`,
        )
      }
    }
    if (rejected) continue

    if (!isStringArray(raw.capabilities, NAME_PATTERN)) {
      reject('model-malformed', `${pointer}/capabilities`, `Model "${id}" needs "capabilities" as an array of capability names.`)
    }
    if (raw.authorisedFor !== undefined && !isStringArray(raw.authorisedFor, NAME_PATTERN)) {
      reject('model-malformed', `${pointer}/authorisedFor`, `Model "${id}" has an "authorisedFor" that is not an array of authority names.`)
    }
    for (const key of ['maxContextTokens', 'maxOutputTokens']) {
      if (!Number.isInteger(raw[key]) || raw[key] < 1) {
        reject('model-malformed', `${pointer}/${key}`, `Model "${id}" needs "${key}" as an integer of 1 or more.`)
      }
    }
    for (const key of ['inputPricePerMillion', 'outputPricePerMillion']) {
      if (typeof raw[key] !== 'number' || !Number.isFinite(raw[key]) || raw[key] < 0) {
        reject('model-malformed', `${pointer}/${key}`, `Model "${id}" needs "${key}" as a finite number of 0 or more.`)
      }
    }
    if (typeof raw.status !== 'string' || !MODEL_STATUSES.includes(raw.status)) {
      reject(
        'model-malformed',
        `${pointer}/status`,
        `Model "${id}" has status "${sanitize(String(raw.status), 40)}"; status must be one of ${MODEL_STATUSES.join(', ')}.`,
      )
    }
    if (rejected) continue

    models.set(id, Object.freeze({
      id,
      capabilities: Object.freeze([...new Set(raw.capabilities)].sort(byCodeUnit)),
      // Absent means no authority granted, not unknown authority. An authority
      // is a grant, and the absence of a grant is a denial -- the alternative
      // is a snapshot that omits the field routing every task it likes.
      authorisedFor: Object.freeze([...new Set(raw.authorisedFor ?? [])].sort(byCodeUnit)),
      maxContextTokens: raw.maxContextTokens,
      maxOutputTokens: raw.maxOutputTokens,
      inputPricePerMillion: raw.inputPricePerMillion,
      outputPricePerMillion: raw.outputPricePerMillion,
      status: raw.status,
    }))
  }

  return { capturedAt, models, declared, problems }
}

/** Cost of one call, in whatever currency the snapshot's prices are in. */
export function estimateCallCost(model, task) {
  const raw = (task.expectedInputTokens / 1000000) * model.inputPricePerMillion
    + (task.expectedOutputTokens / 1000000) * model.outputPricePerMillion
  return roundCost(raw)
}

/**
 * Round to six decimal places, and compare budgets against the *rounded* value.
 *
 * Reporting 0.010000 and then failing a budget of 0.01 because the unrounded
 * sum was 0.010000000000000002 is a bug report waiting to happen, and the
 * operator cannot see the difference from the report. So the number in the
 * report and the number in the comparison are the same number.
 */
export function roundCost(value) {
  return Math.round(value * 1000000) / 1000000
}
