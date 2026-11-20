import { mkdirSync } from 'node:fs';
import path from 'node:path';
import type { DatabaseSync, SQLInputValue, SQLOutputValue } from 'node:sqlite';
import { ulid } from 'ulid';
import { BoardError } from './errors';
import { parseJson } from './json';
import {
  assertChannel,
  assertLabelKey,
  type LabelFilter,
  matchesLabelFilters,
  parseLabelFilter,
} from './labels';
import { redactSecrets } from './redact';
import {
  type BoardEvent,
  type ChannelSummary,
  type Labels,
  type Message,
  NEEDS_LABEL,
  OWNER_LABEL,
  STATE_LABEL,
  type Thread,
  type ThreadSummary,
} from './types';

/** Version of the table layout below; bumped whenever it changes. Reported by `status --json`. */
export const SCHEMA_VERSION = 1;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS messages (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  thread_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  author TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL,
  idempotency_key TEXT UNIQUE
);
CREATE INDEX IF NOT EXISTS messages_thread ON messages(thread_id, seq);
CREATE TABLE IF NOT EXISTS labels (
  thread_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (thread_id, key)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS events (
  cursor INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  actor TEXT NOT NULL,
  at TEXT NOT NULL,
  message_id TEXT,
  data TEXT
);
CREATE INDEX IF NOT EXISTS events_thread ON events(thread_id, cursor);
`;

const MAX_TEXT_LENGTH = 10_000;
const MAX_LABEL_VALUE_LENGTH = 200;

type Row = Record<string, SQLOutputValue>;

export interface ThreadFilter {
  /** An exact channel, or a prefix ending in `/` for a subtree. */
  channel?: string | undefined;
  /** Filters such as `state=ready`, `needs` or `state=ready|review`. */
  labels?: string[] | undefined;
  text?: string | undefined;
  /** Only threads with a message by this author. */
  by?: string | undefined;
  limit?: number | undefined;
}

export interface EventFilter extends Omit<ThreadFilter, 'limit'> {
  threadId?: string | undefined;
}

export interface LabelChange {
  id: string;
  actor: string;
  set?: Labels | undefined;
  unset?: string[] | undefined;
  /** Apply only when these labels currently have these values. */
  ifEquals?: Labels | undefined;
  /** Apply only when these keys are currently unset. */
  ifUnset?: string[] | undefined;
}

export class Store {
  private readonly db: DatabaseSync;

  constructor(file: string) {
    if (file !== ':memory:') {
      mkdirSync(path.dirname(file), { recursive: true });
    }
    // getBuiltinModule rather than an import: bundlers and Vite mangle the `node:sqlite` specifier.
    const { DatabaseSync } = suppressExperimentalWarning(() =>
      process.getBuiltinModule('node:sqlite'),
    );
    this.db = new DatabaseSync(file, { timeout: 10_000 });
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
    this.transaction(() => this.db.exec(SCHEMA));
  }

  close(): void {
    this.db.close();
  }

  /** Starts a thread. A repeated `idempotencyKey` returns the first message instead of posting again. */
  post(input: {
    channel: string;
    text: string;
    author: string;
    labels?: Labels | undefined;
    idempotencyKey?: string | undefined;
  }): { message: Message; created: boolean } {
    assertChannel(input.channel);
    const labels = normalizeLabels(input.labels ?? {});
    return this.transaction(() => {
      const result = this.insertMessage({ ...input, threadId: undefined });
      if (result.created) {
        // Initial labels belong to the post: no separate event, so `wait <id>` on a new thread
        // is not woken by its own labels.
        for (const [key, value] of Object.entries(labels)) {
          this.db
            .prepare('INSERT INTO labels (thread_id, key, value) VALUES (?, ?, ?)')
            .run(result.message.id, key, value);
        }
      }
      return result;
    });
  }

  /** Replies to the thread that message `id` belongs to. */
  reply(input: { id: string; text: string; author: string; idempotencyKey?: string | undefined }): {
    message: Message;
    created: boolean;
  } {
    return this.transaction(() => {
      const root = this.getRoot(input.id);
      return this.insertMessage({ ...input, channel: root.channel, threadId: root.threadId });
    });
  }

  /** Sets and removes labels on a thread, atomically with its preconditions. */
  label(change: LabelChange): Labels {
    const set = normalizeLabels(change.set ?? {});
    return this.transaction(() => {
      const root = this.getRoot(change.id);
      const current = this.getLabels(root.threadId);
      for (const [key, value] of Object.entries(change.ifEquals ?? {})) {
        if (current[key] !== value) {
          throw new BoardError('precondition_failed', `Label ${key} is not ${value}.`);
        }
      }
      for (const key of change.ifUnset ?? []) {
        if (current[key] !== undefined) {
          throw new BoardError('precondition_failed', `Label ${key} is already set.`);
        }
      }
      return this.applyLabels(root.threadId, root.channel, change.actor, set, change.unset ?? []);
    });
  }

  /**
   * Claims a ready thread for `actor`: the named one, or the oldest ready one in `channel`.
   * The check and the write share one write transaction, so two agents never claim the same thread.
   */
  claim(input: {
    id?: string | undefined;
    channel?: string | undefined;
    labels?: string[] | undefined;
    actor: string;
  }): Thread {
    return this.transaction(() => {
      let threadId: string;
      if (input.id) {
        threadId = this.getRoot(input.id).threadId;
        const state = this.getLabels(threadId)[STATE_LABEL];
        if (state !== 'ready') {
          throw new BoardError(
            state === 'claimed' ? 'task_claimed' : 'not_ready',
            `Thread ${threadId} is ${state ?? 'not a task'}, not ready.`,
          );
        }
      } else {
        // Posting order, not id order: ids made in the same millisecond do not sort by age.
        const [oldest] = this.listThreads(
          {
            channel: input.channel,
            labels: [...(input.labels ?? []), `${STATE_LABEL}=ready`],
            limit: 1,
          },
          'm.seq',
        );
        if (!oldest) {
          throw new BoardError('nothing_ready', 'No ready thread matches.');
        }
        threadId = oldest.id;
      }
      const channel = this.getRoot(threadId).channel;
      const claim = { [STATE_LABEL]: 'claimed', [OWNER_LABEL]: input.actor };
      this.applyLabels(threadId, channel, input.actor, claim, []);
      return this.getThread(threadId);
    });
  }

  /** Ends a claim held by `actor`: posts `text` if given, then sets the thread's state. */
  settle(input: {
    id: string;
    actor: string;
    state: 'done' | 'failed' | 'ready';
    text?: string | undefined;
  }): Thread {
    return this.transaction(() => {
      const root = this.getRoot(input.id);
      const labels = this.getLabels(root.threadId);
      if (labels[STATE_LABEL] !== 'claimed' || labels[OWNER_LABEL] !== input.actor) {
        throw new BoardError(
          'claim_not_held',
          `Thread ${root.threadId} is not claimed by ${input.actor}.`,
        );
      }
      if (input.text) {
        this.insertMessage({
          channel: root.channel,
          threadId: root.threadId,
          text: input.text,
          author: input.actor,
        });
      }
      const released = input.state === 'ready';
      this.applyLabels(
        root.threadId,
        root.channel,
        input.actor,
        { [STATE_LABEL]: input.state },
        released ? [OWNER_LABEL] : [],
      );
      return this.getThread(root.threadId);
    });
  }

  /**
   * Posts a session's status to its own thread: the first call starts the thread, later calls
   * reply to it, and each call updates its labels. `key` identifies the session.
   */
  checkin(input: {
    key: string;
    channel: string;
    author: string;
    text: string;
    labels?: Labels | undefined;
    unset?: string[] | undefined;
  }): Thread {
    return this.transaction(() => {
      const { message, created } = this.post({
        channel: input.channel,
        author: input.author,
        text: `**${input.author}**\n\n${input.text}`,
        idempotencyKey: `checkin:${input.key}`,
      });
      if (!created) {
        this.reply({ id: message.id, text: input.text, author: input.author });
      }
      this.label({ id: message.id, actor: input.author, set: input.labels, unset: input.unset });
      return this.getThread(message.id);
    });
  }

  /** Threads matching the filter, most recently active first unless `orderBy` says otherwise. */
  listThreads(filter: ThreadFilter = {}, orderBy = 'last_cursor DESC'): ThreadSummary[] {
    const where = ['m.id = m.thread_id'];
    const params: SQLInputValue[] = [];
    if (filter.channel) {
      if (filter.channel.endsWith('/')) {
        where.push("m.channel LIKE ? ESCAPE '\\'");
        params.push(`${escapeLike(filter.channel)}%`);
      } else {
        where.push('m.channel = ?');
        params.push(filter.channel);
      }
    }
    for (const { key, values } of (filter.labels ?? []).map(parseLabelFilter)) {
      const valueClause =
        values.length > 0 ? `AND l.value IN (${values.map(() => '?').join(', ')})` : '';
      where.push(
        `EXISTS (SELECT 1 FROM labels l WHERE l.thread_id = m.id AND l.key = ? ${valueClause})`,
      );
      params.push(key, ...values);
    }
    if (filter.text) {
      where.push(
        "EXISTS (SELECT 1 FROM messages t WHERE t.thread_id = m.id AND t.text LIKE ? ESCAPE '\\')",
      );
      params.push(`%${escapeLike(filter.text)}%`);
    }
    if (filter.by) {
      where.push('EXISTS (SELECT 1 FROM messages a WHERE a.thread_id = m.id AND a.author = ?)');
      params.push(filter.by);
    }
    const rows = this.db
      .prepare(
        `SELECT m.*, (SELECT MAX(cursor) FROM events e WHERE e.thread_id = m.id) AS last_cursor
         FROM messages m WHERE ${where.join(' AND ')} ORDER BY ${orderBy} LIMIT ?`,
      )
      .all(...params, filter.limit ?? 50);
    return rows.map((row) => this.summarize(toMessage(row)));
  }

  /** The whole thread that message `id` belongs to. */
  getThread(id: string): Thread {
    const root = this.getRoot(id);
    const replies = this.db
      .prepare('SELECT * FROM messages WHERE thread_id = ? AND id != thread_id ORDER BY seq')
      .all(root.threadId)
      .map(toMessage);
    const newest = this.row(
      'SELECT MAX(cursor) AS cursor FROM events WHERE thread_id = ?',
      root.threadId,
    );
    return { ...this.summarize(root), replies, cursor: int(newest, 'cursor') };
  }

  channels(): ChannelSummary[] {
    return this.db
      .prepare(
        `SELECT m.channel AS channel, COUNT(*) AS threads, COUNT(l.thread_id) AS needs,
                COUNT(CASE WHEN s.value = 'ready' THEN 1 END) AS ready,
                COUNT(CASE WHEN s.value IN ('work', 'working', 'claimed') THEN 1 END) AS working
         FROM messages m
         LEFT JOIN labels l ON l.thread_id = m.id AND l.key = ?
         LEFT JOIN labels s ON s.thread_id = m.id AND s.key = ?
         WHERE m.id = m.thread_id GROUP BY m.channel ORDER BY m.channel`,
      )
      .all(NEEDS_LABEL, STATE_LABEL)
      .map((row) => ({
        channel: str(row, 'channel'),
        threads: int(row, 'threads'),
        needs: int(row, 'needs'),
        ready: int(row, 'ready'),
        working: int(row, 'working'),
      }));
  }

  /** The cursor of the newest event; events after it are new. */
  lastCursor(): number {
    const { cursor } = this.row('SELECT MAX(cursor) AS cursor FROM events');
    return typeof cursor === 'number' ? cursor : 0;
  }

  /** The cursor of the event that posted message `id`. */
  cursorOf(id: string): number {
    const row = this.db.prepare('SELECT cursor FROM events WHERE message_id = ?').get(id);
    if (!row) {
      throw new BoardError('not_found', `No message ${id}.`);
    }
    return int(row, 'cursor');
  }

  /** Events after `cursor` that match the filter, oldest first. */
  eventsAfter(cursor: number, filter: EventFilter = {}): BoardEvent[] {
    const labelFilters = (filter.labels ?? []).map(parseLabelFilter);
    const rows = this.db
      .prepare('SELECT * FROM events WHERE cursor > ? ORDER BY cursor LIMIT 500')
      .all(cursor);
    return rows
      .map((row) => this.toEvent(row))
      .filter((event) =>
        matchesEvent(event, filter, labelFilters, () => this.getLabels(event.threadId)),
      );
  }

  private toEvent(row: Row): BoardEvent {
    const base = {
      cursor: int(row, 'cursor'),
      threadId: str(row, 'thread_id'),
      channel: str(row, 'channel'),
      actor: str(row, 'actor'),
      at: str(row, 'at'),
    };
    if (row.type === 'message.posted') {
      const message = this.row('SELECT * FROM messages WHERE id = ?', str(row, 'message_id'));
      return { ...base, type: 'message.posted', message: toMessage(message) };
    }
    const data = parseJson<{ set: Labels; unset: string[] }>(str(row, 'data'));
    return { ...base, type: 'labels.changed', ...data, labels: this.getLabels(base.threadId) };
  }

  private summarize(message: Message): ThreadSummary {
    const last = this.row(
      'SELECT * FROM messages WHERE thread_id = ? ORDER BY seq DESC LIMIT 1',
      message.id,
    );
    const stats = this.row(
      `SELECT (SELECT COUNT(*) FROM messages WHERE thread_id = ?) - 1 AS replies,
              (SELECT MAX(at) FROM events WHERE thread_id = ?) AS updated_at`,
      message.id,
      message.id,
    );
    return {
      id: message.id,
      channel: message.channel,
      title: titleOf(message.text),
      labels: this.getLabels(message.id),
      message,
      last: toMessage(last),
      replyCount: int(stats, 'replies'),
      updatedAt: str(stats, 'updated_at'),
    };
  }

  /** The root message of the thread that message `id` belongs to. */
  private getRoot(id: string): Message {
    const row = this.db
      .prepare('SELECT r.* FROM messages m JOIN messages r ON r.id = m.thread_id WHERE m.id = ?')
      .get(id);
    if (!row) {
      throw new BoardError('not_found', `No message ${id}.`);
    }
    return toMessage(row);
  }

  /** Runs a query that always yields exactly one row. */
  private row(sql: string, ...params: SQLInputValue[]): Row {
    const row = this.db.prepare(sql).get(...params);
    if (!row) {
      throw new Error(`Query returned no row: ${sql}`);
    }
    return row;
  }

  private getLabels(threadId: string): Labels {
    const rows = this.db
      .prepare('SELECT key, value FROM labels WHERE thread_id = ? ORDER BY key')
      .all(threadId);
    return Object.fromEntries(rows.map((row) => [str(row, 'key'), str(row, 'value')]));
  }

  private insertMessage(input: {
    channel: string;
    threadId: string | undefined;
    text: string;
    author: string;
    idempotencyKey?: string | undefined;
  }): { message: Message; created: boolean } {
    if (input.idempotencyKey) {
      const existing = this.db
        .prepare('SELECT * FROM messages WHERE idempotency_key = ?')
        .get(input.idempotencyKey);
      if (existing) {
        return { message: toMessage(existing), created: false };
      }
    }
    const text = redactSecrets(input.text).trim();
    if (!text) {
      throw new BoardError('empty_message', 'Message text is empty.');
    }
    if (text.length > MAX_TEXT_LENGTH) {
      throw new BoardError('message_too_long', `Message exceeds ${MAX_TEXT_LENGTH} characters.`);
    }
    if (!input.author.trim()) {
      throw new BoardError('invalid_author', 'Author handle is empty.');
    }
    const id = `msg_${ulid().toLowerCase()}`;
    const message: Message = {
      id,
      threadId: input.threadId ?? id,
      channel: input.channel,
      author: input.author,
      text,
      createdAt: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO messages (id, thread_id, channel, author, text, created_at, idempotency_key)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        message.id,
        message.threadId,
        message.channel,
        message.author,
        message.text,
        message.createdAt,
        input.idempotencyKey ?? null,
      );
    this.insertEvent('message.posted', message.threadId, message.channel, message.author, {
      messageId: message.id,
    });
    return { message, created: true };
  }

  /** Writes label changes and one event for those that changed anything. */
  private applyLabels(
    threadId: string,
    channel: string,
    actor: string,
    set: Labels,
    unset: string[],
  ): Labels {
    const current = this.getLabels(threadId);
    const changedSet: Labels = {};
    for (const [key, value] of Object.entries(set)) {
      if (current[key] !== value) {
        this.db
          .prepare('INSERT OR REPLACE INTO labels (thread_id, key, value) VALUES (?, ?, ?)')
          .run(threadId, key, value);
        changedSet[key] = value;
      }
    }
    const changedUnset = unset.filter((key) => current[key] !== undefined && !(key in set));
    for (const key of changedUnset) {
      this.db.prepare('DELETE FROM labels WHERE thread_id = ? AND key = ?').run(threadId, key);
    }
    if (Object.keys(changedSet).length > 0 || changedUnset.length > 0) {
      this.insertEvent('labels.changed', threadId, channel, actor, {
        set: changedSet,
        unset: changedUnset,
      });
    }
    return this.getLabels(threadId);
  }

  private insertEvent(
    type: BoardEvent['type'],
    threadId: string,
    channel: string,
    actor: string,
    data: {
      messageId?: string | undefined;
      set?: Labels | undefined;
      unset?: string[] | undefined;
    },
  ): void {
    this.db
      .prepare(
        `INSERT INTO events (type, thread_id, channel, actor, at, message_id, data)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        type,
        threadId,
        channel,
        actor,
        new Date().toISOString(),
        data.messageId ?? null,
        JSON.stringify(data),
      );
  }

  /** Runs `fn` in a write transaction; nested calls join the outer one. */
  private transaction<T>(fn: () => T): T {
    if (this.db.isTransaction) {
      return fn();
    }
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
}

