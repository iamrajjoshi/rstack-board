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

/** The author of CLI writes: a named profile, or `<person>/cli` so it never reads as the person. */
export function cliHandle(profile?: string): string {
  return profile || process.env.BOARD_PROFILE || `${personHandle()}/cli`;
}
