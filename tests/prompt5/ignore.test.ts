import { expect, test } from "bun:test";
import {
  BINARY_EXTENSIONS,
  DEFAULT_IGNORE_TEXT,
  IgnoreStack,
  SKIP_FILE_NAMES,
  isSkippedFile,
  looksMinified,
  parseIgnoreRules,
  ruleMatches,
} from "../../packages/server/src/index/ignore";

const ROOT_RULES = `
# a comment
node_modules
dist/
*.log
/secret.env
docs/**/draft
!keep.log
generated/**
`;

const root = IgnoreStack.from(parseIgnoreRules(ROOT_RULES));

const CASES: [path: string, isDirectory: boolean, ignored: boolean][] = [
  ["node_modules", true, true],
  ["node_modules/x.js", false, true],
  ["a/node_modules/b", false, true],
  ["dist", true, true],
  ["dist/index.html", false, true],
  ["src/dist", true, true],
  ["a.log", false, true],
  ["keep.log", false, false],
  ["deep/keep.log", false, false],
  ["secret.env", false, true],
  ["sub/secret.env", false, false],
  ["docs/draft", false, true],
  ["docs/a/draft", false, true],
  ["docs/a/b/c/draft", false, true],
  ["docs/a/draft.md", false, false],
  ["other/draft.md", false, false],
  [".git", true, true],
  [".git/config", false, true],
  ["__pycache__/x.pyc", false, true],
  ["generated/a.ts", false, true],
  ["generated/deep/b/c.ts", false, true],
  ["generated", true, false],
  ["src/main.ts", false, false],
  ["package.json", false, false],
];

for (const [path, isDirectory, ignored] of CASES) {
  test(`${ignored ? "ignores" : "keeps"} ${path}${isDirectory ? " (directory)" : ""}`, () => {
    expect(root.isIgnored(path, isDirectory)).toBe(ignored);
  });
}

test("comments, blank lines and escapes do not become patterns", () => {
  const rules = parseIgnoreRules("# comment\n\n   \n!important\n\\!literal\n");
  expect(rules.map((rule) => rule.pattern)).toEqual(["!important", "\\!literal"]);
  expect(rules[0].negated).toBe(true);
  expect(rules[1].negated).toBe(false);
  expect(IgnoreStack.from(parseIgnoreRules("\\!literal\n")).isIgnored("!literal", false)).toBe(true);
});

test("a directory-only rule also covers everything under that directory", () => {
  const [rule] = parseIgnoreRules("build/");
  expect(rule.dirOnly).toBe(true);
  expect(ruleMatches(rule, "build", true)).toBe(true);
  expect(ruleMatches(rule, "build", false)).toBe(false);
  expect(ruleMatches(rule, "build/out.js", false)).toBe(true);
  expect(ruleMatches(rule, "src/build/out.js", false)).toBe(true);
  expect(ruleMatches(rule, "builder/out.js", false)).toBe(false);
});

test("the last matching rule wins, which is what makes negation work", () => {
  const stack = IgnoreStack.from(parseIgnoreRules("*.log\n!important.log\n"));
  expect(stack.isIgnored("debug.log", false)).toBe(true);
  expect(stack.isIgnored("important.log", false)).toBe(false);
  // ... and a later rule overrides the negation again
  const reversed = IgnoreStack.from(parseIgnoreRules("*.log\n!important.log\nimportant.log\n"));
  expect(reversed.isIgnored("important.log", false)).toBe(true);
});

test("nested layers override the workspace layer, git-style", () => {
  const nested = root.withLayer("packages/client", parseIgnoreRules("!dist/\nsrc/gen/\n"));
  expect(nested.layerCount).toBe(2);
  expect(nested.isIgnored("packages/client/dist", true)).toBe(false);
  expect(nested.isIgnored("packages/client/dist/app.js", false)).toBe(false);
  expect(nested.isIgnored("packages/client/src/gen/x.ts", false)).toBe(true);
  expect(nested.isIgnored("other/src/gen/x.ts", false)).toBe(false);
  expect(root.isIgnored("src/gen/x.ts", false)).toBe(false);
  // an empty nested file changes nothing
  expect(root.withLayer("packages/client", []).layerCount).toBe(1);
});

test("the built-in defaults cover the usual noise", () => {
  const stack = IgnoreStack.from([]);
  const noise: [path: string, isDirectory: boolean][] = [
    [".git", true], [".git", false], [".git/config", false],
    ["node_modules", true], ["node_modules/zod/index.js", false],
    ["dist/bundle.js", false], ["build/out.o", false], ["__pycache__/mod.pyc", false],
    [".DS_Store", false], ["Thumbs.db", false], [".venv/lib/x.py", false],
  ];
  for (const [path, isDirectory] of noise) {
    expect(stack.isIgnored(path, isDirectory)).toBe(true);
  }
  expect(stack.isIgnored("src/main.ts", false)).toBe(false);
  expect(stack.isIgnored("packages/server/src/index/store.ts", false)).toBe(false);
  expect(parseIgnoreRules(DEFAULT_IGNORE_TEXT).length).toBe(35);
});

test("lock files, binaries and minified bundles are never worth embedding", () => {
  for (const name of ["bun.lock", "bun.lockb", "package-lock.json", "yarn.lock", "pnpm-lock.yaml", "go.sum", "Cargo.lock"]) {
    expect(isSkippedFile(name)).toBe(true);
  }
  for (const name of ["logo.png", "app.node", "vendor/x.so", "font.woff2", "bundle.min.js.map", "data.sqlite"]) {
    expect(isSkippedFile(name)).toBe(true);
  }
  for (const name of ["src/index.ts", "README.md", "package.json", "Dockerfile"]) {
    expect(isSkippedFile(name)).toBe(false);
  }
  expect(SKIP_FILE_NAMES.has("bun.lock")).toBe(true);
  expect(BINARY_EXTENSIONS.has("png")).toBe(true);

  expect(looksMinified("x".repeat(5000))).toBe(true);
  expect(looksMinified(Array.from({ length: 50 }, (_, index) => `line ${index}`).join("\n"))).toBe(false);
  expect(looksMinified("short")).toBe(false);
  expect(looksMinified("")).toBe(false);
});
