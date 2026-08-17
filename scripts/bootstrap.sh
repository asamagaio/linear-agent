#!/usr/bin/env bash
#
# Set linear-agent up on a fresh machine: install, build, put the binary on
# PATH, and teach Claude Code about it. Safe to re-run — every step is
# idempotent.
#
# It deliberately does NOT move credentials. Tokens stay on the machine that
# earned them; run `linear-agent auth` at the end to mint a new one.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLAUDE_MD="${HOME}/.claude/CLAUDE.md"
MARKER="<!-- linear-agent:instructions -->"

cd "$REPO_ROOT"

echo "==> Installing dependencies"
if [ -f package-lock.json ]; then
  npm ci
else
  npm install
fi

echo "==> Building"
npm run build

echo "==> Linking the binary onto PATH"
npm link

echo "==> Teaching Claude Code about the CLI"
mkdir -p "$(dirname "$CLAUDE_MD")"
touch "$CLAUDE_MD"
if grep -qF "$MARKER" "$CLAUDE_MD"; then
  echo "    already present in ${CLAUDE_MD}, leaving it alone"
else
  {
    printf '\n%s\n' "$MARKER"
    bash "${REPO_ROOT}/scripts/render-claude-md.sh"
  } >>"$CLAUDE_MD"
  echo "    appended the Linear section to ${CLAUDE_MD}"
  echo "    values came from claude-md.config (see claude-md.config.example)"
fi

echo
echo "==> Done. Remaining step, which only you can do:"
echo
echo "    linear-agent auth --client-id=<ID> --client-secret=<SECRET>"
echo
echo "    Both come from your Linear application at"
echo "    https://linear.app/settings/api/applications — the app itself is"
echo "    registered per workspace, so it survives a machine change; only the"
echo "    token is per machine."
echo
echo "    Then confirm with: linear-agent whoami"
