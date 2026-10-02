## Claude Code specifics

- Path-scoped rules live in `.claude/rules/` and load when their `paths` glob matches.
- Skills live in `.claude/skills/`; subagents in `.claude/agents/`.
- Use Plan Mode for changes touching more than 3 files.
- Auto Memory is machine-local and is **not** part of the compiled instruction set. Never
  treat a remembered detail as authoritative over this file.