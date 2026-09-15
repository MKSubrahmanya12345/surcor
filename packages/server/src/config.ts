import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { parseEnv } from "node:util";
import type {
  AgentServerConfig, BedrockConfig, IndexConfig, ProviderName, WebSearchConfig,
} from "@forge/shared";

type Env = Record<string, string | undefined>;

let cachedEnv: Env | null = null;

/**
 * The merged environment used to build the config: `packages/server/.env`
 * overlaid by the real process environment. Tools (web search) read their keys
 * from here rather than from `process.env`, because Bun only auto-loads the
 * `.env` of the *current working directory* and the server is usually started
 * from the repository root.
 */
export function serverEnv(): Env {
  if (cachedEnv) return cachedEnv;
  let local: Env = {};
  try {
    local = parseEnv(readFileSync(new URL("../.env", import.meta.url), "utf8"));
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  cachedEnv = { ...local, ...process.env };
  return cachedEnv;
}

function envInteger(env: Env, key: string, fallback: number, min: number, max: number): number {
  const value = env[key] === undefined || env[key] === "" ? fallback : Number(env[key]);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${key} must be an integer between ${min} and ${max}.`);
  }
  return value;
}

function envFlag(env: Env, key: string, fallback: boolean): boolean {
  const value = env[key]?.trim().toLowerCase();
  if (value === undefined || value === "") return fallback;
  if (["1", "true", "yes", "on"].includes(value)) return true;
  if (["0", "false", "no", "off"].includes(value)) return false;
  throw new Error(`${key} must be a boolean (true/false).`);
}

function envList(env: Env, key: string, fallback: string): string[] {
  return (env[key] ?? fallback).split(",").map((item) => item.trim()).filter(Boolean);
}

/** Bedrock region decides the endpoint host, so it is resolved before both. */
function bedrockRegion(env: Env): string {
  return env.BEDROCK_REGION ?? env.AWS_BEDROCK_REGION ?? env.AWS_REGION ?? env.AWS_DEFAULT_REGION ?? "us-east-1";
}

function bedrockBaseUrl(env: Env, region: string): string {
  return env.BEDROCK_BASE_URL ?? `https://bedrock-runtime.${region}.amazonaws.com`;
}

function bedrockModel(env: Env): string {
  // An inference profile id, not a bare model id: on-demand throughput rejects
  // base ids such as "anthropic.claude-sonnet-4-5-20250929-v1:0".
  return env.BEDROCK_MODEL ?? env.AWS_BEDROCK_MODEL ?? "us.anthropic.claude-sonnet-4-5-20250929-v1:0";
}

export function loadBedrockConfig(env: Env = serverEnv()): BedrockConfig {
  const region = bedrockRegion(env);
  return {
    region,
    model: bedrockModel(env),
    baseUrl: bedrockBaseUrl(env, region),
    streaming: envFlag(env, "BEDROCK_STREAMING", true),
    accessKeyId: env.AWS_ACCESS_KEY_ID,
    secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
    sessionToken: env.AWS_SESSION_TOKEN,
    bearerToken: env.AWS_BEARER_TOKEN_BEDROCK,
    profile: env.AWS_PROFILE ?? env.AWS_DEFAULT_PROFILE,
  };
}

export function loadIndexConfig(env: Env = serverEnv()): IndexConfig {
  const order = envList(env, "EMBEDDING_ORDER", "ollama,openai");
  if (order.some((name) => !["ollama", "openai"].includes(name))) {
    throw new Error("EMBEDDING_ORDER must list ollama and/or openai.");
  }
  return {
    enabled: envFlag(env, "INDEX_ENABLED", true),
    maxFiles: envInteger(env, "INDEX_MAX_FILES", 20_000, 100, 500_000),
    maxFileBytes: envInteger(env, "INDEX_MAX_FILE_BYTES", 524_288, 1_024, 16_777_216),
    maxChunkTokens: envInteger(env, "INDEX_MAX_CHUNK_TOKENS", 220, 40, 2_000),
    maxDepth: envInteger(env, "INDEX_MAX_DEPTH", 24, 2, 128),
    batchSize: envInteger(env, "INDEX_BATCH_SIZE", 32, 1, 512),
    embeddingOrder: [...new Set(order)] as ("ollama" | "openai")[],
    ollama: {
      baseUrl: env.OLLAMA_BASE_URL ?? "http://localhost:11434",
      model: env.OLLAMA_EMBED_MODEL ?? "nomic-embed-text",
    },
    openai: {
      baseUrl: env.OPENAI_BASE_URL ?? "https://api.openai.com/v1",
      model: env.OPENAI_EMBED_MODEL ?? "text-embedding-3-small",
      apiKey: env.OPENAI_API_KEY,
    },
    requestTimeoutMs: envInteger(env, "EMBEDDING_TIMEOUT_MS", 30_000, 1_000, 300_000),
  };
}

export function loadWebSearchConfig(env: Env = serverEnv()): WebSearchConfig {
  return {
    tavilyApiKey: env.TAVILY_API_KEY,
    tavilyBaseUrl: env.TAVILY_BASE_URL ?? "https://api.tavily.com",
    braveApiKey: env.BRAVE_API_KEY ?? env.BRAVE_SEARCH_API_KEY,
    braveBaseUrl: env.BRAVE_BASE_URL ?? "https://api.search.brave.com/res/v1",
    requestTimeoutMs: envInteger(env, "WEB_SEARCH_TIMEOUT_MS", 15_000, 1_000, 120_000),
    defaultMaxResults: envInteger(env, "WEB_SEARCH_MAX_RESULTS", 5, 1, 10),
  };
}

/** Current web-search settings. Read by the `web_search` tool on each call. */
export function webSearchConfig(): WebSearchConfig {
  return loadWebSearchConfig();
}

export function loadConfig(): AgentServerConfig {
  const env = serverEnv();
  const names: ProviderName[] = ["bedrock"];
  const order = envList(env, "PROVIDER_ORDER", names.join(","));
  if (!order.length || order.some((name) => !names.includes(name as ProviderName))) {
    throw new Error("PROVIDER_ORDER must list bedrock.");
  }
  const hostname = env.HOST ?? "127.0.0.1";
  const token = env.FORGE_SERVER_TOKEN || undefined;
  if (!["127.0.0.1", "localhost", "::1"].includes(hostname) && !token) {
    throw new Error("FORGE_SERVER_TOKEN is required when HOST exposes the server beyond loopback.");
  }
  const databasePath = env.DATABASE_PATH ?? resolve(homedir(), ".forge", "forge.sqlite");
  const bedrock = loadBedrockConfig(env);

  return {
    hostname,
    port: envInteger(env, "PORT", 4500, 1, 65_535),
    databasePath: isAbsolute(databasePath) || databasePath === ":memory:"
      ? databasePath
      : resolve(import.meta.dir, "..", databasePath),
    token,
    allowedOrigins: envList(env, "ALLOWED_ORIGINS", ""),
    providerOrder: [...new Set(order)] as ProviderName[],
    bedrock,
    index: loadIndexConfig(env),
    webSearch: loadWebSearchConfig(env),
    providerTimeoutMs: envInteger(env, "PROVIDER_TIMEOUT_MS", 120_000, 1_000, 600_000),
    maxTurns: envInteger(env, "AGENT_MAX_TURNS", 12, 1, 100),
    maxToolCallsPerTurn: envInteger(env, "AGENT_MAX_TOOL_CALLS", 8, 1, 32),
    maxTokens: envInteger(env, "MAX_OUTPUT_TOKENS", 4096, 256, 32_768),
    commandTimeoutMs: envInteger(env, "COMMAND_TIMEOUT_MS", 120_000, 1_000, 300_000),
    maxFileBytes: envInteger(env, "MAX_FILE_BYTES", 1_048_576, 1_024, 1_048_576),
    maxOutputBytes: envInteger(env, "MAX_OUTPUT_BYTES", 262_144, 1_024, 1_048_576),
  };
}
