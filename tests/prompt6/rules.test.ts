import { expect, test } from "bun:test";
import { loadWorkspaceRules } from "../../packages/server/src/agent/rules";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("missing .forge/rules.md yields null (no rules block)", async () => {
  const root = mkdtempSync(`${tmpdir()}/forge-rules-`);
  expect(await loadWorkspaceRules(root)).toBeNull();
});

test("an existing rules file is returned trimmed", async () => {
  const root = mkdtempSync(`${tmpdir()}/forge-rules-`);
  mkdirSync(join(root, ".forge"), { recursive: true });
  writeFileSync(join(root, ".forge", "rules.md"), "\n  Always respond in French. \n\n");
  expect(await loadWorkspaceRules(root)).toBe("Always respond in French.");
});

test("an empty rules file is treated as absent", async () => {
  const root = mkdtempSync(`${tmpdir()}/forge-rules-`);
  mkdirSync(join(root, ".forge"), { recursive: true });
  writeFileSync(join(root, ".forge", "rules.md"), "   \n  \n");
  expect(await loadWorkspaceRules(root)).toBeNull();
});

test("oversized rules files are truncated, not rejected", async () => {
  const root = mkdtempSync(`${tmpdir()}/forge-rules-`);
  mkdirSync(join(root, ".forge"), { recursive: true });
  writeFileSync(join(root, ".forge", "rules.md"), "x".repeat(40 * 1024));
  const rules = await loadWorkspaceRules(root);
  expect(rules).not.toBeNull();
  expect(rules!.length).toBeLessThan(20 * 1024);
  expect(rules).toContain("[Rules truncated");
});
