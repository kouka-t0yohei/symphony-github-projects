import type { Logger } from '../logging/logger.js';
import type { NormalizedWorkItem } from '../model/work-item.js';
import type { TrackerAdapter } from '../tracker/adapter.js';
import type { WorkflowContract } from '../workflow/contract.js';

export interface OrchestratorRuntime {
  tick(): Promise<void>;
}

export interface RuntimeStateSnapshot {
  running: string[];
  claimed: string[];
  retryAttempts: Record<string, number>;
  completed: string[];
}

interface RunningEntry {
  item: NormalizedWorkItem;
  startedAt: number;
  lastEventAt: number;
}

interface RetryEntry {
  attempts: number;
  nextEligibleAt: number;
}

export interface PollingRuntimeOptions {
  now?: () => number;
  stallTimeoutMs?: number;
  baseRetryDelayMs?: number;
}

const DEFAULT_STALL_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_BASE_RETRY_DELAY_MS = 10 * 1000;

export class PollingRuntime implements OrchestratorRuntime {
  private readonly running = new Map<string, RunningEntry>();
  private readonly claimed = new Set<string>();
  private readonly retry = new Map<string, RetryEntry>();
  private readonly completed = new Set<string>();
  private readonly now: () => number;
  private readonly stallTimeoutMs: number;
  private readonly baseRetryDelayMs: number;

  constructor(
    private readonly tracker: TrackerAdapter,
    private readonly workflow: WorkflowContract,
    private readonly logger: Logger,
    options: PollingRuntimeOptions = {},
  ) {
    this.now = options.now ?? (() => Date.now());
    this.stallTimeoutMs = options.stallTimeoutMs ?? DEFAULT_STALL_TIMEOUT_MS;
    this.baseRetryDelayMs = options.baseRetryDelayMs ?? DEFAULT_BASE_RETRY_DELAY_MS;
  }

  async tick(): Promise<void> {
    await this.reconcile();

    const maxConcurrency = this.resolveMaxConcurrency();
    if (maxConcurrency <= 0) {
      this.logger.warn('runtime.preflight.invalid_concurrency', {
        maxConcurrency: this.workflow.polling.maxConcurrency,
      });
      return;
    }

    const candidates = await this.tracker.listEligibleItems();
    const sorted = sortCandidates(candidates);
    const dispatchable = sorted.filter((item) => this.isDispatchable(item.id));

    let dispatched = 0;
    const capacity = Math.max(0, maxConcurrency - this.running.size);
    for (const item of dispatchable.slice(0, capacity)) {
      const ok = await this.dispatch(item);
      if (ok) {
        dispatched += 1;
      }
    }

    this.logger.info('runtime.tick', {
      issue_id: undefined,
      issue_identifier: undefined,
      eligibleCount: candidates.length,
      dispatchableCount: dispatchable.length,
      dispatched,
      runningCount: this.running.size,
      claimedCount: this.claimed.size,
      retryCount: this.retry.size,
      completedCount: this.completed.size,
      maxConcurrency,
    });
  }

  markActivity(itemId: string): void {
    const running = this.running.get(itemId);
    if (!running) return;
    running.lastEventAt = this.now();
  }

