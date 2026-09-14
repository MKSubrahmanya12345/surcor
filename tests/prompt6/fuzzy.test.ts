import { expect, test } from "bun:test";
import { fuzzyFilter, fuzzyScore } from "../../packages/client/src/components/CommandPalette/fuzzy";

test("no match returns -1, empty query matches everything", () => {
  expect(fuzzyScore("zzz", "Open Folder")).toBe(-1);
  expect(fuzzyScore("", "anything")).toBe(0);
});

test("subsequence matching works out of order-free", () => {
  expect(fuzzyScore("of", "Open Folder")).toBeGreaterThan(0);
  expect(fuzzyScore("ttp", "Toggle Terminal Plus")).toBeGreaterThan(0);
});

test("word starts and prefixes outrank scattered matches", () => {
  expect(fuzzyScore("term", "Terminal")).toBeGreaterThan(fuzzyScore("term", "Toggle Every Random Menu"));
  expect(fuzzyScore("fol", "Folder")).toBeGreaterThan(fuzzyScore("fol", "foooooooool"));
});

test("fuzzyFilter ranks best-first and drops non-matches", () => {
  const commands = ["Open Folder", "Toggle Terminal", "New Terminal", "Clone Repository"];
  // "New Terminal" wins: "term" lands as one consecutive word-start run.
  expect(fuzzyFilter("term", commands, (label) => label)).toEqual(["New Terminal", "Toggle Terminal"]);
  expect(fuzzyFilter("nomatchatall", commands, (label) => label)).toEqual([]);
  expect(fuzzyFilter("", commands, (label) => label)).toEqual(commands);
});

test("shorter candidates win on near ties", () => {
  expect(fuzzyScore("chat", "Chat")).toBeGreaterThan(fuzzyScore("chat", "Chat Panel With A Very Long Title"));
});
