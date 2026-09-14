/**
 * gitignore-style matcher (no dependency, no `ignore` npm package).
 *
 * Supports: comments (`#`), blank lines, negation (`!`), directory-only
 * patterns (`build/`), leading-slash anchoring (`/secret.env`), `*`, `?`,
 * `[abc]`, and `**` in leading, trailing and middle positions. Patterns are
 * evaluated in order and the LAST match wins, which is what makes `!` work.
 *
 * Layers: the workspace `.gitignore` / `.forgeignore` plus any nested ones
 * found while walking. Deeper layers override shallower ones, matching git.
 */

export interface IgnoreRule {
  pattern: string;
  negated: boolean;
  dirOnly: boolean;
  regex: RegExp;
}

function escapeLiteral(char: string): string {
  return /[.+^${}()|[\]\\]/.test(char) ? `\\${char}` : char;
}

/** Translate one glob pattern body into a regex source (no anchors). */
function patternToRegexSource(pattern: string): string {
  let source = "";
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index];
    if (char === "*") {
      if (pattern[index + 1] === "*") {
        // `**/` -> any number of directories; `/**` at the end -> everything below
        if (pattern[index + 2] === "/") { source += "(?:[^/]*/)*"; index += 2; continue; }
        source += ".*";
        index += 1;
        continue;
      }
      source += "[^/]*";
      continue;
    }
    if (char === "?") { source += "[^/]"; continue; }
    if (char === "[") {
      const end = pattern.indexOf("]", index + 1);
      if (end < 0) { source += "\\["; continue; }
      let body = pattern.slice(index + 1, end);
      if (body.startsWith("!")) body = `^${body.slice(1)}`;
      source += `[${body.replace(/\\/g, "\\\\")}]`;
      index = end;
      continue;
    }
    source += escapeLiteral(char);
  }
  return source;
}

export function parseIgnoreRules(text: string): IgnoreRule[] {
  const rules: IgnoreRule[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+$/, "");
    if (!line || line.startsWith("#")) continue;
    const negated = line.startsWith("!");
    let pattern = negated ? line.slice(1) : line;
    if (pattern.startsWith("\\!") || pattern.startsWith("\\#")) pattern = pattern.slice(1);
    if (!pattern) continue;
    const dirOnly = pattern.endsWith("/");
    if (dirOnly) pattern = pattern.slice(0, -1);
    if (!pattern) continue;
    const anchored = pattern.startsWith("/") || pattern.slice(0, -1).includes("/");
    if (pattern.startsWith("/")) pattern = pattern.slice(1);
    const body = patternToRegexSource(pattern);
    const prefix = anchored ? "" : "(?:[^/]*/)*";
    rules.push({ pattern: line, negated, dirOnly, regex: new RegExp(`^${prefix}${body}(?:/.*)?$`) });
  }
  return rules;
}

/**
 * Entries that are never worth indexing, whatever the user's .gitignore says.
 * `.git` has no trailing slash on purpose: in worktrees and submodules it is a
 * file, and either way it is never source.
 */
export const DEFAULT_IGNORE_TEXT = `
.git
.hg/
.svn/
node_modules/
bower_components/
vendor/
dist/
build/
out/
target/
coverage/
.next/
.nuxt/
.output/
.svelte-kit/
.cache/
.parcel-cache/
.vite/
.turbo/
.mypy_cache/
.pytest_cache/
.ruff_cache/
__pycache__/
.venv/
venv/
env/
.tox/
.nox/
.idea/
.gradle/
*.o
*.obj
*.pyc
.DS_Store
Thumbs.db
`;

/** Extensions that are never text we want to embed. */
export const BINARY_EXTENSIONS = new Set([
  "png", "jpg", "jpeg", "gif", "bmp", "ico", "icns", "webp", "avif", "tiff", "psd",
  "mp3", "wav", "ogg", "flac", "aac", "m4a", "opus", "mid",
  "mp4", "mov", "avi", "mkv", "webm", "wmv", "m4v",
  "ttf", "otf", "woff", "woff2", "eot",
  "zip", "gz", "tgz", "bz2", "xz", "7z", "rar", "tar", "jar", "war", "whl", "egg",
  "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "odt",
  "exe", "dll", "so", "dylib", "bin", "dat", "db", "sqlite", "sqlite3", "wasm",
  "class", "pyc", "pyd", "o", "obj", "a", "lib", "map", "pack", "idx",
  "lockb", "node", "bundle",
]);

/** Files whose contents are noise at best and huge at worst. */
export const SKIP_FILE_NAMES = new Set([
  "package-lock.json", "yarn.lock", "pnpm-lock.yaml", "bun.lock", "bun.lockb",
  "cargo.lock", "composer.lock", "poetry.lock", "gemfile.lock", "flake.lock",
  "go.sum", "uv.lock", "pdm.lock",
]);

/** True for anything that is obviously not source text. */
export function isSkippedFile(relativePath: string): boolean {
  const name = relativePath.split("/").pop()?.toLowerCase() ?? "";
  if (SKIP_FILE_NAMES.has(name)) return true;
  const extension = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : "";
  return BINARY_EXTENSIONS.has(extension);
}

/** True when the file looks minified: very few, very long lines. */
export function looksMinified(content: string): boolean {
  const lines = content.split("\n").length;
  if (lines > 40) return false;
  return content.length / Math.max(1, lines) > 400;
}

export interface IgnoreLayer {
  /** Workspace-relative directory the rules are anchored to ("" = root). */
  base: string;
  rules: IgnoreRule[];
}

/**
 * Does one rule apply to `scoped`? A directory-only rule also covers
 * everything *under* that directory: git gets this by never walking into an
 * ignored directory, but single-path queries (e.g. re-indexing one file after
 * a write) must answer the same way, so ancestor prefixes are checked too.
 */
export function ruleMatches(rule: IgnoreRule, scoped: string, isDirectory: boolean): boolean {
  if (!rule.dirOnly) return rule.regex.test(scoped);
  if (rule.regex.test(scoped) && isDirectory) return true;
  for (let index = scoped.indexOf("/"); index > 0; index = scoped.indexOf("/", index + 1)) {
    if (rule.regex.test(scoped.slice(0, index))) return true;
  }
  return false;
}

export class IgnoreStack {
  constructor(private readonly layers: IgnoreLayer[]) {}

  static from(rootRules: IgnoreRule[]): IgnoreStack {
    return new IgnoreStack([{ base: "", rules: [...parseIgnoreRules(DEFAULT_IGNORE_TEXT), ...rootRules] }]);
  }

  /** A nested .gitignore/.forgeignore discovered while walking. */
  withLayer(base: string, rules: IgnoreRule[]): IgnoreStack {
    if (!rules.length) return this;
    return new IgnoreStack([...this.layers, { base, rules }]);
  }

  get layerCount(): number { return this.layers.length; }

  /**
   * `relativePath` is workspace-relative and "/" separated. Deeper layers win:
   * the result of the last layer that matches is returned.
   */
  isIgnored(relativePath: string, isDirectory: boolean): boolean {
    let ignored = false;
    for (const layer of this.layers) {
      const scoped = layer.base
        ? relativePath === layer.base || relativePath.startsWith(`${layer.base}/`)
          ? relativePath.slice(layer.base.length + 1)
          : null
        : relativePath;
      if (scoped === null || !scoped) continue;
      for (const rule of layer.rules) {
        if (ruleMatches(rule, scoped, isDirectory)) ignored = !rule.negated;
      }
    }
    return ignored;
  }
}
