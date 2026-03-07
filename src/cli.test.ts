import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { LoadedWorkflowContract } from './workflow/contract.js';
import { parseArgs, startService } from './cli.js';

type LoggerRecord = { message: string; data?: Record<string, unknown> };

type Reloader = {
  start: (contract: LoadedWorkflowContract) => void;
  stop: () => void;
};

type TimerHandle = ReturnType<typeof setTimeout>;

type TimeoutRecord = {
  fn: () => void;
  delay: number;
  id: number;
};

function makeWorkflow(pollingOverride?: Partial<LoadedWorkflowContract['polling']>): LoadedWorkflowContract {
  return {
    tracker: {
      kind: 'github_projects',
      github: {
        owner: 'owner',
        projectNumber: 1,
        tokenEnv: 'TOKEN',
      },
    },
    runtime: { pollIntervalMs: 1000, maxConcurrency: 1 },
    polling: {
      intervalMs: 1000,
      maxConcurrency: 1,
      ...(pollingOverride ?? {}),
    },
    workspace: {
      root: '/tmp/workspaces',
      baseDir: '/tmp/workspaces',
    },
    agent: { command: 'codex' },
    prompt_template: 'Run {{ issue.identifier }}',
  };
}

function withFakeTimers(calls: TimeoutRecord[]): {
  setTimeoutFn: typeof setTimeout;
  clearTimeoutFn: typeof clearTimeout;
} {
  let nextId = 0;

  const setTimeoutFn = ((fn: () => void, delay: number): TimerHandle => {
    const id = ++nextId;
    calls.push({ fn, delay, id });
    return { id } as unknown as TimerHandle;
  }) as typeof setTimeout;

  const clearTimeoutFn = ((id: TimerHandle): void => {
    const handle = id as unknown as { id: number };
    calls.splice(
      calls.findIndex((entry) => entry.id === handle.id),
      1,
    );
  }) as typeof clearTimeout;

  return { setTimeoutFn, clearTimeoutFn };
}

class FakeRuntime {
  public tickCount = 0;
  public applied: number[] = [];

  async tick(): Promise<void> {
    this.tickCount += 1;
  }

  applyWorkflow(contract: LoadedWorkflowContract): void {
    this.applied.push(contract.polling.intervalMs);
  }
}

describe('CLI argument parsing', () => {
  it('uses WORKFLOW_PATH env var as default when no --workflow flag is set', () => {
    const original = process.env.WORKFLOW_PATH;
    process.env.WORKFLOW_PATH = 'env/WORKFLOW.md';

    try {
      const config = parseArgs([]);
      assert.equal(config.workflowPath, 'env/WORKFLOW.md');
    } finally {
      if (original === undefined) {
        delete process.env.WORKFLOW_PATH;
      } else {
        process.env.WORKFLOW_PATH = original;
      }
    }
  });

  it('supports -w/--workflow overrides', () => {
    const config = parseArgs(['--workflow', 'custom/WORKFLOW.md']);
    assert.equal(config.workflowPath, 'custom/WORKFLOW.md');
    const configShort = parseArgs(['-w', 'short/WORKFLOW.md']);
    assert.equal(configShort.workflowPath, 'short/WORKFLOW.md');
  });

  it('prints usage and exits for help flags', () => {
    const originalExit = process.exit;
    const originalLog = console.log;
    let logged = '';
    let exitCode: number | undefined;

    (process as typeof process & { exit: (code?: number | string) => never }).exit = ((code?: number) => {
      exitCode = code ?? 0;
      throw new Error(`exit:${code ?? 0}`);
    }) as typeof process.exit;
    console.log = (...args: unknown[]) => {
      logged += args.join(' ');
    };

    try {
      assert.throws(() => parseArgs(['--help']), /exit:0/);
      assert.equal(exitCode, 0);
      assert.ok(logged.includes('Usage:'));
    } finally {
      process.exit = originalExit;
      console.log = originalLog;
    }
  });
});

describe('startService orchestration', () => {
  it('starts ticker and applies stop lifecycle hooks', async () => {
    const runtime = new FakeRuntime();
    const workflow = makeWorkflow();
    const loggerRecords: LoggerRecord[] = [];

    const timeoutCalls: TimeoutRecord[] = [];
    const { setTimeoutFn, clearTimeoutFn } = withFakeTimers(timeoutCalls);

    let reloaderStarted = 0;
    let reloaderStopped = 0;

    const handle = await startService(
      { workflowPath: 'WORKFLOW.md' },
      {
        logger: {
          info(message: string, context?: Record<string, unknown>): void {
            loggerRecords.push({ message, data: context });
          },
          warn: () => {},
          error: () => {},
        },
        bootstrap: async () => ({
          workflow,
          runtime,
          logger: {
            info: () => {},
            warn: () => {},
            error: () => {},
          },
        }),
        reloaderFactory: () => ({
          start: () => {
            reloaderStarted += 1;
          },
          stop: () => {
            reloaderStopped += 1;
          },
        }),
        setTimeoutFn,
        clearTimeoutFn,
        installSignalHandlers: false,
      },
    );

    assert.equal(reloaderStarted, 1);
    assert.equal(timeoutCalls.length, 1);

    timeoutCalls[0].fn();
    await Promise.resolve();
    assert.equal(runtime.tickCount, 1);

    handle.stop();

    assert.equal(reloaderStopped, 1);
    assert.equal(timeoutCalls.length, 1);
    assert.ok(loggerRecords.some((entry) => entry.message === 'service.started'));
    assert.ok(loggerRecords.some((entry) => entry.message === 'service.shutdown_requested'));
  });

  it('reapplies runtime config on workflow reload and reschedules poll interval', async () => {
    const runtime = new FakeRuntime();
    const workflow = makeWorkflow({ intervalMs: 1000, maxConcurrency: 1 });
    const loggerRecords: LoggerRecord[] = [];

    let onReload: ((contract: LoadedWorkflowContract) => void) | undefined;
    const timeoutCalls: TimeoutRecord[] = [];
    const { setTimeoutFn, clearTimeoutFn } = withFakeTimers(timeoutCalls);

    await startService(
      { workflowPath: 'WORKFLOW.md' },
      {
        logger: {
          info(message: string): void {
            loggerRecords.push({ message });
          },
          warn: () => {},
          error: () => {},
        },
        bootstrap: async () => ({
          workflow,
          runtime,
          logger: {
            info: () => {},
            warn: () => {},
            error: () => {},
          },
        }),
        reloaderFactory: (options): Reloader => {
          onReload = options.onReload;
          return {
            start: () => {},
            stop: () => {},
          };
        },
        setTimeoutFn,
        clearTimeoutFn,
        installSignalHandlers: false,
      },
    );

    assert.ok(onReload);
    onReload!({
      ...workflow,
      polling: {
        intervalMs: 500,
        maxConcurrency: 2,
      },
    });

    assert.equal(runtime.applied[0], 500);
    assert.ok(loggerRecords.some((entry) => entry.message === 'runtime.config.reloaded'));
    assert.equal(timeoutCalls[0]?.delay, 500);
  });
});
