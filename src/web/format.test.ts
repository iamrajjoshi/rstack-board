import { expect, it } from 'vitest';
import type { Message, ThreadSummary } from '../shared/types';
import {
  dayLabel,
  formatRoute,
  matchesTaskTab,
  oneLine,
  parseFilter,
  parseRoute,
  rstackCodeThread,
  splitHandle,
  taskTabs,
  timeAgo,
} from './format';

function thread(state?: string): ThreadSummary {
  const message: Message = {
    id: `msg_${state}`,
    threadId: `msg_${state}`,
    channel: 'tasks',
    author: 'coordinator',
    text: 'a task',
    createdAt: '2026-11-20T12:00:00Z',
    via: 'cli',
  };
  return {
    id: message.id,
    channel: message.channel,
    title: message.text,
    labels: state ? { state } : {},
    message,
    last: message,
    replyCount: 0,
    updatedAt: message.createdAt,
  };
}

it('round-trips routes through the hash', () => {
  const route = { view: { kind: 'channel', channel: 'prs/' }, threadId: 'msg_1' } as const;
  expect(formatRoute(route)).toBe('#/c/prs/?thread=msg_1');
  expect(parseRoute(formatRoute(route))).toEqual(route);
  expect(parseRoute('#/tasks')).toEqual({ view: { kind: 'tasks' }, threadId: null });
  expect(parseRoute('')).toEqual({ view: { kind: 'needs' }, threadId: null });
});

it('splits the filter box into label filters and text', () => {
  expect(parseFilter('state=ready|review gift cards owner=ui')).toEqual({
    labels: ['state=ready|review', 'owner=ui'],
    text: 'gift cards',
  });
});

it('shows compact ages', () => {
  const now = Date.parse('2026-11-20T12:00:00Z');
  expect(timeAgo('2026-11-20T11:59:58Z', now)).toBe('now');
  expect(timeAgo('2026-11-20T11:59:20Z', now)).toBe('40s');
  expect(timeAgo('2026-11-20T11:15:00Z', now)).toBe('45m');
  expect(timeAgo('2026-11-20T07:00:00Z', now)).toBe('5h');
  expect(timeAgo('2026-11-17T12:00:00Z', now)).toBe('3d');
});

it('labels feed days relative to today', () => {
  const now = new Date(2026, 10, 20, 9);
  expect(dayLabel(new Date(2026, 10, 20, 1).toISOString(), now)).toBe('today');
  expect(dayLabel(new Date(2026, 10, 19, 23).toISOString(), now)).toBe('yesterday');
  expect(dayLabel(new Date(2026, 10, 3, 12).toISOString(), now)).toBe('Nov 3, 2026');
});

it('flattens a message to one line and keeps issue numbers', () => {
  expect(oneLine('## Plan\n\nA `note` on **#2**,\nthen go')).toBe('Plan A note on #2, then go');
});

it('offers a tab per state present, open states first, and counts closed states out of open', () => {
  const threads = ['done', 'ready', 'triage', 'blocked', 'ready'].map(thread);
  expect(taskTabs(threads)).toEqual(['open', 'ready', 'blocked', 'triage', 'done', 'all']);
  const titles = (tab: string) =>
    threads.filter((t) => matchesTaskTab(t, tab)).map((t) => t.labels.state);
  expect(titles('open')).toEqual(['ready', 'triage', 'blocked', 'ready']);
  expect(titles('done')).toEqual(['done']);
  expect(titles('all')).toHaveLength(5);
});

it('links a thread from rstack code back to it, or gives only the id without an environment', () => {
  expect(rstackCodeThread({ t3: 'th-1', env: 'env 1' })).toEqual({
    id: 'th-1',
    link: 'rstackcode://threads/env%201/th-1',
  });
  expect(rstackCodeThread({ t3: 'th-1' })).toEqual({ id: 'th-1', link: null });
  expect(rstackCodeThread({ env: 'env-1' })).toBeNull();
});

it('splits a trailing six-character hash off a handle, and leaves other names whole', () => {
  expect(splitHandle('parallel-board-bridge-te-kebjxw')).toEqual({
    base: 'parallel-board-bridge-te',
    hash: '-kebjxw',
  });
  expect(splitHandle('fix-flaky-search-1x9k2b')).toEqual({
    base: 'fix-flaky-search',
    hash: '-1x9k2b',
  });
  expect(splitHandle('artemis')).toEqual({ base: 'artemis', hash: '' });
  expect(splitHandle('-abc123')).toEqual({ base: '-abc123', hash: '' });
});
