#!/usr/bin/env node
/**
 * Compiles `.ai/` (the single source of truth) into each AI tool's native format.
 *
 * Usage:
 *   node scripts/sync-ai.mjs          # write changed output and prune stale files
 *   node scripts/sync-ai.mjs --check  # report differences without writing or pruning
 *   node scripts/sync-ai.mjs --help   # display options and configuration syntax
 *
 * Paths resolve relative to the script's parent directory, not the working directory.
 * Select tools in `.ai/local.json`, for example { "tools": ["claude", "codex"] }.
 * Supported tools: claude, codex, copilot, cursor. Tool names are not CLI arguments.
 * Missing configuration or an empty selection produces no output and prunes previously
 * generated files in write mode. A missing `.ai/` directory is a successful no-op.
 *
 * Sources are parsed, links and scopes validated, and output staged before disk mutation.
 * Generated paths must be git-ignored when Git ignore checks are available. Check mode
 * compares output bytes and detects stale files; differences set exit code 1.
 * Uses only Node.js built-ins, including fs.globSync and import.meta.dirname.
 */
import { spawnSync } from "node:child_process";
import {
  existsSync,
  globSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, posix, relative, resolve, sep } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const SRC = join(ROOT, ".ai");
/** Subdirectory of `.ai/skills/` holding upstream skills rather than authored ones. */
const VENDOR = "vendor";
/** JSON configuration containing the selected tools; see LOCAL_CONFIG_EXAMPLE. */
const LOCAL_CONFIG = ".ai/local.json";
const LOCAL_CONFIG_EXAMPLE = ".ai/local.example.json";
const CHECK_ONLY = process.argv.includes("--check");

const toPosix = (p) => p.split(sep).join(posix.sep);

/* ------------------------------------------------------------------ tool selection */

const ALL_TOOLS = ["claude", "codex", "copilot", "cursor"];

const KNOWN_FLAGS = new Set(["--check", "--help", "-h"]);

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(
    [
      "Compiles .ai/ (the single source of truth) into each AI tool's native format.",
      "",
      "Usage: ai:sync [--check]",
      "",
      `  Which tools to generate for comes only from ${LOCAL_CONFIG}:`,
      `    { "tools": ["claude"] }        supported: ${ALL_TOOLS.join(", ")}`,
      `  Copy ${LOCAL_CONFIG_EXAMPLE} to get started. That file is git-ignored,`,
      "  as is everything generated from it, so your toolchain stays yours.",
      "",
      "  With no config, or an empty list, nothing is generated and any previously",
      "  generated files are removed. Edit the config rather than passing tool names:",
      "  a one-off override would be undone by the next commit anyway.",
      "",
      "  --check verifies the output on disk matches .ai/ and writes nothing.",
    ].join("\n"),
  );
  process.exit(0);
}

/**
 * Reads the tools array from `.ai/local.json`, e.g. `{ "tools": ["claude"] }`.
 * An absent file or tools field returns an empty selection. Invalid JSON or a tools
 * value other than an array of strings throws; no default selection is substituted.
 */
function loadLocalTools() {
  const pathToLocalConfig = join(ROOT, LOCAL_CONFIG);
  if (!existsSync(pathToLocalConfig)) return [];

  let parsed;
  try {
    parsed = JSON.parse(readFileSync(pathToLocalConfig, "utf8"));
  } catch (error) {
    throw new Error(`${LOCAL_CONFIG}: not valid JSON — ${error.message}`);
  }

  const { tools } = parsed;

  if (tools === undefined) return [];
  if (!Array.isArray(tools) || tools.some((t) => typeof t !== "string"))
    throw new Error(`${LOCAL_CONFIG}: "tools" must be an array of strings`);

  return tools;
}

/**
 * Validates CLI flags, then trims, lowercases, and deduplicates configured tool names.
 * Unknown flags or tool names terminate execution with exit code 1.
 */
function loadEnabledTools() {
  const fail = (reason) => {
    console.error(`✗ ${reason}`);
    console.error(`  valid tools: ${ALL_TOOLS.join(", ")}`);
    console.error(`  configure them in ${LOCAL_CONFIG} — see ${LOCAL_CONFIG_EXAMPLE}`);
    process.exit(1);
  };

  const unexpected = process.argv.slice(2).find((arg) => arg !== "--" && !KNOWN_FLAGS.has(arg));
  if (unexpected)
    fail(
      `unexpected argument: ${unexpected}\n  tools are configured in ${LOCAL_CONFIG}, not passed here`,
    );

  let names = [];
  try {
    names = loadLocalTools();
  } catch (error) {
    fail(error.message);
  }

  const selected = [...new Set(names.map((n) => n.trim().toLowerCase()).filter(Boolean))];
  const unknown = selected.filter((n) => !ALL_TOOLS.includes(n));
  if (unknown.length) fail(`unknown tool(s) in ${LOCAL_CONFIG}: ${unknown.join(", ")}`);

  return new Set(selected);
}

