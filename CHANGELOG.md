# Changelog

## 0.1.1 (2026-11-04)

- A trust table written as `["\U00000070rojects"."/x"]`, with TOML's eight-digit escape, is now seen as machine-local;
  before, `extract` put it in the shared file. A key with an escape the tool cannot read is refused.
- `config.toml.bak` is written by rename with the mode of `config.toml`: a `.bak` that is a link no longer sends the
  write to another file, and an old `.bak` with wider permissions no longer exposes a private config.
- `apply` reads the file once more just before the rename, so a trust choice saved while the backup was being
  written is kept.
- `extract -o` keeps an existing output as `FILE.bak` and writes through a dangling link instead of replacing it.
- `extract -o` through a linked folder lands where the system says: a link's `..` no longer sends the write to an unrelated file.
- Two child tables of separate `[[array]]` elements are accepted. `x.y = 1` with a later `[x]` is refused.
- A file that cannot be read exits 2, not 1, which `check` keeps for drift.
- One multi-line dotted trust entry is counted once.

## 0.1.0 (2026-10-30)

- First release: `extract`, `apply` and `check`. Machine-local tables (`[projects.*]` by default, more with
  `--keep`) stay on each machine; everything else comes from the shared file.
- `apply` backs the old file up to `config.toml.bak`, writes by rename, refuses a file it cannot split and a
  `config.toml` that is a symlink, and starts over when the file changes while it runs.
- `check` compares lines exactly, so a change of trailing spaces inside a multi-line string counts.
- `extract -o` onto a symlink writes the file the link points to.
