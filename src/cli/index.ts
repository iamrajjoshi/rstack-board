#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { Command, CommanderError, Option } from 'commander';
import open from 'open';
import { BoardError } from '../shared/errors';
import { type BoardState, importBoardState } from '../shared/import-state';
import { parseJson } from '../shared/json';
import { parseDuration, parseLabels } from '../shared/labels';
import {
  cliHandle,
  cliThreadLabels,
  databaseFile,
  packageVersion,
  personHandle,
  stateDir,
} from '../shared/paths';
import { type EventFilter, SCHEMA_VERSION, Store } from '../shared/store';
import type { BoardEvent, Message, Thread, ThreadSummary, Via } from '../shared/types';
import { ensureServer, findServer, serverUrl, stopServer } from './lifecycle';

const POLL_MS = 200;

const program = new Command()
  .name('rstack-board')
  .description('Local message board for people and coding agents.')
  .version(packageVersion)
  .option('--json', 'print JSON')
  .option('--as <profile>', 'author handle for writes (default: $BOARD_PROFILE)')
  // Usage errors reach the handler at the bottom, so --json reports them as reason `usage`.
  .exitOverride()
  .configureOutput({
    outputError: (text, write) => {
      if (!process.argv.includes('--json')) {
        write(text);
      }
    },
  });

interface Globals {
  json?: boolean;
  as?: string;
}

const globals = (): Globals => program.opts<Globals>();
const me = (): string => cliHandle(globals().as);
/** Labels every thread this CLI starts carries, under any labels the caller passed. */
const myLabels = (labels: Record<string, string>): Record<string, string> => ({
  ...cliThreadLabels(globals().as),
  ...labels,
});
const openStore = (): Store => new Store(databaseFile());
const collect = (value: string, previous: string[]): string[] => [...previous, value];
const isMessageId = (target: string | undefined): target is string =>
  target?.startsWith('msg_') === true;

/** Prints `value` as JSON under --json, else the text form. */
function print(value: unknown, text: string): void {
  process.stdout.write(globals().json ? `${JSON.stringify(value, null, 2)}\n` : `${text}\n`);
}

/** Message text from the argument, `--file <path>`, or stdin for `--file -`. */
function readText(text: string | undefined, file: string | undefined): string {
  if (file) {
    return readFileSync(file === '-' ? 0 : file, 'utf8');
  }
  if (text === undefined) {
    throw new BoardError('empty_message', 'Pass the message text or --file.');
  }
  return text;
}

function formatMessage(message: Message): string {
  return `${message.author}  ${message.createdAt}  ${message.id}\n${message.text}\n`;
}

function formatLabels(labels: Record<string, string>): string {
  return Object.entries(labels)
    .map(([key, value]) => `${key}=${value}`)
    .join(' ');
}

function formatSummary(thread: ThreadSummary): string {
  const replies = thread.replyCount > 0 ? `  (${thread.replyCount} replies)` : '';
  const labels = formatLabels(thread.labels);
  return `${thread.id}  ${thread.channel}  ${thread.title}${labels ? `  [${labels}]` : ''}${replies}`;
}

function formatThread(thread: Thread): string {
  return [
    `# ${thread.title}`,
    `${thread.channel}  [${formatLabels(thread.labels)}]  cursor ${thread.cursor}`,
    '',
    ...[thread.message, ...thread.replies].map(formatMessage),
  ].join('\n');
}

function formatEvent(event: BoardEvent): string {
  const head = `${event.at}  ${event.channel}  ${event.threadId}  ${event.actor}`;
  if (event.type === 'message.posted') {
    return `${head}  posted ${event.message.id}\n${event.message.text}\n`;
  }
  const changes = [formatLabels(event.set), ...event.unset.map((key) => `-${key}`)];
  return `${head}  labels ${changes.filter(Boolean).join(' ')}\n`;
}

interface FilterOptions {
  label: string[];
  text?: string;
  by?: string;
  via?: Via;
}

function addFilters(command: Command): Command {
  return command
    .option('--label <filter>', 'label filter: key, key=value or key=a|b', collect, [])
    .option('--text <words>', 'only messages containing this text')
    .option('--by <handle>', 'only this author')
    .addOption(
      new Option('--via <origin>', "only writes made on the board's page (web) or the CLI").choices(
        ['web', 'cli'],
      ),
    );
}

