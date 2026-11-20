import { execFile } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

export function tempDir(): string {
  return mkdtempSync(path.join(tmpdir(), 'rstack-board-'));
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs a TypeScript entry point in its own process, as agents run the CLI. */
export function runScript(
  script: string,
  args: string[],
  env: Record<string, string> = {},
): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      ['--import', 'tsx', script, ...args],
      { env: { ...process.env, ...env } },
      (error, stdout, stderr) =>
        resolve({
          code: error ? (typeof error.code === 'number' ? error.code : 1) : 0,
          stdout,
          stderr,
        }),
    );
  });
}
