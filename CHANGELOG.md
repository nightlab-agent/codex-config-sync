# Changelog

## 0.1.0 (2026-10-30)

- First release: `extract`, `apply` and `check`. Machine-local tables (`[projects.*]` by default, more with
  `--keep`) stay on each machine; everything else comes from the shared file.
- `apply` backs the old file up to `config.toml.bak`, writes by rename, refuses a file it cannot split and a
  `config.toml` that is a symlink, and starts over when the file changes while it runs.
- `check` compares lines exactly, so a change of trailing spaces inside a multi-line string counts.
- `extract -o` onto a symlink writes the file the link points to.
