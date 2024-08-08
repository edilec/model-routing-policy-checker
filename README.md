# Model Routing Policy Checker

Check a model routing policy against a capability and pricing snapshot you
supply: can each route's model actually do what the task needs, is it authorised
for the task's data, does it fit the context and the budget, and does the
fallback graph terminate.

- **Repository:** [edilec/model-routing-policy-checker](https://github.com/edilec/model-routing-policy-checker)
- **Area:** Prompt & Agent Workflows
- **License:** MIT

## What it does

You give it two JSON documents. A **snapshot** says what each model can do, what
it costs, how much context it has and what data it is authorised for, and when
those facts were captured. A **policy** says what each task needs and which
model each route sends it to, with an explicit fallback edge from one route to
the next.

It answers one question: **is this policy sound against this snapshot?** Exit 0
if it is, 1 if it is not, 2 if the evidence was not good enough to say.

**Nothing is fetched.** The snapshot is evidence you supply and date. This tool
makes no provider call, at any time, including in its tests.

## Why it exists

Routing policies fail in ways that are cheap to check and expensive to discover:

1. **The cheap model cannot do the work.** Somebody routed a tool-calling task
   to a text-only model because it was a twentieth of the price. The policy
   looks like a cost win and the task silently degrades. This tool rejects that
   route and puts the price in the message, because "but it was cheaper" is the
   argument the check exists to end.
2. **Nobody knows what the model can do.** The route names a model that is not
   in the snapshot, or is in it with a field missing. The tempting behaviour is
   to let it through. Here that is `incomplete`, no routing decision at all, and
   exit 2 — an unknown model is never approved and never rejected.
3. **The fallback graph has a cycle.** `cheap -> mid -> cheap` retries forever
   at runtime under exactly the conditions that made the first call fail. As an
   ordered list of models that state is unrepresentable and therefore invisible;
   as a graph it is three lines of traversal.
4. **Authority is assumed rather than granted.** A task touching customer data
   is routed to a model nobody authorised for it, because the snapshot simply
   did not mention the subject. Here an absent grant is a denial.

The approach is informed by two upstream projects, neither a dependency and
neither with any code here. [ajv-validator/ajv][ajv] is why every document key
is declared and an unknown one is refused rather than ignored — though nothing
is installed and the validation is written out by hand.
[statelyai/xstate][xstate] is why fallback is an edge between named states
rather than an array index, which is what makes a cycle findable.

[ajv]: https://github.com/ajv-validator/ajv
[xstate]: https://github.com/statelyai/xstate

## Quick start

```bash
# Check the worked example: passes, exits 0
node bin/model-routing-policy-checker.mjs \
  --policy examples/routing-policy.json \
  --snapshot examples/snapshot.json \
  --config examples/checker.config.json

# The same run as machine-readable JSON
node bin/model-routing-policy-checker.mjs \
  --policy examples/routing-policy.json \
  --snapshot examples/snapshot.json \
  --as-of 2026-09-14 --json

# A policy with a cheap-but-unsupported primary and a fallback cycle: exits 1
node bin/model-routing-policy-checker.mjs \
  --policy examples/broken-policy.json \
  --snapshot examples/snapshot.json

# Everything: lint, tests, both examples, packaging
npm run check
```

## The snapshot

```json
{
  "schemaVersion": "1",
  "capturedAt": "2026-09-01",
  "models": {
    "compact-mini": {
      "capabilities": ["text"],
      "maxContextTokens": 32768,
      "maxOutputTokens": 4096,
      "inputPricePerMillion": 0.25,
      "outputPricePerMillion": 1.25,
      "authorisedFor": ["internal"],
      "status": "available"
    }
  }
}
```

| Key | Required | Meaning |
| --- | --- | --- |
| `capabilities` | yes | Capability names this model supports. |
| `maxContextTokens` | yes | Total context window, in tokens. |
| `maxOutputTokens` | yes | Largest reply the model will produce. |
| `inputPricePerMillion` | yes | Price per million input tokens. |
| `outputPricePerMillion` | yes | Price per million output tokens. |
| `status` | yes | `available`, `deprecated` or `retired`. |
| `authorisedFor` | no | Authority names granted to this model. **Absent means none.** |

All six required fields must be present for every model. A snapshot that omits
`maxOutputTokens` for one model is not a snapshot permitting any output length,
it is a snapshot that does not say — and "does not say" is the one answer this
tool refuses to treat as permission.

`authorisedFor` is the single optional field, and it **defaults closed**. An
authority is a grant; the absence of a grant is a denial. The alternative would
be a snapshot that omits the field routing every task it likes.

## The policy

```json
{
  "schemaVersion": "1",
  "defaults": { "maxSnapshotAgeDays": 30 },
  "tasks": {
    "answer-with-tools": {
      "requires": ["text", "tool-calling"],
      "authority": ["internal", "customer-data"],
      "expectedInputTokens": 12000,
      "expectedOutputTokens": 1500,
      "maxCostPerCallUsd": 0.3,
      "entry": "tools-mid"
    }
  },
  "routes": {
    "tools-mid": { "task": "answer-with-tools", "model": "standard-mid", "fallbackTo": "tools-large" },
    "tools-large": { "task": "answer-with-tools", "model": "flagship-large" }
  }
}
```

A task requires `entry`, `expectedInputTokens` and `expectedOutputTokens`;
`requires`, `authority` and `maxCostPerCallUsd` are optional, and the last falls
back to `defaults.maxCostPerCallUsd`. A route requires `task` and `model`;
`fallbackTo` is optional and names another route.

## What is checked

| Check | Fails when |
| --- | --- |
| Capability | the model does not support something the task requires |
| Context | `maxContextTokens` is below `expectedInputTokens + expectedOutputTokens` |
| Output | `maxOutputTokens` is below `expectedOutputTokens` |
| Authority | the task needs an authority the model is not granted |
| Budget | the estimated per-call cost is above the task's limit |
| Lifecycle | the snapshot marks the model retired |
| Fallback shape | the chain cycles, dangles, or changes task mid-chain |
| Reachability | a route no task enters and no fallback reaches |
| Snapshot age | the snapshot is older than `defaults.maxSnapshotAgeDays` |

Cost is `expectedInputTokens / 1e6 * inputPricePerMillion + expectedOutputTokens
/ 1e6 * outputPricePerMillion`, rounded to six decimal places. The budget is
compared against the **rounded** value, so the number in the report and the
number in the verdict are the same number. **It is an estimate from the task's
own declared token counts, not a bill.**

Snapshot age needs a date to measure against, and this tool never reads a clock.
So a policy that sets `defaults.maxSnapshotAgeDays` and is given no `--as-of` is
a configuration error rather than a check that quietly does nothing.

## Rules

Every finding takes its severity from one frozen table in `src/index.mjs`. An
unknown rule id throws rather than defaulting.

| Rule | Severity | Incomplete | Meaning |
| --- | --- | :---: | --- |
| `authority-not-granted` | error | | The model is not granted an authority the task needs. |
| `budget-exceeded` | error | | Estimated per-call cost is above the task's limit. |
| `capability-unsupported` | error | | The model does not support a required capability. |
| `context-too-small` | error | | The context window is below what the task expects to use. |
| `document-malformed` | error | yes | A document, or a required section of it, has the wrong shape. |
| `document-not-json` | error | yes | A document did not parse. |
| `document-not-utf8` | error | yes | A document is not valid UTF-8. |
| `document-schema-unsupported` | error | yes | `schemaVersion` is not `"1"`. |
| `document-too-large` | error | yes | Above `maxDocumentBytes`; not read. |
| `document-unknown-key` | error | yes | A key this tool does not define. |
| `document-unreadable` | error | yes | A document could not be opened. |
| `fallback-cycle` | error | | A route can fall back to itself. |
| `fallback-depth-exceeded` | error | yes | A chain is longer than `maxFallbackDepth`. |
| `fallback-missing` | warning | | A task has one route and no fallback. |
| `fallback-task-mismatch` | error | | A fallback serves a different task. |
| `fallback-unknown` | error | | `fallbackTo` names no declared route. |
| `identifier-invalid` | error | yes | A model, task or route id breaks the identifier rule. |
| `model-deprecated` | warning | | The snapshot marks the model deprecated. It still routes. |
| `model-malformed` | error | yes | A model field has the wrong type or an unknown key. |
| `model-metadata-missing` | error | yes | A model entry has no value for a required field. |
| `model-retired` | error | | The snapshot marks the model retired. |
| `model-unknown` | error | yes | A route names a model the snapshot does not usably describe. |
| `no-routes` | warning | yes | The policy declares no usable routes. |
| `output-cap-too-small` | error | | The output cap is below what the task expects. |
| `route-malformed` | error | yes | A route field has the wrong type or an unknown key. |
| `route-task-unknown` | error | | A route serves a task the policy does not declare. |
| `route-unreachable` | warning | | No task enters this route and no fallback reaches it. |
| `snapshot-not-comparable` | error | yes | The snapshot is dated after the supplied `--as-of`. |
| `snapshot-stale` | error | yes | The snapshot is older than the policy allows. |
| `task-entry-unknown` | error | | A task enters at a route the policy does not declare. |
| `task-malformed` | error | yes | A task field has the wrong type or an unknown key. |
| `task-routed` | info | | Which route and model a task actually uses, and at what cost. |
| `task-unroutable` | error | | Every route in the task's chain is blocked. |
| `time-budget-exceeded` | error | yes | `timeoutMs` expired. |
| `too-many-models` | error | yes | Above `maxModels`. |
| `too-many-routes` | error | yes | Above `maxRoutes`. |
| `too-many-tasks` | error | yes | Above `maxTasks`. |

"Incomplete" means the rule marks the run `incomplete`, suppresses the routing
decision entirely, and exits 2 — whatever else the run found.

`snapshot-stale` is deliberately in that column rather than among the failures.
A snapshot older than the policy allows is not evidence that the policy is
wrong; it is evidence about models as they were, and the honest answer to "is
this policy sound today" is that the run cannot tell.

## Exit codes

| Code | Meaning | stdout |
| ---: | --- | --- |
| `0` | Both documents were read and the policy is sound. | the report |
| `1` | Both documents were read and the policy is not sound. | the report |
| `2` | Invalid usage or configuration — the run never had a subject. | **empty** |
| `2` | Evidence missing, undecodable, stale or bounded out. | an `incomplete` report |

A consumer piping stdout must handle the empty case. Emitting a fake report for
a run that never started would be worse.

stdout carries exactly one of the two renderings of the report and nothing else;
stderr carries diagnostics — how many models the snapshot held, when it was
captured, what date it was judged against, and whether the run was incomplete.

## Limits

Every limit is enforced, overridable from the command line, and named in the
finding when it is reached. Exceeding one is an `incomplete` result with no
routing decision.

| Limit | Flag | Default |
| --- | --- | ---: |
| `maxCapabilities` | `--max-capabilities` | 32 |
| `maxDocumentBytes` | `--max-document-bytes` | 1048576 |
| `maxFallbackDepth` | `--max-fallback-depth` | 8 |
| `maxModels` | `--max-models` | 500 |
| `maxRoutes` | `--max-routes` | 500 |
| `maxTasks` | `--max-tasks` | 200 |
| `timeoutMs` | `--timeout-ms` | 10000 |

`timeoutMs` accepts 0, and 0 means no time at all: the first check fires. That
is how the flag is proved to be wired through from outside the process.

An unknown limit name, an unknown configuration key and an unknown command-line
option are all refused rather than ignored.

## Non-goals

This tool deliberately does not:

- **Fetch anything.** No provider call, no model list, no price lookup, at any
  time, including in the tests. The snapshot is yours to produce and to date.
- **Know which models exist.** It has no built-in model catalogue and no
  opinion about any named model. Everything it knows comes from your snapshot.
- **Predict a bill.** The cost figure is the task's own declared token counts
  against the snapshot's prices. Real traffic, caching, retries, batching and
  tool round-trips are not in the policy and are not counted.
- **Measure quality.** It checks that a model *can* do the work, never that it
  does it well. No benchmark, no eval, no score.
- **Choose a policy for you.** It checks the policy you wrote; it does not
  suggest a cheaper route or reorder a fallback chain.
- **Execute or simulate routing.** It reads two documents. It calls nothing,
  runs nothing and changes nothing on disk.
- **Read a clock.** Snapshot age is measured against the date you pass as
  `--as-of`, so the same documents and the same date always give the same
  verdict on every machine, forever.

## Layout

- `src/text.mjs` — decoding, ordering, sanitising, the parse-failure helper
- `src/document.mjs` — reading, bounding and parsing one input document
- `src/snapshot.mjs` — snapshot validation, dates, cost arithmetic
- `src/policy.mjs` — task and route validation
- `src/graph.mjs` — fallback chains, cycles, reachability
- `src/index.mjs` — the rule table, limits, the entry point, the report
- `bin/model-routing-policy-checker.mjs` — the command line
- `docs/design.md` — the decisions behind the above
- `examples/` — a snapshot, a sound policy, and a broken one

## Verification

```bash
npm run check   # lint, tests, both examples, npm pack --dry-run
```

The suite is written against the guarantees above rather than around them.
`test/severity-outcomes.test.mjs` drives every rule through the real command
line and asserts the exit code, so a severity cannot be flipped by editing a
table. `test/acceptance.test.mjs` proves the cheapest model in a snapshot is
still rejected for work it cannot do, that a model with any one field missing
produces no verdict at all, and that a cycle fails even among routes no task
enters. `test/ordering.test.mjs` uses ids and file names whose code-unit order
differs from collation order and asserts the exact emitted sequence.

## License

MIT. See [LICENSE](./LICENSE).
