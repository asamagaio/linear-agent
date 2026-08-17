# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project uses
[semantic versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] — 2026-08-17

First public release.

### Added

- `whoami`, `list`, `read`, `comment`, `status`, `create`, `projects`, and `auth`, each with `--json`.
- Authentication as a Linear app actor, defaulting to the `client_credentials` grant: no browser,
  a 30-day token, and unattended renewal on a 401.
- Browser OAuth flow (`auth --browser`) as a fallback for applications without that grant, using a
  throwaway `127.0.0.1:8787` listener that is closed before the command exits.
- Credential storage in the macOS Keychain, with a `0600` file fallback and non-secret metadata kept
  separately in `~/.config/linear-agent/credentials.json`.
- Human identifiers (`ENG-42`) everywhere, resolved by team key and number, with a fallback through
  Linear's `previousIdentifiers` so a team re-key does not break existing references.
- Workflow state resolution by name, listing the valid states when there is no match.
- Rate-limit backoff that honours Linear's reset hint, capped at 5 attempts or 60 seconds rather
  than hanging.
- Distinct exit codes (`0`–`6`) so a calling agent can branch on the outcome.
- Instructions for Claude Code in `docs/claude-md-section.md`, installed by `npm run setup` and
  checked for drift by `npm run claude-md:check`.

### Security

- The CLI authenticates only as an app. There is no fallback to a personal API key or user token;
  `LINEAR_API_KEY` and similar are ignored on purpose and the error says so.
- Secrets are never printed, and all output passes through a redactor.
- The Keychain write feeds `security` on stdin, keeping the token out of the process table, and
  verifies the round trip because `security` truncates a prompted secret at 128 bytes.
- Terminal control characters are stripped from untrusted issue and comment text.

[1.0.0]: https://github.com/asamagaio/linear-agent/releases/tag/v1.0.0