const TOOLS = loadEnabledTools();
const enabled = (tool) => TOOLS.has(tool);

/** Cursor and Codex read the root AGENTS.md natively; Copilot's CLI surface also does. */
const wantsRootAgentsFile = () => enabled("cursor") || enabled("codex");
const banner = (source) =>
  `<!-- AUTO-GENERATED from ${source} by scripts/sync-ai.mjs. Do not edit. -->`;

/* ------------------------------------------------------------------ frontmatter */

/**
 * Reads flat `key: value` frontmatter with string scalars and inline `[a, b]` arrays.
 * Handles quoted values and comments, but does not interpret general YAML syntax.
 * Malformed lines, unterminated quotes, and arrays spanning lines throw; other YAML
 * constructs may remain literal strings.
 */
function parseFrontmatter(raw, file) {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?/);
  if (!match) return { data: {}, content: raw };

  const data = {};
  for (const line of match[1].split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const kv = line.match(/^([A-Za-z0-9_-]+):[ \t]*(.*)$/);
    if (!kv) throw new Error(`${file}: unsupported frontmatter line: ${line}`);
    const [, key, rawValue] = kv;
    const value = frontmatterParts(rawValue, file).join(",").trim();
    if (value.startsWith("[")) {
      if (!value.endsWith("]")) throw new Error(`${file}: "${key}" array must be on one line`);
      data[key] = frontmatterParts(value.slice(1, -1), file)
        .map((v) => unquote(v.trim()))
        .filter(Boolean);
    } else {
      data[key] = unquote(value);
    }
  }
  return { data, content: raw.slice(match[0].length) };
}

