import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Logger } from '../logging/logger.js';
import type { NormalizedWorkItem, WorkItemState } from '../model/work-item.js';
import { PollingRuntime } from './runtime.js';

class FakeLogger implements Logger {
  info(): void {}
  warn(): void {}
  error(): void {}
}

class FakeTracker {
  public items: NormalizedWorkItem[] = [];
  public states: Record<string, WorkItemState> = {};
  public markInProgressCalls: string[] = [];
  public markDoneCalls: string[] = [];
  public failMarkInProgressFor = new Set<string>();

  async listEligibleItems(): Promise<NormalizedWorkItem[]> {
    return this.items;
  }

  async listCandidateItems(): Promise<NormalizedWorkItem[]> {
    return this.items;
  }

  async listItemsByStates(): Promise<NormalizedWorkItem[]> {
    return this.items;
  }

  async getStatesByIds(itemIds: string[]): Promise<Record<string, WorkItemState>> {
    const result: Record<string, WorkItemState> = {};
    for (const id of itemIds) {
      const state = this.states[id];
      if (state) {
        result[id] = state;
      }
    }
    return result;
  }

  async markInProgress(itemId: string): Promise<void> {
    this.markInProgressCalls.push(itemId);
    if (this.failMarkInProgressFor.has(itemId)) {
      throw new Error('failed to claim');
    }
  }

  async markDone(itemId: string): Promise<void> {
    this.markDoneCalls.push(itemId);
  }
}

function item(id: string, number: number): NormalizedWorkItem {
  return {
    id,
    identifier: `#${number}`,
    number,
    title: `Issue ${number}`,
    state: 'todo',
    labels: [],
    assignees: [],
  };
}

describe('PollingRuntime state machine', () => {
  it('prevents duplicate dispatch across ticks for already running item', async () => {
    const tracker = new FakeTracker();
    tracker.items = [item('A', 101)];
    tracker.states.A = 'in_progress';

    const runtime = new PollingRuntime(
      tracker,
      {
        tracker: {
          kind: 'github_projects',
          github: { owner: 'o', projectNumber: 1, tokenEnv: 'GITHUB_TOKEN' },
        },
        polling: { intervalMs: 1000, maxConcurrency: 1 },
        workspace: { baseDir: '/tmp' },
        agent: { command: 'codex' },
      },
      new FakeLogger(),
    );

    await runtime.tick();
    await runtime.tick();

    assert.equal(tracker.markInProgressCalls.length, 1);
    assert.deepEqual(runtime.snapshot().running, ['A']);
  });

  it('schedules exponential retry on claim failure then dispatches after backoff', async () => {
    let now = 1_000;
    const tracker = new FakeTracker();
    tracker.items = [item('A', 101)];
    tracker.failMarkInProgressFor.add('A');

    const runtime = new PollingRuntime(
      tracker,
      {
        tracker: {
          kind: 'github_projects',
          github: { owner: 'o', projectNumber: 1, tokenEnv: 'GITHUB_TOKEN' },
        },
        polling: { intervalMs: 1000, maxConcurrency: 1 },
        workspace: { baseDir: '/tmp' },
        agent: { command: 'codex' },
      },
      new FakeLogger(),
      { now: () => now, baseRetryDelayMs: 100 },
    );

    await runtime.tick();
    assert.equal(tracker.markInProgressCalls.length, 1);

    tracker.failMarkInProgressFor.delete('A');
    await runtime.tick();
    assert.equal(tracker.markInProgressCalls.length, 1);

    now += 101;
    await runtime.tick();
    assert.equal(tracker.markInProgressCalls.length, 2);
    assert.deepEqual(runtime.snapshot().running, ['A']);
  });

  it('reconciles done state and handles abnormal exit retry', async () => {
    const tracker = new FakeTracker();
    tracker.items = [item('A', 101)];
    tracker.states.A = 'in_progress';

    const runtime = new PollingRuntime(
      tracker,
      {
        tracker: {
          kind: 'github_projects',
          github: { owner: 'o', projectNumber: 1, tokenEnv: 'GITHUB_TOKEN' },
        },
        polling: { intervalMs: 1000, maxConcurrency: 1 },
        workspace: { baseDir: '/tmp' },
        agent: { command: 'codex' },
      },
      new FakeLogger(),
    );

    await runtime.tick();
    await runtime.handleWorkerExit('A', 'failed');
    assert.equal(runtime.snapshot().running.length, 0);
    assert.equal(runtime.snapshot().retryAttempts.A, 1);

    tracker.items = [item('B', 102)];
    tracker.states.B = 'in_progress';
    await runtime.tick();
    tracker.states.B = 'done';
    await runtime.tick();

    assert.deepEqual(runtime.snapshot().completed.includes('B'), true);
    assert.equal(runtime.snapshot().running.includes('B'), false);
  });
});
