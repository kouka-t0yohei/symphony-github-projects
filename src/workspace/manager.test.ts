import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { HookRunner } from './hooks.js';
import { WorkspaceManager, WorkspaceSafetyError } from './manager.js';

function createHookRunner(exitCode: number, calls: string[]): HookRunner {
  return new HookRunner({
    hooks: {
      after_create: 'echo create',
      before_run: 'echo run',
      after_run: 'echo post',
      before_remove: 'echo remove',
    },
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
    },
    exec: async (_cmd, args, opts) => {
      calls.push(`${args.join(' ')}@${opts.cwd}`);
      return {
        stdout: '',
        stderr: exitCode === 0 ? '' : 'failed',
        exitCode,
      };
    },
  });
}

test('toWorkspaceKey keeps [A-Za-z0-9._-] and replaces others with _', () => {
  const manager = new WorkspaceManager({ workspaceRoot: '/tmp/workspaces' });
  const key = manager.toWorkspaceKey(' Issue #50: 安全/../Path ');
  assert.equal(key, 'Issue__50_____.._Path');
});

test('prepareWorkspace creates then reuses existing workspace', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'workspace-manager-'));
  const manager = new WorkspaceManager({ workspaceRoot: root });

  try {
    const first = await manager.prepareWorkspace('issue-50');
    const second = await manager.prepareWorkspace('issue-50');

    assert.equal(first.created, true);
    assert.equal(second.created, false);
    assert.equal(first.path, second.path);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('assertWorkspacePath rejects traversal outside root', () => {
  const manager = new WorkspaceManager({ workspaceRoot: '/tmp/ws-root' });
  assert.throws(() => manager.assertWorkspacePath('/tmp/elsewhere/escape'), WorkspaceSafetyError);
});

test('assertWorkerCwd enforces exact computed workspace path', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'workspace-manager-'));
  const manager = new WorkspaceManager({ workspaceRoot: root });

  try {
    const prepared = await manager.prepareWorkspace('issue-50');
    const expected = manager.assertWorkerCwd('issue-50', prepared.path);
    assert.equal(expected, prepared.path);

    assert.throws(() => manager.assertWorkerCwd('issue-50', root), WorkspaceSafetyError);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('cleanupTerminalStateWorkspaces removes done/blocked only', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'workspace-manager-'));
  const manager = new WorkspaceManager({ workspaceRoot: root });

  try {
    const done = await manager.prepareWorkspace('done-item');
    const blocked = await manager.prepareWorkspace('blocked-item');
    const todo = await manager.prepareWorkspace('todo-item');

    const cleaned = await manager.cleanupTerminalStateWorkspaces([
      { workspacePath: done.path, state: 'done' },
      { workspacePath: blocked.path, state: 'blocked' },
      { workspacePath: todo.path, state: 'todo' },
    ]);

    assert.equal(cleaned, 2);

    const doneRecreated = await manager.prepareWorkspace('done-item');
    const todoReused = await manager.prepareWorkspace('todo-item');
    assert.equal(doneRecreated.created, true);
    assert.equal(todoReused.created, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('after_create and before_run failures are fatal, after_run and before_remove are non-fatal', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'workspace-manager-'));
  const calls: string[] = [];
  const failingHooks = createHookRunner(1, calls);
  const manager = new WorkspaceManager({ workspaceRoot: root, hooks: failingHooks });

  try {
    await assert.rejects(() => manager.prepareWorkspace('fatal-after-create'));

    const plain = new WorkspaceManager({ workspaceRoot: root });
    const prepared = await plain.prepareWorkspace('existing-for-before-run');
    await assert.rejects(() => manager.beforeRun(prepared.path));

    await manager.afterRun(prepared.path);
    await manager.cleanupWorkspace(prepared.path);
  } finally {
    await rm(root, { recursive: true, force: true });
  }

  assert.ok(calls.some((call) => call.includes('echo create')));
  assert.ok(calls.some((call) => call.includes('echo run')));
  assert.ok(calls.some((call) => call.includes('echo post')));
  assert.ok(calls.some((call) => call.includes('echo remove')));
});
