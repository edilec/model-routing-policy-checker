# Design notes

## Why the snapshot is supplied rather than fetched

A checker that called a provider to find out what a model can do would be a
checker whose verdict depends on the network, the time of day, an API key, and
whatever the provider's documentation said that morning. Two runs on two
machines would disagree, and neither would be reproducible in a month.

So the capabilities and the prices are **evidence the operator brings**, in a
dated document, and the tool's job is to check the policy against that evidence
and to be loud about the evidence's date. That is why `capturedAt` is required,
why `--as-of` exists, and why `snapshot-stale` is `incomplete` rather than
`fail`: an out-of-date snapshot does not make the policy wrong, it makes this
run unable to say.

It is also why there is no built-in model catalogue. A catalogue baked into the
tool would be stale on the day it shipped and would quietly override the
operator's own evidence.

## Why missing metadata is unknown rather than a failure

The three plausible behaviours for a route naming a model the snapshot does not
describe are: approve it, reject it, or refuse to answer. The first is obviously
wrong. The second is tempting and also wrong, because it makes a typo in a model
id indistinguishable from a real capability failure, and because "this policy is
unsound" is a claim about facts the run does not have.

So it is the third. `model-unknown` and `model-metadata-missing` make the whole
run `incomplete`, suppress the routing decision entirely, and exit 2. And it is
the *whole* run rather than that route: a decision computed from the routes that
did resolve looks exactly like a decision computed from a complete snapshot, and
nobody reading it can tell which one they have.

The one deliberate exception is `authorisedFor`. Every other model field is
required and its absence is unknown; that field is optional and its absence is a
**denial**. An authority is a grant, and a tool that treated an ungranted
authority as an unanswered question would let a snapshot route regulated data by
saying nothing about it. Default-deny is the only safe reading, and the README
says so where somebody deciding what to put in a snapshot will read it.

## Why fallback is a graph

Written as an ordered array of models, a fallback cycle is unrepresentable — and
therefore invisible until production, where it becomes an infinite retry loop
under exactly the conditions that made the first call fail.

Written as an edge from one named route to another, it is three lines of
traversal to find. The same shape also makes `route-unreachable` findable, which
matters more than it sounds: dead policy is where stale model ids accumulate
until somebody points an entry at them.

Every traversal carries a visited set, so a cyclic policy terminates inside the
checker even though it would not at runtime. Cycles are searched from **every**
route rather than only from task entries, because a cycle sitting in routes
nobody currently enters goes live the moment somebody wires it up.

## Why price is in the capability message

`capability-unsupported` interpolates the rejected model's price into its own
message. That looks like decoration and is not. The failure mode this rule
exists for is a human argument — "but it was a twentieth of the price" — and
putting the price in the refusal makes the report answer the argument instead of
inviting it. The test asserts the price is there, because a message that quietly
stopped saying it would be a rule that quietly stopped ending the argument.

## Why costs are rounded before they are compared

An unrounded floating-point sum can be `0.010000000000000002` against a budget
of `0.01`. Reporting `0.01` and failing the budget is a bug report nobody can
diagnose from the report, because the report shows two numbers that agree.

So `roundCost` runs once, to six decimal places, and the budget is compared
against the rounded value. The number in the report and the number in the
verdict are the same number.

## Why the date parser round-trips

`Date.UTC(2026, 1, 30)` does not fail; it rolls forward into March. A date
parser that trusts it accepts `2026-02-30` and silently measures snapshot age
from a day that does not exist. The only way to know the caller wrote a real
date is to format the result back and compare, which is what `parseDate` does.

No clock is read anywhere in `src/` or `bin/`. The only two dates the tool
handles are the one in the snapshot and the one the caller passes.

## Why there are seven `document-*` rules rather than fourteen

Both inputs are read through the same path, so both get the same seven failure
rules and `location.file` says which document failed. A `policy-not-json` and a
`snapshot-not-json` would double the rule table to restate something the
location already carries.

## What is guarded, and how

Each of these is a guarantee with a test that fails when the guarantee is
removed, rather than a test that checks a declaration about it:

| Guarantee | Guarded by |
| --- | --- |
| A cheap but unsupported model is rejected | `test/acceptance.test.mjs` routes a model six hundred times cheaper than the capable one and asserts exit 1, plus that the price appears in the refusal |
| Missing model metadata is unknown | a sweep deleting each required field in turn, asserting exit 2, `routing: null`, and that no task is reported routed *or* unroutable |
| Cyclic fallback rules fail | two-route, three-route and unreachable cycles, each asserting exit 1 |
| Unknown evidence is never a pass | `test/incomplete.test.mjs` plus one outcome test per rule |
| Severity is not editable by hand | `test/severity-outcomes.test.mjs` writes every expectation as a literal at the assertion site and asserts exit codes |
| Ordering is by code unit | `test/ordering.test.mjs` uses ids and file names that code-unit and collation order differently, and asserts the fixture actually distinguishes them |
| Control characters never reach output | `test/sanitisation.test.mjs` crosses five character classes with ten document surfaces, identifiers included |
| A parse failure never reproduces the document | `test/parse-failure.test.mjs`, including the `at position 1` case and a wording only the backstop catches |
| Documents stay inside the root | `test/confinement.test.mjs` plants a real symlink out of the root |
| Every documented limit bites | `test/limits.test.mjs` drives each as a flag and asserts the flag list covers `DEFAULT_LIMITS` |

## Bounds

Limits are part of the contract rather than a safety net, so each is named in
the finding that reports it and each is reachable from the command line.
`timeoutMs` accepts 0, which means no time at all — the only way to prove from
outside the process that the flag reaches the evaluation loop, and a documented
limit the command line never reaches is a defect this catalog has already
shipped once.
