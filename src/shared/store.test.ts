import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runScript, tempDir } from '../test/run';
import { BoardError } from './errors';
import { Store } from './store';

const memory = () => new Store(':memory:');
const reason = (fn: () => unknown): string => {
  try {
    fn();
  } catch (error) {
    if (error instanceof BoardError) {
      return error.reason;
    }
    throw error;
  }
  return 'no error';
};

describe('messages', () => {
  it('threads replies under the root and titles the thread by its first line', () => {
    const store = memory();
    const { message } = store.post({
      channel: 'prs/backend',
      text: '**#12 Add gift cards**\n\nDetails',
      author: 'checkout',
      labels: { state: 'review', pr: '12' },
    });
    const reply = store.reply({ id: message.id, text: 'rebased', author: 'checkout' });
    // Replying to a reply still lands in the same thread.
    store.reply({ id: reply.message.id, text: 'looks good', author: 'raj' });

    const thread = store.getThread(reply.message.id);
    expect(thread.id).toBe(message.id);
    expect(thread.title).toBe('#12 Add gift cards');
    expect(thread.labels).toEqual({ pr: '12', state: 'review' });
    expect(thread.replies.map((r) => r.text)).toEqual(['rebased', 'looks good']);
    expect(thread.last.author).toBe('raj');
  });

  it('returns the first message when an idempotency key is reused', () => {
    const store = memory();
    const first = store.post({ channel: 'dev', text: 'once', author: 'a', idempotencyKey: 'k1' });
    const retry = store.post({ channel: 'dev', text: 'again', author: 'a', idempotencyKey: 'k1' });
    const reply = { id: first.message.id, text: 'r', author: 'a', idempotencyKey: 'k2' };
    store.reply(reply);
    store.reply(reply);

    expect(retry).toEqual({ message: first.message, created: false });
    expect(store.listThreads()).toHaveLength(1);
    expect(store.getThread(first.message.id).replies).toHaveLength(1);
  });

  it('redacts secrets from text and label values before storing them', () => {
    const store = memory();
    const { message } = store.post({
      channel: 'dev',
      text: 'key is sk-abcdefghijklmnopqrstuvwxyz123456 and GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789',
      author: 'a',
      labels: { note: 'xoxb-1234567890-abcdefghij' },
    });
    expect(message.text).toBe('key is [redacted] and GITHUB_TOKEN=[redacted]');
    expect(store.getThread(message.id).labels.note).toBe('[redacted]');
  });

  it('rejects malformed channels, labels and unknown ids', () => {
    const store = memory();
    expect(reason(() => store.post({ channel: 'Bad Channel', text: 'x', author: 'a' }))).toBe(
      'invalid_channel',
    );
    expect(
      reason(() => store.post({ channel: 'dev', text: 'x', author: 'a', labels: { 'A b': 'c' } })),
    ).toBe('invalid_label');
    expect(reason(() => store.reply({ id: 'msg_missing', text: 'x', author: 'a' }))).toBe(
      'not_found',
    );
    expect(store.listThreads()).toEqual([]);
  });
});

