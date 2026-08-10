#!/usr/bin/env bash
#
# Report drift between the versioned instructions and the copy installed in
# ~/.claude/CLAUDE.md.
#
# The installed file is outside the repo, so nothing here can commit it. Editing
# it by hand is the easy mistake: the change works locally, is invisible to git,
# and is lost on the next machine. This makes that visible.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE="${REPO_ROOT}/docs/claude-md-section.md"
INSTALLED="${HOME}/.claude/CLAUDE.md"
MARKER="<!-- linear-agent:instructions -->"

if [ ! -f "$INSTALLED" ]; then
  echo "not installed: ${INSTALLED} does not exist"
  echo "run: npm run setup"
  exit 1
fi

if ! grep -qF "$MARKER" "$INSTALLED"; then
  echo "not installed: ${INSTALLED} has no ${MARKER} marker"
  echo "run: npm run setup"
  exit 1
fi

# Take everything after the marker, which is what setup appended. Anything the
# operator keeps above it is theirs and is deliberately ignored.
INSTALLED_SECTION="$(awk -v marker="$MARKER" 'found {print} index($0, marker) {found=1}' "$INSTALLED")"

if diff -u "$SOURCE" <(printf '%s\n' "$INSTALLED_SECTION") >/tmp/linear-agent-claude-md.diff 2>&1; then
  echo "in sync: ${INSTALLED} matches docs/claude-md-section.md"
  exit 0
fi

echo "DRIFT between docs/claude-md-section.md (-) and ${INSTALLED} (+):"
echo
cat /tmp/linear-agent-claude-md.diff
echo
echo "If the installed copy is right, fold the change into docs/claude-md-section.md"
echo "and commit it. If the repo is right, re-run: npm run setup"
exit 1
