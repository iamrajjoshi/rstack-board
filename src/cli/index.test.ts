import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { serve } from '@hono/node-server';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../server/index';
import { parseJson } from '../shared/json';
import { Store } from '../shared/store';
import { type RunResult, runScript, tempDir } from '../test/run';

let stateDir: string;
beforeEach(() => {
  stateDir = tempDir();
});

/** Runs the CLI as the named agent against this test's own board. */
function cli(profile: string, ...args: string[]): Promise<RunResult> {
  return runScript('src/cli/index.ts', [...args, '--json'], {
    RSTACK_BOARD_STATE_DIR: stateDir,
    BOARD_PROFILE: profile,
    T3CODE_THREAD_ID: '',
  });
}

async function json<T = any>(profile: string, ...args: string[]): Promise<T> {
  const result = await cli(profile, ...args);
  expect(result.stderr).toBe('');
  return parseJson<T>(result.stdout);
}

/** Like `json`, with `--json` first, as the bridge passes it, so `--` can end the options. */
async function jsonFirst<T = any>(profile: string, ...args: string[]): Promise<T> {
  const result = await runScript('src/cli/index.ts', ['--json', ...args], {
    RSTACK_BOARD_STATE_DIR: stateDir,
    BOARD_PROFILE: profile,
    BOARD_COORDINATOR: '',
    T3CODE_THREAD_ID: '',
  });
  expect(result.stderr).toBe('');
  return parseJson<T>(result.stdout);
}

describe('posting and reading', () => {
  it('posts, replies, labels and reads back a thread', async () => {
    const root = await json('ui', 'post', 'prs/ui', '**#7 Cart badge**', '--label', 'state=review');
    await json('ui', 'reply', root.id, 'pushed the fix');
    await json('ui', 'label', root.id, 'state=ready', 'owner=ui', '--unset', 'missing');

    const thread = await json('other', 'read', root.id);
    expect(thread.title).toBe('#7 Cart badge');
    expect(thread.labels).toEqual({ owner: 'ui', state: 'ready' });
    expect(thread.replies.map((reply: any) => [reply.author, reply.text])).toEqual([
      ['ui', 'pushed the fix'],
    ]);

    const listed = await json('other', 'read', 'prs/', '--label', 'state=ready');
    expect(listed.threads.map((t: any) => t.id)).toEqual([root.id]);
    expect((await json('other', 'read', 'prs/', '--label', 'state=review')).threads).toEqual([]);
    expect((await json('other', 'channels')).channels).toEqual([
      { channel: 'prs/ui', threads: 1, needs: 0, ready: 1, working: 0 },
    ]);
  });

  it('does not post twice for a retried idempotency key, and reads text from a file', async () => {
    const file = path.join(stateDir, 'note.md');
    writeFileSync(file, '# Plan\n\nstep one');
    const args = ['post', 'dev', '--file', file, '--idempotency-key', 'plan-1'];
    const first = await json('a', ...args);
    const retry = await json('a', ...args);

    expect(retry.id).toBe(first.id);
    expect((await json('a', 'read', 'dev')).threads).toHaveLength(1);
    expect((await json('a', 'read', first.id)).title).toBe('Plan');
  });

  it('takes text that starts with a dash after --, in every command that takes text', async () => {
    const rejected = await cli('a', 'post', 'dev', '-x is not an option');
    expect(JSON.parse(rejected.stderr).reason).toBe('usage');

    const root = await jsonFirst('a', 'post', '--label', 'state=review', '--', 'dev', '-x title');
    expect(root.text).toBe('-x title');
    expect((await jsonFirst('b', 'reply', '--', root.id, '--force')).text).toBe('--force');
    const checkin = await jsonFirst('a', 'checkin', '--state', 'working', '--', '-v');
    expect(checkin.message.text).toBe('**a**\n\n-v');
    const task = await jsonFirst('a', 'tasks', 'create', '--', 'tasks', '--help me');
    expect(task.text).toBe('--help me');
    await jsonFirst('b', 'tasks', 'claim', '--', task.id);
    const done = await jsonFirst('b', 'tasks', 'complete', '--', task.id, '-1 flaky test left');
    expect(done.last.text).toBe('-1 flaky test left');
  }, 30_000);

  it('reports failures as a reason on stderr with exit code 1', async () => {
    const result = await cli('a', 'reply', 'msg_missing', 'hello');
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stderr).reason).toBe('not_found');
  });

  it('posts as <person>/cli when no profile is set', async () => {
    const result = await runScript('src/cli/index.ts', ['whoami'], {
      RSTACK_BOARD_STATE_DIR: stateDir,
      RSTACK_BOARD_USER: 'raj',
      BOARD_PROFILE: '',
      T3CODE_THREAD_ID: '',
    });
    expect(result.stdout.trim()).toBe('raj/cli');
    const named = await runScript('src/cli/index.ts', ['whoami', '--as', 'coordinator'], {
      RSTACK_BOARD_STATE_DIR: stateDir,
    });
    expect(named.stdout.trim()).toBe('coordinator');
  });
});

