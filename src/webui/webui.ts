import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Logger } from '../logging/logger.js';
import type { RuntimeStateSnapshot } from '../orchestrator/runtime.js';

export interface WebUIServerOptions {
  host?: string;
  port?: number;
  workflowPath: string;
  pollIntervalMs: number;
  maxConcurrency: number;
  getRuntimeSnapshot: () => RuntimeStateSnapshot;
  logger: Logger;
}

export interface WebUIServerHandle {
  host: string;
  port: number;
  stop(): Promise<void>;
}

function renderDashboardHtml(): string {
  return `
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Symphony GitHub Projects</title>
    <style>
      body {
        margin: 0;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        color: #e6edf3;
        background: #0d1117;
      }
      .container { max-width: 1000px; margin: 0 auto; padding: 2rem; }
      h1 { margin: 0 0 1rem; }
      .cards {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
        gap: 0.75rem;
        margin-bottom: 1rem;
      }
      .card {
        background: #161b22;
        border: 1px solid #30363d;
        border-radius: 8px;
        padding: 0.75rem;
      }
      .card h2 {
        margin: 0;
        font-size: 0.85rem;
        text-transform: uppercase;
        color: #8b949e;
      }
      .card p {
        margin: 0.4rem 0 0;
        font-size: 1.4rem;
      }
      table {
        width: 100%;
        border-collapse: collapse;
        margin-top: 1rem;
      }
      th, td {
        border: 1px solid #30363d;
        padding: 0.55rem;
        text-align: left;
      }
      th { background: #1f242a; }
      .muted { color: #8b949e; }
      .status { margin-bottom: 0.75rem; font-size: 0.95rem; }
      .error { color: #f85149; }
    </style>
  </head>
  <body>
    <div class="container">
      <h1>Symphony GitHub Projects</h1>
      <div id="status" class="status muted">Loading state…</div>
      <div class="cards">
        <div class="card"><h2>Running</h2><p id="runningCount">-</p></div>
        <div class="card"><h2>Retrying</h2><p id="retryingCount">-</p></div>
        <div class="card"><h2>Completed</h2><p id="completedCount">-</p></div>
        <div class="card"><h2>Usage (total)</h2><p id="usage">-</p></div>
      </div>

      <h2>Running Items</h2>
      <table>
        <thead>
          <tr><th>Item Id</th><th>Identifier</th><th>Session</th></tr>
        </thead>
        <tbody id="runningBody">
          <tr><td colspan="3" class="muted">No running items yet</td></tr>
        </tbody>
      </table>

      <h2>Retrying Items</h2>
      <table>
        <thead>
          <tr>
            <th>Item Id</th><th>Identifier</th><th>Kind</th><th>Attempt</th><th>Due</th>
          </tr>
        </thead>
        <tbody id="retryingBody">
          <tr><td colspan="5" class="muted">No retry entries</td></tr>
        </tbody>
      </table>
      <p class="muted" id="updatedAt"></p>
      <p class="muted" id="workflowInfo"></p>
    </div>

    <script>
      const runningBody = document.getElementById('runningBody');
      const retryingBody = document.getElementById('retryingBody');
      const runningCount = document.getElementById('runningCount');
      const retryingCount = document.getElementById('retryingCount');
      const completedCount = document.getElementById('completedCount');
      const usage = document.getElementById('usage');
      const updatedAt = document.getElementById('updatedAt');
      const status = document.getElementById('status');
      const workflowInfo = document.getElementById('workflowInfo');

      function renderRows(container, rows) {
        if (!rows.length) {
          container.innerHTML = '<tr><td colspan="3" class="muted">No items</td></tr>';
          return;
        }
        container.innerHTML = rows
          .map(function (row) {
            return (
              '<tr>' +
              '<td>' + row.itemId + '</td>' +
              '<td>' + row.issueIdentifier + '</td>' +
              '<td>' + (row.sessionId || '-') + '</td>' +
              '</tr>'
            );
          })
          .join('');
      }

      function renderRetryRows(container, rows) {
        if (!rows.length) {
          container.innerHTML = '<tr><td colspan="5" class="muted">No retry entries</td></tr>';
          return;
        }
        container.innerHTML = rows
          .map(function (row) {
            return (
              '<tr>' +
              '<td>' + row.itemId + '</td>' +
              '<td>' + row.issueIdentifier + '</td>' +
              '<td>' + row.kind + '</td>' +
              '<td>' + row.attempt + '</td>' +
              '<td>' + new Date(row.dueAt).toLocaleString() + '</td>' +
              '</tr>'
            );
          })
          .join('');
      }

      async function refresh() {
        try {
          const res = await fetch('/api/v1/state');
          if (!res.ok) {
            throw new Error('Request failed with status ' + res.status);
          }

          const data = await res.json();
          const snapshot = data.snapshot;

          status.textContent = 'Connected';
          status.className = 'status';

          runningCount.textContent = '' + snapshot.running.length;
          retryingCount.textContent = '' + snapshot.retryingDetails.length;
          completedCount.textContent = '' + snapshot.completed.length;
          usage.textContent = snapshot.usageTotals.totalTokens + ' (in:' + snapshot.usageTotals.inputTokens + ' out:' + snapshot.usageTotals.outputTokens + ')';

          renderRows(runningBody, snapshot.runningDetails);
          renderRetryRows(retryingBody, snapshot.retryingDetails);

          updatedAt.textContent = 'Updated: ' + new Date(snapshot.updatedAt).toLocaleString();
          workflowInfo.textContent = data.workflow.workflowPath + ' • interval=' + data.workflow.pollIntervalMs + 'ms • maxConcurrency=' + data.workflow.maxConcurrency;

          if (snapshot.latestRateLimit && snapshot.latestRateLimit.message) {
            status.textContent = 'Rate limited: ' + snapshot.latestRateLimit.message;
            status.className = 'status error';
          }
        } catch (error) {
          status.textContent = 'Failed to load state: ' + error.message;
          status.className = 'status error';
        }
      }

      async function refreshData() {
        await refresh();
      }

      refreshData();
      window.setInterval(refreshData, 3000);
    </script>
  </body>
</html>
`;
}

