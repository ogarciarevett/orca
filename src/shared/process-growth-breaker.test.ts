import { describe, expect, it } from 'vitest'
import {
  countDescendantsByRoot,
  createProcessGrowthState,
  DEFAULT_PROCESS_GROWTH_LIMITS as LIMITS,
  evaluateProcessGrowth
} from './process-growth-breaker'

function sample(atMs: number, host: number | null, scopes: Record<string, number> = {}) {
  return { atMs, hostDescendants: host, scopes: new Map(Object.entries(scopes)) }
}

describe('evaluateProcessGrowth', () => {
  it('trips on one agent forking 40+/s for 10 s and names that agent', () => {
    const state = createProcessGrowthState()
    let verdict = evaluateProcessGrowth(state, sample(0, 10, { a: 5, b: 5 }), LIMITS)
    expect(verdict.level).toBe('ok')
    for (let t = 5_000; t <= 10_000; t += 5_000) {
      verdict = evaluateProcessGrowth(
        state,
        sample(t, 10 + t / 20, { a: 5 + t / 20, b: 5 }),
        LIMITS
      )
    }
    expect(verdict.level).toBe('critical')
    expect(verdict.trips).toEqual(
      expect.arrayContaining([
        { scopeId: 'a', descendants: 505, growthPerSecond: 50, cause: 'growth' },
        expect.objectContaining({ scopeId: null, cause: 'growth' })
      ])
    )
    expect(verdict.trips.some((trip) => trip.scopeId === 'b')).toBe(false)
  })

  it('reports a short burst as elevated, and resets the streak once growth stops', () => {
    const state = createProcessGrowthState()
    evaluateProcessGrowth(state, sample(0, 0), LIMITS)
    expect(evaluateProcessGrowth(state, sample(5_000, 300), LIMITS).level).toBe('elevated')
    expect(evaluateProcessGrowth(state, sample(10_000, 300), LIMITS).level).toBe('ok')
    expect(evaluateProcessGrowth(state, sample(15_000, 600), LIMITS).level).toBe('elevated')
  })

  it('trips on the total descendant count regardless of growth', () => {
    const state = createProcessGrowthState()
    expect(evaluateProcessGrowth(state, sample(0, LIMITS.hostCriticalDescendants), LIMITS)).toEqual(
      {
        level: 'critical',
        trips: [
          {
            scopeId: null,
            descendants: LIMITS.hostCriticalDescendants,
            growthPerSecond: 0,
            cause: 'count'
          }
        ]
      }
    )
  })

  it('treats an unreadable table as unknown, never as a trip or a reset', () => {
    const state = createProcessGrowthState()
    evaluateProcessGrowth(state, sample(0, 0), LIMITS)
    evaluateProcessGrowth(state, sample(5_000, 300), LIMITS)
    expect(evaluateProcessGrowth(state, sample(7_000, null), LIMITS)).toEqual({
      level: 'unknown',
      trips: []
    })
    expect(evaluateProcessGrowth(state, sample(10_000, 600), LIMITS).level).toBe('critical')
  })
})

describe('countDescendantsByRoot', () => {
  it('counts each root tree and tolerates cycles', () => {
    const rows = [
      { pid: 2, ppid: 1 },
      { pid: 3, ppid: 2 },
      { pid: 4, ppid: 2 },
      { pid: 5, ppid: 1 },
      { pid: 6, ppid: 7 },
      { pid: 7, ppid: 6 }
    ]
    expect(countDescendantsByRoot(rows, [1, 2, 5, 6, 99])).toEqual(
      new Map([
        [1, 4],
        [2, 2],
        [5, 0],
        [6, 1],
        [99, 0]
      ])
    )
  })
})
