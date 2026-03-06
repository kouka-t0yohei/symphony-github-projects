import assert from 'node:assert/strict';
import test from 'node:test';

import { Reconciler } from './reconciler.js';
import type { RunningJob, TrackerStateProvider } from './reconciler.js';
import type { WorkItemState } from '../model/work-item.js';
import type { Logger } from '../logging/logger.js';

class CapturingLogger implements Logger {
  public readonly messages: Array<{ message: string; context?: Record<string, unknown> }> = [];
  info(message: string, context?: Record<string, unknown>): void {
    this.messages.push({ message, context });
  }
  warn(message: string, context?: Record<string, unknown>): void {
    this.messages.push({ message, context });
  }
  error(message: string, context?: Record<string, unknown>): void {
    this.messages.push({ message, context });
  }
}

function makeWorker() {
  const killed: string[] = [];
  const cleaned: string[] = [];
  const retried: string[] = [];
  return {
    killed,
    cleaned,
    retried,
    kill(itemId: string) {
      killed.push(itemId);
    },
    async cleanupWorkspace(itemId: string) {
      cleaned.push(itemId);
    },
    scheduleRetry(itemId: string) {
      retried.push(itemId);
    },
  };
}

function makeTracker(states: Record<string, WorkItemState | undefined>): TrackerStateProvider {
  return {
    async getItemState(itemId: string) {
      return states[itemId];
    },
  };
}

const now = Date.now();

test('kills stalled workers and schedules retry', async () => {
  const logger = new CapturingLogger();
  const worker = makeWorker();
  const tracker = makeTracker({ 'item-1': 'in_progress' });

  const reconciler = new Reconciler({
    stallTimeoutMs: 5000,
    logger,
    tracker,
    worker,
  });

  const jobs: RunningJob[] = [
    { itemId: 'item-1', startedAt: now - 10000, lastEventAt: now - 10000 },
  ];

  const result = await reconciler.reconcile(jobs);

  assert.deepEqual(result.staleKilled, ['item-1']);
  assert.deepEqual(worker.killed, ['item-1']);
  assert.deepEqual(worker.retried, ['item-1']);
});

test('terminates worker and cleans up for terminal state (done)', async () => {
  const logger = new CapturingLogger();
  const worker = makeWorker();
  const tracker = makeTracker({ 'item-2': 'done' });

  const reconciler = new Reconciler({
    stallTimeoutMs: 60000,
    logger,
    tracker,
    worker,
  });

  const jobs: RunningJob[] = [{ itemId: 'item-2', startedAt: now, lastEventAt: now }];

  const result = await reconciler.reconcile(jobs);

  assert.deepEqual(result.terminalKilled, ['item-2']);
  assert.deepEqual(worker.killed, ['item-2']);
  assert.deepEqual(worker.cleaned, ['item-2']);
});

test('terminates worker without cleanup for blocked state', async () => {
  const logger = new CapturingLogger();
  const worker = makeWorker();
  const tracker = makeTracker({ 'item-3': 'blocked' });

  const reconciler = new Reconciler({
    stallTimeoutMs: 60000,
    logger,
    tracker,
    worker,
  });

  const jobs: RunningJob[] = [{ itemId: 'item-3', startedAt: now, lastEventAt: now }];

  const result = await reconciler.reconcile(jobs);

  assert.deepEqual(result.nonActiveKilled, ['item-3']);
  assert.deepEqual(worker.killed, ['item-3']);
  assert.deepEqual(worker.cleaned, []);
});

test('handles tracker API failure gracefully', async () => {
  const logger = new CapturingLogger();
  const worker = makeWorker();
  const tracker: TrackerStateProvider = {
    async getItemState() {
      throw new Error('API down');
    },
  };

  const reconciler = new Reconciler({
    stallTimeoutMs: 60000,
    logger,
    tracker,
    worker,
  });

  const jobs: RunningJob[] = [{ itemId: 'item-4', startedAt: now, lastEventAt: now }];

  const result = await reconciler.reconcile(jobs);

  assert.deepEqual(result.trackerErrors, ['item-4']);
  assert.deepEqual(worker.killed, []);
  assert.ok(logger.messages.some((m) => m.message === 'reconcile.tracker_error'));
});

test('keeps active (in_progress) items running', async () => {
  const logger = new CapturingLogger();
  const worker = makeWorker();
  const tracker = makeTracker({ 'item-5': 'in_progress' });

  const reconciler = new Reconciler({
    stallTimeoutMs: 60000,
    logger,
    tracker,
    worker,
  });

  const jobs: RunningJob[] = [{ itemId: 'item-5', startedAt: now, lastEventAt: now }];

  const result = await reconciler.reconcile(jobs);

  assert.deepEqual(result.staleKilled, []);
  assert.deepEqual(result.terminalKilled, []);
  assert.deepEqual(result.nonActiveKilled, []);
  assert.deepEqual(worker.killed, []);
});

test('handles item not found (undefined state)', async () => {
  const logger = new CapturingLogger();
  const worker = makeWorker();
  const tracker = makeTracker({});

  const reconciler = new Reconciler({
    stallTimeoutMs: 60000,
    logger,
    tracker,
    worker,
  });

  const jobs: RunningJob[] = [{ itemId: 'item-gone', startedAt: now, lastEventAt: now }];

  const result = await reconciler.reconcile(jobs);

  assert.deepEqual(result.nonActiveKilled, ['item-gone']);
  assert.deepEqual(worker.killed, ['item-gone']);
  assert.deepEqual(worker.cleaned, []);
});
