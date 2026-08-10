# linear-agent

A CLI that reads and writes Linear issues under the agent's **own** app identity, so
comments are attributable and the human can reply to them.

## Linear

The instructions that teach an agent to use this CLI live in
[docs/claude-md-section.md](docs/claude-md-section.md). That file is the single source of truth:
`npm run setup` installs it into `~/.claude/CLAUDE.md`, and `npm run claude-md:check` reports drift
between the two.

Do not paste a copy of it here or anywhere else in the repo — an out-of-date second copy is worse
than none, because whichever one an agent reads first wins. Edit `docs/claude-md-section.md` and
re-run the setup.

## Working on this repo

- TypeScript, ESM, Node 20+. `npm run build` compiles `src/` to `dist/`; the `bin` entry is
  `dist/index.js`.
- `npm test` builds and runs the suite (`node --test`). It must stay serial — two test files bind
  port 8787.
- Tests never touch the real Keychain: they force the file store with
  `LINEAR_AGENT_CREDENTIALS_STORE=file` and an isolated `XDG_CONFIG_HOME`. The one Keychain test is
  opt-in via `LINEAR_AGENT_TEST_KEYCHAIN=1`.
- **The invariant:** the CLI authenticates only with an `actor=app` OAuth token. It must never fall
  back to a personal API key or a user token — that would make every comment appear as the operator.
  `src/creds.ts` enforces this on load; `whoami` re-checks it against the API.
- Verify GraphQL field names against the schema in `node_modules/@linear/sdk/dist/index-*.d.mts`
  before adding a query. Do not trust remembered field names.
