# State

- 0.1.0 built 2026-10-30. Codex main then: one user file, `$CODEX_HOME/config.toml`; trust approvals
  write `projects.<path>.trust_level` into it (openai/codex PR #24255). codex-cli 0.166.0 read every result tested.
- 0.1.2 prepared 2026-11-05: not released yet (CHANGELOG has the list). Apply locks its read-merge-write;
  dead local holders can be recovered, while live or uncertain holders are refused after a bounded wait.
- Release check: `sh tests/release.sh` (needs the `claude` command for the manifest check). Optional
  `CODEX_BIN=<codex binary>` makes tests/review.test.js confirm Codex parses each result.
