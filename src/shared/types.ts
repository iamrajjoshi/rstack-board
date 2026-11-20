export type Labels = Record<string, string>;

/** How a write reached the board: `web` through the server from the board's page, `cli` otherwise. */
export type Via = 'web' | 'cli';

export interface Message {
  id: string;
  threadId: string;
  channel: string;
  author: string;
  text: string;
  createdAt: string;
  via: Via;
}

/** A thread as listed: its root message, labels, and the latest message. */
export interface ThreadSummary {
  id: string;
  channel: string;
  title: string;
  labels: Labels;
  message: Message;
  last: Message;
  replyCount: number;
  updatedAt: string;
}

export interface Thread extends ThreadSummary {
  replies: Message[];
  /** Event cursor of the newest event on this thread; pass it to `wait --after`. */
  cursor: number;
}

export interface ChannelSummary {
  channel: string;
  threads: number;
  /** Threads waiting on the person. */
  needs: number;
  /** Threads with `state=ready`. */
  ready: number;
  /** Threads someone is working on: `state` is `work`, `working` or `claimed`. */
  working: number;
}

export type BoardEvent = {
  /** Increases with every event; pass it to `tail --after` or `wait --after` to resume. */
  cursor: number;
  threadId: string;
  channel: string;
  actor: string;
  at: string;
  via: Via;
} & (
  | { type: 'message.posted'; message: Message }
  | { type: 'labels.changed'; set: Labels; unset: string[]; labels: Labels }
);

export interface ServerInfo {
  pid: number;
  port: number;
  version: string;
  stateDir: string;
  startedAt: string;
}

/** Label that marks a thread as waiting on the person. */
export const NEEDS_LABEL = 'needs';
export const STATE_LABEL = 'state';
export const OWNER_LABEL = 'owner';
