import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createLogger } from '../shared/index.js';
import {
  type DashboardSource,
  groupsView,
  outboxView,
  questionsView,
  runsView,
  statusView,
  summariesView,
} from './data.js';
import { PAGE_HTML } from './page.js';

export interface DashboardOptions extends DashboardSource {
  host: string;
  /** 0 picks a free port (tests). */
  port: number;
}

export interface DashboardHandle {
  url: string;
  port: number;
  stop(): Promise<void>;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;

function limitOf(url: URL): number {
  const raw = Number.parseInt(url.searchParams.get('limit') ?? '', 10);
  if (!Number.isInteger(raw) || raw < 1) return DEFAULT_LIMIT;
  return Math.min(raw, MAX_LIMIT);
}

/**
 * Read-only local dashboard: one HTML page plus JSON under /api/. No auth,
 * so it binds to loopback by default; nothing here can send, summarize, or
 * change config. Only GET is accepted.
 */
export function startDashboard(opts: DashboardOptions): Promise<DashboardHandle> {
  const log = createLogger('dashboard', { tenant_id: opts.tenantId });

  const routes: Record<string, (url: URL) => unknown> = {
    '/api/status': () => statusView(opts),
    '/api/groups': () => groupsView(opts),
    '/api/runs': (url) => runsView(opts, limitOf(url)),
    '/api/summaries': (url) => summariesView(opts, limitOf(url)),
    '/api/questions': (url) => questionsView(opts, limitOf(url)),
    '/api/outbox': (url) => outboxView(opts, limitOf(url)),
  };

  function handle(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD', 'Content-Type': 'text/plain' });
      res.end('method not allowed');
      return;
    }
    if (url.pathname === '/' || url.pathname === '/index.html') {
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      });
      res.end(req.method === 'HEAD' ? undefined : PAGE_HTML);
      return;
    }
    const route = routes[url.pathname];
    if (!route) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found');
      return;
    }
    try {
      const body = JSON.stringify(route(url));
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      });
      res.end(req.method === 'HEAD' ? undefined : body);
    } catch (e) {
      log.error({ err: e, path: url.pathname }, 'dashboard request failed');
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('internal error');
    }
  }

  return new Promise((resolve, reject) => {
    const server: Server = createServer(handle);
    server.once('error', reject);
    server.listen(opts.port, opts.host, () => {
      server.off('error', reject);
      const { port } = server.address() as AddressInfo;
      const host = opts.host.includes(':') ? `[${opts.host}]` : opts.host;
      const url = `http://${host}:${port}`;
      log.info({ url, host: opts.host, port }, 'dashboard listening');
      resolve({
        url,
        port,
        stop: () =>
          new Promise<void>((done) => {
            server.closeAllConnections?.();
            server.close(() => done());
          }),
      });
    });
  });
}