function frontmatterParts(value, file) {
  const parts = [];
  let start = 0;
  let quoted = "";
  for (let index = 0; index < value.length; index++) {
    const char = value[index];
    if (quoted) {
      if (quoted === '"' && char === "\\") index++;
      else if (char === quoted) {
        if (quoted === "'" && value[index + 1] === "'") index++;
        else quoted = "";
      }
    } else if (char === '"' || char === "'") {
      if (index === 0 || /[\s[,]/.test(value[index - 1])) quoted = char;
    } else if (char === "#" && (index === 0 || /\s/.test(value[index - 1]))) {
      parts.push(value.slice(start, index));
      return parts;
    } else if (char === ",") {
      parts.push(value.slice(start, index));
      start = index + 1;
    }
  }
  if (quoted) throw new Error(`${file}: unterminated frontmatter quote`);
  parts.push(value.slice(start));
  return parts;
}

const unquote = (value) => {
  if (value.startsWith('"')) return JSON.parse(value);
  return value.replace(/^'(.*)'$/s, "$1").replace(/''/g, "'");
};

const quote = (v) => `"${String(v).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

function splitScopes(scope) {
  const patterns = [];
  let start = 0;
  let braces = 0;
  let brackets = 0;
  for (let index = 0; index < scope.length; index++) {
    const char = scope[index];
    if (char === "\\") index++;
    else if (char === "[") brackets++;
    else if (char === "]") brackets--;
    else if (!brackets) {
      if (char === "{") braces++;
      else if (char === "}") braces--;
      else if (char === "," && braces === 0) {
        patterns.push(scope.slice(start, index).trim());
        start = index + 1;
      }
    }
  }
  patterns.push(scope.slice(start).trim());
  return patterns;
}

const readSource = (path) =>
  parseFrontmatter(readFileSync(path, "utf8"), toPosix(relative(ROOT, path)));

const listFiles = (dir, suffix) =>
  existsSync(dir)
    ? readdirSync(dir)
        .filter((f) => f.endsWith(suffix))
        .sort()
    : [];

/* ------------------------------------------------------------------ link rewriting */

/**
 * The always-loaded baseline file, which differs by which tools are enabled. Copilot-only
 * runs generate neither AGENTS.md nor CLAUDE.md, so links must target Copilot's own file
 * rather than one that is never written.
 */
const baselineFile = () => {
  if (wantsRootAgentsFile()) return "AGENTS.md";
  return enabled("claude") ? "CLAUDE.md" : ".github/copilot-instructions.md";
};

/** How the baseline is named in prose and link labels — the bare filename reads better. */
const baselineName = () => baselineFile().split("/").pop();

/**
 * Source links are root-absolute (`/AGENTS.md`, `/path/to/file.md`)
 * so one source can compile to outputs at different depths. Rewrite each to a path
 * relative to the generated file. Links inside fenced code blocks are illustrative
 * examples and are left alone.
 *
 * `/AGENTS.md` is retargeted to whichever file actually carries the baseline, since
 * AGENTS.md is not generated when neither Cursor nor Codex is enabled.
 */
function rewriteLinks(body, outputPath) {
  const fromDir = dirname(join(ROOT, outputPath));
  let inFence = false;

  return body
    .split("\n")
    .map((line) => {
      if (/^\s*(```|~~~)/.test(line)) {
        inFence = !inFence;
        return line;
      }
      if (inFence) return line;
      const linked = line.replace(
        /\[([^\]]*)\]\((\/[^)\s#]*)([^)\s]*)\)/g,
        (_m, text, target, fragment) => {
          const resolved = target === "/AGENTS.md" ? `/${baselineFile()}` : target;
          const rel = toPosix(relative(fromDir, join(ROOT, resolved.slice(1)))) || ".";
          const label = text === "AGENTS.md" ? baselineName() : text;
          return `[${label}](${rel}${fragment})`;
        },
      );
      // Bare prose mentions ("AGENTS.md § Stack"). The lookbehind keeps `AGENTS.md` in
      // backticks and path-prefixed ones like packages/ui/AGENTS.md, which mean the
      // nested Codex files rather than the baseline.
      return linked.replace(/(?<![/`\w-])AGENTS\.md/g, baselineName());
    })
    .join("\n");
}

/* ------------------------------------------------------------------ write queue */

const writes = new Map();

function stage(path, content) {
  const normalized = toPosix(path);
  if (writes.has(normalized)) throw new Error(`two sources both compile to ${normalized}`);
  writes.set(
    normalized,
    Buffer.isBuffer(content)
      ? content
      : Buffer.from(content.replace(/\r\n/g, "\n").replace(/\n*$/, "\n")),
  );
}

function stageMarkdown(path, source, content, frontmatter) {
  stage(
    path,
    ["---", ...frontmatter, "---", "", banner(source), "", rewriteLinks(content, path).trim()].join(
      "\n",
    ),
  );
}

const serializeFrontmatter = (data) =>
  Object.entries(data).map(
    ([key, value]) =>
      `${key}: ${Array.isArray(value) ? `[${value.map(quote).join(", ")}]` : quote(value)}`,
  );

/**
 * Directories the compiler exclusively owns: anything here that it did not just stage is
 * pruned. Listed for every tool, not just the enabled ones, so disabling a tool removes
 * its output instead of leaving a stale copy for an agent to read.
 */
const OWNED = [
  { dir: ".github/instructions", match: (f) => f.endsWith(".instructions.md") },
  { dir: ".github/agents", match: (f) => f.endsWith(".agent.md") },
  { dir: ".github/prompts", match: (f) => f.endsWith(".prompt.md") },
  { dir: ".cursor/rules", match: (f) => f.endsWith(".mdc") },
  { dir: ".cursor/agents", match: (f) => f.endsWith(".md") },
  { dir: ".claude/rules", match: (f) => f.endsWith(".md") },
  { dir: ".claude/agents", match: (f) => f.endsWith(".md") },
  { dir: ".claude/commands", match: (f) => f.endsWith(".md") },
  { dir: ".codex/agents", match: (f) => f.endsWith(".toml") },
];

/** Single-file outputs, which no directory scan would reach. */
const ownedSingletons = () => [
  "AGENTS.md",
  "CLAUDE.md",
  ".github/copilot-instructions.md",
  ...globSync("**/AGENTS.md", {
    cwd: ROOT,
    exclude: [".ai/**", "**/node_modules/**", ".git/**"],
  }).filter((path) =>
    readFileSync(join(ROOT, path), "utf8").startsWith("<!-- AUTO-GENERATED from .ai/domains/"),
  ),
];

/* ------------------------------------------------------------------ sources */

function loadCore() {
  // Filenames determine the concatenation order of the baseline sections.
  return listFiles(join(SRC, "core"), ".md").map((file) => ({
    file,
    ...readSource(join(SRC, "core", file)),
  }));
}

function loadDomains() {
  return listFiles(join(SRC, "domains"), ".md").map((file) => {
    const { data, content } = readSource(join(SRC, "domains", file));
    const name = file.replace(/\.md$/, "");
    if (!data.scope) throw new Error(`.ai/domains/${file}: missing required "scope" glob`);
    if (!data.description) throw new Error(`.ai/domains/${file}: missing required "description"`);
    return {
      name,
      scope: data.scope,
      description: data.description,
      codexPaths: data.codexPaths ?? [],
      content,
    };
  });
}

function loadAgents() {
  return listFiles(join(SRC, "agents"), ".agent.md").map((file) => {
    const { data, content } = readSource(join(SRC, "agents", file));
    const name = file.replace(/\.agent\.md$/, "");
    if (!data.description) throw new Error(`.ai/agents/${file}: missing required "description"`);
    data.models = Object.fromEntries(
      ALL_TOOLS.map((tool) => [
        tool,
        asList(data.model).filter((model) => supportsAgentModel(tool, model)),
      ]),
    );
    for (const tool of asList(data.tools)) {
      if (!Object.hasOwn(AGENT_TOOLS, tool))
        throw new Error(`.ai/agents/${file}: unsupported tool group: ${tool}`);
    }
    return { name, data, content };
  });
}

function loadPrompts() {
  return listFiles(join(SRC, "prompts"), ".prompt.md").map((file) => {
    const { data, content } = readSource(join(SRC, "prompts", file));
    return { name: file.replace(/\.prompt\.md$/, ""), data, content };
  });
}

function loadSkills() {
  const dir = join(SRC, "skills");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => existsSync(join(dir, name, "SKILL.md")))
    .sort()
    .map((name) => ({ name, ...readSource(join(dir, name, "SKILL.md")) }));
}

/**
 * Skills fetched from upstream repos and pinned by skills-lock.json. They live under
 * `.ai/skills/vendor/` so `.ai/` stays the single source, but they are copied byte-for-byte:
 * upstream frontmatter is richer than the parser here accepts, and rewriting their prose
 * would silently diverge them from the hash they are pinned to.
 */
function loadVendoredSkills() {
  const dir = join(SRC, "skills", VENDOR);
  if (!existsSync(dir)) return [];
  const lock = join(ROOT, "skills-lock.json");
  const pinned = existsSync(lock) ? (JSON.parse(readFileSync(lock, "utf8")).skills ?? {}) : {};
  return readdirSync(dir)
    .filter((name) => existsSync(join(dir, name, "SKILL.md")))
    .sort()
    .map((name) => ({ name, source: pinned[name]?.source ?? "unpinned" }));
}

/* ------------------------------------------------------------------ catalogs */

const table = (head, rows) =>
  [
    `| ${head.join(" | ")} |`,
    `| ${head.map(() => "---").join(" | ")} |`,
    ...rows.map((r) => `| ${r.join(" | ")} |`),
  ].join("\n");

/** First sentence of a description — catalogs are the always-loaded tier, so keep them terse. */
const summarize = (text) => {
  const firstSentence = text.split(/(?<=\.)\s|\s—\s/)[0].trim();
  return (firstSentence.length > 20 ? firstSentence : text.trim())
    .replace(/\|/g, "\\|")
    .replace(/\.$/, "");
};

const asList = (value) => (Array.isArray(value) ? value : value ? [value] : []);
const supportsAgentModel = (tool, model) => {
  if (tool === "copilot") return true;
  if (tool === "claude") return /^(?:sonnet|opus|haiku|inherit|claude-[a-z0-9-]+)$/.test(model);
  if (tool === "codex") return /^(?:gpt-\d[a-z0-9.-]*|o\d[a-z0-9.-]*)$/.test(model);
  return model === "inherit";
};
const AGENT_TOOLS = {
  read: ["Read"],
  search: ["Grep", "Glob"],
  execute: ["Bash"],
  agent: ["Agent"],
  edit: ["Edit", "Write"],
};

const agentReadOnly = (data) =>
  data.readonly === "true" || (data.tools !== undefined && !asList(data.tools).includes("edit"));

function markdownAgentHeaders({ name, data }, tool) {
  const model = data.models[tool][0];
  const headers = [
    `name: ${quote(data.name ?? name)}`,
    `description: ${quote(data.description)}`,
    ...(model ? [`model: ${quote(model)}`] : []),
  ];
  if (tool === "cursor") {
    if (agentReadOnly(data)) headers.push("readonly: true");
    return headers;
  }
  if (data.tools !== undefined) {
    const tools = asList(data.tools).flatMap((group) => {
      if (group === "agent" && data.agents !== undefined)
        return asList(data.agents).map((agent) => `Agent(${agent})`);
      return AGENT_TOOLS[group];
    });
    headers.push(`tools: [${tools.map(quote).join(", ")}]`);
  }
  if (data["reasoning-effort"]) headers.push(`effort: ${data["reasoning-effort"]}`);
  return headers;
}

const sharesClaudeAgent = (agent) =>
  enabled("claude") &&
  JSON.stringify(markdownAgentHeaders(agent, "cursor")) ===
    JSON.stringify(markdownAgentHeaders(agent, "claude"));

const markdownAgentTarget = (agent, tool) =>
  `.${tool === "cursor" && sharesClaudeAgent(agent) ? "claude" : tool}/agents/${agent.name}.md`;

function renderCatalogs({ domains, skills, vendoredSkills, agents }, tools) {
  const domainTargets = (domain, tool) => {
    if (tool === "copilot") return [`.github/instructions/${domain.name}.instructions.md`];
    if (tool === "claude") return [`.claude/rules/${domain.name}.md`];
    if (tool === "cursor") return [`.cursor/rules/${domain.name}.mdc`];
    return domain.codexPaths.map((path) => `${path}/AGENTS.md`);
  };
  const agentTarget = (agent, tool) => {
    if (tool === "copilot") return `.github/agents/${agent.name}.agent.md`;
    if (tool === "codex") return `.codex/agents/${agent.name}.toml`;
    return markdownAgentTarget(agent, tool);
  };
  const catalog = (render) =>
    tools.map((tool) => `${tools.length > 1 ? `### ${tool}\n\n` : ""}${render(tool)}`).join("\n\n");
  return {
    "ai:domain-catalog": catalog(
      (tool) =>
        table(
          ["Rules", "Applies to", "Covers"],
          domains
            .filter((domain) => domainTargets(domain, tool).length)
            .map((d) => [
              domainTargets(d, tool)
                .map((path) => `[${d.name}](/${path})`)
                .join(" · "),
              `\`${d.scope.replace(/\|/g, "\\|")}\``,
              summarize(d.description),
            ]),
        ) +
        (tool === "codex"
          ? "\n\nOnly domains with `codexPaths` have generated Codex instructions."
          : ""),
    ),
    "ai:skill-catalog": catalog((tool) =>
      table(
        ["Skill", "Load when", "Source"],
        [
          ...skills.map((s) => [
            `[${s.name}](/${skillTarget(tool)}/${s.name}/SKILL.md)`,
            summarize(s.data.description ?? s.name),
            "authored — `.ai/skills/`",
          ]),
          ...vendoredSkills.map((s) => [
            `[${s.name}](/${skillTarget(tool)}/${s.name}/SKILL.md)`,
            "see its `SKILL.md`",
            `vendored — \`${s.source}\``,
          ]),
        ],
      ),
    ),
    "ai:agent-catalog": catalog((tool) =>
      table(
        ["Subagent", "Use for"],
        agents.map((a) => [`[${a.name}](/${agentTarget(a, tool)})`, summarize(a.data.description)]),
      ),
    ),
  };
}

