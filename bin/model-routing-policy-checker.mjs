#!/usr/bin/env node

import { checkRouting, formatReport, loadConfigFile } from '../src/index.mjs'

const HELP = `model-routing-policy-checker

Check a model routing policy against a supplied capability and pricing
snapshot: can each route's model actually do what the task needs, is it
authorised for the task's data, does it fit the context and the budget, and
does the fallback graph terminate.

Nothing is fetched. The snapshot is evidence you supply and date; this tool
makes no provider call, at any time.

Usage:
  model-routing-policy-checker --policy FILE --snapshot FILE
                               [--root DIR] [--config FILE] [--as-of DATE]
                               [--json] [limits]

Options:
  --policy FILE            Routing policy to check (required)
  --snapshot FILE          Capability and pricing snapshot (required)
  --root DIR               Root every reported path is relative to
                           (default: the directory holding the policy)
  --config FILE            JSON configuration: asOf, limits
  --as-of DATE             The date to judge the snapshot's age against,
                           YYYY-MM-DD. Required when the policy sets
                           defaults.maxSnapshotAgeDays; there is no clock
                           reading, so the date is always supplied.
  --json                   Emit the machine-readable report on stdout
  --max-capabilities N     Maximum capabilities one task may require (default 32)
  --max-document-bytes N   Maximum size of either document (default 1048576)
  --max-fallback-depth N   Maximum routes in one fallback chain (default 8)
  --max-models N           Maximum models in a snapshot (default 500)
  --max-routes N           Maximum routes in a policy (default 500)
  --max-tasks N            Maximum tasks in a policy (default 200)
  --timeout-ms N           Time budget for the run (default 10000; 0 leaves no
                           time at all and is only useful for proving the
                           budget is enforced)
  -h, --help               Show this help

What this tool refuses:

  - A cheap model that cannot do the work. Price never rescues capability, and
    the finding says so with the price attached.
  - A model the snapshot does not describe, or describes with a field missing.
    That is unknown, not permission: the run goes incomplete, produces no
    routing decision at all, and exits 2.
  - A fallback graph with a cycle, which at runtime retries forever under
    exactly the conditions that made the first call fail.
  - A model not granted the authority a task needs. An authority absent from
    the snapshot is a denial, not an omission.

Every option is accepted once; a repeated flag is a configuration error rather
than a silent last-wins. An unknown option is refused rather than ignored.

Exit codes:
  0  both documents were read and the policy is sound against the snapshot
  1  both documents were read and the policy is not sound
  2  invalid usage or configuration (no report on stdout), or evidence that was
     missing, undecodable, stale or bounded out (an "incomplete" report on
     stdout)
`

const LIMIT_FLAGS = new Map([
  ['--max-capabilities', 'maxCapabilities'],
  ['--max-document-bytes', 'maxDocumentBytes'],
  ['--max-fallback-depth', 'maxFallbackDepth'],
  ['--max-models', 'maxModels'],
  ['--max-routes', 'maxRoutes'],
  ['--max-tasks', 'maxTasks'],
  ['--timeout-ms', 'timeoutMs'],
])

function parseArguments(argv) {
  if (argv.includes('-h') || argv.includes('--help')) return { help: true }
  const options = { policy: null, snapshot: null, root: null, config: null, asOf: null, json: false, limits: {} }
  const given = new Set()

  /**
   * A flag that carries a value is accepted once.
   *
   * Letting it repeat discards the earlier value with no diagnostic, so
   * `--snapshot last-year.json --snapshot today.json` checks against a snapshot
   * nobody chose. That is the same defect as an ignored typo, which this tool
   * already refuses.
   */
  const once = (name) => {
    if (given.has(name)) throw new Error(`${name} was given more than once`)
    given.add(name)
  }

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    const takeValue = (name) => {
      const value = argv[index + 1]
      if (value === undefined || value.startsWith('-')) throw new Error(`${name} requires a value`)
      index += 1
      return value
    }

    if (argument === '--json') {
      once('--json')
      options.json = true
    } else if (argument === '--policy') {
      once('--policy')
      options.policy = takeValue('--policy')
    } else if (argument === '--snapshot') {
      once('--snapshot')
      options.snapshot = takeValue('--snapshot')
    } else if (argument === '--root') {
      once('--root')
      options.root = takeValue('--root')
    } else if (argument === '--config') {
      once('--config')
      options.config = takeValue('--config')
    } else if (argument === '--as-of') {
      once('--as-of')
      options.asOf = takeValue('--as-of')
    } else if (LIMIT_FLAGS.has(argument)) {
      once(argument)
      const raw = takeValue(argument)
      const minimum = argument === '--timeout-ms' ? 0 : 1
      if (!/^\d+$/.test(raw) || Number(raw) < minimum) {
        throw new Error(`${argument} requires an integer of ${minimum} or more`)
      }
      options.limits[LIMIT_FLAGS.get(argument)] = Number(raw)
    } else throw new Error(`Unknown option "${argument}"`)
  }

  for (const name of ['policy', 'snapshot']) {
    if (options[name] === null) throw new Error(`--${name} is required`)
  }
  return options
}

async function main(argv) {
  let options
  try {
    options = parseArguments(argv)
  } catch (error) {
    process.stderr.write(`${error.message}\n\n${HELP}`)
    return 2
  }
  if (options.help) {
    process.stdout.write(HELP)
    return 0
  }

  let config = { asOf: null, limits: {} }
  if (options.config !== null) {
    try {
      config = await loadConfigFile(options.config)
    } catch (error) {
      process.stderr.write(`--config is not usable: ${error.message}\n`)
      return 2
    }
  }
  const asOf = options.asOf ?? config.asOf

  let report
  try {
    report = await checkRouting({
      policy: options.policy,
      snapshot: options.snapshot,
      ...(options.root === null ? {} : { root: options.root }),
      ...(asOf === null || asOf === undefined ? {} : { asOf }),
      limits: { ...config.limits, ...options.limits },
    })
  } catch (error) {
    process.stderr.write(`${error.message}\n`)
    return 2
  }

  // Which snapshot the verdict rests on is a diagnostic, not data: it goes to
  // stderr so stdout stays parseable, but it is never left unsaid, because a
  // policy approved against last year's capabilities is exactly the run whose
  // verdict somebody will quote later.
  process.stderr.write(
    `snapshot ${report.summary.models} model(s)`
    + `${report.routing?.snapshotCapturedAt ? ` captured ${report.routing.snapshotCapturedAt}` : ''}`
    + `${asOf === null || asOf === undefined ? '' : `, judged as of ${asOf}`}\n`,
  )

  process.stdout.write(options.json ? `${JSON.stringify(report, null, 2)}\n` : formatReport(report))

  if (report.status === 'incomplete') {
    process.stderr.write(
      `incomplete: ${report.summary.unexamined} piece(s) of evidence were not obtained, so no routing decision was produced.\n`,
    )
    return 2
  }
  return report.status === 'fail' ? 1 : 0
}

process.exitCode = await main(process.argv.slice(2))
