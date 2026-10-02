# Context Map

Instruction sources are **compiled** from `.ai/` — the single source of truth. Edit `.ai/`, never a
generated file. See [README.md](/README.md).

## Domain Rules

The catalog links to generated instructions, not authoring sources. Copilot, Cursor, and Claude load
rules when their glob matches; Codex loads nested instructions by directory. Read a linked file
manually when needed outside its normal scope.

Authoring guides: [Domain rules](/.ai/domains/authoring-domains.md) and
[Reusable prompts](/.ai/domains/authoring-prompts.md).

<!-- ai:domain-catalog -->

## Agent Skills

Skills are **on-demand**: only the name and description are ambient. Load one **explicitly** when its
trigger matches — they do not fire on their own.

<!-- ai:skill-catalog -->

## Subagents

<!-- ai:agent-catalog -->
