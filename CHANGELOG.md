# Changelog

All notable changes to this project are documented here. Rule ids are part of
the public contract: renaming one is a breaking change and is recorded here.

## 0.1.0

First working release.

- Checks each route's model against the task's required capabilities, authority,
  context window, output cap and per-call budget, using a supplied capability
  and pricing snapshot. Nothing is fetched.
- A model the snapshot does not describe, or describes with a required field
  missing, makes the run `incomplete` with no routing decision and exit 2.
- `authorisedFor` is the one optional model field and defaults closed: an
  authority absent from the snapshot is a denial.
- Fallback is a graph. Cycles, dangling fallbacks, fallbacks that change task,
  and unreachable routes are all reported; a cycle fails the run.
- Snapshot age is checked against `--as-of` when the policy sets
  `defaults.maxSnapshotAgeDays`; no clock is read anywhere.
- Per-call cost is rounded once to six decimal places, and the budget is
  compared against the rounded value.
