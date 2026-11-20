import type { Store } from './store';
import type { Labels } from './types';

/**
 * A board described as one JSON document: what needs the person, one entry per open pull
 * request, merged pull requests, and agent sessions. See `examples/board-state.json`.
 */
export interface BoardState {
  needs_you: { kind: string; title: string; url?: string; detail?: string }[];
  threads: {
    number: number;
    title: string;
    url: string;
    channel: string;
    state: string;
    labels: { text: string; tone: string }[];
    note?: string;
  }[];
  merged: { number: number; title: string; url: string; at: string }[];
  sessions: { state: string; title: string; holds?: string }[];
}

const NEEDS_BY_KIND: Record<string, string> = {
  approve: 'approval',
  decide: 'decision',
  do: 'action',
  confirm: 'confirmation',
};

// Labels the import owns on a PR thread: each run sets the current ones and removes the rest.
const PR_LABEL_KEYS = [
  'approved',
  'review',
  'checks',
  'conflict',
  'threads',
  'base',
  'hold',
  'owner',
];

/**
 * Fills the board from a state document. Safe to run again: threads are keyed, PR and
 * session labels are refreshed, and "needs you" items are only labelled when first created, so
 * one the person already resolved stays resolved.
 */
export function importBoardState(
  store: Store,
  state: BoardState,
  author: string,
  project?: string,
): { created: number; updated: number } {
  // Under a project everything lands in `<project>/...`: its PRs in one channel with the
  // document's channel as an `area` label, its sessions as workers.
  const channels = project
    ? {
        needs: `${project}/needs-you`,
        pr: () => `${project}/prs`,
        merged: `${project}/merged`,
        sessions: `${project}/workers`,
      }
    : {
        needs: 'needs-you',
        pr: (area: string) => `prs/${area}`,
        merged: 'prs/merged',
        sessions: 'sessions',
      };
  const keyFor = (kind: string, id: string | number) =>
    project ? `import:${project}:${kind}:${id}` : `import:${kind}:${id}`;
  let created = 0;
  let updated = 0;
  const count = (isNew: boolean) => {
    if (isNew) {
      created += 1;
    } else {
      updated += 1;
    }
  };

  for (const item of state.needs_you) {
    const pr = /#(\d+)/.exec(item.title)?.[1];
    const result = store.post({
      channel: channels.needs,
      author,
      text: [`**${item.title}**`, item.detail, item.url].filter(Boolean).join('\n\n'),
      labels: { needs: NEEDS_BY_KIND[item.kind] ?? item.kind, ...(pr ? { pr } : {}) },
      idempotencyKey: keyFor('needs', item.title),
    });
    count(result.created);
  }

  for (const pr of state.threads) {
    const labels: Labels = {
      state: pr.state,
      pr: String(pr.number),
      ...(project ? { area: pr.channel } : {}),
      ...prLabels(pr.labels),
    };
    const result = store.post({
      channel: channels.pr(pr.channel),
      author,
      text: [`**#${pr.number} ${plainTitle(pr.title)}**`, pr.note, pr.url]
        .filter(Boolean)
        .join('\n\n'),
      idempotencyKey: keyFor('pr', pr.number),
    });
    store.label({
      id: result.message.id,
      actor: author,
      set: labels,
      unset: PR_LABEL_KEYS.filter((key) => !(key in labels)),
    });
    count(result.created);
  }

  for (const pr of state.merged) {
    // A PR already on the board keeps its thread and channel; it is only marked merged.
    const result = store.post({
      channel: channels.merged,
      author,
      text: `**#${pr.number} ${plainTitle(pr.title)}**\n\n${pr.url}`,
      idempotencyKey: keyFor('pr', pr.number),
    });
    store.label({
      id: result.message.id,
      actor: author,
      set: { state: 'merged', pr: String(pr.number) },
      unset: PR_LABEL_KEYS,
    });
    count(result.created);
  }

  for (const session of state.sessions) {
    const result = store.post({
      channel: channels.sessions,
      author,
      text: [`**${session.title}**`, session.holds].filter(Boolean).join('\n\n'),
      idempotencyKey: keyFor('session', session.title),
    });
    store.label({ id: result.message.id, actor: author, set: { state: session.state } });
    count(result.created);
  }

  return { created, updated };
}

/** Drops the leading `:sparkles:`-style emoji code of a commit-style title. */
function plainTitle(title: string): string {
  return title.replace(/^:[a-z0-9_+-]+:\s*/, '');
}

/** Turns the document's free-text chips into `key=value` labels. */
function prLabels(chips: { text: string; tone: string }[]): Labels {
  const labels: Labels = {};
  for (const { text, tone } of chips) {
    const openThreads = /^(\d+) open thread/.exec(text)?.[1];
    if (text.startsWith('approved: ')) {
      labels.approved = text.slice('approved: '.length);
    } else if (text === 'needs approval') {
      labels.review = 'needed';
    } else if (text === 'checks green') {
      labels.checks = 'green';
    } else if (text === 'checks running') {
      labels.checks = 'running';
    } else if (text.startsWith('failing: ')) {
      labels.checks = text;
    } else if (text === 'conflicts with main') {
      labels.conflict = 'main';
    } else if (openThreads) {
      labels.threads = openThreads;
    } else if (text.startsWith('stacked on ')) {
      labels.base = text.slice('stacked on '.length);
    } else if (tone === 'warn') {
      labels.hold = text;
    } else {
      labels.owner = text;
    }
  }
  return labels;
}
