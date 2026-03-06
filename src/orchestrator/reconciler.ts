import type { Logger } from '../logging/logger.js';
import type { WorkItemState } from '../model/work-item.js';

export interface RunningJob {
  itemId: string;
  startedAt: number;
  lastEventAt: number;
}

export interface TrackerStateProvider {
  getItemState(itemId: string): Promise<WorkItemState | undefined>;
}

export interface WorkerController {
  kill(itemId: string): void;
  cleanupWorkspace(itemId: string): Promise<void>;
  scheduleRetry(itemId: string): void;
}

export interface ReconcilerOptions {
  stallTimeoutMs: number;
  logger: Logger;
  tracker: TrackerStateProvider;
  worker: WorkerController;
}

const TERMINAL_STATES: Set<WorkItemState> = new Set(['done']);

export interface ReconcileResult {
  staleKilled: string[];
  terminalKilled: string[];
  nonActiveKilled: string[];
  trackerErrors: string[];
}

export class Reconciler {
  private readonly stallTimeoutMs: number;
  private readonly logger: Logger;
  private readonly tracker: TrackerStateProvider;
  private readonly worker: WorkerController;

  constructor(options: ReconcilerOptions) {
    this.stallTimeoutMs = options.stallTimeoutMs;
    this.logger = options.logger;
    this.tracker = options.tracker;
    this.worker = options.worker;
  }

  async reconcile(runningJobs: RunningJob[]): Promise<ReconcileResult> {
    const result: ReconcileResult = {
      staleKilled: [],
      terminalKilled: [],
      nonActiveKilled: [],
      trackerErrors: [],
    };

    const now = Date.now();

    // Part A: Stall detection
    for (const job of runningJobs) {
      const elapsed = now - job.lastEventAt;
      if (elapsed > this.stallTimeoutMs) {
        this.logger.info('reconcile.stall', {
          itemId: job.itemId,
          elapsedMs: elapsed,
          stallTimeoutMs: this.stallTimeoutMs,
        });
        this.worker.kill(job.itemId);
        this.worker.scheduleRetry(job.itemId);
        result.staleKilled.push(job.itemId);
      }
    }

    // Part B: Tracker state refresh
    const nonStaleJobs = runningJobs.filter((j) => !result.staleKilled.includes(j.itemId));

    for (const job of nonStaleJobs) {
      let state: WorkItemState | undefined;
      try {
        state = await this.tracker.getItemState(job.itemId);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.warn('reconcile.tracker_error', {
          itemId: job.itemId,
          error: message,
        });
        result.trackerErrors.push(job.itemId);
        continue;
      }

      if (state === undefined) {
        // Item no longer exists — terminate without cleanup
        this.logger.info('reconcile.not_found', { itemId: job.itemId });
        this.worker.kill(job.itemId);
        result.nonActiveKilled.push(job.itemId);
        continue;
      }

      if (TERMINAL_STATES.has(state)) {
        this.logger.info('reconcile.terminal', { itemId: job.itemId, state });
        this.worker.kill(job.itemId);
        await this.worker.cleanupWorkspace(job.itemId);
        result.terminalKilled.push(job.itemId);
        continue;
      }

      if (state !== 'in_progress' && state !== 'todo') {
        // Blocked or unknown — terminate without cleanup
        this.logger.info('reconcile.non_active', { itemId: job.itemId, state });
        this.worker.kill(job.itemId);
        result.nonActiveKilled.push(job.itemId);
      }
    }

    this.logger.info('reconcile.complete', {
      staleKilled: result.staleKilled.length,
      terminalKilled: result.terminalKilled.length,
      nonActiveKilled: result.nonActiveKilled.length,
      trackerErrors: result.trackerErrors.length,
    });

    return result;
  }
}
