# AI Vendor-Agnostic Compiler

The [compiler](scripts/sync-ai.mjs) translates authored instruction sources into native formats
for GitHub Copilot, Cursor, Claude Code, and Codex. Shared policy is authored once; each developer
selects which integrations to generate locally. Edit sources in `.ai/`, not generated destinations.

## Quick Start

Use Node.js **22.17.0^**. The compiler uses only Node.js built-ins;
no dependency installation is needed.

From the repository root:

```bash
cp .ai/local.example.json .ai/local.json
node scripts/sync-ai.mjs
node scripts/sync-ai.mjs --check
```

Edit the local configuration to select tools, then rerun the compiler. Generated output and local
selection are covered by [.gitignore](.gitignore); commit authored sources, not generated files.

## Configuration and Commands

Tool selection comes only from `.ai/local.json`, copied from
[.ai/local.example.json](.ai/local.example.json). Select any combination of `claude`, `codex`,
`copilot`, and `cursor`:

```json
{ "tools": ["claude"] }
```

Use a JSON object with a `tools` array of strings. Invalid JSON, invalid field types, and unknown
tools fail. Missing configuration, a missing `tools` field, or an empty array selects no tools:
**write mode then prunes previously owned output**, while check mode reports it as stale.

| Command | Behavior |
| --- | --- |
| `node scripts/sync-ai.mjs` | Validate, write changed files, and prune stale output. |
| `node scripts/sync-ai.mjs --check` | Validate and compare output without writing or pruning. |
| `node scripts/sync-ai.mjs --help` | Display usage; `-h` is equivalent. |

## Generated Outputs and Ownership

Each row is emitted only for its selected tool. Source paths are relative to `.ai/`.

| Generated                                | Compiled from                 | Enabled by                           |
| ---------------------------------------- | ----------------------------- | ------------------------------------ |
| `AGENTS.md`                              | `core/`                       | `cursor`, `codex`                    |
| `CLAUDE.md`                              | `core/` + `tools/claude.md`    | `claude`                             |
| `.github/copilot-instructions.md`        | `core/`                       | `copilot`                            |
| `.github/instructions/*.instructions.md` | `domains/` (`applyTo:`)       | `copilot`                            |
| `.cursor/rules/*.mdc`                    | `domains/` (`globs:`)         | `cursor`                             |
| `.claude/rules/*.md`                     | `domains/` (`paths:`)         | `claude`                             |
| `<dir>/AGENTS.md`                        | `domains/` with `codexPaths:` | `codex`                              |
| `.github/agents/*.agent.md`              | `agents/`                     | `copilot`                            |
| `.claude/agents/*.md`                    | `agents/`                     | `claude`                             |
| `.cursor/agents/*.md`                    | `agents/`                     | `cursor` unless profile is shared    |
| `.codex/agents/*.toml`                   | `agents/`                     | `codex`                              |
| `.claude/skills/`                        | `skills/`                     | `claude`                             |
| `.github/skills/`                        | `skills/`                     | `copilot`                            |
| `.cursor/skills/`                        | `skills/`                     | `cursor` without `claude` or `codex` |
| `.agents/skills/`                        | `skills/`                     | `codex`                              |
| `.github/prompts/*.prompt.md`            | `prompts/`                    | `copilot`                            |
| `.claude/commands/*.md`                  | `prompts/`                    | `claude`                             |

**Do not hand-author files in owned destinations.** Sync overwrites changed output without merging
edits or managed blocks, and prunes output for disabled tools or removed sources. Ownership covers
the three baseline files, matching immediate native files in rules/agents/prompts directories,
and all files inside individual generated skill directories, even without banners. Nested Codex
files are pruned only with the generated-domain banner, but configured targets can overwrite others.

The canonical baseline is `AGENTS.md` for Cursor/Codex, otherwise `CLAUDE.md` for Claude, otherwise
Copilot's repository instructions. Claude imports `@AGENTS.md` when emitted; otherwise its baseline
is flattened. Copilot always receives a flattened baseline.

Cursor shares Claude agents only when both rendered native headers are identical. Cursor skills
reuse Claude's destination first, then Codex's, otherwise its own. Claude and Codex still receive
their required copies when both are selected. Cursor and Codex receive no compiled prompt files.

## Source Layers and Authoring

Choose one owning layer for each policy and reference it elsewhere instead of duplicating rules.
Loading expectations below are authoring conventions, not compiler-enforced behavior.

| Source pattern under `.ai/` | Purpose |
| --- | --- |
| `core/*.md` | Shared baseline for every request; keep it lean. |
| `domains/*.md` | File-specific conventions selected by scope. |
| `agents/*.agent.md` | Invoked personas with constraints and output rules. |
| `skills/<name>/SKILL.md` | On-demand procedures and bundled resources. |
| `prompts/*.prompt.md` | Explicit reusable one-shot requests. |

