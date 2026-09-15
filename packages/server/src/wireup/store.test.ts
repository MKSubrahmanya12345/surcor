/**
 * End-to-end: hardware_build tool → wireup engine → Forge SQLite sink.
 *
 * Boots a real ForgeDatabase(:memory:), registers the engine sink against it,
 * then runs the hardware_build tool exactly as the agent loop dispatches it.
 * This proves the whole chain works: tool arg schema → engine pipeline (offline,
 * deterministic) → project persisted as a JSON blob in forge.sqlite.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { AgentToolContext, ToolCall } from "@forge/shared";
import { ForgeDatabase } from "../db/client";
import { executeTool } from "../tools/registry";
import { initWireupStore } from "./store";

const ORIGINAL_ENV: Record<string, string | undefined> = { ...process.env };

beforeAll(() => {
  process.env.WIREUP_LOG_LEVEL = "warn";
  process.env.WIREUP_MAX_FIX_ITERATIONS = "1";
  process.env.WIREUP_ENABLE_LLM_VALIDATION = "false";
  process.env.WIREUP_ENABLE_LLM_FIXER = "false";
  process.env.WIREUP_ENABLE_LLM_CODEGEN = "false";
  process.env.WIREUP_ENABLE_FIRMWARE_COMPILE = "false";
  process.env.WIREUP_ENABLE_REAL_SIM_LOOP = "false";
  process.env.WIREUP_ENABLE_EVERFLOW_ACTIONS = "false";
  process.env.AWS_ACCESS_KEY_ID = "";
  process.env.AWS_SECRET_ACCESS_KEY = "";
  process.env.AWS_SESSION_TOKEN = "";
});

afterAll(() => {
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("hardware_build tool chain", () => {
  test("builds an offline project and persists it to forge.sqlite", async () => {
    const database = new ForgeDatabase(":memory:");
    initWireupStore(database.sqlite);

    const call: ToolCall = {
      id: crypto.randomUUID(),
      name: "hardware_build",
      args: {
        prompt: "A plant moisture meter that lights a red LED when a capacitive soil sensor reads dry.",
      },
    };
    const chunks: string[] = [];
    const context: AgentToolContext = {
      workspaceRoot: process.cwd(),
      sessionId: "smoke-session",
      database,
      signal: new AbortController().signal,
      emit: (message) => {
        if (message.type === "tool_result_chunk") chunks.push(message.result.output);
      },
      commandTimeoutMs: 120_000,
      maxFileBytes: 1_048_576,
      maxOutputBytes: 262_144,
    };

    const result = await executeTool(call, context);

    expect(result.ok).toBe(true);
    expect(chunks.length).toBeGreaterThan(3); // stage progress was streamed
    const summary = JSON.parse(result.output) as {
      projectId: string; status: string; components: unknown[]; code: { files: { path: string }[] } | null;
    };
    expect(summary.components.length).toBeGreaterThan(0);
    expect(summary.code).not.toBeNull();
    expect(summary.code!.files.length).toBeGreaterThan(0);

    // The project row must have reached SQLite through the sink.
    const row = database.sqlite.query<{ id: string; doc: string }, [string]>(
      "SELECT id, doc FROM wireup_projects WHERE id = ?",
    ).get(summary.projectId);
    expect(row).not.toBeNull();
    const doc = JSON.parse(row!.doc) as { status: string; components: unknown[] };
    expect(doc.components.length).toBe(summary.components.length);
    expect(doc.status).toBe(summary.status);

    database.close();
  }, 120_000);
});