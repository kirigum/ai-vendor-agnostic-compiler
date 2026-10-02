---
description: "How to author a reusable prompt in .ai/prompts/ — frontmatter, the Usage/Process/Related skeleton, argument variables, and when a prompt should be a skill or an agent instead."
scope: ".ai/prompts/**/*.prompt.md"
---

# Authoring Prompts

A prompt is the **explicitly invoked** tier: it never loads on its own. One source file here compiles
to a Copilot prompt file (`/name` in chat) and a Claude Code slash command. Never author those outputs
directly — see [README.md](/README.md).

**Target: 5–50 lines** (100 max) | **Naming:** `verb-object.prompt.md`

## Frontmatter

```yaml
---
description: "One line. Shown in the prompt picker. Required."
argument-hint: "Optional: files, slice, branch, or PR to review"
agent: reviewer # Copilot-only delegation metadata
---
```

## Prompt, skill, or agent?

| You want                                              | Author              |
| ----------------------------------------------------- | ------------------- |
| A short request you re-type often                     | a **prompt** ← here |
| A multi-step procedure with bundled scripts/resources | a **skill**         |
| A persona with its own tools and context window       | an **agent**        |

A prompt that grows past ~100 lines of procedure belongs in a skill. For Copilot, use `agent:` to
select a persona with its own tool permissions. Claude commands omit this metadata; do not assume
equivalent delegation. Descriptions are required by this convention, not by the compiler.

## Structure

Keep it to **Usage + Process + Related**. The prompt is a thin entry point; the rules live in the
agent or domain it cites.

```markdown
---
description: One-line summary
agent: agent-name
---

# Title

One-sentence statement of the task.

> **See:** [agent-name](/.ai/agents/agent-name.agent.md) for scope resolution and output format.

## Usage

`/prompt-name ${input:target}` — target is optional.

## Process

1. One-line step (reference the agent or domain for detail)
2. Another step

## Related

- [agent-name](/.ai/agents/agent-name.agent.md) - What it does
```

## Writing

**DO:**

- Reference rules, never restate them — a `> **See:**` line pointing at the agent or domain that owns
  them is the whole mechanism.
- One line per step. If a step needs a paragraph, it belongs in the agent or domain.
- Name the failure mode when there is an obvious one ("If nothing is staged, say so").

**DON'T:**

- Duplicate constants, globs, or conventions that already live in a domain rule.
- Copy examples that the cited instruction already carries.
- Re-describe an agent's output format.

## Variables

`${input:name}`, `${input:name:placeholder}`, `${workspaceFolder}`, `${file}`, `${selection}`.

These are Copilot variables. The compiler preserves them literally in Claude command bodies; it
does not translate them to `$ARGUMENTS`. Keep shared instructions portable and verify invocation
in each selected client. See [README.md](/README.md) for the compiler's prompt metadata contract.

Write link targets **workspace-root-absolute** (`/.ai/agents/reviewer.agent.md`); the compiler
rewrites them per output location.

## Validation

```bash
node scripts/sync-ai.mjs    # compile; fails on a dead scope glob or bad frontmatter
node scripts/sync-ai.mjs --check   # verify local generated output matches .ai/, writing nothing
```

Then invoke `/prompt-name` and confirm it resolves its references.

## Related

- [README.md](/README.md) - Layer model and the full generated-file map
- [authoring-domains](/.ai/domains/authoring-domains.md) - Domain rule guidelines
- [Prompt files](https://code.visualstudio.com/docs/copilot/customization/prompt-files) - VS Code docs
