import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { serve } from '@hono/node-server';
import { databaseFile, packageVersion, personHandle, serverFile, stateDir } from '../shared/paths';
import { Store } from '../shared/store';
import type { ServerInfo } from '../shared/types';
import { createApp } from './index';

const port = Number(process.env.RSTACK_BOARD_PORT);
if (!port) {
  throw new Error('RSTACK_BOARD_PORT is required');
}

const store = new Store(databaseFile());
const server = serve({
  fetch: createApp({ store, person: personHandle() }).fetch,
  port,
  // Loopback only: the board has no auth and must not be reachable from the network.
  hostname: '127.0.0.1',
});

server.on('listening', () => {
  const info: ServerInfo = {
    pid: process.pid,
    port,
    version: packageVersion,
    stateDir: stateDir(),
    startedAt: new Date().toISOString(),
  };
  writeFileSync(serverFile(), `${JSON.stringify(info, null, 2)}\n`);
});

for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
  process.on(signal, () => {
    // A replacement server may already have written its own pointer; leave that one alone.
    if (
      existsSync(serverFile()) &&
      JSON.parse(readFileSync(serverFile(), 'utf8')).pid === process.pid
    ) {
      rmSync(serverFile(), { force: true });
    }
    process.exit(0);
  });
}
