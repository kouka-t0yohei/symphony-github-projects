import test from 'node:test';
import assert from 'node:assert/strict';
import type { Logger } from '../logging/logger.js';
import type { RuntimeStateSnapshot } from '../orchestrator/runtime.js';
import { startWebUIServer } from './webui.js';

class TestLogger implements Logger {
  public messages: Array<{ level: string; message: string; context?: Record<string, unknown> }> = [];

  info(message: string, context?: Record<string, unknown>): void {
    this.messages.push({ level: 'info', message, context });
  }

  warn(message: string, context?: Record<string, unknown>): void {
    this.messages.push({ level: 'warn', message, context });
  }

  error(message: string, context?: Record<string, unknown>): void {
    this.messages.push({ level: 'error', message, context });
  }
}

function fakeSnapshot(): RuntimeStateSnapshot {
  return {
    running: ['I1'],
    claimed: ['I1'],
    retryAttempts: { I1: 2 },
    completed: ['I2'],
    runningDetails: [{ itemId: 'I1', issueIdentifier: '#101', sessionId: 'sess-1' }],
    retryingDetails: [{ itemId: 'I1', issueIdentifier: '#101', attempt: 2, kind: 'failure', dueAt: '2026-03-07T00:00:00.000Z' }],
    usageTotals: { inputTokens: 12, outputTokens: 4, totalTokens: 16 },
    aggregateRuntimeSeconds: 1234,
  };
}

test('startWebUIServer serves dashboard and state endpoint', async () => {
  const logger = new TestLogger();
  const state = fakeSnapshot();
  const handle = await startWebUIServer({
    logger,
    workflowPath: 'WORKFLOW.md',
    host: '127.0.0.1',
    port: 0,
    pollIntervalMs: 1000,
    maxConcurrency: 2,
    getRuntimeSnapshot: () => state,
  });

  const baseUrl = `http://${handle.host}:${handle.port}`;
  const root = await fetch(`${baseUrl}/`);
  assert.equal(root.status, 200);
  assert.equal(root.headers.get('content-type')?.includes('text/html'), true);

  const health = await fetch(`${baseUrl}/healthz`);
  assert.equal(health.status, 200);
  const healthPayload = (await health.json()) as { status: string };
  assert.equal(healthPayload.status, 'ok');

  const stateResp = await fetch(`${baseUrl}/api/v1/state`);
  assert.equal(stateResp.status, 200);
  const body = (await stateResp.json()) as Record<string, unknown>;
  assert.equal((body.workflow as Record<string, unknown>).workflowPath, 'WORKFLOW.md');

  await handle.stop();

  const stoppedMsg = logger.messages.find((message) => message.message === 'webui.server.stopped');
  assert.ok(stoppedMsg);
});


test('startWebUIServer returns 404 for unknown routes', async () => {
  const logger = new TestLogger();
  const handle = await startWebUIServer({
    logger,
    workflowPath: 'WORKFLOW.md',
    host: '127.0.0.1',
    port: 0,
    pollIntervalMs: 1000,
    maxConcurrency: 1,
    getRuntimeSnapshot: () => fakeSnapshot(),
  });

  const baseUrl = `http://${handle.host}:${handle.port}`;
  const missing = await fetch(`${baseUrl}/__unknown`);
  assert.equal(missing.status, 404);

  await handle.stop();
});