describe('labels and filters', () => {
  it('applies a label change only when its preconditions hold', () => {
    const store = memory();
    const { message } = store.post({ channel: 'dev', text: 'x', author: 'a' });
    store.label({ id: message.id, actor: 'a', set: { owner: 'a' }, ifUnset: ['owner'] });

    expect(
      reason(() =>
        store.label({ id: message.id, actor: 'b', set: { owner: 'b' }, ifUnset: ['owner'] }),
      ),
    ).toBe('precondition_failed');
    expect(
      reason(() =>
        store.label({ id: message.id, actor: 'b', unset: ['owner'], ifEquals: { owner: 'b' } }),
      ),
    ).toBe('precondition_failed');
    expect(store.getThread(message.id).labels).toEqual({ owner: 'a' });
  });

  it('filters threads by channel subtree, label values, text and author', () => {
    const store = memory();
    const post = (channel: string, text: string, labels = {}) =>
      store.post({ channel, text, author: 'a', labels }).message.id;
    const ready = post('prs/backend', 'gift cards', { state: 'ready' });
    const review = post('prs/ui', 'cart badge', { state: 'review', needs: 'approval' });
    const other = post('prs-old', 'archive', { state: 'ready' });
    store.reply({ id: review, text: 'the badge overlaps', author: 'raj' });

    const ids = (filter: Parameters<Store['listThreads']>[0]) =>
      store
        .listThreads(filter)
        .map((thread) => thread.id)
        .sort();
    expect(ids({ channel: 'prs/' })).toEqual([ready, review].sort());
    expect(ids({ channel: 'prs/ui' })).toEqual([review]);
    expect(ids({ labels: ['state=ready'] })).toEqual([ready, other].sort());
    expect(ids({ labels: ['state=ready|review', 'needs'] })).toEqual([review]);
    expect(ids({ text: 'badge' })).toEqual([review]);
    expect(ids({ by: 'raj' })).toEqual([review]);
    expect(store.channels()).toEqual([
      { channel: 'prs-old', threads: 1, needs: 0, ready: 1, working: 0 },
      { channel: 'prs/backend', threads: 1, needs: 0, ready: 1, working: 0 },
      { channel: 'prs/ui', threads: 1, needs: 1, ready: 0, working: 0 },
    ]);
  });

  it('lists the most recently active thread first, counting label changes', () => {
    const store = memory();
    const first = store.post({ channel: 'dev', text: 'first', author: 'a' }).message.id;
    const second = store.post({ channel: 'dev', text: 'second', author: 'a' }).message.id;
    expect(store.listThreads().map((thread) => thread.id)).toEqual([second, first]);
    store.label({ id: first, actor: 'raj', set: { hold: 'raj' } });
    expect(store.listThreads().map((thread) => thread.id)).toEqual([first, second]);
  });
});

describe('events', () => {
  it('records one event per reply and per effective label change, after a cursor', () => {
    const store = memory();
    const { message } = store.post({
      channel: 'ask',
      text: 'ship it?',
      author: 'agent',
      labels: { needs: 'decision' },
    });
    // A new thread's own labels are part of its post, so a waiter on it sees nothing yet.
    const start = store.cursorOf(message.id);
    expect(store.eventsAfter(start)).toEqual([]);

    store.reply({ id: message.id, text: 'yes', author: 'raj' });
    store.label({ id: message.id, actor: 'raj', set: { decision: 'approved' }, unset: ['needs'] });
    store.label({ id: message.id, actor: 'raj', set: { decision: 'approved' }, unset: ['needs'] });

    const events = store.eventsAfter(start, { threadId: message.id });
    expect(events.map((event) => event.type)).toEqual(['message.posted', 'labels.changed']);
    expect(events[1]).toMatchObject({
      actor: 'raj',
      set: { decision: 'approved' },
      unset: ['needs'],
      labels: { decision: 'approved' },
    });
    expect(store.eventsAfter(start, { channel: 'other' })).toEqual([]);
    expect(store.eventsAfter(start, { by: 'raj', text: 'YES' })).toHaveLength(1);
    expect(store.getThread(message.id).cursor).toBe(events[1]?.cursor);
  });
});

describe('tasks', () => {
  it('claims the oldest ready thread and lets only the owner settle it', () => {
    const store = memory();
    const task = (text: string) =>
      store.post({ channel: 'tasks', text, author: 'raj', labels: { state: 'ready' } }).message.id;
    const first = task('first');
    const second = task('second');

    expect(store.claim({ channel: 'tasks', actor: 'a' }).id).toBe(first);
    expect(reason(() => store.claim({ id: first, actor: 'b' }))).toBe('task_claimed');
    expect(reason(() => store.settle({ id: first, actor: 'b', state: 'done' }))).toBe(
      'claim_not_held',
    );
    expect(store.claim({ channel: 'tasks', actor: 'b' }).id).toBe(second);
    expect(reason(() => store.claim({ channel: 'tasks', actor: 'c' }))).toBe('nothing_ready');

    const done = store.settle({ id: first, actor: 'a', state: 'done', text: 'merged' });
    expect(done.labels).toEqual({ owner: 'a', state: 'done' });
    expect(done.replies.at(-1)?.text).toBe('merged');

    const released = store.settle({ id: second, actor: 'b', state: 'ready' });
    expect(released.labels).toEqual({ state: 'ready' });
  });
});

