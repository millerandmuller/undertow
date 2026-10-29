import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DisplayState } from '../run.ts';

export type OverlaySnapshot = Omit<DisplayState, 'subscribe' | 'publish'>;
export type OverlayOptions = {
  heartbeatIntervalMs?: number;
  mapState?: (state: DisplayState) => OverlaySnapshot;
};
type Client = {
  response: ServerResponse;
  unsubscribe: () => void;
};

const PUBLIC_DIRECTORY = join(dirname(fileURLToPath(import.meta.url)), 'public');
const STATIC_FILES: Record<string, { file: string; contentType: string }> = {
  '/overlay.css': { file: 'overlay.css', contentType: 'text/css; charset=utf-8' },
  '/overlay.js': { file: 'overlay.js', contentType: 'text/javascript; charset=utf-8' },
  '/gauge.js': { file: 'gauge.js', contentType: 'text/javascript; charset=utf-8' },
};

function snapshot(state: DisplayState): OverlaySnapshot {
  return {
    pace: state.pace,
    setpoint: state.setpoint,
    step: state.step,
    mode: state.mode,
    stepLabel: state.stepLabel,
    stepCount: state.stepCount,
    warning: state.warning,
    warningHoldSeconds: state.warningHoldSeconds,
    ratelimitRemaining: state.ratelimitRemaining,
    ratelimitLimit: state.ratelimitLimit,
    paceSource: state.paceSource,
    badge: state.badge,
    lastReason: state.lastReason,
  };
}

function sendState(response: ServerResponse, state: OverlaySnapshot): void {
  response.write(`event: state\ndata: ${JSON.stringify(state)}\n\n`);
}

function sendNotFound(response: ServerResponse): void {
  response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  response.end('not found');
}

async function serveStatic(
  pathname: string,
  response: ServerResponse,
): Promise<void> {
  const path = pathname === '/' ? '/index.html' : pathname;
  if (path === '/index.html') {
    await writeStatic(response, 'index.html', 'text/html; charset=utf-8');
    return;
  }
  const item = STATIC_FILES[path];
  if (!item) {
    sendNotFound(response);
    return;
  }
  await writeStatic(response, item.file, item.contentType);
}

async function writeStatic(
  response: ServerResponse,
  file: string,
  contentType: string,
): Promise<void> {
  try {
    const content = await readFile(join(PUBLIC_DIRECTORY, file));
    response.writeHead(200, {
      'Content-Type': contentType,
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'self'; connect-src 'self'; " +
        "style-src 'self' 'unsafe-inline'; script-src 'self'",
    });
    response.end(content);
  } catch {
    response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('overlay asset unavailable');
  }
}

function serveEvents(
  request: IncomingMessage,
  response: ServerResponse,
  display: DisplayState,
  clients: Set<Client>,
  mapState: (state: DisplayState) => OverlaySnapshot,
): void {
  response.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const client: Client = { response, unsubscribe: () => undefined };
  const remove = (): void => {
    if (!clients.delete(client)) return;
    client.unsubscribe();
  };
  client.unsubscribe = display.subscribe((state) => sendState(response, mapState(state)));
  clients.add(client);
  request.on('aborted', remove);
  response.on('close', remove);
}

export async function startOverlayServer(
  display: DisplayState,
  port = 8787,
  options: OverlayOptions = {},
): Promise<{ url: string; port: number; stop(): Promise<void> }> {
  const clients = new Set<Client>();
  const project = options.mapState ?? snapshot;
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (request.method !== 'GET') {
      sendNotFound(response);
      return;
    }
    if (url.pathname === '/state') {
      response.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      });
      response.end(JSON.stringify(project(display)));
      return;
    }
    if (url.pathname === '/events') {
      serveEvents(request, response, display, clients, project);
      return;
    }
    void serveStatic(url.pathname, response);
  });
  const heartbeatMs = options.heartbeatIntervalMs ?? 5000;
  const heartbeat = setInterval(() => {
    for (const client of clients) {
      client.response.write(': heartbeat\n\n');
      client.response.write('event: heartbeat\ndata: {}\n\n');
    }
  }, heartbeatMs);
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', resolve);
    });
  } catch (error) {
    clearInterval(heartbeat);
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    throw error;
  }
  const address = server.address();
  if (!address || typeof address === 'string') {
    clearInterval(heartbeat);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new Error('Overlay server did not report its listening address');
  }
  const actualPort = address.port;
  let stopped = false;
  return {
    url: `http://127.0.0.1:${actualPort}/`,
    port: actualPort,
    async stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(heartbeat);
      for (const client of [...clients]) {
        client.unsubscribe();
        client.response.end();
        clients.delete(client);
      }
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    },
  };
}