const injectCatalogs = (body, catalogs) =>
  body.replace(/^<!--\s*(ai:[a-z-]+)\s*-->$/gm, (marker, key) => {
    if (!(key in catalogs)) throw new Error(`unknown catalog marker: ${key}`);
    return catalogs[key];
  });

/* ------------------------------------------------------------------ layer 1: core */

function compileCore(core, sources) {
  const body = core.map((f) => f.content.trim()).join("\n\n---\n\n");
  const render = (tools) => injectCatalogs(body, renderCatalogs(sources, tools));
  const source = ".ai/core/*.md";

  // Cursor and Codex read AGENTS.md natively — no per-tool core output needed for them.
  if (wantsRootAgentsFile())
    stage(
      "AGENTS.md",
      `${banner(source)}\n\n${rewriteLinks(render(["cursor", "codex"].filter(enabled)), "AGENTS.md")}`,
    );

  // Claude Code does not read AGENTS.md; Anthropic's documented bridge is an @import.
  // With no AGENTS.md to import, CLAUDE.md has to carry the baseline itself.
  if (enabled("claude")) {
    const additionsPath = join(SRC, "tools", "claude.md");
    const additions = existsSync(additionsPath) ? readSource(additionsPath).content : "";
    const catalogs = renderCatalogs(sources, ["claude"]);
    const discovery = Object.entries(catalogs)
      .filter(([key]) => body.includes(`<!-- ${key} -->`))
      .map(
        ([key, content]) =>
          `## ${{ "ai:domain-catalog": "Domain Rules", "ai:skill-catalog": "Agent Skills", "ai:agent-catalog": "Subagents" }[key]}\n\n${content}`,
      )
      .join("\n\n");
    stage(
      "CLAUDE.md",
      [
        banner(additions ? `${source}, .ai/tools/claude.md` : source),
        "",
        "# CLAUDE.md",
        "",
        wantsRootAgentsFile() ? "@AGENTS.md" : rewriteLinks(render(["claude"]), "CLAUDE.md"),
        ...(wantsRootAgentsFile() && discovery
          ? ["", "# Claude Discovery", "", rewriteLinks(discovery, "CLAUDE.md")]
          : []),
        ...(additions
          ? ["", rewriteLinks(injectCatalogs(additions, catalogs), "CLAUDE.md").trim()]
          : []),
      ].join("\n"),
    );
  }

  // Copilot's IDE surface does not read AGENTS.md, and @import is CLI-only — flatten.
  const copilot = ".github/copilot-instructions.md";
  if (enabled("copilot"))
    stage(copilot, `${banner(source)}\n\n${rewriteLinks(render(["copilot"]), copilot)}`);
}

