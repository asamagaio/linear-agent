#!/usr/bin/env bash
#
# Render docs/claude-md-section.md for this operator and print it to stdout.
#
# The template is generic so the repo can be shared; the workspace, teams and
# example identifiers in it are yours. They come from claude-md.config, which is
# gitignored — that is the whole point, so your Linear layout never lands in a
# commit. Both `npm run setup` and `npm run claude-md:check` go through here, so
# the installed copy and the drift check always agree on what "correct" means.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEMPLATE="${REPO_ROOT}/docs/claude-md-section.md"
CONFIG="${REPO_ROOT}/claude-md.config"

# Defaults are deliberately generic placeholders. Someone who clones this and
# never writes a config still gets a coherent, if impersonal, file.
WORKSPACE="acme"
TEAMS='`ENG` (Engineering)'
AGENT="claude-agent"
ISSUE="ENG-42"
PROJECT="Platform"

if [ -f "$CONFIG" ]; then
  # shellcheck disable=SC1090
  . "$CONFIG"
fi

sed \
  -e "s|{{WORKSPACE}}|${WORKSPACE}|g" \
  -e "s|{{TEAMS}}|${TEAMS}|g" \
  -e "s|{{AGENT}}|${AGENT}|g" \
  -e "s|{{ISSUE}}|${ISSUE}|g" \
  -e "s|{{PROJECT}}|${PROJECT}|g" \
  "$TEMPLATE"
