# Catalog

| Path | Read it when |
|---|---|
| `bin/codex-config-sync.js` | You change what it writes or refuses. |
| `bin/toml-lines.js` | You change how a config is split, shared or merged. |
| `tests/review-link.test.js`, `tests/review-link-kill.js` | You change how links and the live config are handled. |
| `tests/test.js` | You change behaviour: add a case first. |
| `tests/release.sh` | You release. |
| `01-context/purpose.md` | You judge whether a change fits. |
| `04-memory/STATE.md` | You need what is true now. |
| `tests/review.test.js`, `tests/race-preload.js` | You change splitting or apply: faults found in review, each beside a passing case. |
| `tests/review-second.test.js`, `tests/review-second-race.js`, `tests/review-release.test.js`, `tests/review-ts.test.js`, `tests/review-ts-race3.js` | You change reading, writing or `-o`: faults from the second review and the release review, each beside a passing case. |
| `tests/review-overlap.test.js`, `tests/review-overlap-stress.test.js`, `tests/review-overlap-peer.js` | You change concurrent applies: forced overlap compared with sequential applies, and parallel applies without barriers. |
| `tests/review-lock-recovery.test.js`, `tests/review-lock-lifecycle.test.js`, `tests/review-lock-preload.js` | You change apply's lock: dead-holder recovery, ownership boundaries, refusals, release and interrupted applies. |
| `tests/review-apply-safety.test.js`, `tests/review-overlap-helpers.js` | You change apply's preflight, aliases or backups, or the overlap suites' shared fixtures and runner. |
| `docs/try-the-overlap.md` | You want to run the overlap regression in a temp folder and compare the old failure with the current result. |
| `preview/project/` | You want the sample laptop and dotfiles configs a terminal demo runs on. |
