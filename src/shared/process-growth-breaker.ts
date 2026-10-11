// Pure, clock-injected breaker over descendant process counts. Each scope is one
// terminal's process tree (today: one agent per PTY); the host total covers them all.
// Why per scope: a per-agent OS ceiling can later act on exactly the scope that tripped.

export type ProcessGrowthSample = {
  atMs: number
  /** Descendants of the whole host, or null when the table could not be read. */
  hostDescendants: number | null
  scopes: ReadonlyMap<string, number>
}

export type ProcessGrowthLimits = {
  hostCriticalDescendants: number
  /** New descendants per second, per scope or host-wide, that count as a storm. */
  growthPerSecond: number
  /** How long the growth rate must hold before it trips. */
  sustainMs: number
}

export const DEFAULT_PROCESS_GROWTH_LIMITS: ProcessGrowthLimits = {
  hostCriticalDescendants: 1500,
  growthPerSecond: 40,
  sustainMs: 10_000
}

export type ProcessGrowthTrip = {
  /** null: the host total; otherwise the scope whose tree grew. */
  scopeId: string | null
  descendants: number
  growthPerSecond: number
  cause: 'count' | 'growth'
}

export type ProcessGrowthState = {
  previous: ProcessGrowthSample | null
  /** When each scope (`''` = host) first exceeded the growth rate in the current streak. */
  growingSince: Map<string, number>
}

export type ProcessGrowthVerdict = {
  level: 'ok' | 'elevated' | 'critical' | 'unknown'
  trips: ProcessGrowthTrip[]
}

const HOST_KEY = ''

export function createProcessGrowthState(): ProcessGrowthState {
  return { previous: null, growingSince: new Map() }
}

function growthRate(previous: number | undefined, current: number, elapsedMs: number): number {
  return previous === undefined || elapsedMs <= 0 ? 0 : ((current - previous) * 1000) / elapsedMs
}

/** Folds one sample into the state. `unknown` never trips and never clears a streak. */
export function evaluateProcessGrowth(
  state: ProcessGrowthState,
  sample: ProcessGrowthSample,
  limits: ProcessGrowthLimits
): ProcessGrowthVerdict {
  if (sample.hostDescendants === null) {
    return { level: 'unknown', trips: [] }
  }
  const previous = state.previous
  const elapsedMs = previous ? sample.atMs - previous.atMs : 0
  const trips: ProcessGrowthTrip[] = []
  let growing = false
  const observe = (key: string, before: number | undefined, current: number): void => {
    const rate = growthRate(before, current, elapsedMs)
    if (rate < limits.growthPerSecond) {
      state.growingSince.delete(key)
      return
    }
    growing = true
    const since = state.growingSince.get(key) ?? previous?.atMs ?? sample.atMs
    state.growingSince.set(key, since)
    if (sample.atMs - since >= limits.sustainMs) {
      trips.push({
        scopeId: key === HOST_KEY ? null : key,
        descendants: current,
        growthPerSecond: Math.round(rate),
        cause: 'growth'
      })
    }
  }
  observe(HOST_KEY, previous?.hostDescendants ?? undefined, sample.hostDescendants)
  for (const [scopeId, count] of sample.scopes) {
    observe(scopeId, previous?.scopes.get(scopeId), count)
  }
  for (const key of state.growingSince.keys()) {
    if (key !== HOST_KEY && !sample.scopes.has(key)) {
      state.growingSince.delete(key)
    }
  }
  if (sample.hostDescendants >= limits.hostCriticalDescendants) {
    trips.push({
      scopeId: null,
      descendants: sample.hostDescendants,
      growthPerSecond: Math.round(
        growthRate(previous?.hostDescendants ?? undefined, sample.hostDescendants, elapsedMs)
      ),
      cause: 'count'
    })
  }
  state.previous = sample
  return { level: trips.length > 0 ? 'critical' : growing ? 'elevated' : 'ok', trips }
}

/** Descendant counts per root pid from a pid/ppid table. */
export function countDescendantsByRoot(
  rows: readonly { pid: number; ppid: number }[],
  roots: readonly number[]
): Map<number, number> {
  const children = new Map<number, number[]>()
  for (const row of rows) {
    if (row.pid === row.ppid) {
      continue
    }
    const siblings = children.get(row.ppid)
    if (siblings) {
      siblings.push(row.pid)
    } else {
      children.set(row.ppid, [row.pid])
    }
  }
  const counts = new Map<number, number>()
  for (const root of roots) {
    let count = 0
    const seen = new Set<number>([root])
    const stack = [...(children.get(root) ?? [])]
    while (stack.length > 0) {
      const pid = stack.pop()
      if (pid === undefined || seen.has(pid)) {
        continue
      }
      seen.add(pid)
      count += 1
      stack.push(...(children.get(pid) ?? []))
    }
    counts.set(root, count)
  }
  return counts
}