export async function startWebUIServer(options: WebUIServerOptions): Promise<WebUIServerHandle> {
  const host = options.host ?? '127.0.0.1';
  const requestedPort = options.port ?? 3000;
  const port = typeof requestedPort === 'number' && Number.isFinite(requestedPort) && requestedPort >= 0 ? Math.floor(requestedPort) : 3000;

  const html = renderDashboardHtml();
  const requestHandler = (req: IncomingMessage, res: ServerResponse): void => {
    const rawPath = req.url ?? '/';
    const url = new URL(rawPath, `http://${host}:${port}`);
    const pathname = url.pathname;

    if (pathname === '/api/v1/state') {
      const snapshot = options.getRuntimeSnapshot();
      const body = JSON.stringify({
        snapshot: {
          ...snapshot,
          usageTotals: { ...snapshot.usageTotals },
          retryAttempts: { ...snapshot.retryAttempts },
          runningDetails: snapshot.runningDetails,
          retryingDetails: snapshot.retryingDetails,
          latestRateLimit: snapshot.latestRateLimit,
          updatedAt: new Date().toISOString(),
        },
        workflow: {
          workflowPath: options.workflowPath,
          pollIntervalMs: options.pollIntervalMs,
          maxConcurrency: options.maxConcurrency,
        },
      });

      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(body);
      return;
    }

    if (pathname === '/health' || pathname === '/healthz') {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end('{"status":"ok"}');
      return;
    }

    if (pathname === '/') {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(html);
      return;
    }

    res.statusCode = 404;
    res.end('Not found');
  };

  const server = createServer(requestHandler);

  return await new Promise((resolve, reject) => {
    server.once('error', (error) => {
      options.logger.error('webui.server.error', {
        message: error instanceof Error ? error.message : String(error),
        host,
        port,
      });
      reject(error);
    });

    server.listen(port, host, () => {
      const address = server.address();
      const resolvedPort = typeof address === 'object' && address ? address.port : port;
      options.logger.info('webui.server.started', {
        host,
        port: resolvedPort,
        workflowPath: options.workflowPath,
      });

      resolve({
        host,
        port: resolvedPort,
        stop: () => {
          return new Promise((stopResolve) => {
            server.close(() => {
              options.logger.info('webui.server.stopped', { host, port: resolvedPort });
              stopResolve();
            });
          });
        },
      });
    });
  });
}
