/**
 * Detached-Run lifecycle for the Agent Execution Host (arch.md §16).
 *
 * The host outlives Electron when — and only when — runs are in flight:
 *
 *   client detached ─┬─ active runs ──→ ORPHAN (keep working, serve the
 *                    │                  reconnect socket, time out approvals)
 *                    └─ no active runs → exit after a short grace period
 *
 * While a client is attached, approvals wait forever (the user is watching);
 * the timeout clock only runs while orphaned.
 */
export interface HostLifecycleDeps {
  /** Whether at least one run is RUNNING/WAITING_*. */
  hasActiveRuns(): boolean;
  /** Host-internal approval rejection (routes to the owning adapter). */
  rejectApproval(approvalId: string): Promise<void>;
  /** Terminate the host process (stop + exit). */
  exit(): void;
  /** Grace period before an idle, clientless host exits (default 2s). */
  idleExitDelayMs?: number;
  /** Approval timeout while orphaned (default 30 minutes). */
  approvalTimeoutMs?: number;
  /** Clock injection for tests. */
  now?: () => number;
  /** Timer injection for tests. */
  schedule?(fn: () => void, ms: number): { clear(): void };
}

export class HostLifecycle {
  private orphan = false;
  private exitTimer: { clear(): void } | undefined;
  private approvalTimers = new Map<string, { clear(): void }>();
  private pendingApprovals = new Set<string>();

  constructor(private deps: HostLifecycleDeps) {}

  get isOrphan(): boolean {
    return this.orphan;
  }

  /** A primary client (stdio or socket) is attached again. */
  onClientAttached(): void {
    this.orphan = false;
    this.exitTimer?.clear();
    this.exitTimer = undefined;
    for (const t of this.approvalTimers.values()) t.clear();
    this.approvalTimers.clear();
  }

  /** The primary client went away; decide between orphan mode and exit. */
  onClientDetached(): void {
    if (this.deps.hasActiveRuns()) {
      this.enterOrphan();
    } else {
      this.scheduleExit();
    }
  }

  /** Active-run count changed (run reached a terminal state). */
  onActiveRunsChanged(): void {
    if (!this.orphan) return;
    if (!this.deps.hasActiveRuns()) {
      this.scheduleExit();
    } else {
      this.exitTimer?.clear();
      this.exitTimer = undefined;
    }
  }

  onApprovalRequested(approvalId: string): void {
    this.pendingApprovals.add(approvalId);
    if (this.orphan) this.armApprovalTimeout(approvalId);
  }

  onApprovalResolved(approvalId: string): void {
    this.pendingApprovals.delete(approvalId);
    const t = this.approvalTimers.get(approvalId);
    if (t) {
      t.clear();
      this.approvalTimers.delete(approvalId);
    }
  }

  dispose(): void {
    this.exitTimer?.clear();
    for (const t of this.approvalTimers.values()) t.clear();
    this.approvalTimers.clear();
  }

  private enterOrphan(): void {
    this.orphan = true;
    // Arm timeouts for approvals that were already pending when we detached.
    for (const id of this.pendingApprovals) this.armApprovalTimeout(id);
  }

  private scheduleExit(): void {
    this.exitTimer?.clear();
    this.exitTimer = this.timer(() => this.deps.exit(), this.deps.idleExitDelayMs ?? 2_000);
  }

  private armApprovalTimeout(approvalId: string): void {
    if (this.approvalTimers.has(approvalId)) return;
    // <= 0 means "wait forever" (user disabled the orphan-mode timeout).
    const timeout = this.deps.approvalTimeoutMs ?? 30 * 60 * 1_000;
    if (timeout <= 0) return;
    const t = this.timer(() => {
      this.approvalTimers.delete(approvalId);
      void this.deps.rejectApproval(approvalId).catch(() => {
        // Adapter may have settled already (race with the user's own
        // response); losing the race is harmless.
      });
    }, timeout);
    this.approvalTimers.set(approvalId, t);
  }

  private timer(fn: () => void, ms: number): { clear(): void } {
    if (this.deps.schedule) return this.deps.schedule(fn, ms);
    const h = setTimeout(fn, ms);
    return { clear: () => clearTimeout(h) };
  }
}