/* ------------------------------------------------------------------ layer 2: domains */

function compileDomains(domains) {
  // Codex scopes by directory, not glob, so a domain opts into nesting via `codexPaths`.
  const codexNested = new Map();

  for (const { name, scope, description, codexPaths, content } of domains) {
    const source = `.ai/domains/${name}.md`;
    const head = banner(source);

    const copilot = `.github/instructions/${name}.instructions.md`;
    if (enabled("copilot"))
      stageMarkdown(copilot, source, content, [
        `description: ${quote(description)}`,
        `applyTo: ${quote(scope)}`,
      ]);

    const cursor = `.cursor/rules/${name}.mdc`;
    if (enabled("cursor"))
      stageMarkdown(cursor, source, content, [
        `description: ${quote(description)}`,
        `globs: [${splitScopes(scope).map(quote).join(", ")}]`,
        `alwaysApply: false`,
      ]);

    const claude = `.claude/rules/${name}.md`;
    if (enabled("claude"))
      stageMarkdown(claude, source, content, [
        `description: ${quote(description)}`,
        `paths: [${splitScopes(scope).map(quote).join(", ")}]`,
      ]);

    for (const codexDir of enabled("codex") ? codexPaths : []) {
      const target = `${codexDir}/AGENTS.md`;
      const section = `${head}\n\n${rewriteLinks(content, target).trim()}`;
      codexNested.set(target, [...(codexNested.get(target) ?? []), section]);
    }
  }

  for (const [target, sections] of codexNested) {
    stage(target, sections.join("\n\n---\n\n"));
  }
}

