import { type Labels, STATE_LABEL, type ThreadSummary } from '../shared/types';

export type View =
  | { kind: 'needs' }
  | { kind: 'activity' }
  | { kind: 'tasks' }
  /** A channel, or a subtree when the path ends in `/`. */
  | { kind: 'channel'; channel: string };

export interface Route {
  view: View;
  threadId: string | null;
}

/** Routes live in the hash: `#/needs`, `#/activity`, `#/tasks`, `#/c/prs/backend`, each with an optional `?thread=<id>`. */
export function parseRoute(hash: string): Route {
  const [path = '', query = ''] = hash.replace(/^#\/?/, '').split('?');
  const threadId = new URLSearchParams(query).get('thread');
  if (path.startsWith('c/')) {
    return { view: { kind: 'channel', channel: path.slice(2) }, threadId };
  }
  const kind = path === 'activity' || path === 'tasks' ? path : 'needs';
  return { view: { kind }, threadId };
}

export function formatRoute({ view, threadId }: Route): string {
  const path = view.kind === 'channel' ? `c/${view.channel}` : view.kind;
  return `#/${path}${threadId ? `?thread=${threadId}` : ''}`;
}

/**
 * Splits a name such as `parallel-board-bridge-te-kebjxw` into its slug and a trailing six-character
 * hash, the shape of rstack code's handles, so the slug can be cut short and the hash kept. Other
 * names are all `base`. A six-letter last word also matches; that only changes how it is drawn.
 */
export function splitHandle(name: string): { base: string; hash: string } {
  const match = /^(.+)(-[a-z0-9]{6})$/.exec(name);
  return match?.[1] && match[2] ? { base: match[1], hash: match[2] } : { base: name, hash: '' };
}

/** Splits the filter box into label filters (`state=ready`) and free text. */
export function parseFilter(input: string): { labels: string[]; text: string } {
  const words = input.split(/\s+/).filter(Boolean);
  return {
    labels: words.filter((word) => /^[a-z][a-z0-9_.-]*=./.test(word)),
    text: words.filter((word) => !/^[a-z][a-z0-9_.-]*=./.test(word)).join(' '),
  };
}

/** `now`, `40s`, `5m`, `3h`, `2d`: how long ago `iso` was. */
export function timeAgo(iso: string, now = Date.now()): string {
  const seconds = Math.floor((now - Date.parse(iso)) / 1000);
  if (seconds < 5) {
    return 'now';
  }
  if (seconds < 60) {
    return `${seconds}s`;
  }
  if (seconds < 3600) {
    return `${Math.floor(seconds / 60)}m`;
  }
  if (seconds < 86_400) {
    return `${Math.floor(seconds / 3600)}h`;
  }
  return `${Math.floor(seconds / 86_400)}d`;
}

function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/** The feed's day divider: `today`, `yesterday`, or a date. */
export function dayLabel(iso: string, now = new Date()): string {
  const day = new Date(iso);
  const daysAgo = Math.round((startOfDay(now) - startOfDay(day)) / 86_400_000);
  if (daysAgo === 0) {
    return 'today';
  }
  if (daysAgo === 1) {
    return 'yesterday';
  }
  return day.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

/** One line of a message, without Markdown markers. */
export function oneLine(text: string): string {
  return text
    .replace(/[*`>]|#+(?=\s)/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// States a thread has left for good; everything else is still open.
const CLOSED_STATES = new Set(['done', 'failed', 'merged', 'parked']);
const STATE_ORDER = ['draft', 'ready', 'claimed', 'work', 'working', 'review', 'blocked', 'idle'];

function stateRank(state: string): number {
  if (CLOSED_STATES.has(state)) {
    return STATE_ORDER.length + 1;
  }
  const index = STATE_ORDER.indexOf(state);
  return index === -1 ? STATE_ORDER.length : index;
}

/** The tasks view's tabs: `open`, each state present (open ones first), then `all`. */
export function taskTabs(threads: ThreadSummary[]): string[] {
  const states = [...new Set(threads.map((thread) => thread.labels[STATE_LABEL] ?? ''))]
    .filter(Boolean)
    .sort((a, b) => stateRank(a) - stateRank(b) || a.localeCompare(b));
  return ['open', ...states, 'all'];
}

export function matchesTaskTab(thread: ThreadSummary, tab: string): boolean {
  const state = thread.labels[STATE_LABEL] ?? '';
  if (tab === 'all') {
    return true;
  }
  return tab === 'open' ? !CLOSED_STATES.has(state) : state === tab;
}

/**
 * The rstack code thread a board thread came from: `t3=<threadId>` and, when the environment is
 * known, `env=<environmentId>`. rstack code opens `rstackcode://threads/<env>/<thread>`; without
 * the environment there is no link, only the id.
 */
export function rstackCodeThread(labels: Labels): { id: string; link: string | null } | null {
  const id = labels.t3;
  if (!id) {
    return null;
  }
  const env = labels.env;
  const link = env
    ? `rstackcode://threads/${encodeURIComponent(env)}/${encodeURIComponent(id)}`
    : null;
  return { id, link };
}