function matchesEvent(
  event: BoardEvent,
  filter: EventFilter,
  labelFilters: LabelFilter[],
  getLabels: () => Labels,
): boolean {
  if (filter.threadId && event.threadId !== filter.threadId) {
    return false;
  }
  if (filter.channel) {
    const matches = filter.channel.endsWith('/')
      ? event.channel.startsWith(filter.channel)
      : event.channel === filter.channel;
    if (!matches) {
      return false;
    }
  }
  if (filter.by && event.actor !== filter.by) {
    return false;
  }
  if (filter.text) {
    const text = event.type === 'message.posted' ? event.message.text : '';
    if (!text.toLowerCase().includes(filter.text.toLowerCase())) {
      return false;
    }
  }
  return labelFilters.length === 0 || matchesLabelFilters(getLabels(), labelFilters);
}

function normalizeLabels(labels: Labels): Labels {
  const result: Labels = {};
  for (const [key, raw] of Object.entries(labels)) {
    assertLabelKey(key);
    const value = redactSecrets(raw).trim();
    if (!value || value.includes('\n') || value.length > MAX_LABEL_VALUE_LENGTH) {
      throw new BoardError(
        'invalid_label',
        `Label ${key} needs a one-line value of at most ${MAX_LABEL_VALUE_LENGTH} characters.`,
      );
    }
    result[key] = value;
  }
  return result;
}

