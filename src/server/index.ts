import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { BoardError } from '../shared/errors';
import { packageVersion, stateDir } from '../shared/paths';
import type { Store } from '../shared/store';
import type { Labels } from '../shared/types';

const CONTENT_TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
};
const EVENT_POLL_MS = 250;

export interface AppOptions {
  store: Store;
  /** The handle browser writes are attributed to. */
  person: string;
  webRoot?: string;
}

export function createApp({ store, person, webRoot = defaultWebRoot() }: AppOptions): Hono {
  const app = new Hono();
  // The server has no auth, so only pages it served may reach it: the Host check stops DNS
  // rebinding, and the Origin check stops other sites from reaching localhost. Any port is
  // accepted because an SSH tunnel may forward the board to a different local port.
  app.use(async (c, next) => {
    const origin = c.req.header('origin');
    if (
      !isLoopback(c.req.header('host')) ||
      (origin && !isLoopback(origin.replace(/^http:\/\//, '')))
    ) {
      return c.json({ reason: 'forbidden', message: 'Requests must come from this board.' }, 403);
    }
    // Writes are recorded as the person's, made on the page, so they must carry the page's own
    // origin: the scheme and Host the browser loaded it from, which for a tunnel or forwarded
    // port is that port. This keeps a bare curl or another local page from writing as `web`;
    // it is not authentication.
    if (c.req.method !== 'GET' && origin !== `http://${c.req.header('host')}`) {
      return c.json(
        { reason: 'forbidden', message: "Writes must come from the board's own page." },
        403,
      );
    }
    return next();
  });

  app.onError((error, c) => {
    if (error instanceof BoardError) {
      return c.json(
        { reason: error.reason, message: error.message },
        error.reason === 'not_found' ? 404 : 400,
      );
    }
    throw error;
  });

  app.get('/api/health', (c) =>
    c.json({ ok: true, version: packageVersion, stateDir: stateDir(), person }),
  );

  app.get('/api/channels', (c) => c.json({ channels: store.channels() }));

  app.get('/api/threads', (c) =>
    c.json({
      threads: store.listThreads({
        channel: c.req.query('channel'),
        labels: c.req.queries('label'),
        text: c.req.query('text'),
        limit: 500,
      }),
      cursor: store.lastCursor(),
    }),
  );

  app.get('/api/threads/:id', (c) => c.json(store.getThread(c.req.param('id'))));

  app.post('/api/threads', async (c) => {
    const body = await c.req.json<{ channel: string; text: string; labels?: Labels }>();
    const { message } = store.post({
      channel: body.channel,
      text: body.text,
      author: person,
      labels: body.labels,
      via: 'web',
    });
    return c.json(store.getThread(message.id));
  });

  app.post('/api/threads/:id/replies', async (c) => {
    const body = await c.req.json<{ text: string }>();
    store.reply({ id: c.req.param('id'), text: body.text, author: person, via: 'web' });
    return c.json(store.getThread(c.req.param('id')));
  });

  app.post('/api/threads/:id/labels', async (c) => {
    const body = await c.req.json<{ set?: Record<string, string>; unset?: string[] }>();
    store.label({
      id: c.req.param('id'),
      actor: person,
      via: 'web',
      set: body.set,
      unset: body.unset,
    });
    return c.json(store.getThread(c.req.param('id')));
  });

  app.get('/api/events', (c) =>
    streamSSE(c, async (stream) => {
      let cursor = Number(c.req.header('last-event-id') ?? store.lastCursor());
      while (!stream.aborted) {
        for (const event of store.eventsAfter(cursor)) {
          cursor = event.cursor;
          await stream.writeSSE({ id: String(cursor), data: JSON.stringify(event) });
        }
        await stream.sleep(EVENT_POLL_MS);
      }
    }),
  );

  app.get('*', async (c) => {
    const requested = path.normalize(c.req.path).replace(/^[/\\]+/, '');
    const isAsset = requested.startsWith('assets/') && !requested.includes('..');
    const file = isAsset ? requested : 'index.html';
    try {
      const body = await readFile(path.join(webRoot, file));
      return c.body(body, 200, {
        'content-type': CONTENT_TYPES[path.extname(file)] ?? 'application/octet-stream',
      });
    } catch {
      return c.text('Not found. Run pnpm build to build the web UI.', 404);
    }
  });

  return app;
}

function isLoopback(host: string | undefined): boolean {
  return (
    host !== undefined && ['localhost', '127.0.0.1', '[::1]'].includes(host.replace(/:\d+$/, ''))
  );
}

function defaultWebRoot(): string {
  return fileURLToPath(new URL('../web/', import.meta.url));
}