/* ------------------------------------------------------------------ layer 3: agents */

function compileAgents(agents) {
  for (const agent of agents) {
    const { name, data, content } = agent;
    const source = `.ai/agents/${name}.agent.md`;
    for (const tool of ["claude", "cursor"].filter(enabled)) {
      if (tool === "cursor" && sharesClaudeAgent(agent)) continue;
      stageMarkdown(
        markdownAgentTarget(agent, tool),
        source,
        content,
        markdownAgentHeaders(agent, tool),
      );
    }

    const copilot = `.github/agents/${name}.agent.md`;
    if (enabled("copilot"))
      stageMarkdown(copilot, source, content, [
        `name: ${data.name ?? name}`,
        `description: ${quote(data.description)}`,
        ...(data.tools !== undefined
          ? [`tools: [${asList(data.tools).map(quote).join(", ")}]`]
          : []),
        ...(data.models.copilot.length
          ? [`model: [${data.models.copilot.map(quote).join(", ")}]`]
          : []),
        ...(data["reasoning-effort"] ? [`reasoning-effort: ${data["reasoning-effort"]}`] : []),
        ...(data["argument-hint"] ? [`argument-hint: ${quote(data["argument-hint"])}`] : []),
        ...(data.agents ? [`agents: [${asList(data.agents).map(quote).join(", ")}]`] : []),
        ...(data["user-invocable"] !== undefined
          ? [`user-invocable: ${data["user-invocable"]}`]
          : []),
      ]);

    const codex = `.codex/agents/${name}.toml`;
    if (enabled("codex"))
      stage(
        codex,
        [
          `# ${banner(source).replace(/^<!-- | -->$/g, "")}`,
          `name = ${quote(data.name ?? name)}`,
          `description = ${quote(data.description)}`,
          ...(data.models.codex.length ? [`model = ${quote(data.models.codex[0])}`] : []),
          ...(data["reasoning-effort"]
            ? [`model_reasoning_effort = ${quote(data["reasoning-effort"])}`]
            : []),
          ...(agentReadOnly(data) ? ['sandbox_mode = "read-only"'] : []),
          `developer_instructions = ${JSON.stringify(rewriteLinks(content, codex).trim()).replace(/\u007f/g, "\\u007f")}`,
        ].join("\n"),
      );
  }
}

/* ------------------------------------------------------------------ layer 4: skills */

// Codex reads the shared .agents/skills/ path; Cursor reads both its own and the shared one.
const SKILL_TARGETS_BY_TOOL = {
  claude: ".claude/skills",
  codex: ".agents/skills",
  copilot: ".github/skills",
  cursor: ".cursor/skills",
};

function skillTarget(tool) {
  if (tool === "cursor") {
    if (enabled("claude")) return SKILL_TARGETS_BY_TOOL.claude;
    if (enabled("codex")) return SKILL_TARGETS_BY_TOOL.codex;
  }
  return SKILL_TARGETS_BY_TOOL[tool];
}

const skillTargets = () => [...new Set(ALL_TOOLS.filter(enabled).map(skillTarget))];

/**
 * SKILL.md is the one format that is identical across all four tools, so skills only
 * need copying — flattened, since every tool keys a skill by its directory name and
 * `vendor/` is a source-side distinction only.
 */
function compileSkills(skills, vendoredSkills) {
  for (const { name } of skills) copySkill(join(SRC, "skills", name), name, `.ai/skills/${name}`);
  for (const { name } of vendoredSkills) copySkill(join(SRC, "skills", VENDOR, name), name, null);
}

