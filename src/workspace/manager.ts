import { mkdir, realpath, rm } from 'node:fs/promises';
import path from 'node:path';

import { sanitizeWorkspaceKey } from '../model/work-item.js';
import { HookFailureError, HookRunner } from './hooks.js';

export interface WorkspaceManagerOptions {
  workspaceRoot: string;
  hooks?: HookRunner;
}

export interface PreparedWorkspace {
  key: string;
  path: string;
  created: boolean;
}

export class WorkspaceSafetyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkspaceSafetyError';
  }
}

export class WorkspaceManager {
  private readonly workspaceRoot: string;
  private readonly hooks?: HookRunner;

  constructor(options: WorkspaceManagerOptions) {
    this.workspaceRoot = path.resolve(options.workspaceRoot);
    this.hooks = options.hooks;
  }

  async prepareWorkspace(rawKey: string): Promise<PreparedWorkspace> {
    const key = this.toWorkspaceKey(rawKey);
    const workspacePath = this.resolveWorkspacePath(key);

    let created = false;
    try {
      await realpath(workspacePath);
    } catch {
      await mkdir(workspacePath, { recursive: true });
      created = true;
    }

    if (created && this.hooks) {
      const hookResult = await this.hooks.afterCreate(workspacePath);
      if (!hookResult.success) {
        await rm(workspacePath, { recursive: true, force: true });
        throw new HookFailureError(hookResult);
      }
    }

    return { key, path: workspacePath, created };
  }

  async beforeRun(workspacePath: string): Promise<void> {
    this.assertWorkspacePath(workspacePath);
    if (!this.hooks) return;
    const result = await this.hooks.beforeRun(path.resolve(workspacePath));
    if (!result.success) {
      throw new HookFailureError(result);
    }
  }

  async afterRun(workspacePath: string): Promise<void> {
    this.assertWorkspacePath(workspacePath);
    await this.hooks?.afterRun(path.resolve(workspacePath));
  }

  async cleanupWorkspace(workspacePath: string): Promise<void> {
    this.assertWorkspacePath(workspacePath);
    const abs = path.resolve(workspacePath);
    await this.hooks?.beforeRemove(abs);
    await rm(abs, { recursive: true, force: true });
  }

  async cleanupTerminalStateWorkspaces(entries: Array<{ workspacePath: string; state: string }>): Promise<number> {
    const terminal = new Set(['done', 'blocked']);
    let cleaned = 0;
    for (const entry of entries) {
      if (!terminal.has(entry.state)) continue;
      this.assertWorkspacePath(entry.workspacePath);
      await this.cleanupWorkspace(entry.workspacePath);
      cleaned += 1;
    }
    return cleaned;
  }

  assertWorkerCwd(rawKey: string, cwd: string): string {
    const expected = this.resolveWorkspacePath(this.toWorkspaceKey(rawKey));
    const actual = path.resolve(cwd);
    if (actual !== expected) {
      throw new WorkspaceSafetyError(`worker cwd mismatch: expected ${expected}, got ${actual}`);
    }
    return expected;
  }

  toWorkspaceKey(rawKey: string): string {
    const key = sanitizeWorkspaceKey(rawKey);
    if (!key) {
      throw new WorkspaceSafetyError('workspace key became empty after sanitization');
    }
    return key;
  }

  resolveWorkspacePath(workspaceKey: string): string {
    const workspacePath = path.resolve(this.workspaceRoot, workspaceKey);
    this.assertWorkspacePath(workspacePath);
    return workspacePath;
  }

  assertWorkspacePath(candidatePath: string): void {
    const abs = path.resolve(candidatePath);
    const rel = path.relative(this.workspaceRoot, abs);
    if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) {
      return;
    }
    throw new WorkspaceSafetyError(
      `workspace path escapes root: root=${this.workspaceRoot} candidate=${abs}`,
    );
  }
}
