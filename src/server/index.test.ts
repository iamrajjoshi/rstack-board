import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseJson } from '../shared/json';
import { Store } from '../shared/store';
import { tempDir } from '../test/run';
import type { BoardEvent, Thread, ThreadSummary } from '../shared/types';
import { createApp } from './index';

const HOST = { host: 'localhost:4477' };
/** What the board's own page sends with a write. */
const PAGE = { ...HOST, origin: 'http://localhost:4477' };

async function readJson<T>(response: Response): Promise<T> {
  return parseJson<T>(await response.text());
}

/** Reads the first event from an open event stream, then closes it. */
async function readEvent(response: Response): Promise<BoardEvent> {
  if (!response.body) {
    throw new Error('The event stream has no body.');
  }
  const reader = response.body.getReader();
  let text = '';
  while (!text.includes('\n\n')) {
    text += new TextDecoder().decode((await reader.read()).value);
  }
  await reader.cancel();
  return parseJson<BoardEvent>(/^data: (.*)$/m.exec(text)?.[1] ?? '');
}

function setup() {
  const store = new Store(':memory:');
  const app = createApp({ store, person: 'raj', webRoot: '/nonexistent' });
  const get = (path: string) => app.request(path, { headers: HOST });
  const post = (path: string, body: unknown, headers = {}) =>
    app.request(path, {
      method: 'POST',
      headers: { ...PAGE, 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
  return { store, app, get, post };
}

describe('reads', () => {
  it('lists threads filtered by channel and label', async () => {
    const { store, get } = setup();
    store.post({
      channel: 'prs/ui',
      text: 'cart badge',
      author: 'ui',
      labels: { needs: 'approval' },
    });
    store.post({
      channel: 'prs/backend',
      text: 'gift cards',
      author: 'web',
      labels: { state: 'ready' },
    });

    const needs = await readJson<{ threads: ThreadSummary[] }>(
      await get('/api/threads?label=needs'),
    );
    expect(needs.threads.map((thread) => thread.title)).toEqual(['cart badge']);
    const backend = await readJson<{ threads: ThreadSummary[] }>(
      await get('/api/threads?channel=prs/backend'),
    );
    expect(backend.threads.map((thread) => thread.title)).toEqual(['gift cards']);
    expect((await (await get('/api/channels')).json()).channels).toHaveLength(2);
  });

  it('answers 404 with a reason for an unknown thread', async () => {
    const response = await setup().get('/api/threads/msg_missing');
    expect(response.status).toBe(404);
    expect((await response.json()).reason).toBe('not_found');
  });
});

describe('writes from the browser', () => {
  it('posts replies and label changes as the person', async () => {
    const { store, post } = setup();
    const { message } = store.post({
      channel: 'needs-you',
      text: 'merge?',
      author: 'coordinator',
      labels: { needs: 'decision' },
    });
    const start = store.cursorOf(message.id);

    await post(`/api/threads/${message.id}/replies`, { text: 'yes' });
    const response = await post(`/api/threads/${message.id}/labels`, {
      set: { decision: 'approved' },
      unset: ['needs'],
    });
    const thread = await readJson<Thread>(response);

    expect(thread.replies.map((reply) => [reply.author, reply.text, reply.via])).toEqual([
      ['raj', 'yes', 'web'],
    ]);
    expect(thread.message.via).toBe('cli');
    expect(thread.labels).toEqual({ decision: 'approved' });
    // These are the events an agent's `wait` on the thread wakes on.
    expect(store.eventsAfter(start).map((event) => [event.actor, event.via])).toEqual([
      ['raj', 'web'],
      ['raj', 'web'],
    ]);
  });

  it('starts a thread as the person, with its labels', async () => {
    const { store, post } = setup();
    const response = await post('/api/threads', {
      channel: 'tasks',
      text: 'Rebase #103',
      labels: { state: 'ready' },
    });
    const thread = await readJson<Thread>(response);

    expect(thread).toMatchObject({ channel: 'tasks', title: 'Rebase #103' });
    expect(thread.message).toMatchObject({ author: 'raj', via: 'web' });
    expect(store.claim({ channel: 'tasks', actor: 'agent' }).id).toBe(thread.id);
  });

  it('rejects an empty reply with its reason', async () => {
    const { store, post } = setup();
    const { message } = store.post({ channel: 'dev', text: 'x', author: 'a' });
    const response = await post(`/api/threads/${message.id}/replies`, { text: '  ' });
    expect(response.status).toBe(400);
    expect((await response.json()).reason).toBe('empty_message');
  });
});

describe('local-only access', () => {
  it('refuses another host name and cross-site origins', async () => {
    const { store, app, post } = setup();
    const { message } = store.post({ channel: 'dev', text: 'x', author: 'a' });

    for (const host of ['evil.test:4477', 'localhost.evil.test']) {
      expect((await app.request('/api/threads', { headers: { host } })).status).toBe(403);
    }
    const crossSite = await post(
      `/api/threads/${message.id}/replies`,
      { text: 'injected' },
      { origin: 'https://evil.test' },
    );
    expect(crossSite.status).toBe(403);
    expect(store.getThread(message.id).replies).toEqual([]);

    // A tunnelled board is still loopback on another port.
    const sameOrigin = await post(
      `/api/threads/${message.id}/replies`,
      { text: 'ok' },
      { host: '127.0.0.1:9000', origin: 'http://127.0.0.1:9000' },
    );
    expect(sameOrigin.status).toBe(200);
  });
});

describe('writes recorded as the web page', () => {
  it('need the origin of the page they are sent to', async () => {
    const { store, app, post } = setup();
    const { message } = store.post({ channel: 'dev', text: 'x', author: 'a' });
    const write = (path: string, body: unknown, origin?: string) =>
      app.request(path, {
        method: 'POST',
        headers: { ...HOST, 'content-type': 'application/json', ...(origin ? { origin } : {}) },
        body: JSON.stringify(body),
      });

    // No Origin, as from a bare curl; another loopback port; another name or scheme for the host.
    for (const origin of [
      undefined,
      'http://localhost:3773',
      'http://127.0.0.1:4477',
      'https://localhost:4477',
    ]) {
      for (const [path, body] of [
        [`/api/threads/${message.id}/replies`, { text: 'injected' }],
        [`/api/threads/${message.id}/labels`, { set: { decision: 'approved' } }],
        ['/api/threads', { channel: 'dev', text: 'injected' }],
      ] as const) {
        const response = await write(path, body, origin);
        expect(response.status).toBe(403);
        expect((await response.json()).reason).toBe('forbidden');
      }
    }
    expect(store.listThreads()).toHaveLength(1);
    const labels = await post(`/api/threads/${message.id}/labels`, { set: { needs: 'x' } });
    expect(labels.status).toBe(200);
    expect(store.getThread(message.id).replies).toEqual([]);
    expect(store.getThread(message.id).labels).toEqual({ needs: 'x' });
  });
});

describe('embedding in rstack code', () => {
  it('serves the page and API on any forwarded loopback port, without frame restrictions', async () => {
    const webRoot = tempDir();
    mkdirSync(join(webRoot, 'assets'));
    writeFileSync(join(webRoot, 'index.html'), '<!doctype html><div id="root"></div>');
    const store = new Store(':memory:');
    const { message } = store.post({ channel: 'dev', text: 'x', author: 'a' });
    const app = createApp({ store, person: 'raj', webRoot });

    for (const host of ['127.0.0.1:53124', 'localhost:61000', '[::1]:4478']) {
      const page = await app.request('/', { headers: { host } });
      expect(page.status).toBe(200);
      // rstack code shows the board inside its own browser panel, so nothing may forbid framing.
      expect(page.headers.get('x-frame-options')).toBeNull();
      expect(page.headers.get('content-security-policy')).toBeNull();

      // The page's own requests carry its forwarded origin, and may read and write.
      const reply = await app.request(`/api/threads/${message.id}/replies`, {
        method: 'POST',
        headers: { host, origin: `http://${host}`, 'content-type': 'application/json' },
        body: JSON.stringify({ text: `from ${host}` }),
      });
      expect(reply.status).toBe(200);
      // A page on another loopback port, such as the panel's app, may only read.
      const read = await app.request('/api/channels', {
        headers: { host, origin: 'http://localhost:3773' },
      });
      expect(read.status).toBe(200);
    }

    // Anything that is not loopback is still refused.
    for (const origin of ['https://evil.test', 'http://127.0.0.1.evil.test', 'null']) {
      const response = await app.request(`/api/threads/${message.id}/replies`, {
        method: 'POST',
        headers: { host: '127.0.0.1:53124', origin, 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'injected' }),
      });
      expect(response.status).toBe(403);
    }
    expect(store.getThread(message.id).replies.map((reply) => reply.text)).not.toContain(
      'injected',
    );
  });
});

describe('event stream', () => {
  it('sends events written after the stream opened, and resumes after Last-Event-ID', async () => {
    const { store, app, get } = setup();
    const { message } = store.post({ channel: 'dev', text: 'before', author: 'a' });

    const live = await get('/api/events');
    store.reply({ id: message.id, text: 'after', author: 'b' });
    const event = await readEvent(live);
    expect(event).toMatchObject({ type: 'message.posted', actor: 'b' });

    const resumed = await app.request('/api/events', {
      headers: { ...HOST, 'last-event-id': '0' },
    });
    expect(await readEvent(resumed)).toMatchObject({ cursor: 1, actor: 'a' });
  });
});