describe('inside an rstack code thread', () => {
  const thread = '1A2B3C4D-5e6f-4a0b-8c9d-0123456789ab';
  const env = (extra: Record<string, string> = {}) => ({
    RSTACK_BOARD_STATE_DIR: stateDir,
    T3CODE_THREAD_ID: thread,
    BOARD_PROFILE: '',
    BOARD_COORDINATOR: 'shop',
    ...extra,
  });
  const run = async (extra: Record<string, string>, ...args: string[]) => {
    const result = await runScript('src/cli/index.ts', [...args, '--json'], env(extra));
    expect(result.stderr).toBe('');
    return parseJson<any>(result.stdout);
  };

  it('posts as t3-<id prefix> and labels the threads it starts with the thread id', async () => {
    expect((await run({}, 'whoami')).handle).toBe('t3-1a2b3c4d');

    // Separate shell calls, no exported profile: still one status thread.
    const first = await run({}, 'checkin', 'Starting.', '--state', 'working');
    const again = await run({}, 'checkin', 'PR up.', '--pr', '7');
    expect(again.id).toBe(first.id);
    expect(again.message.author).toBe('t3-1a2b3c4d');
    expect(again.labels).toEqual({ pr: '7', state: 'working', t3: thread });

    const posted = await run({}, 'post', 'prs/shop', '#7', '--label', 'pr=7');
    expect((await run({}, 'read', posted.id)).labels).toEqual({ pr: '7', t3: thread });
    const task = await run({}, 'tasks', 'create', 'tasks', 'rebase');
    expect((await run({}, 'read', task.id)).labels).toEqual({ state: 'ready', t3: thread });
  }, 30_000);

  it('lets --as and $BOARD_PROFILE win, without the automatic label', async () => {
    expect((await run({}, 'whoami', '--as', 'search')).handle).toBe('search');
    expect((await run({ BOARD_PROFILE: 'checkout' }, 'whoami')).handle).toBe('checkout');
    const posted = await run({}, 'post', 'dev', 'hello', '--as', 'search');
    expect((await run({}, 'read', posted.id)).labels).toEqual({});
  }, 30_000);
});

describe('machine-readable output', () => {
  it('reports version, schema, handles and no server in status --json', async () => {
    const status = await json('bridge', 'status');
    expect(status).toMatchObject({
      running: false,
      url: null,
      pid: null,
      server: null,
      stateDir,
      database: path.join(stateDir, 'board.db'),
      schemaVersion: 1,
      handle: 'bridge',
    });
    expect(status.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(typeof status.person).toBe('string');
  });

  it('reports the running server from server.json in status --json', async () => {
    const previous = process.env.RSTACK_BOARD_STATE_DIR;
    process.env.RSTACK_BOARD_STATE_DIR = stateDir;
    const app = createApp({ store: new Store(':memory:'), person: 'raj', webRoot: '/nonexistent' });
    const server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' });
    try {
      await new Promise((resolve) => server.once('listening', resolve));
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      const info = { pid: process.pid, port, version: '0.1.0', stateDir, startedAt: 'now' };
      writeFileSync(path.join(stateDir, 'server.json'), JSON.stringify(info));

      const status = await json('bridge', 'status');
      expect(status).toMatchObject({ running: true, pid: process.pid });
      expect(status.url).toBe(`http://localhost:${port}`);
      expect(status.server).toEqual({ ...info, url: `http://localhost:${port}` });
    } finally {
      server.close();
      process.env.RSTACK_BOARD_STATE_DIR = previous;
    }
  });

  it('reports usage errors as reason usage under --json', async () => {
    const result = await cli('a', 'post');
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stderr)).toMatchObject({ reason: 'usage' });
  });

  it('streams one JSON event per line from tail --json', async () => {
    const root = await json('a', 'post', 'dev', 'first');
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', 'src/cli/index.ts', 'tail', root.id, '--json'],
      {
        env: { ...process.env, RSTACK_BOARD_STATE_DIR: stateDir, BOARD_PROFILE: 'watcher' },
      },
    );
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      await json('b', 'reply', root.id, 'second');
      await json('b', 'label', root.id, 'state=done');
      await expect.poll(() => output.split('\n').filter(Boolean).length, { timeout: 5000 }).toBe(2);
      const events = output
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      expect(events.map((event) => [event.type, event.actor, event.threadId])).toEqual([
        ['message.posted', 'b', root.id],
        ['labels.changed', 'b', root.id],
      ]);
    } finally {
      child.kill();
    }
  }, 30_000);
});