/** Reads a text column; any other type means the schema and this code disagree. */
function str(row: Row, column: string): string {
  const value = row[column];
  if (typeof value !== 'string') {
    throw new Error(`Column ${column} is not text.`);
  }
  return value;
}

function int(row: Row, column: string): number {
  const value = row[column];
  if (typeof value !== 'number') {
    throw new Error(`Column ${column} is not a number.`);
  }
  return value;
}

function toMessage(row: Row): Message {
  return {
    id: str(row, 'id'),
    threadId: str(row, 'thread_id'),
    channel: str(row, 'channel'),
    author: str(row, 'author'),
    text: str(row, 'text'),
    createdAt: str(row, 'created_at'),
  };
}

/** A thread's title: the first line of its root message without Markdown markers. */
export function titleOf(text: string): string {
  const line = text.split('\n').find((candidate) => candidate.trim()) ?? '';
  return line
    .replace(/^#+\s*/, '')
    .replace(/\*\*|__/g, '')
    .trim()
    .slice(0, 160);
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

function suppressExperimentalWarning<T>(load: () => T): T {
  // oxlint-disable-next-line typescript/unbound-method -- saved only to be put back unchanged
  const emitWarning = process.emitWarning;
  process.emitWarning = () => {};
  try {
    return load();
  } finally {
    process.emitWarning = emitWarning;
  }
}
