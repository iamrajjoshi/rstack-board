export type Labels = Record<string, string>;

export interface Message {
  id: string;
  threadId: string;
  channel: string;
  author: string;
  text: string;
  createdAt: string;
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
  cursor: number;
  threadId: string;
  channel: string;
  actor: string;
  at: string;
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