describe('wait', () => {
  it("blocks until another author replies, ignoring the waiter's own messages", async () => {
    const question = await json(
      'agent',
      'post',
      'needs-you',
      'Merge?',
      '--label',
      'needs=decision',
    );
    const waiting = cli('agent', 'wait', question.id, '--timeout', '30s');
    await json('agent', 'reply', question.id, 'still waiting');
    await new Promise((resolve) => setTimeout(resolve, 500));
    await json('raj', 'reply', question.id, 'yes, merge');

    const result = await waiting;
    expect(result.code).toBe(0);
    const event = JSON.parse(result.stdout);
    expect(event).toMatchObject({ type: 'message.posted', actor: 'raj' });
    expect(event.message.text).toBe('yes, merge');
  }, 30_000);

  it('returns at once for an answer that arrived before the wait started', async () => {
    const question = await json('agent', 'post', 'needs-you', 'Merge?');
    await json('raj', 'label', question.id, 'decision=approved');
    const event = await json('agent', 'wait', question.id, '--timeout', '5s');
    expect(event).toMatchObject({ type: 'labels.changed', set: { decision: 'approved' } });

    // Resuming after that event finds nothing new.
    const again = await cli(
      'agent',
      'wait',
      question.id,
      '--after',
      String(event.cursor),
      '--timeout',
      '1s',
    );
    expect(again.code).toBe(1);
    expect(JSON.parse(again.stderr).reason).toBe('timeout');
  }, 30_000);

  it('wakes on a matching thread appearing in a channel', async () => {
    const waiting = cli(
      'coordinator',
      'wait',
      'prs/',
      '--label',
      'state=ready',
      '--timeout',
      '30s',
    );
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await json('ui', 'post', 'prs/ui', 'not ready yet', '--label', 'state=draft');
    const ready = await json('ui', 'post', 'prs/ui', 'ready one', '--label', 'state=ready');

    const event = JSON.parse((await waiting).stdout);
    expect(event.threadId).toBe(ready.id);
  }, 30_000);
});

describe('tasks', () => {
  it('creates, claims, completes and releases', async () => {
    const first = await json('raj', 'tasks', 'create', 'tasks', 'rebase #7');
    const second = await json('raj', 'tasks', 'create', 'tasks', 'fix lint');

    expect((await json('a', 'tasks', 'claim', '--ready', 'tasks')).id).toBe(first.id);
    const taken = await cli('b', 'tasks', 'claim', first.id);
    expect(JSON.parse(taken.stderr).reason).toBe('task_claimed');
    const notMine = await cli('b', 'tasks', 'complete', first.id, 'done');
    expect(JSON.parse(notMine.stderr).reason).toBe('claim_not_held');

    const done = await json('a', 'tasks', 'complete', first.id, 'rebased and pushed');
    expect(done.labels).toEqual({ owner: 'a', state: 'done' });
    expect(done.last.text).toBe('rebased and pushed');

    await json('b', 'tasks', 'claim', second.id);
    expect((await json('b', 'tasks', 'release', second.id)).labels).toEqual({ state: 'ready' });
    const failed = await json('a', 'tasks', 'claim', '--ready', 'tasks');
    expect((await json('a', 'tasks', 'fail', failed.id, 'cannot reproduce')).labels.state).toBe(
      'failed',
    );
    const none = await cli('a', 'tasks', 'claim', '--ready', 'tasks', '--wait', '1s');
    expect(JSON.parse(none.stderr).reason).toBe('nothing_ready');
  }, 30_000);

  it('reads the result of complete, fail and release from --file', async () => {
    const file = path.join(stateDir, 'result.md');
    writeFileSync(file, 'Pushed; CI green.');
    for (const verb of ['complete', 'fail', 'release']) {
      const task = await json('raj', 'tasks', 'create', 'tasks', `task to ${verb}`);
      await json('a', 'tasks', 'claim', task.id);
      expect((await json('a', 'tasks', verb, task.id, '--file', file)).last.text).toBe(
        'Pushed; CI green.',
      );
    }
  }, 30_000);
});

