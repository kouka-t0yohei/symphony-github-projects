import { JsonConsoleLogger, type Logger } from './logging/logger.js';
import { PollingRuntime, type OrchestratorRuntime } from './orchestrator/runtime.js';
import { GitHubProjectsAdapter, type TrackerAdapter } from './tracker/adapter.js';
import { GraphQLClient } from './tracker/graphql-client.js';
import { GitHubProjectsGraphQLClient } from './tracker/github-projects-client.js';
import {
  FileWorkflowLoader,
  type LoadedWorkflowContract,
  type WorkflowLoader,
} from './workflow/contract.js';

export interface BootstrapDependencies {
  workflowLoader?: WorkflowLoader;
  trackerAdapter?: TrackerAdapter;
  logger?: Logger;
}

export interface BootstrapResult {
  workflow: LoadedWorkflowContract;
  runtime: OrchestratorRuntime;
  logger: Logger;
}

export class BootstrapConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BootstrapConfigurationError';
  }
}

export async function bootstrapFromWorkflow(
  workflowPath: string,
  deps: BootstrapDependencies = {},
): Promise<BootstrapResult> {
  const workflowLoader = deps.workflowLoader ?? new FileWorkflowLoader();
  const logger = deps.logger ?? new JsonConsoleLogger();

  const workflow = await workflowLoader.load(workflowPath);
  const tracker = deps.trackerAdapter ?? createTrackerFromWorkflow(workflow);
  const runtime = new PollingRuntime(tracker, workflow, logger);

  logger.info('bootstrap.ready', {
    workflowPath,
    tracker: workflow.tracker.kind,
    maxConcurrency: workflow.polling.maxConcurrency ?? 1,
    pollIntervalMs: workflow.polling.intervalMs,
  });

  return {
    workflow,
    runtime,
    logger,
  };
}

function createTrackerFromWorkflow(workflow: LoadedWorkflowContract): TrackerAdapter {
  const { owner, projectNumber, tokenEnv } = workflow.tracker.github;
  const token = process.env[tokenEnv]?.trim();

  if (!token) {
    throw new BootstrapConfigurationError(
      `Missing tracker auth token environment variable: ${tokenEnv}`,
    );
  }

  const graphQLClient = new GraphQLClient({ token });
  const projectsClient = new GitHubProjectsGraphQLClient(graphQLClient);

  return new GitHubProjectsAdapter({
    owner,
    projectNumber,
    client: projectsClient,
  });
}
