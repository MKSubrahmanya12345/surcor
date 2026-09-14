import { expect, test } from "bun:test";
import { chunkFile, chunkText, estimateTokens, languageForPath } from "../../packages/server/src/index/chunker";

const twoFunctions = [
  "function alpha() {",
  "  return 1;",
  "}",
  "",
  "function beta() {",
  "  return 2;",
  "}",
].join("\n");

test("languageForPath knows extensions, special file names, and gives up politely", () => {
  expect(languageForPath("src/app.tsx")).toBe("typescriptreact");
  expect(languageForPath("src/app.ts")).toBe("typescript");
  expect(languageForPath("notes.md")).toBe("markdown");
  expect(languageForPath("Dockerfile")).toBe("dockerfile");
  expect(languageForPath("dockerfile.prod")).toBe("dockerfile");
  expect(languageForPath("Makefile")).toBe("makefile");
  expect(languageForPath("CMakeLists.txt")).toBe("cmake");
  expect(languageForPath("windows\\style\\path.py")).toBe("python");
  expect(languageForPath("archive.mystery")).toBe("plaintext");
  expect(languageForPath("no-extension")).toBe("plaintext");
});

test("estimateTokens is roughly four characters per token", () => {
  expect(estimateTokens("")).toBe(1);
  expect(estimateTokens("abcd")).toBe(1);
  expect(estimateTokens("abcde")).toBe(2);
  expect(estimateTokens("x".repeat(400))).toBe(100);
});

test("blocks separated by a blank line merge into one chunk", () => {
  const chunks = chunkText(twoFunctions);
  expect(chunks.length).toBe(1);
  expect(chunks[0].startLine).toBe(1);
  expect(chunks[0].endLine).toBe(7);
  expect(chunks[0].content).toContain("function alpha()");
  expect(chunks[0].content).toContain("function beta()");
});

test("a tight token budget keeps the blocks apart, with exact line ranges", () => {
  const chunks = chunkText(twoFunctions, { maxTokens: 5 });
  expect(chunks.map((chunk) => [chunk.startLine, chunk.endLine])).toEqual([[1, 3], [5, 7]]);
});

test("empty and whitespace-only files produce no chunks", () => {
  expect(chunkText("")).toEqual([]);
  expect(chunkText("   \n\n\t\n")).toEqual([]);
});

test("trivial blocks are dropped instead of embedded", () => {
  // Fewer than twelve alphanumeric characters carries no retrievable signal.
  expect(chunkText("a\n\nb\n\nc\n")).toEqual([]);
});

test("a block taller than maxLines is windowed by line", () => {
  const content = Array.from({ length: 30 }, (_, index) => `const value${index} = ${index};`).join("\n");
  const chunks = chunkText(content, { maxTokens: 20, maxLines: 10 });
  expect(chunks.length).toBe(3);
  expect(chunks.map((chunk) => chunk.startLine)).toEqual([1, 11, 21]);
  expect(chunks.map((chunk) => chunk.endLine)).toEqual([10, 20, 30]);
});

test("a huge single line is windowed by characters, not lost", () => {
  const chunks = chunkText("x".repeat(5000), { maxTokens: 50 });
  // window = maxTokens * 4 characters/token * 4 = 800 characters
  expect(chunks.length).toBe(7);
  expect(chunks[0].content.length).toBe(800);
  expect(chunks.every((chunk) => chunk.startLine === 1 && chunk.endLine === 1)).toBe(true);
});

test("the budget widens rather than emitting thousands of chunks", () => {
  const content = Array.from({ length: 6 }, (_, index) => `const item${index} = "${"x".repeat(20)}";`).join("\n\n");
  expect(chunkText(content, { maxTokens: 5 }).length).toBe(6);
  expect(chunkText(content, { maxTokens: 5, maxChunks: 2 }).length).toBeLessThanOrEqual(2);
});

test("chunkFile produces the stored shape, with workspace-scoped ids", () => {
  const chunks = chunkFile("src/a.ts", "/ws/src/a.ts", "line one\n\nline two\n", { workspaceId: "ws-1" });
  expect(chunks.length).toBe(1);
  expect(chunks[0].id).toBe("ws-1:src/a.ts:1:0");
  expect(chunks[0].relativePath).toBe("src/a.ts");
  expect(chunks[0].absolutePath).toBe("/ws/src/a.ts");
  expect(chunks[0].language).toBe("typescript");
  expect(chunks[0].startLine).toBe(1);
  expect(chunks[0].endLine).toBe(3);
  expect(chunks[0].tokenEstimate).toBe(5);
});

test("chunk ids stay unique when a file yields many chunks", () => {
  const content = Array.from({ length: 30 }, (_, index) => `const value${index} = ${index};`).join("\n");
  const chunks = chunkFile("big.ts", "/ws/big.ts", content, { maxTokens: 20, maxLines: 10, workspaceId: "ws-1" });
  expect(chunks.length).toBe(3);
  expect(new Set(chunks.map((chunk) => chunk.id)).size).toBe(chunks.length);
  expect(chunkFile("big.ts", "/ws/big.ts", content).every((chunk) => chunk.id.startsWith("big.ts:"))).toBe(true);
});
