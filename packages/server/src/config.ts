import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { parseEnv } from "node:util";
import type { AgentServerConfig, ProviderName } from "@forge/shared";

export function loadConfig(): AgentServerConfig {
  // Bun loads cwd/.env automatically. Explicitly load this package's file too,
  // so `bun run packages/server/src/server.ts` works from the repository root.
  let local: Record<string, string> = {};
  try {
    local = parseEnv(readFileSync(new URL("../.env", import.meta.url), "utf8"));
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  const env = { ...local, ...process.env };
  const integer = (key: string, fallback: number, min: number, max: number): number => {
    const value = env[key] === undefined ? fallback : Number(env[key]);
    if (!Number.isInteger(value) || value < min || value > max) {
      throw new Error(`${key} must be an integer between ${min} and ${max}.`);
    }
    return value;
  };
  const names: ProviderName[] = ["anthropic", "openai", "gemini", "ollama"];
  const order = (env.PROVIDER_ORDER ?? names.join(",")).split(",").map((name) => name.trim());
  if (!order.length || order.some((name) => !names.includes(name as ProviderName))) {
    throw new Error("PROVIDER_ORDER must list anthropic, openai, gemini, and/or ollama.");
  }
  const hostname = env.HOST ?? "127.0.0.1";
  const token = env.FORGE_SERVER_TOKEN || undefined;
  if (!["127.0.0.1", "localhost", "::1"].includes(hostname) && !token) {
    throw new Error("FORGE_SERVER_TOKEN is required when HOST exposes the server beyond loopback.");
  }
  const databasePath = env.DATABASE_PATH ?? resolve(homedir(), ".forge", "forge.sqlite");
  return {
    hostname,
    port: integer("PORT", 4500, 1, 65_535),
    databasePath: isAbsolute(databasePath) || databasePath === ":memory:"
      ? databasePath
      : resolve(import.meta.dir, "..", databasePath),
    token,
    allowedOrigins: (env.ALLOWED_ORIGINS ?? "").split(",").map((origin) => origin.trim()).filter(Boolean),
    providerOrder: [...new Set(order)] as ProviderName[],
    providers: {
      anthropic: {
        apiKey: env.ANTHROPIC_API_KEY,
        baseUrl: env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com",
        model: env.ANTHROPIC_MODEL ?? "claude-sonnet-4-20250514",
      },
      openai: {
        apiKey: env.OPENAI_API_KEY,
        baseUrl: env.OPENAI_BASE_URL ?? "https://api.openai.com/v1",
        model: env.OPENAI_MODEL ?? "gpt-4o",
      },
      gemini: {
        apiKey: env.GEMINI_API_KEY ?? env.GOOGLE_API_KEY,
        baseUrl: env.GEMINI_BASE_URL ?? "https://generativelanguage.googleapis.com/v1beta",
        model: env.GEMINI_MODEL ?? "gemini-2.5-flash",
      },
      ollama: {
        baseUrl: env.OLLAMA_BASE_URL ?? "http://localhost:11434",
        model: env.OLLAMA_MODEL ?? "llama3.1:8b",
      },
    },
    providerTimeoutMs: integer("PROVIDER_TIMEOUT_MS", 120_000, 1_000, 600_000),
    maxTurns: integer("AGENT_MAX_TURNS", 12, 1, 100),
    maxToolCallsPerTurn: integer("AGENT_MAX_TOOL_CALLS", 8, 1, 32),
    maxTokens: integer("MAX_OUTPUT_TOKENS", 4096, 256, 32_768),
    commandTimeoutMs: integer("COMMAND_TIMEOUT_MS", 120_000, 1_000, 300_000),
    maxFileBytes: integer("MAX_FILE_BYTES", 1_048_576, 1_024, 1_048_576),
    maxOutputBytes: integer("MAX_OUTPUT_BYTES", 262_144, 1_024, 1_048_576),
  };
}