  async handleWorkerExit(itemId: string, result: 'completed' | 'failed'): Promise<void> {
    const entry = this.running.get(itemId);
    if (!entry) return;

    this.running.delete(itemId);
    this.claimed.delete(itemId);

    if (result === 'completed') {
      this.completed.add(itemId);
      this.retry.delete(itemId);
      this.logger.info('runtime.transition.completed', {
        issue_id: entry.item.id,
        issue_identifier: entry.item.identifier,
      });
      try {
        await this.tracker.markDone(itemId);
      } catch (err) {
        this.logger.warn('runtime.mark_done_failed', {
          issue_id: entry.item.id,
          issue_identifier: entry.item.identifier,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      return;
    }

    this.scheduleRetry(itemId, entry.item, 'worker_exit_failed');
  }

  snapshot(): RuntimeStateSnapshot {
    const retryAttempts: Record<string, number> = {};
    for (const [id, entry] of this.retry.entries()) {
      retryAttempts[id] = entry.attempts;
    }

    return {
      running: [...this.running.keys()],
      claimed: [...this.claimed],
      retryAttempts,
      completed: [...this.completed],
    };
  }

  private async reconcile(): Promise<void> {
    const now = this.now();
    const runningIds = [...this.running.keys()];
    if (runningIds.length === 0) {
      return;
    }

    for (const [itemId, entry] of this.running.entries()) {
      if (now - entry.lastEventAt > this.stallTimeoutMs) {
        this.running.delete(itemId);
        this.claimed.delete(itemId);
        this.scheduleRetry(itemId, entry.item, 'stalled');
      }
    }

    const activeIds = [...this.running.keys()];
    if (activeIds.length === 0) {
      return;
    }

    const trackerStates = await this.tracker.getStatesByIds(activeIds);
    for (const itemId of activeIds) {
      const entry = this.running.get(itemId);
      if (!entry) continue;

      const state = trackerStates[itemId];
      if (!state) {
        this.running.delete(itemId);
        this.claimed.delete(itemId);
        this.scheduleRetry(itemId, entry.item, 'state_missing');
        continue;
      }

      if (state === 'done') {
        this.running.delete(itemId);
        this.claimed.delete(itemId);
        this.completed.add(itemId);
        this.retry.delete(itemId);
        this.logger.info('runtime.transition.reconcile_done', {
          issue_id: entry.item.id,
          issue_identifier: entry.item.identifier,
        });
        continue;
      }

      if (state !== 'in_progress') {
        this.running.delete(itemId);
        this.claimed.delete(itemId);
        this.scheduleRetry(itemId, entry.item, `state_${state}`);
      }
    }
  }

  private async dispatch(item: NormalizedWorkItem): Promise<boolean> {
    if (this.claimed.has(item.id) || this.running.has(item.id)) {
      return false;
    }

    this.claimed.add(item.id);
    this.logger.info('runtime.transition.claimed', {
      issue_id: item.id,
      issue_identifier: item.identifier,
    });

    try {
      await this.tracker.markInProgress(item.id);
      const now = this.now();
      this.running.set(item.id, {
        item,
        startedAt: now,
        lastEventAt: now,
      });
      this.retry.delete(item.id);
      this.logger.info('runtime.transition.running', {
        issue_id: item.id,
        issue_identifier: item.identifier,
      });
      return true;
    } catch (err) {
      this.claimed.delete(item.id);
      this.scheduleRetry(item.id, item, 'claim_failed');
      this.logger.warn('runtime.transition.claim_failed', {
        issue_id: item.id,
        issue_identifier: item.identifier,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  private scheduleRetry(itemId: string, item: NormalizedWorkItem, reason: string): void {
    const current = this.retry.get(itemId);
    const attempts = (current?.attempts ?? 0) + 1;
    const delay = this.baseRetryDelayMs * 2 ** Math.max(0, attempts - 1);
    this.retry.set(itemId, {
      attempts,
      nextEligibleAt: this.now() + delay,
    });
    this.logger.info('runtime.transition.retry', {
      issue_id: item.id,
      issue_identifier: item.identifier,
      reason,
      retry_attempt: attempts,
      nextEligibleInMs: delay,
    });
  }

  private isDispatchable(itemId: string): boolean {
    if (this.completed.has(itemId)) return false;
    if (this.claimed.has(itemId)) return false;
    if (this.running.has(itemId)) return false;

    const retry = this.retry.get(itemId);
    if (!retry) return true;
    return this.now() >= retry.nextEligibleAt;
  }

  private resolveMaxConcurrency(): number {
    const configured = this.workflow.polling.maxConcurrency;
    if (typeof configured !== 'number' || !Number.isFinite(configured)) {
      return 1;
    }
    return Math.max(0, Math.floor(configured));
  }
}

function sortCandidates(items: NormalizedWorkItem[]): NormalizedWorkItem[] {
  return [...items].sort((a, b) => {
    const pa = a.priority ?? Number.MAX_SAFE_INTEGER;
    const pb = b.priority ?? Number.MAX_SAFE_INTEGER;
    if (pa !== pb) return pa - pb;

    const ua = Date.parse(a.updated_at ?? a.updatedAt ?? '');
    const ub = Date.parse(b.updated_at ?? b.updatedAt ?? '');
    const uaSafe = Number.isNaN(ua) ? Number.MAX_SAFE_INTEGER : ua;
    const ubSafe = Number.isNaN(ub) ? Number.MAX_SAFE_INTEGER : ub;
    if (uaSafe !== ubSafe) return uaSafe - ubSafe;

    return (a.number ?? Number.MAX_SAFE_INTEGER) - (b.number ?? Number.MAX_SAFE_INTEGER);
  });
}