describe('checkin', () => {
  it('keeps one thread per session: the first call starts it, later calls reply and relabel', () => {
    const store = memory();
    const first = store.checkin({
      key: 'shop:search',
      channel: 'shop/workers',
      author: 'search',
      person: 'raj',
      text: 'Starting on accented queries.',
      labels: { state: 'working' },
    });
    const second = store.checkin({
      key: 'shop:search',
      channel: 'shop/workers',
      author: 'search',
      person: 'raj',
      text: 'PR is up; which analyzer do you want?',
      labels: { state: 'blocked', pr: '102', needs: 'decision' },
    });
    store.checkin({
      key: ':search',
      channel: 'threads',
      author: 'search',
      person: 'raj',
      text: 'A one-off.',
    });

    expect(second.id).toBe(first.id);
    expect(second.title).toBe('search');
    expect(second.replies.map((reply) => reply.text)).toEqual([
      'PR is up; which analyzer do you want?',
    ]);
    expect(second.labels).toEqual({ needs: 'decision', pr: '102', state: 'blocked' });
    expect(store.channels()).toEqual([
      { channel: 'shop/workers', threads: 1, needs: 1, ready: 0, working: 0 },
      { channel: 'threads', threads: 1, needs: 0, ready: 0, working: 0 },
    ]);
  });

  it("keeps an unanswered question through the author's later check-ins, until the person writes", () => {
    const store = memory();
    const session = { key: ':search', channel: 'threads', author: 'search', person: 'raj' };
    const asked = store.checkin({
      ...session,
      text: 'ICU or a custom fold?',
      labels: { state: 'blocked', needs: 'decision' },
    });
    const done = store.checkin({
      ...session,
      text: 'Done.',
      labels: { state: 'done' },
      unset: ['needs'],
    });
    expect(done.labels).toEqual({ needs: 'decision', state: 'done' });
    expect(store.listThreads({ labels: ['needs'] }).map((t) => t.id)).toEqual([asked.id]);

    // Another agent's reply is not the person's answer.
    store.reply({ id: asked.id, text: 'Use ICU.', author: 'coordinator' });
    expect(store.checkin({ ...session, text: 'Done.', unset: ['needs'] }).labels.needs).toBe(
      'decision',
    );

    store.reply({ id: asked.id, text: 'ICU.', author: 'raj' });
    expect(
      store.checkin({ ...session, text: 'Switched to ICU.', unset: ['needs'] }).labels,
    ).toEqual({ state: 'done' });

    // A new question is open again until the person answers it.
    store.checkin({ ...session, text: 'Ship it?', labels: { needs: 'approval' } });
    expect(store.checkin({ ...session, text: 'Done.', unset: ['needs'] }).labels.needs).toBe(
      'approval',
    );
  });
});

describe('many processes', () => {
  const script = 'src/test/writer.ts';

  it('keeps every write from concurrent writer processes', async () => {
    const file = path.join(tempDir(), 'board.db');
    const writers = ['a', 'b', 'c', 'd', 'e', 'f'];
    const results = await Promise.all(
      writers.map((name) => runScript(script, [file, 'post', name, '25'])),
    );
    expect(results.map((result) => result.stderr)).toEqual(writers.map(() => ''));

    const store = new Store(file);
    const threads = store.listThreads({ limit: 1000 });
    expect(threads).toHaveLength(150);
    expect(threads.every((thread) => thread.replyCount === 1 && thread.labels.n)).toBe(true);
    // 150 posts, 150 replies and 150 label changes, each with its own cursor.
    expect(store.lastCursor()).toBe(450);
  }, 60_000);

  it('gives each ready thread to exactly one of many claiming processes', async () => {
    const file = path.join(tempDir(), 'board.db');
    const store = new Store(file);
    const ready = [1, 2, 3].map(
      (n) =>
        store.post({ channel: 'tasks', text: `t${n}`, author: 'raj', labels: { state: 'ready' } })
          .message.id,
    );
    const claimers = Array.from({ length: 10 }, (_, index) => `agent-${index}`);
    const results = await Promise.all(
      claimers.map((name) => runScript(script, [file, 'claim', name, 'tasks'])),
    );
    expect(results.map((result) => result.stderr)).toEqual(claimers.map(() => ''));

    const claimed = results.map((result) => result.stdout).filter(Boolean);
    expect(claimed.sort()).toEqual([...ready].sort());
    const owners = ready.map((id) => store.getThread(id).labels.owner);
    expect(new Set(owners).size).toBe(3);
  }, 60_000);
});
