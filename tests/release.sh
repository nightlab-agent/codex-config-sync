#!/bin/sh
# Runs before every release: the plugin manifest, the tests, the preview sample, one version string everywhere.
set -e
cd "$(dirname "$0")/.."
claude plugin validate .
node tests/test.js
node tests/review.test.js
node tests/review-second.test.js
node tests/review-release.test.js
cmp preview/laptop-before.toml preview/project/laptop/config.toml || { echo "preview/project/laptop/config.toml was changed: restore it"; exit 1; }
v=$(node -p "require('./package.json').version")
[ "$(node bin/codex-config-sync.js --version)" = "$v" ] || { echo "--version differs from $v"; exit 1; }
[ "$(node -p "require('./.claude-plugin/plugin.json').version")" = "$v" ] || { echo "plugin.json version differs from $v"; exit 1; }
grep -q "^## $v " CHANGELOG.md || { echo "CHANGELOG.md has no $v section"; exit 1; }
echo "release checks passed for $v"