describe('checkin', () => {
  it('files a worker under its coordinator and a one-off under threads', async () => {
    const env = { RSTACK_BOARD_STATE_DIR: stateDir, BOARD_PROFILE: 'search' };
    const run = async (extra: Record<string, string>, ...args: string[]) =>
      parseJson<any>(
        (await runScript('src/cli/index.ts', [...args, '--json'], { ...env, ...extra })).stdout,
      );

    const worker = await run(
      { BOARD_COORDINATOR: 'shop' },
      'checkin',
      'Starting.',
      '--state',
      'working',
    );
    const again = await run(
      { BOARD_COORDINATOR: 'shop' },
      'checkin',
      'Done, PR up.',
      '--state',
      'done',
      '--pr',
      '102',
    );
    const oneOff = await run({ BOARD_COORDINATOR: '' }, 'checkin', 'Fixing a typo.');

    expect(worker.channel).toBe('shop/workers');
    expect(again.id).toBe(worker.id);
    expect(again.labels).toEqual({ pr: '102', state: 'done' });
    expect(again.replies).toHaveLength(1);
    expect(oneOff.channel).toBe('threads');
    expect(oneOff.id).not.toBe(worker.id);
  }, 30_000);

  it('files the thread in --channel, which wins over the coordinator', async () => {
    const env = { RSTACK_BOARD_STATE_DIR: stateDir, BOARD_PROFILE: 'search' };
    const run = async (...args: string[]) =>
      parseJson<any>(
        (
          await runScript('src/cli/index.ts', [...args, '--json'], {
            ...env,
            BOARD_COORDINATOR: 'shop',
          })
        ).stdout,
      );

    const worker = await run('checkin', 'Under the coordinator.');
    const project = await run('checkin', 'In the project.', '--channel', 'rstack-code');
    const again = await run('checkin', 'Still in the project.', '--channel', 'rstack-code');

    expect(worker.channel).toBe('shop/workers');
    expect(project.channel).toBe('rstack-code');
    expect(project.id).not.toBe(worker.id);
    expect(again.id).toBe(project.id);
    expect(again.replies).toHaveLength(1);
  }, 30_000);
});

describe('import', () => {
  it('fills the board from a state document and refreshes it on a rerun', async () => {
    const fixture = 'examples/board-state.json';
    expect(await json('coordinator', 'import', fixture)).toEqual({ created: 6, updated: 0 });

    const needs = (await json('raj', 'read', '--label', 'needs')).threads;
    expect(needs.map((t: any) => [t.channel, t.labels])).toEqual(
      expect.arrayContaining([
        ['needs-you', { needs: 'decision', pr: '101' }],
        ['needs-you', { needs: 'action' }],
      ]),
    );
    const [held] = (await json('raj', 'read', 'prs/checkout')).threads;
    expect(held.title).toBe('#101 feat: add gift cards to checkout');
    expect(held.labels).toEqual({
      approved: 'sam',
      checks: 'green',
      hold: 'held for you',
      owner: 'checkout agent',
      pr: '101',
      state: 'review',
    });
    const [blocked] = (await json('raj', 'read', 'prs/search')).threads;
    expect(blocked.labels).toEqual({
      base: 'search-index',
      checks: 'failing: lint, test',
      conflict: 'main',
      pr: '102',
      review: 'needed',
      state: 'blocked',
      threads: '2',
    });
    expect((await json('raj', 'read', 'sessions')).threads[0].labels).toEqual({ state: 'working' });

    // Raj resolves an item; later #102 merges and its stale labels go away.
    const decision = needs.find((t: any) => t.labels.pr === '101');
    await json('raj', 'label', decision.id, '--unset', 'needs');
    const state = JSON.parse(readFileSync(fixture, 'utf8'));
    state.merged.push({ ...state.threads.pop(), at: '2026-11-20T01:00:00Z' });
    const next = path.join(stateDir, 'state.json');
    writeFileSync(next, JSON.stringify(state));
    expect(await json('coordinator', 'import', next)).toEqual({ created: 0, updated: 6 });

    expect((await json('raj', 'read', '--label', 'needs')).threads).toHaveLength(1);
    const [merged] = (await json('raj', 'read', 'prs/search')).threads;
    expect(merged.labels).toEqual({ pr: '102', state: 'merged' });
    expect((await json('raj', 'read', 'prs/merged')).threads).toHaveLength(1);
  }, 30_000);

  it('files a state document under a project', async () => {
    await json('coordinator', 'import', 'examples/board-state.json', '--project', 'shop');
    const channels = (await json('raj', 'channels')).channels;
    expect(channels).toEqual([
      { channel: 'shop/merged', threads: 1, needs: 0, ready: 0, working: 0 },
      { channel: 'shop/needs-you', threads: 2, needs: 2, ready: 0, working: 0 },
      { channel: 'shop/prs', threads: 2, needs: 0, ready: 0, working: 0 },
      { channel: 'shop/workers', threads: 1, needs: 0, ready: 0, working: 1 },
    ]);
    const prs = (await json('raj', 'read', 'shop/prs', '--label', 'area=search')).threads;
    expect(prs.map((t: any) => t.labels.pr)).toEqual(['102']);
  }, 30_000);
});
