import { spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import getPort from 'get-port';
import { parseJson } from '../shared/json';
import { defaultPort, packageVersion, serverFile, serverLogFile, stateDir } from '../shared/paths';
import type { ServerInfo } from '../shared/types';

const START_TIMEOUT_MS = 8000;

export function serverUrl(info: Pick<ServerInfo, 'port'>): string {
  return `http://localhost:${info.port}`;
}

export function readServerInfo(): ServerInfo | null {
  if (!existsSync(serverFile())) {
    return null;
  }
  return parseJson<ServerInfo>(readFileSync(serverFile(), 'utf8'));
}

async function readHealth(info: ServerInfo): Promise<{ version: string; stateDir: string } | null> {
  try {
    const response = await fetch(`http://127.0.0.1:${info.port}/api/health`);
    return parseJson<{ version: string; stateDir: string }>(await response.text());
  } catch {
    return null;
  }
}

/**
 * The recorded server if it answers for this state directory. `server.json` can outlive its
 * process, so the pid in it is only trusted once the port answers as this board.
 */
export async function findServer(): Promise<ServerInfo | null> {
  const info = readServerInfo();
  if (!info) {
    return null;
  }
  const health = await readHealth(info);
  if (health?.stateDir === stateDir()) {
    return { ...info, version: health.version };
  }
  rmSync(serverFile(), { force: true });
  return null;
}

/** Returns the running server, starting a background one if none answers. */
export async function ensureServer(
  options: { port?: number | undefined } = {},
): Promise<ServerInfo> {
  const existing = await findServer();
  if (existing?.version === packageVersion) {
    return existing;
  }
  if (existing) {
    stopServer(existing);
  }
  const port = options.port ?? (await getPort({ port: existing?.port ?? defaultPort }));
  const daemonPath = fileURLToPath(new URL('../server/daemon.js', import.meta.url));
  if (!existsSync(daemonPath)) {
    throw new Error(`Cannot find the server at ${daemonPath}. Run pnpm build first.`);
  }
  mkdirSync(stateDir(), { recursive: true });
  const logFd = openSync(serverLogFile(), 'a');
  const child = spawn(process.execPath, [daemonPath], {
    detached: true,
    env: { ...process.env, RSTACK_BOARD_PORT: String(port), RSTACK_BOARD_STATE_DIR: stateDir() },
    stdio: ['ignore', logFd, logFd],
  });
  closeSync(logFd);
  child.unref();

  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (readServerInfo()?.pid === child.pid) {
      const info = await findServer();
      if (info) {
        return info;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`The server did not start. See ${serverLogFile()}.`);
}

/** Stops a server that `findServer` returned. */
export function stopServer(info: ServerInfo): void {
  process.kill(info.pid, 'SIGTERM');
  rmSync(serverFile(), { force: true });
}