Core, domains, agents, and prompts are discovered only at their directory's immediate level.
Core files are concatenated alphabetically; numeric prefixes control order, not priority.
Optional [.ai/tools/claude.md](.ai/tools/claude.md) additions are appended only to Claude's baseline.

### Domains and Frontmatter

```yaml
---
description: "Conventions for compiler scripts."
scope: "scripts/*.mjs"
codexPaths: ["scripts"]
---
```

Domains require `description` and a workspace-relative `scope`. Comma-separated patterns compile
to Copilot `applyTo`, Cursor `globs`, and Claude `paths`; commas inside brace alternatives are retained.
Optional `codexPaths` places rules in nested directory-based instructions, combining domains at the
same path. Use workspace-relative directories: path containment and directory existence are not
validated. See [.ai/domains/authoring-domains.md](.ai/domains/authoring-domains.md).

Frontmatter supports flat string values and single-line arrays between opening/closing `---` lines
at the file's start. Quoted strings and comments are supported; nested mappings and multiline YAML
are not. Use Markdown bodies for long instructions rather than unsupported YAML constructs.

### Agents and Prompts

Agents require `description`; optional metadata includes `name`, `model`, `tools`, and
`reasoning-effort`. Copilot retains all model choices; other tools take the first recognized choice
or omit the field to inherit the session model. Names are not translated or availability-checked.
Claude recognizes its aliases and lowercase `claude-*` IDs, Codex lowercase GPT/o-series IDs,
and Cursor only `inherit`.

Portable tool groups are `read`, `search`, `execute`, `agent`, and `edit`. Unknown groups fail.
Claude maps these to native tools; Cursor/Codex infer coarse read-only restrictions when an explicit
tool list lacks `edit` or `readonly: true` is set. Permissions are not equivalent across vendors.

Prompts accept optional `description` and `argument-hint`. Copilot retains all metadata; Claude
retains only these two fields. **Copilot `agent` delegation and `${input:...}` variables are not
translated for Claude commands.** Follow
[.ai/domains/authoring-prompts.md](.ai/domains/authoring-prompts.md) and verify invocation per client.

### Skills, Links, and Catalogs

Authored skills bundle resources beneath their entry point: Markdown is parsed, stamped, and
link-rewritten; other resources are copied unchanged. Vendor skills under `skills/vendor/<name>/`
are copied byte-for-byte into flat output skill directories. Optional root `skills-lock.json`
provides catalog source labels, not hash verification or fetching. Keep skill names unique.

Use workspace-root-absolute links in compiled sources; the compiler rewrites them relative to each
output. `/AGENTS.md` aliases the selected baseline. Relative links, external URLs, and fenced
examples are left unchanged. Human-only README links should be relative.

[.ai/core/01-context-map.md](.ai/core/01-context-map.md) uses full-line `<!-- ai:domain-catalog -->`,
`<!-- ai:skill-catalog -->`, and `<!-- ai:agent-catalog -->` markers. These expand in core and Claude
additions into native discovery tables; do not maintain those tables manually. Codex lists only
domains with `codexPaths`.

## Validation and Troubleshooting

```bash
node --check scripts/sync-ai.mjs
node scripts/sync-ai.mjs --check
```

The compiler loads sources, validates scopes/links, stages native output, checks Git ignore coverage,
then compares bytes and either reports drift or writes/prunes. Validation precedes mutation, but
filesystem writes are not transactional. Git ignore validation is skipped if its invocation fails.

Each separated scope pattern must match a path outside `node_modules`. Non-vendor root-absolute
Markdown links must exist, except the virtual baseline alias; relative links and fragments are not
checked. Source entry points, scopes, and links are checked even for disabled tools, while rendering
and some auxiliary parsing depend on the selection. An absent `.ai/` is a no-op; an empty core fails.

Check mode covers the local selection, not all tool combinations. Verify rule attachment and
agent/prompt invocation in the client; compilation does not prove model availability, permission
equivalence, or vendor integrity. Success exits `0`; errors and drift exit nonzero, normally `1`.

| Report                          | Meaning                                             | Resolution                                                      |
| ------------------------------- | --------------------------------------------------- | --------------------------------------------------------------- |
| `outdated`                      | Expected file is absent or its bytes differ.        | Run write mode after verifying sources and configuration.       |
| `stale`                         | An owned file is no longer expected.                | Run write mode to prune it; this also applies after opting out. |
| Scope matches no file           | At least one separated pattern has no matches.      | Correct the scope or restore the intended files.                |
| Link target does not exist      | Root-absolute source link points to a missing path. | Fix the source link; anchors are not checked.                   |
| Generated path not ignored      | A staged path lacks an effective ignore rule.       | Update ignore rules, then rerun.                                |
| Two sources compile to one path | Native destinations collide.                        | Rename sources or remove conflicting targets.                   |

