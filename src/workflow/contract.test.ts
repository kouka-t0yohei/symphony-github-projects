import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildContract, FileWorkflowLoader, WorkflowContractBuildError } from './contract.js';
import type { WorkflowDocument } from './loader.js';

test('buildContract maps WorkflowDocument to LoadedWorkflowContract', () => {
  const doc: WorkflowDocument = {
    config: {
      tracker: {
        kind: 'github_projects',
        github: {
          owner: 'kouka-t0yohei',
          projectNumber: 123,
        },
        auth: {
          tokenEnv: 'GITHUB_TOKEN',
        },
      },
      polling: {
        intervalMs: 5000,
        maxConcurrency: 3,
      },
      workspace: {
        baseDir: './tmp/workspaces',
      },
      agent: {
        command: 'codex',
        args: ['run'],
      },
      hooks: {
        onStart: 'echo start',
      },
    },
    prompt_template: 'Do the thing',
  };

  const contract = buildContract(doc);

  assert.equal(contract.tracker.github.owner, 'kouka-t0yohei');
  assert.equal(contract.tracker.github.projectNumber, 123);
  assert.equal(contract.tracker.github.tokenEnv, 'GITHUB_TOKEN');
  assert.equal(contract.polling.intervalMs, 5000);
  assert.equal(contract.polling.maxConcurrency, 3);
  assert.deepEqual(contract.agent.args, ['run']);
  assert.equal(contract.hooks?.onStart, 'echo start');
  assert.equal(contract.prompt_template, 'Do the thing');
});

test('buildContract surfaces validation errors clearly', () => {
  const doc: WorkflowDocument = {
    config: {
      tracker: {
        kind: 'github_projects',
        github: {
          projectNumber: 1,
        },
      },
    },
    prompt_template: 'Prompt',
  };

  assert.throws(
    () => buildContract(doc),
    (error: unknown) => {
      assert.ok(error instanceof WorkflowContractBuildError);
      assert.match(error.message, /Invalid WORKFLOW\.md front matter/);
      assert.ok(error.validationErrors.length > 0);
      assert.ok(error.validationErrors.some((entry) => entry.path === 'tracker.github.owner'));
      return true;
    },
  );
});

test('FileWorkflowLoader reads file and returns contract with prompt template', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'workflow-contract-loader-'));
  const filePath = join(dir, 'WORKFLOW.md');
  await writeFile(
    filePath,
    `---
tracker:
  kind: github_projects
  github:
    owner: kouka-t0yohei
    projectNumber: 99
  auth:
    tokenEnv: GITHUB_TOKEN
polling:
  intervalMs: 5000
workspace:
  baseDir: ./tmp/workspaces
agent:
  command: codex
---
\nPrompt from file\n`,
    'utf8',
  );

  const loader = new FileWorkflowLoader();
  const workflow = await loader.load(filePath);

  assert.equal(workflow.tracker.github.owner, 'kouka-t0yohei');
  assert.equal(workflow.tracker.github.projectNumber, 99);
  assert.equal(workflow.prompt_template, 'Prompt from file');
});
