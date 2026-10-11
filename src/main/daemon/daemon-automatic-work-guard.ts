import type { HostPressureLevel } from '../../shared/host-spawn-admission'
import type { ProcessGrowthTrip } from '../../shared/process-growth-breaker'
import { AutomaticWorkRunMarker } from './automatic-work-run-marker-store'
import { DaemonProcessGrowthMonitor } from './daemon-process-growth-monitor'
import { TerminalSpawnGate, type TerminalSpawnAdmissionMode } from './terminal-spawn-gate'

type DaemonAutomaticWorkGuardOptions = {
  markerPath: string | undefined
  mode: TerminalSpawnAdmissionMode
  log: { log: (event: string, details: Record<string, unknown>) => void }
  listSessions: () => readonly { sessionId: string; pid: number | null }[]
  ownsEndpoint: () => boolean
  /** Test seam for the growth monitor's process table. */
  monitor?: DaemonProcessGrowthMonitor
}

/**
 * Everything that decides whether the daemon may start automatic work: the fork gate,
 * the same-boot crash marker, and the process-growth breaker that pauses it.
 */
export class DaemonAutomaticWorkGuard {
  readonly gate: TerminalSpawnGate
  private readonly marker: AutomaticWorkRunMarker
  private readonly monitor: DaemonProcessGrowthMonitor

  constructor(private readonly options: DaemonAutomaticWorkGuardOptions) {
    this.marker = new AutomaticWorkRunMarker(options.markerPath, options.log, options.ownsEndpoint)
    this.monitor =
      options.monitor ??
      new DaemonProcessGrowthMonitor({
        listSessions: options.listSessions,
        recentAutomaticWork: () => this.gate.hasRecentAutomaticWork(),
        sampleWhenIdle: options.mode === 'enforce',
        onLevelChanged: (level) => this.onPressureChanged(level),
        onTrip: (trips) => this.onTrip(trips)
      })
    this.gate = new TerminalSpawnGate({
      log: (event, details) => options.log.log(event, details),
      mode: options.mode,
      pressure: () => this.monitor.level,
      ...this.marker.gateOptions()
    })
  }

  /** Called once the daemon owns its endpoint. */
  start(): void {
    this.marker.open()
    this.monitor.start()
  }

  /** Called after every session was disposed on an orderly shutdown. */
  stop(): void {
    this.monitor.stop()
    this.marker.markCleanExit()
  }

  /** An exit on purpose that skips teardown (macOS login-session retirement). */
  recordOrderlyExit(): void {
    this.monitor.stop()
    this.marker.markCleanExit()
  }

  private onPressureChanged(level: HostPressureLevel): void {
    this.options.log.log('process-growth-level', { level })
    this.gate.onPressureChanged()
  }

  private onTrip(trips: readonly ProcessGrowthTrip[]): void {
    // Why pause, not kill: running agents keep running; only new automatic work stops,
    // and it stays stopped until someone resumes it (owner decision Q3).
    this.marker.pause('pressure')
    this.options.log.log('process-growth-breaker-tripped', {
      trips: trips.map((trip) => ({
        scope: trip.scopeId === null ? 'host' : trip.scopeId.slice(-12),
        descendants: trip.descendants,
        growthPerSecond: trip.growthPerSecond,
        cause: trip.cause
      }))
    })
  }
}
