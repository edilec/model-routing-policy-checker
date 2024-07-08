/**
 * The fallback graph.
 *
 * Fallback is an edge from one named route to another, so the set of routes a
 * task can reach is a walk and not a list. Two things follow, and both are
 * reasons this shape was chosen over an ordered array of models:
 *
 * 1. **A cycle is findable.** `cheap -> mid -> cheap` is a policy that, at
 *    runtime, retries forever under exactly the conditions that made the first
 *    call fail. As a list it is unrepresentable and therefore invisible; as a
 *    graph it is three lines of traversal.
 * 2. **An unreachable route is findable.** A route nobody enters at and nobody
 *    falls back to is dead policy, and dead policy is where stale model ids
 *    accumulate until somebody wires it up again.
 *
 * Every traversal here carries a visited set, so a cyclic policy terminates in
 * the checker even though it would not at runtime. That is the point.
 */

import { byCodeUnit } from './text.mjs'

/**
 * Follow `fallbackTo` from one route, bounded and cycle-safe.
 *
 * Returns the chain in order, and says how it ended: `missing` names a
 * `fallbackTo` that resolves to nothing, `cycle` names the route the walk came
 * back to, `depthExceeded` says the chain ran past the limit. The chain that
 * comes back is always the part that was actually walked -- never a guess about
 * what would have followed.
 */
export function walkChain(start, routes, maxDepth) {
  const chain = []
  const seen = new Set()
  let current = start
  let missing = null
  let cycle = null
  let depthExceeded = false

  while (current !== null) {
    if (!routes.has(current)) {
      missing = current
      break
    }
    if (seen.has(current)) {
      cycle = current
      break
    }
    if (chain.length >= maxDepth) {
      depthExceeded = true
      break
    }
    seen.add(current)
    chain.push(current)
    current = routes.get(current).fallbackTo
  }

  return { chain, missing, cycle, depthExceeded }
}

/**
 * Every route that can reach itself through fallbacks, ordered by code unit.
 *
 * Walked from every route rather than only from the task entries, because a
 * cycle sitting in routes nobody currently enters is a cycle that goes live the
 * moment somebody points an entry at it.
 */
export function routesInCycles(routes) {
  const cyclic = []
  for (const start of [...routes.keys()].sort(byCodeUnit)) {
    const seen = new Set()
    let current = routes.get(start).fallbackTo
    while (current !== null && routes.has(current) && !seen.has(current)) {
      if (current === start) {
        cyclic.push(start)
        break
      }
      seen.add(current)
      current = routes.get(current).fallbackTo
    }
  }
  return cyclic
}
