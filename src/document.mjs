/**
 * Reading one JSON input document, with bounds, strictly.
 *
 * Both inputs -- the capability/pricing snapshot and the routing policy -- are
 * read through here, so neither gets a weaker path than the other. Every
 * failure comes back as a problem carrying the document's relative name rather
 * than as an exception, because a document that could not be read is a fact
 * about the run's subject and belongs in the report.
 */

import { readFile, stat } from 'node:fs/promises'

import { byCodeUnit, decodeUtf8, escapePointerSegment, parseFailureDetail, sanitize } from './text.mjs'

/**
 * The document-level rules, shared by both inputs.
 *
 * One set rather than a `policy-*` and a `snapshot-*` copy of each: which
 * document failed is what `location.file` is for, and duplicating seven rules
 * to restate it would double the rule table without adding an answer.
 */
export const DOCUMENT_RULES = Object.freeze([
  'document-malformed',
  'document-not-json',
  'document-not-utf8',
  'document-schema-unsupported',
  'document-too-large',
  'document-unknown-key',
  'document-unreadable',
])

/**
 * Read, bound, decode and parse one document.
 *
 * Returns `{ document }` or `{ problem }`. Size is checked before the read, so
 * an oversized file is never pulled into memory to be measured.
 */
export async function readJsonDocument(path, file, maxBytes) {
  let info
  try {
    info = await stat(path)
  } catch (error) {
    return {
      problem: {
        ruleId: 'document-unreadable',
        file,
        message: `${file} could not be inspected (${sanitize(String(error.code ?? 'unreadable'), 40)}).`,
      },
    }
  }
  if (!info.isFile()) {
    return { problem: { ruleId: 'document-unreadable', file, message: `${file} is not a regular file.` } }
  }
  if (info.size > maxBytes) {
    return {
      problem: {
        ruleId: 'document-too-large',
        file,
        message: `${file} is ${info.size} bytes, above the limit of ${maxBytes}. It was not read, so this run has no evidence from it.`,
      },
    }
  }

  let bytes
  try {
    bytes = await readFile(path)
  } catch (error) {
    return {
      problem: {
        ruleId: 'document-unreadable',
        file,
        message: `${file} could not be read (${sanitize(String(error.code ?? 'unreadable'), 40)}).`,
      },
    }
  }

  const decoded = decodeUtf8(bytes)
  if (!decoded.ok) {
    return {
      problem: {
        ruleId: 'document-not-utf8',
        file,
        message: `${file} is not valid UTF-8, so it could not be decoded. The decoder decides this; the decoded text never gets a vote.`,
      },
    }
  }

  try {
    return { document: JSON.parse(decoded.text) }
  } catch (error) {
    return {
      problem: {
        ruleId: 'document-not-json',
        file,
        // The detail never reproduces the document: see parseFailureDetail.
        message: `${file} is not valid JSON: ${sanitize(parseFailureDetail(error), 120)}.`,
      },
    }
  }
}

export function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Check a document's envelope: an object, the right schemaVersion, no unknown
 * top-level key.
 *
 * An unknown key is refused rather than ignored. Accepting `models` next to a
 * misspelled `model` would check a snapshot that is missing most of itself, and
 * the run would look like it passed.
 */
export function checkEnvelope(document, { file, schemaVersion, keys }) {
  const problems = []
  if (!isRecord(document)) {
    return [{ ruleId: 'document-malformed', file, pointer: '', message: `${file} must be a JSON object.` }]
  }
  if (document.schemaVersion !== schemaVersion) {
    problems.push({
      ruleId: 'document-schema-unsupported',
      file,
      pointer: '/schemaVersion',
      message: `${file} declares schemaVersion "${sanitize(String(document.schemaVersion ?? 'missing'), 40)}"; this tool reads version ${schemaVersion}.`,
    })
  }
  // Explicitly by code unit. `Array.prototype.sort` with no comparator happens
  // to compare code units too, but relying on that leaves nothing in the source
  // saying the ordering was a decision.
  for (const key of Object.keys(document).sort(byCodeUnit)) {
    if (keys.includes(key)) continue
    problems.push({
      ruleId: 'document-unknown-key',
      file,
      pointer: `/${escapePointerSegment(key)}`,
      message: `${file} carries unknown key "${sanitize(key, 60)}"; it accepts ${keys.join(', ')}. A misspelled key that is ignored turns a real constraint into no constraint at all.`,
    })
  }
  return problems
}