/** The event cursor for `--after`: an event cursor, or a message id for the event that posted it. */
function resumeCursor(store: Store, after: string): number {
  if (isMessageId(after)) {
    return store.cursorOf(after);
  }
  const cursor = Number(after);
  if (!Number.isInteger(cursor) || cursor < 0) {
    throw new BoardError('usage', '--after takes a message id or an event cursor.');
  }
  return cursor;
}

/** Turns a `[channel|id]` argument and filter flags into an event filter. */
function eventFilter(
  store: Store,
  target: string | undefined,
  options: FilterOptions,
): EventFilter {
  return {
    ...(isMessageId(target) ? { threadId: store.getThread(target).id } : { channel: target }),
    labels: options.label,
    text: options.text,
    by: options.by,
    via: options.via,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

program
  .command('open', { isDefault: true })
  .description('start the local server and open the board in the browser')
  .option('--port <port>', 'port for a newly started server', Number)
  .option('--no-open', 'start the server without opening a browser')
  .action(async (options: { port?: number; open: boolean }) => {
    const info = await ensureServer({ port: options.port });
    const url = serverUrl(info);
    // Over SSH there is no browser here: the board is reached through a tunnel instead.
    const remote = Boolean(process.env.SSH_CONNECTION) && !process.env.DISPLAY;
    if (options.open && !remote) {
      await open(url);
    }
    if (remote && !globals().json) {
      process.stderr.write(
        `This is an SSH session, so the board is only reachable on this machine. On your own machine run\n  ssh -N -L ${info.port}:localhost:${info.port} <the host you ssh to>\nand keep it running, then open:\n`,
      );
    }
    print({ url }, url);
  });

program
  .command('status')
  .description('show whether the server is running and where state lives')
  .action(async () => {
    const info = await findServer();
    const status = {
      running: info !== null,
      url: info ? serverUrl(info) : null,
      pid: info?.pid ?? null,
      stateDir: stateDir(),
      database: databaseFile(),
      version: packageVersion,
      schemaVersion: SCHEMA_VERSION,
      handle: me(),
      person: personHandle(),
      server: info ? { ...info, url: serverUrl(info) } : null,
    };
    print(
      status,
      `${info ? `running at ${status.url} (pid ${info.pid})` : 'not running'}\n${status.database}`,
    );
  });

program
  .command('stop')
  .description('stop the local server; the board data stays on disk')
  .action(async () => {
    const info = await findServer();
    if (info) {
      stopServer(info);
    }
    print({ stopped: info !== null }, info ? 'stopped' : 'not running');
  });

program
  .command('whoami')
  .description('print the handle your writes are posted as')
  .action(() => print({ handle: me() }, me()));

program
  .command('channels')
  .description('list channels with thread counts')
  .action(() => {
    const channels = openStore().channels();
    print(
      { channels },
      channels
        .map(
          (c) =>
            `${c.channel}  ${c.threads} threads  ${c.needs} need you  ${c.ready} ready  ${c.working} working`,
        )
        .join('\n'),
    );
  });

addFilters(
  program
    .command('read [target]')
    .description('list threads in a channel (prs/ for a subtree), or print one thread by id')
    .option('-n <count>', 'maximum threads', Number, 50),
).action((target: string | undefined, options: FilterOptions & { n: number }) => {
  const store = openStore();
  if (isMessageId(target)) {
    const thread = store.getThread(target);
    print(thread, formatThread(thread));
    return;
  }
  const threads = store.listThreads({
    channel: target,
    labels: options.label,
    text: options.text,
    by: options.by,
    via: options.via,
    limit: options.n,
  });
  print({ threads, cursor: store.lastCursor() }, threads.map(formatSummary).join('\n'));
});

program
  .command('post <channel> [text]')
  .description('start a thread')
  .option('--file <path>', 'read the text from a file, or - for stdin')
  .option('--label <key=value>', 'label to set', collect, [])
  .option('--idempotency-key <key>', 'a retry with the same key does not post again')
  .action(
    (
      channel: string,
      text: string | undefined,
      options: { file?: string; label: string[]; idempotencyKey?: string },
    ) => {
      const { message } = openStore().post({
        channel,
        text: readText(text, options.file),
        author: me(),
        labels: myLabels(parseLabels(options.label)),
        idempotencyKey: options.idempotencyKey,
      });
      print(message, message.id);
    },
  );

program
  .command('reply <id> [text]')
  .description('reply to a thread')
  .option('--file <path>', 'read the text from a file, or - for stdin')
  .option('--idempotency-key <key>', 'a retry with the same key does not post again')
  .action(
    (id: string, text: string | undefined, options: { file?: string; idempotencyKey?: string }) => {
      const { message } = openStore().reply({
        id,
        text: readText(text, options.file),
        author: me(),
        idempotencyKey: options.idempotencyKey,
      });
      print(message, message.id);
    },
  );

program
  .command('label <id> [labels...]')
  .description('set key=value labels on a thread, and remove others')
  .option('--unset <key>', 'label to remove', collect, [])
  .option('--if <key=value>', 'only if this label has this value', collect, [])
  .option('--if-unset <key>', 'only if this label is not set', collect, [])
  .action(
    (
      id: string,
      labels: string[],
      options: { unset: string[]; if: string[]; ifUnset: string[] },
    ) => {
      const result = openStore().label({
        id,
        actor: me(),
        set: parseLabels(labels),
        unset: options.unset,
        ifEquals: parseLabels(options.if),
        ifUnset: options.ifUnset,
      });
      print({ labels: result }, formatLabels(result));
    },
  );

addFilters(
  program
    .command('tail [target]')
    .description('print new messages and label changes until interrupted')
    .option('--after <cursor>', 'first replay events after this event cursor or message id'),
).action(async (target: string | undefined, options: FilterOptions & { after?: string }) => {
  const store = openStore();
  const filter = eventFilter(store, target, options);
  // One loop serves the replay and the live stream, so nothing between them is lost or repeated.
  let cursor = options.after ? resumeCursor(store, options.after) : store.lastCursor();
  for (;;) {
    const batch = store.scanEvents(cursor, filter);
    for (const event of batch.events) {
      process.stdout.write(globals().json ? `${JSON.stringify(event)}\n` : formatEvent(event));
    }
    cursor = batch.cursor;
    await sleep(POLL_MS);
  }
});

addFilters(
  program
    .command('wait [target]')
    .description(
      "block until someone else's message or label change matches, print it, and exit; exits 1 on timeout",
    )
    .option('--timeout <duration>', 'how long to wait: 30s, 10m, 1h', '30m')
    .option('--after <cursor>', 'resume after this message id or event cursor'),
).action(
  async (
    target: string | undefined,
    options: FilterOptions & { timeout: string; after?: string },
  ) => {
    const store = openStore();
    const filter = eventFilter(store, target, options);
    const deadline = Date.now() + parseDuration(options.timeout);
    // A thread is watched from the named message, so an answer that already arrived returns at
    // once; a channel is watched from now.
    let cursor = options.after
      ? resumeCursor(store, options.after)
      : isMessageId(target)
        ? store.cursorOf(target)
        : store.lastCursor();
    for (;;) {
      const events = store.eventsAfter(cursor);
      const event = store.eventsAfter(cursor, filter).find((e) => e.actor !== me());
      if (event) {
        print(event, `${formatEvent(event)}resume: --after ${event.cursor}`);
        return;
      }
      cursor = events.at(-1)?.cursor ?? cursor;
      if (Date.now() >= deadline) {
        throw new BoardError('timeout', `Nothing matched within ${options.timeout}.`);
      }
      await sleep(POLL_MS);
    }
  },
);

program
  .command('checkin [text]')
  .description(
    "post this session's status to its own thread: in --channel, else under $BOARD_COORDINATOR/workers, else in threads for a one-off",
  )
  .option('--file <path>', 'read the text from a file, or - for stdin')
  .option(
    '--coordinator <name>',
    'the coordinator this session works for (default: $BOARD_COORDINATOR)',
  )
  .option('--channel <path>', 'file the thread in this channel; wins over --coordinator')
  .option('--state <state>', 'set the state label, e.g. working, blocked, done')
  .option('--pr <number>', 'set the pr label')
  .option('--needs <what>', 'mark the thread as waiting on the person, e.g. decision')
  .option('--label <key=value>', 'another label to set', collect, [])
  .option('--unset <key>', 'label to remove', collect, [])
  .action(
    (
      text: string | undefined,
      options: {
        file?: string;
        coordinator?: string;
        channel?: string;
        state?: string;
        pr?: string;
        needs?: string;
        label: string[];
        unset: string[];
      },
    ) => {
      const coordinator = options.coordinator || process.env.BOARD_COORDINATOR;
      // An explicit channel keys its own thread (`#` cannot appear in a channel or coordinator).
      const thread = openStore().checkin({
        key: options.channel ? `#${options.channel}:${me()}` : `${coordinator ?? ''}:${me()}`,
        channel: options.channel || (coordinator ? `${coordinator}/workers` : 'threads'),
        author: me(),
        person: personHandle(),
        text: readText(text, options.file),
        labels: myLabels({
          ...parseLabels(options.label),
          ...(options.state ? { state: options.state } : {}),
          ...(options.pr ? { pr: options.pr } : {}),
          ...(options.needs ? { needs: options.needs } : {}),
        }),
        unset: options.unset,
      });
      print(thread, `${thread.id}  ${thread.channel}`);
    },
  );

const tasks = program.command('tasks').description('threads agents claim, work on and complete');

tasks
  .command('create <channel> [text]')
  .description('post a thread that is ready to be claimed (state=ready)')
  .option('--file <path>', 'read the text from a file, or - for stdin')
  .option('--label <key=value>', 'label to set', collect, [])
  .option('--idempotency-key <key>', 'a retry with the same key does not post again')
  .action(
    (
      channel: string,
      text: string | undefined,
      options: { file?: string; label: string[]; idempotencyKey?: string },
    ) => {
      const { message } = openStore().post({
        channel,
        text: readText(text, options.file),
        author: me(),
        labels: myLabels({ ...parseLabels(options.label), state: 'ready' }),
        idempotencyKey: options.idempotencyKey,
      });
      print(message, message.id);
    },
  );

tasks
  .command('claim [id]')
  .description('claim a ready thread: the one named, or the oldest in --ready <channel>')
  .option('--ready <channel>', 'claim the oldest ready thread in this channel')
  .option('--label <filter>', 'with --ready: only threads matching this label', collect, [])
  .option('--wait <duration>', 'with --ready: wait this long for a thread to become ready')
  .action(
    async (id: string | undefined, options: { ready?: string; label: string[]; wait?: string }) => {
      if (!id && !options.ready) {
        throw new BoardError('usage', 'Pass a thread id or --ready <channel>.');
      }
      const store = openStore();
      const deadline = Date.now() + (options.wait ? parseDuration(options.wait) : 0);
      for (;;) {
        try {
          const thread = store.claim({
            id,
            channel: options.ready,
            labels: options.label,
            actor: me(),
          });
          print(thread, formatThread(thread));
          return;
        } catch (error) {
          const retry = error instanceof BoardError && error.reason === 'nothing_ready';
          if (!retry || Date.now() >= deadline) {
            throw error;
          }
          await sleep(POLL_MS);
        }
      }
    },
  );

for (const [name, state, description] of [
  ['complete', 'done', 'finish a thread you claimed, with an optional result (state=done)'],
  ['fail', 'failed', 'give up on a thread you claimed, with the reason (state=failed)'],
  ['release', 'ready', 'return a thread you claimed to the queue (state=ready)'],
] as const) {
  tasks
    .command(`${name} <id> [text]`)
    .description(description)
    .option('--file <path>', 'read the text from a file, or - for stdin')
    .action((id: string, text: string | undefined, options: { file?: string }) => {
      const thread = openStore().settle({
        id,
        actor: me(),
        state,
        text: options.file || text !== undefined ? readText(text, options.file) : undefined,
      });
      print(thread, formatSummary(thread));
    });
}

program
  .command('import <file>')
  .description(
    'fill the board from a state document (see examples/board-state.json); safe to rerun',
  )
  .option('--project <name>', 'file everything under <name>/ (prs, merged, workers, needs-you)')
  .action((file: string, options: { project?: string }) => {
    const state = parseJson<BoardState>(readFileSync(file, 'utf8'));
    const result = importBoardState(openStore(), state, me(), options.project);
    print(result, `${result.created} threads created, ${result.updated} refreshed`);
  });

program.parseAsync().catch((error: unknown) => {
  const json = process.argv.includes('--json');
  if (error instanceof CommanderError) {
    // Commander has already printed help, the version or (without --json) the usage error.
    if (json && error.exitCode !== 0) {
      process.stderr.write(`${JSON.stringify({ reason: 'usage', message: error.message })}\n`);
    }
    process.exitCode = error.exitCode;
    return;
  }
  // Under --json a caller always gets a reason to branch on, even for an unexpected failure.
  if (!(error instanceof BoardError) && !json) {
    throw error;
  }
  const body =
    error instanceof BoardError
      ? { reason: error.reason, message: error.message }
      : { reason: 'error', message: error instanceof Error ? error.message : String(error) };
  process.stderr.write(json ? `${JSON.stringify(body)}\n` : `${body.message}\n`);
  process.exitCode = 1;
});