/** `sourceLabel: null` means copy verbatim — see loadVendoredSkills. */
function copySkill(from, name, sourceLabel) {
  const targets = skillTargets();
  if (targets.length === 0) return;
  for (const file of walk(from)) {
    const rel = toPosix(relative(from, file));
    const raw = readFileSync(file);
    const authored =
      sourceLabel && file.endsWith(".md") ? parseFrontmatter(raw.toString("utf8"), rel) : null;
    for (const target of targets) {
      const path = `${target}/${name}/${rel}`;
      if (authored)
        stageMarkdown(
          path,
          `${sourceLabel}/${rel}`,
          authored.content,
          serializeFrontmatter(authored.data),
        );
      else stage(path, raw);
    }
  }
}

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });
}

/* ------------------------------------------------------------------ layer 5: prompts */

function compilePrompts(prompts) {
  for (const { name, data, content } of prompts) {
    const source = `.ai/prompts/${name}.prompt.md`;

    const copilot = `.github/prompts/${name}.prompt.md`;
    if (enabled("copilot")) stageMarkdown(copilot, source, content, serializeFrontmatter(data));

    // Claude merged slash commands into Skills, but .claude/commands/ still works for
    // simple one-shot prompts like these.
    const claude = `.claude/commands/${name}.md`;
    if (enabled("claude"))
      stageMarkdown(claude, source, content, [
        `description: ${quote(data.description ?? name)}`,
        ...(data["argument-hint"] ? [`argument-hint: ${quote(data["argument-hint"])}`] : []),
      ]);
  }
}

/* ------------------------------------------------------------------ validation */

/**
 * Checks that every staged output path is covered by Git ignore rules.
 * Returns validation errors for unignored paths. Skips validation if Git cannot run
 * the ignore check, including when the root is not a Git repository.
 */
function validateOutputIgnored() {
  const paths = [...writes.keys()];
  if (paths.length === 0) return [];

  let ignored;
  try {
    // --no-index checks ignore rules even for paths already tracked by Git.
    const result = spawnSync("git", ["check-ignore", "--no-index", "--stdin"], {
      cwd: ROOT,
      input: paths.join("\n"),
      encoding: "utf8",
    });
    if (result.error || result.status > 1) return [];
    ignored = new Set(
      result.stdout
        .split("\n")
        .map((p) => toPosix(p.trim()))
        .filter(Boolean),
    );
  } catch {
    return [];
  }

  return paths
    .filter((p) => !ignored.has(p))
    .map((p) => `${p} — generated but not git-ignored; add it to .gitignore`);
}

/** Requires each comma-separated domain scope pattern to match at least one file. */
function validateScopes(domains) {
  const problems = [];
  for (const { name, scope } of domains) {
    for (const glob of splitScopes(scope)) {
      const matches = globSync(glob, { cwd: ROOT, exclude: (p) => p.includes("node_modules") });
      if (matches.length === 0)
        problems.push(`.ai/domains/${name}.md — scope "${glob}" matches no file`);
    }
  }
  return problems;
}

/**
 * Root-absolute links get rewritten blindly, so a typo compiles into a broken relative path.
 * Vendored skills are exempt: our link convention is not upstream's contract, and they are
 * copied verbatim anyway.
 */
