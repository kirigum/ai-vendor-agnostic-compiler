---
description: "How to author a path-scoped domain rule in .ai/domains/ — the scope/codexPaths frontmatter contract, link style, sizing, and what belongs in a domain versus core, skills, or prompts."
scope: ".ai/domains/**/*.md"
---

# Authoring Domain Rules

A domain rule is the **path-scoped** tier: it loads only when its `scope` glob matches a file in
context. One source file here compiles to Copilot's `applyTo:`, Cursor's `globs:`, Claude's `paths:`,
and optionally a nested Codex `AGENTS.md`. Never author those outputs directly — see
[README.md](/README.md).

**Target: 50–150 lines** | **Naming:** `lowercase-with-hyphens.md`

## Frontmatter

```yaml
---
description: "One line, 1–500 chars. Required."
scope: "**/*.test.ts,**/*.test.tsx" # comma-separated globs, workspace-root relative. Required.
codexPaths: ["scripts"] # optional workspace-relative directory placement
---
```

- **`description`** — Name the concrete topics the rule covers. The compiler emits this metadata
  and uses it in discovery catalogs; it does not verify client-side relevance decisions.
- **`scope`** — `node scripts/sync-ai.mjs` **fails** if a glob matches no file, so a rename cannot leave a dead
  rule behind.
- **`codexPaths`** — only when the rule maps cleanly onto whole directories. Codex scopes by
  directory rather than glob, so this plants the content as a nested `AGENTS.md` at each path.

## Pick the right tier

| Content                                  | Goes to               |
| ---------------------------------------- | --------------------- |
| True for every file, every request       | `.ai/core/`           |
| True only for files matching a glob      | `.ai/domains/` ← here |
| A multi-step procedure invoked on demand | `.ai/skills/`         |
| A persona with scoped tools              | `.ai/agents/`         |
| A reusable one-shot request              | `.ai/prompts/`        |

A rule that seems to need "just in case" ambient loading is usually a domain rule with a sharper glob.

## Writing

**DO:**

- One idea per bullet; **bold** key terms; imperative mood ("Use", "Never", "Prefer").
- Be specific and checkable: `Use next/image with explicit width/height` beats "optimize images".
- Reference instead of duplicating — a rule stated in two tiers will diverge when only one is edited.
- Label examples Good/Bad when the contrast is the point.

**DON'T:**

- Restate anything already in `.ai/core/` — core is always loaded, so repeating it here is waste.
- Use hedges ("should", "might", "possibly"). Say what is required.
- Write prose where a bullet works.

## Links

Write link targets **workspace-root-absolute** so they survive compilation to every output depth:

```markdown
[ui-components](/.ai/domains/ui-components.md)
```

The compiler rewrites each to a relative path per output file. Links inside fenced code blocks are
treated as examples and left untouched.

## Validation

```bash
node scripts/sync-ai.mjs    # compile; fails on a dead scope glob or bad frontmatter
node scripts/sync-ai.mjs --check   # verify local generated output matches .ai/, writing nothing
```

Then confirm the rule actually loads: open a file the glob matches and check that the tool attaches
it.

## Related

- [README.md](/README.md) - Layer model and the full generated-file map
- [authoring-prompts](/.ai/domains/authoring-prompts.md) - Prompt file guidelines
- [Custom instructions](https://code.visualstudio.com/docs/copilot/customization/custom-instructions) - VS Code docs
- [Cursor rules](https://docs.cursor.com/en/context/rules) - Cursor docs
