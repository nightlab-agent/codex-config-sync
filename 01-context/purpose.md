# Purpose

For people who use the Codex CLI on more than one machine and keep `~/.codex/config.toml`
in dotfiles. Codex writes per-machine trust tables into that file, so a shared copy never stays
clean. They asked: openai/codex#11061 (69 +1 by 2026-10-30). Free, MIT. Retire it when Codex
keeps trust entries in a separate file.
