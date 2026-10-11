import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DaemonAutomaticWorkGuard } from './daemon-automatic-work-guard'
import { DaemonProcessGrowthMonitor } from './daemon-process-growth-monitor'

describe('DaemonAutomaticWorkGuard growth breaker', () => {
  let dir: string
  let rows: { pid: number; ppid: number }[]
  let now: number

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'orca-growth-'))
    rows = []
    now = 0
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  function forkChildren(parent: number, count: number, startPid: number): void {
    for (let i = 0; i < count; i++) {
      rows.push({ pid: startPid + i, ppid: parent })
    }
  }

  function createGuard() {
    const log = { log: vi.fn() }
    const markerPath = join(dir, 'daemon-v1.automatic-work-run.json')
    let guard: DaemonAutomaticWorkGuard | undefined
    const monitor = new DaemonProcessGrowthMonitor({
      listSessions: () => [{ sessionId: 'agent-session-0001', pid: 100 }],
      recentAutomaticWork: () => true,
      sampleWhenIdle: true,
      onLevelChanged: (level) => guard?.['onPressureChanged'](level),
      onTrip: (trips) => guard?.['onTrip'](trips),
      readRows: async () => rows,
      rootPid: 1,
      now: () => now
    })
    guard = new DaemonAutomaticWorkGuard({
      markerPath,
      mode: 'enforce',
      log,
      listSessions: () => [],
      ownsEndpoint: () => true,
      monitor
    })
    guard.start()
    return { guard, monitor, log, markerPath }
  }

  it('pauses automatic work durably and names the agent whose tree is storming', async () => {
    rows.push({ pid: 100, ppid: 1 })
    const { guard, monitor, log, markerPath } = createGuard()
    await monitor.sample()
    for (let step = 1; step <= 2; step++) {
      now = step * 5_000
      forkChildren(100, 300, 1_000 * step)
      await monitor.sample()
    }

    expect(guard.gate.snapshot()).toMatchObject({ mode: 'enforce' })
    expect(monitor.level).toBe('critical')
    expect(log.log).toHaveBeenCalledWith(
      'process-growth-breaker-tripped',
      expect.objectContaining({
        trips: expect.arrayContaining([expect.objectContaining({ scope: 'session-0001' })])
      })
    )
    expect(JSON.parse(readFileSync(markerPath, 'utf8'))).toMatchObject({
      mode: { kind: 'paused', reason: 'pressure' }
    })
    monitor.stop()
  })
})
