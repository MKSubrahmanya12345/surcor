import { expect, test } from "bun:test";
import {
  cosineSimilarity,
  dotProduct,
  makeSnippet,
  normalizePrefix,
  normalizeVector,
} from "../../packages/server/src/index/search";

test("cosineSimilarity is scale-invariant and safe on degenerate input", () => {
  expect(cosineSimilarity([1, 0], [1, 0])).toBe(1);
  expect(cosineSimilarity([1, 0], [0, 1])).toBe(0);
  expect(cosineSimilarity([1, 0], [-1, 0])).toBe(-1);
  expect(cosineSimilarity([1, 2], [2, 4])).toBeCloseTo(1, 10);
  expect(cosineSimilarity([3, 4], [3, 4])).toBeCloseTo(1, 10);
  // mismatched lengths and zero vectors must not produce NaN
  expect(cosineSimilarity([1], [1, 2])).toBe(0);
  expect(cosineSimilarity([], [])).toBe(0);
  expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
  expect(Number.isNaN(cosineSimilarity([0, 0], [0, 0]))).toBe(false);
});

test("normalizeVector produces unit length and leaves zero vectors alone", () => {
  const unit = normalizeVector([3, 4]);
  expect(unit).toBeInstanceOf(Float32Array);
  expect(unit[0]).toBeCloseTo(0.6, 6);
  expect(unit[1]).toBeCloseTo(0.8, 6);
  expect(Math.hypot(unit[0], unit[1])).toBeCloseTo(1, 6);
  expect(Array.from(normalizeVector([0, 0]))).toEqual([0, 0]);
  // an already-normalised vector is returned unchanged
  expect(normalizeVector(unit)[0]).toBeCloseTo(unit[0], 6);
});

test("dotProduct of normalised vectors is the cosine similarity", () => {
  const a = normalizeVector([1, 2, 3]);
  const b = normalizeVector([2, 4, 6]);
  expect(dotProduct(a, b)).toBeCloseTo(1, 6);
  expect(dotProduct(normalizeVector([1, 0]), normalizeVector([0, 1]))).toBeCloseTo(0, 6);
  expect(dotProduct(new Float32Array([1, 2]), new Float32Array([3, 4]))).toBe(11);
  expect(dotProduct(new Float32Array([1]), new Float32Array([1, 2]))).toBe(0);
});

test("makeSnippet keeps whole lines inside the budget", () => {
  expect(makeSnippet("  hello  ", 100)).toBe("hello");
  const lines = Array.from({ length: 20 }, (_, index) => `line ${index}: ${"abcdefghij".repeat(3)}`).join("\n");
  const snippet = makeSnippet(lines, 120);
  expect(snippet.endsWith("\n…")).toBe(true);
  expect(snippet.length).toBeLessThanOrEqual(122);
  const originals = lines.split("\n");
  for (const line of snippet.split("\n").slice(0, -1)) {
    expect(originals).toContain(line);
  }
});

test("normalizePrefix accepts the shapes an agent is likely to send", () => {
  expect(normalizePrefix(undefined)).toBe("");
  expect(normalizePrefix("")).toBe("");
  expect(normalizePrefix("   ")).toBe("");
  expect(normalizePrefix("./")).toBe("");
  expect(normalizePrefix("/")).toBe("");
  expect(normalizePrefix("src")).toBe("src");
  expect(normalizePrefix("./src/")).toBe("src");
  expect(normalizePrefix("/src/")).toBe("src");
  expect(normalizePrefix("  packages/server  ")).toBe("packages/server");
  expect(normalizePrefix("packages\\server")).toBe("packages/server");
});
