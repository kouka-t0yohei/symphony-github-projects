#!/usr/bin/env node
import { JsonConsoleLogger } from './logging/logger.js';
import { bootstrapFromWorkflow, type BootstrapResult } from './bootstrap.js';
import { PollingRuntime } from './orchestrator/runtime.js';
import { FileWorkflowLoader, type LoadedWorkflowContract, type WorkflowLoader } from './workflow/contract.js';
import { WorkflowHotReloader } from './workflow/hot-reload.js';
import { startWebUIServer, type WebUIServerHandle, type WebUIServerOptions } from './webui/webui.js';
import type { Logger } from './logging/logger.js';

interface WebUIConfig {
  enabled: boolean;
  host: string;
  port: number;
}

interface ServiceConfig {
  workflowPath: string;
  webUI: WebUIConfig;
}

interface ReloaderLike {
  start(initialContract: LoadedWorkflowContract): void;
  stop(): void;
}

interface ServiceDependencies {
  workflowLoader?: WorkflowLoader;
  bootstrap?: (
    workflowPath: string,
    deps: {
      workflowLoader: WorkflowLoader;
      logger: Logger;
    },
  ) => Promise<BootstrapResult>;
  reloaderFactory?: (options: {
    workflowPath: string;
    loader: WorkflowLoader;
    logger: Logger;
    onReload: (contract: LoadedWorkflowContract) => void;
  }) => ReloaderLike;
  webUIServerFactory?: (options: Omit<WebUIServerOptions, 'logger'> & { logger: Logger }) => Promise<WebUIServerHandle>;
  logger?: Logger;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
  installSignalHandlers?: boolean;
}

export interface ServiceHandle {
  stop: () => void;
}

const DEFAULT_WORKFLOW_PATH = 'WORKFLOW.md';
const DEFAULT_WEBUI_HOST = '127.0.0.1';
const DEFAULT_WEBUI_PORT = 3000;

export function parseArgs(argv: string[]): ServiceConfig {
  let workflowPath = process.env.WORKFLOW_PATH ?? DEFAULT_WORKFLOW_PATH;
  let webUIEnabled = process.env.WEBUI_ENABLED === '1';
  let webUIHost = process.env.WEBUI_HOST ?? DEFAULT_WEBUI_HOST;
  let webUIPort = parsePort(process.env.WEBUI_PORT, DEFAULT_WEBUI_PORT);

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === '--help' || arg === '-h') {
      printUsage();
      process.exit(0);
    }

    if ((arg === '--workflow' || arg === '-w') && i + 1 < argv.length) {
      workflowPath = argv[i + 1];
      i += 1;
      continue;
    }

    if (arg === '--webui') {
      webUIEnabled = true;
      continue;
    }

    if (arg === '--webui-host' && i + 1 < argv.length) {
      webUIHost = argv[i + 1];
      i += 1;
      continue;
    }

    if (arg === '--webui-port' && i + 1 < argv.length) {
      webUIPort = parsePort(argv[i + 1], DEFAULT_WEBUI_PORT);
      i += 1;
      continue;
    }
  }

  return {
    workflowPath,
    webUI: {
      enabled: webUIEnabled,
      host: webUIHost,
      port: webUIPort,
    },
  };
}

function parsePort(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) {
    return fallback;
  }
  return parsed;
}

function printUsage(): void {
  // eslint-disable-next-line no-console
  console.log(
    `Usage: node dist/cli.js [--workflow path | -w path] [--webui --webui-host host --webui-port 3000]\n` +
      'Starts Symphony-GitHub-Projects runtime loop using the specified WORKFLOW.md.',
  );
}

