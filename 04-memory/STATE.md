# State

- 0.1.0 built 2026-10-30. Codex main then: one user file, `$CODEX_HOME/config.toml`; trust approvals
  write `projects.<path>.trust_level` into it (openai/codex PR #24255). codex-cli 0.166.0 read every result tested.
- Release check: `sh tests/release.sh` (needs the `claude` command for the manifest check). Optional
  `CODEX_BIN=<codex binary>` makes tests/review.test.js confirm Codex parses each result.