function validateLinks() {
  const problems = [];
  for (const file of globSync(".ai/**/*.md", { cwd: ROOT, exclude: [`.ai/skills/${VENDOR}/**`] })) {
    let inFence = false;
    readFileSync(join(ROOT, file), "utf8")
      .split("\n")
      .forEach((line, index) => {
        if (/^\s*(```|~~~)/.test(line)) {
          inFence = !inFence;
          return;
        }
        if (inFence) return;
        for (const [, target] of line.matchAll(/\]\((\/[^)\s#]*)/g)) {
          // /AGENTS.md is retargeted at compile time, so it need not exist on disk.
          if (target === "/AGENTS.md") continue;
          if (!existsSync(join(ROOT, target.slice(1)))) {
            problems.push(`${toPosix(file)}:${index + 1} — link target "${target}" does not exist`);
          }
        }
      });
  }
  return problems;
}

/* ------------------------------------------------------------------ flush */

/** Outputs left behind by a renamed source or a now-disabled tool. */
function findStale() {
  const keep = new Set(writes.keys());
  const stale = [];
  const skillRoots = Object.values(SKILL_TARGETS_BY_TOOL);
  const owned = [...OWNED, ...skillRoots.flatMap((dir) => listSkillDirs(dir))];

  for (const { dir, match } of owned) {
    const abs = join(ROOT, dir);
    if (!existsSync(abs)) continue;
    for (const file of readdirSync(abs)) {
      const path = `${dir}/${file}`;
      if (lstatSync(join(abs, file)).isDirectory()) continue;
      if (match(file) && !keep.has(path)) stale.push(path);
    }
  }

  for (const path of new Set(ownedSingletons())) {
    if (!keep.has(path) && existsSync(join(ROOT, path))) stale.push(path);
  }
  return stale;
}

/**
 * Skill subdirectories the compiler owns. Enumerated from what is on disk rather than from
 * the current sources: a skill that was renamed or deleted no longer has a source name to
 * derive, and deriving from the sources is exactly how its stale output would survive.
 * Each target root is generated in full, so everything under one is ours to prune.
 */
function listSkillDirs(root) {
  const abs = join(ROOT, root);
  if (!existsSync(abs)) return [];
  return readdirSync(abs, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .flatMap((e) => nestedDirs(`${root}/${e.name}`));
}

function nestedDirs(dir) {
  const abs = join(ROOT, dir);
  const children = readdirSync(abs, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .flatMap((e) => nestedDirs(`${dir}/${e.name}`));
  return [{ dir, match: () => true }, ...children];
}

/**
 * Pruning files leaves the directories behind, and an empty `.claude/` is still enough for
 * a tool to advertise itself as configured. Deepest-first so a parent empties before it is
 * tested. Only ever removes directories the compiler itself creates.
 */
function removeEmptyOutputDirs() {
  const roots = [
    ...new Set([
      ...OWNED.map((o) => o.dir),
      ...Object.values(SKILL_TARGETS_BY_TOOL),
      ...Object.values(SKILL_TARGETS_BY_TOOL).map((d) => dirname(d)),
      ...OWNED.map((o) => dirname(o.dir)),
    ]),
  ].filter((dir) => dir !== "." && dir !== ".github");

  const depthFirst = (dir) => {
    const abs = join(ROOT, dir);
    if (!existsSync(abs)) return;
    for (const entry of readdirSync(abs, { withFileTypes: true }))
      if (entry.isDirectory()) depthFirst(`${dir}/${entry.name}`);
    if (readdirSync(abs).length === 0) rmSync(abs, { recursive: true });
  };

  for (const dir of roots.sort((a, b) => b.length - a.length)) depthFirst(dir);
}

function main() {
  // An absent source directory is a successful no-op in both write and check modes.
  if (!existsSync(SRC)) {
    console.log("✓ no .ai/ directory — nothing to compile");
    return;
  }

  const core = loadCore();
  const domains = loadDomains();
  const agents = loadAgents();
  const prompts = loadPrompts();
  const skills = loadSkills();
  const vendoredSkills = loadVendoredSkills();

  if (core.length === 0)
    throw new Error(".ai/core/ is empty — refusing to compile an empty baseline");

  const problems = [...validateScopes(domains), ...validateLinks()];
  if (problems.length) {
    console.error(`\n✗ ${problems.length} problem(s) in .ai/:`);
    for (const p of problems) console.error(`  - ${p}`);
    process.exitCode = 1;
    return;
  }

  compileCore(core, { domains, skills, vendoredSkills, agents });
  compileDomains(domains);
  compileAgents(agents);
  compileSkills(skills, vendoredSkills);
  compilePrompts(prompts);

  // Validate staged paths before writing output or pruning existing files.
  const ignoreProblems = validateOutputIgnored();
  if (ignoreProblems.length) {
    console.error(`✗ refusing to write — ${ignoreProblems.length} generated path(s) not ignored:`);
    for (const p of ignoreProblems) console.error(`  - ${p}`);
    process.exitCode = 1;
    return;
  }

  const stale = findStale();

  const outdated = [...writes].filter(([path, content]) => {
    const abs = join(ROOT, path);
    return !existsSync(abs) || !readFileSync(abs).equals(content);
  });

  const summary = TOOLS.size
    ? `${writes.size} files for ${[...TOOLS].sort().join(", ")} — ` +
      `${core.length} core, ${domains.length} domains, ${agents.length} agents, ` +
      `${skills.length} skills (+${vendoredSkills.length} vendored), ${prompts.length} prompts`
    : `no tools configured in ${LOCAL_CONFIG} — nothing to generate`;

  if (CHECK_ONLY) {
    if (outdated.length === 0 && stale.length === 0) {
      console.log(`✓ AI instruction files are in sync — ${summary}`);
    } else {
      console.error(`✗ AI instruction files are out of sync — expected ${summary}`);
      console.error("  Run `node scripts/sync-ai.mjs` to regenerate.\n");
      for (const [path] of outdated) console.error(`  outdated  ${path}`);
      for (const path of stale) console.error(`  stale     ${path}`);
      process.exitCode = 1;
    }
  } else {
    for (const [path, content] of outdated) {
      const abs = join(ROOT, path);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, content);
    }
    for (const path of stale) rmSync(join(ROOT, path));
    removeEmptyOutputDirs();

    console.log(TOOLS.size ? `✓ compiled ${summary}` : `✓ ${summary}`);
    if (outdated.length) console.log(`  wrote ${outdated.length} changed file(s)`);
    if (stale.length) console.log(`  pruned ${stale.length} stale output(s): ${stale.join(", ")}`);
  }
}

main();
