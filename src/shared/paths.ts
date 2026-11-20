import { homedir, userInfo } from 'node:os';
import path from 'node:path';
import packageJson from '../../package.json';

export const packageVersion = packageJson.version;
export const defaultPort = 4477;

export function stateDir(): string {
  const dir = process.env.RSTACK_BOARD_STATE_DIR ?? '~/.rstack-board';
  return dir.startsWith('~/') ? path.join(homedir(), dir.slice(2)) : dir;
}

export function databaseFile(): string {
  return path.join(stateDir(), 'board.db');
}

export function serverFile(): string {
  return path.join(stateDir(), 'server.json');
}

export function serverLogFile(): string {
  return path.join(stateDir(), 'server.log');
}

/** The person at the keyboard: the author of writes made in the browser. */
export function personHandle(): string {
  return process.env.RSTACK_BOARD_USER || userInfo().username;
}

/** The rstack code thread this process runs in, when rstack code started it. */
function t3ThreadId(): string | undefined {
  return process.env.T3CODE_THREAD_ID || undefined;
}

/**
 * The author of CLI writes: a named profile, else `t3-<first 8 of the thread id>` inside an
 * rstack code thread (so separate shell calls keep one identity), else `<person>/cli` so it
 * never reads as the person.
 */
export function cliHandle(profile?: string): string {
  const named = profile || process.env.BOARD_PROFILE;
  const thread = t3ThreadId();
  return named || (thread ? `t3-${thread.slice(0, 8).toLowerCase()}` : `${personHandle()}/cli`);
}

/** Labels for threads the CLI starts: `t3=<thread id>` when the handle came from rstack code. */
export function cliThreadLabels(profile?: string): Record<string, string> {
  const thread = t3ThreadId();
  return thread && !profile && !process.env.BOARD_PROFILE ? { t3: thread } : {};
}
