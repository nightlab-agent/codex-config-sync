# Changelog

## 0.1.2 (2026-11-05)

- `apply` exclusively creates `config.toml.lock` before reading the config and holds it through the merge,
  backup and rename. Two overlapping applies could previously both succeed and lose one writer's change.
- A competing apply waits in 50 ms steps (500 ms total), then exits 2 naming the lock and its holder,
  without changing the config or backup. A normal exit removes its own lock, including on refusal.
- A lock refusal explains manual recovery, including for an incomplete or unreadable record: check that no apply is
  still running on any host using the config, then remove the named lock and retry.
- A dead local holder is recovered automatically. Hard links let one process recover a lock at a time; abandoned
  recovery links from dead processes are cleaned on retry. A live PID (even if reused), foreign host, namespace mismatch or incomplete
  lock record (including a missing namespace field) is never taken over. Recovery links also identify their PID namespace. Recovery requires reliable hard links and inode/link counts.
- `--dry-run`, `extract` and `check` take no lock. An unwritable config folder refuses apply, including when
  already in sync. A symlinked config is refused with advice before trying to create the lock.
- `apply` refuses a shared file that aliases its backup when the config would change; previously the backup
  replaced the shared file. Invalid UTF-8 input is refused before writing, so decoding cannot change the old bytes in `.bak`.

## 0.1.1 (2026-11-05)

- A trust table written as `["\U00000070rojects"."/x"]`, with TOML's eight-digit escape, is now seen as machine-local;
  before, `extract` put it in the shared file. A key with an escape the tool cannot read is refused.
- A refused `apply` keeps your last `config.toml.bak`: the backup is written only once the write is going ahead.
- `config.toml.bak` is written by rename with exactly the mode of `config.toml`, whatever the umask: a `.bak` that is a link no longer sends the
  write to another file, and an old `.bak` with wider permissions no longer exposes a private config.
- `apply` reads the file once more just before the rename, so a trust choice saved while the backup was being
  written is kept.
- `extract -o` keeps an existing output as `FILE.bak` and writes through a dangling link instead of replacing it.
- `extract -o` through a linked folder lands where the system says: a link's `..` no longer sends the write to an unrelated file.
- A link whose path goes through something that is not a folder (a dangling link, a plain file) is refused with exit 2, as the system refuses it.
- `extract -o` aimed at the live config, by its own name or through a link, is refused with exit 2. Before, it replaced the file and dropped its
  trust tables, which stayed only in `FILE.bak`. Anyone whose `config.toml` links to the file named in the README's first command hit this.
- `extract -o FILE` is refused when `FILE.bak` is the live config: the backup would have replaced it.
- A link whose text ends in `/` or `/.` is refused with exit 2, as the system refuses it.
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
