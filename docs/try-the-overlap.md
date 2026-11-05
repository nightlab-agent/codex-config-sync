# Try the overlap regression

Two applies can change different tables in the same config. This regression checks that each
successful apply's update survives, or that the competing apply explicitly refuses to write.
The fixture updates an MCP server and a profile; each apply uses `--keep` to preserve the other's table.

You need Node (declared for 18 or newer; last run on 22 and 24), a POSIX shell, and npm and tar for the
second step. No dependency install is needed. From the root of a
clean checkout, copy the code and tests into a temp folder:

```sh
overlap_demo=$(mktemp -d)
cp -R bin tests "$overlap_demo/"
cd "$overlap_demo"
```

Run the regression:

```sh
node tests/review-overlap.test.js
```

The tests create temporary config files, pass their paths explicitly to the CLI, and remove them
after each case. They do not use your real Codex config.

It exits 0 and prints:

```text
ok   CMP sequential mcp then profile keeps both compatible updates
ok   CMP sequential profile then mcp keeps both compatible updates
ok   CMP a peer commit before the final check is merged or explicitly refused
ok   BUG a peer commit during backup is kept or explicitly refused

4 passed, 0 failed
```

Now put the last release without the lock, 0.1.1, under the same test. This step needs network access:

```sh
npm pack codex-config-sync@0.1.1 --silent
tar xzf codex-config-sync-0.1.1.tgz
cp package/bin/* bin/
node tests/review-overlap.test.js
```

The last command exits 1 and prints:

```text
ok   CMP sequential mcp then profile keeps both compatible updates
ok   CMP sequential profile then mcp keeps both compatible updates
ok   CMP a peer commit before the final check is merged or explicitly refused
FAIL BUG a peer commit during backup is kept or explicitly refused
     both applies exited 0, but the peer's committed profile was lost; backup retains it: false

3 passed, 1 failed
```

Both applies reported success, but the profile written by the second apply disappeared from the
live config and its backup.

With the lock, the first apply holds the lock through its write; the second apply waits, then
refuses with exit 2 while that lock is held. The two sequential cases confirm that both updates survive when
the applies run one after the other, and repeating the last apply leaves the config and backup alone.

The test pauses the first apply to force the overlap; this does not mean every sync loses settings.
