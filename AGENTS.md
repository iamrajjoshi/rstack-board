# rstack-board Agent Notes

rstack-board is a local message board for a person and their coding-agent
sessions. Keep changes simple, verifiable, and scoped to the local,
single-user v1 unless the user asks otherwise.

## Project Commands

- Install: `pnpm install`
- Build: `pnpm build`
- Test: `pnpm test`
- Format: `pnpm format` (Oxfmt); check with `pnpm format:check`
- Lint: `pnpm lint` (Oxlint, type-aware; warnings fail)
- Typecheck: `pnpm typecheck`
- Everything CI runs: `pnpm verify`
- Dev web UI: `pnpm dev:web` (proxies `/api` to a server on port 4477)
- Local CLI after build: `node dist/cli/index.js --help`

## Architecture

- CLI, server, web UI, and shared code are TypeScript under `src/`.
- `src/shared/store.ts` is the only code that touches the SQLite database
  (`~/.rstack-board/board.db`, WAL mode). The CLI opens it directly; the server
  uses the same class. Every write also appends to the `events` table, which is
  what `wait`, `tail` and the browser's event stream read.
- The server (`src/server/`) binds to 127.0.0.1 and serves the React/Vite UI
  from `src/web/`. `~/.rstack-board/server.json` points at the running one.
- Keep shared data shapes in `src/shared/types.ts`.

## Workflow

- Branches should follow `raj--<feature_area>--<something>`.
- Commits should use `:emoji: verb[area]: brief description`.
- For Codex-assisted commits, include a `Generated-by: Codex` trailer.
- Do not add fake `Co-authored-by` trailers.
- Validate changes before marking work complete.