export async function startService(config: ServiceConfig, deps: ServiceDependencies = {}): Promise<ServiceHandle> {
  const logger = deps.logger ?? new JsonConsoleLogger();
  const workflowPath = config.workflowPath;
  const workflowLoader = deps.workflowLoader ?? new FileWorkflowLoader();

  const bootstrap = deps.bootstrap ?? bootstrapFromWorkflow;
  const reloaderFactory =
    deps.reloaderFactory ??
    ((options) => new WorkflowHotReloader(options) as unknown as ReloaderLike);

  const setTimeoutFn = deps.setTimeoutFn ?? setTimeout;
  const clearTimeoutFn = deps.clearTimeoutFn ?? clearTimeout;

  const bootstrapResult = await bootstrap(workflowPath, {
    workflowLoader,
    logger,
  });

  const runtime = bootstrapResult.runtime as PollingRuntime;
  let currentPollIntervalMs = bootstrapResult.workflow.polling.intervalMs;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlightTick = false;
  let stopping = false;
  let webUIServer: WebUIServerHandle | null = null;

  const tick = async (): Promise<void> => {
    if (stopping) return;
    if (inFlightTick) {
      logger.warn('runtime.tick.skip_in_progress');
      return;
    }

    inFlightTick = true;
    try {
      await runtime.tick();
    } catch (error) {
      logger.error('runtime.tick.failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      inFlightTick = false;
      if (!stopping) {
        scheduleNextTick(currentPollIntervalMs);
      }
    }
  };

  const scheduleNextTick = (delayMs: number): void => {
    if (stopping) return;

    if (timer !== null) {
      clearTimeoutFn(timer);
      timer = null;
    }

    timer = setTimeoutFn(() => {
      void tick();
    }, Math.max(0, delayMs));
  };

  const applyWorkflow = (contract: LoadedWorkflowContract): void => {
    try {
      runtime.applyWorkflow(contract);
      currentPollIntervalMs = Math.max(1_000, contract.polling.intervalMs);
      logger.info('runtime.config.reloaded', {
        pollIntervalMs: currentPollIntervalMs,
        maxConcurrency: contract.polling.maxConcurrency,
        maxConcurrencyRuntime: contract.runtime.maxConcurrency,
      });
      if (!stopping) {
        scheduleNextTick(currentPollIntervalMs);
      }
    } catch (error) {
      logger.error('runtime.config.reload_failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const reloader = reloaderFactory({
    workflowPath,
    loader: workflowLoader,
    logger,
    onReload: applyWorkflow,
  });

  const startWebUI = async (): Promise<void> => {
    if (!config.webUI.enabled) {
      return;
    }

    const factory = deps.webUIServerFactory ?? startWebUIServer;
    webUIServer = await factory({
      logger,
      workflowPath,
      host: config.webUI.host,
      port: config.webUI.port,
      pollIntervalMs: bootstrapResult.workflow.polling.intervalMs,
      maxConcurrency: bootstrapResult.workflow.runtime.maxConcurrency ?? bootstrapResult.workflow.polling.maxConcurrency ?? 1,
      getRuntimeSnapshot: () => runtime.snapshot(),
    });
  };

  const stop = (): void => {
    if (stopping) return;
    stopping = true;

    if (timer !== null) {
      clearTimeoutFn(timer);
      timer = null;
    }
    if (webUIServer !== null) {
      void webUIServer.stop();
      webUIServer = null;
    }
    reloader.stop();
    logger.info('service.shutdown_requested');
  };

  const handleShutdown = (): void => {
    stop();
  };

  if (deps.installSignalHandlers !== false) {
    process.on('SIGINT', handleShutdown);
    process.on('SIGTERM', handleShutdown);
  }

  reloader.start(bootstrapResult.workflow);
  await startWebUI();
  logger.info('service.started', {
    workflowPath,
    pollIntervalMs: currentPollIntervalMs,
    maxConcurrency: bootstrapResult.workflow.polling.maxConcurrency,
    runtimeKind: bootstrapResult.workflow.tracker.kind,
    webUIEnabled: config.webUI.enabled,
  });

  scheduleNextTick(0);

  return { stop };
}

if (process.argv[1]?.endsWith('dist/cli.js')) {
  const config = parseArgs(process.argv.slice(2));
  void startService(config).catch((error) => {
    // eslint-disable-next-line no-console
    console.error(
      JSON.stringify({
        ts: new Date().toISOString(),
        level: 'error',
        message: 'service.bootstrap_failed',
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    process.exitCode = 1;
  });
}

export type { PollingRuntime } from './orchestrator/runtime.js';
