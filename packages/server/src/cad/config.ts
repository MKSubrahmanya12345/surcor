import { homedir } from "node:os";
import { resolve } from "node:path";
import type { AgentServerConfig, ProviderName } from "@forge/shared";
import { loadConfig, serverEnv } from "../config";

/**
 * Everything Prompt 7 needs from the environment, resolved once per call site
 * (the same style as `webSearchConfig()`: read lazily so a test can drive the
 * pipeline without a full `loadConfig()`).
 *
 * The MAC sidecar is an *optional local service*, exactly like Ollama: Forge
 * connects to it, it is never spawned or installed by the Electron bundler.
 */

export interface CadLlmConfig {
  /** OpenAI-compatible endpoint MAC's four stages call (its `DS_BASE_URL`). */
  baseUrl: string;
  /** Model id served at that endpoint; used for all four stages. */
  model: string;
  /** Aider's repair stage wants a litellm-style `provider/model` name. */
  aiderModel: string;
  apiKey?: string;
  /** Where the key came from, for error messages that name the real setting. */
  provider: string;
}

export interface CadConfig {
  enabled: boolean;
  /** MAC web service root, e.g. http://127.0.0.1:8000 */
  macBaseUrl: string;
  /** Timeout for individual sidecar HTTP calls (health, result, file reads). */
  requestTimeoutMs: number;
  /** Ceiling for a whole MAC job (pipeline + its internal repair loop). */
  jobTimeoutMs: number;
  /** How long to wait between `GET /api/jobs/{id}/result` polls. */
  pollIntervalMs: number;
  /**
   * Total QA attempts Forge allows. Fed to MAC as `MAX_RETRIES` so the retries
   * happen inside MAC's own autonomous loop (10s iteration checkpoint →
   * auto-iterate) instead of restarting the pipeline from the Spec Planner.
   */
  attemptBudget: number;
  /** Directory Forge copies verified artifacts into; also the only dir served over HTTP. */
  artifactDir: string;
  /** Search-first path (Part B). Off ⇒ always generate. */
  searchEnabled: boolean;
  searchMaxResults: number;
  /** Ceiling for a single downloaded candidate model file. */
  maxDownloadBytes: number;
  downloadTimeoutMs: number;
  /** `opencascade-tools` CLI (npm i -g opencascade-tools) used for STEP → GLB. */
  cascadeBin: string;
  cascadeTimeoutMs: number;
  /** Tessellation quality for the viewer (smaller = finer mesh, bigger GLB). */
  cascadeLinDeflection: number;
  cascadeAngDeflection: number;
  /** Refuse a bare box/cylinder/sphere that stands in for a featureful request. */
  rejectTrivialPrimitive: boolean;
  llm: CadLlmConfig;
}

type Env = Record<string, string | undefined>;

function envInt(env: Env, key: string, fallback: number, min: number, max: number): number {
  const raw = env[key];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${key} must be an integer between ${min} and ${max}.`);
  }
  return value;
}

/** Float settings that must stay finite and inside a sane range for the CLI. */
function envNumber(env: Env, key: string, fallback: number, min: number, max: number): number {
  const raw = env[key];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${key} must be a number between ${min} and ${max}.`);
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

const trimSlash = (value: string): string => value.replace(/\/+$/, "");

/** Providers whose API is OpenAI-compatible — the only kind MAC can talk to. */
const COMPATIBLE_PROVIDERS: ProviderName[] = ["openai", "gemini", "ollama"];

/**
 * Point MAC at whichever OpenAI-compatible endpoint Forge already routes to
 * (Prompt 3's provider router), unless FORGE_CAD_* overrides say otherwise.
 *
 * Gemini needs its dedicated OpenAI-compatibility path appended; Ollama needs
 * no key at all, so a placeholder is supplied because the sidecar's `/api/run`
 * rejects an empty `api_key` field.
 */
export function resolveCadLlm(env: Env, agent?: AgentServerConfig): CadLlmConfig {
  const explicitBaseUrl = env.FORGE_CAD_BASE_URL?.trim();
  const model = env.FORGE_CAD_MODEL?.trim();
  const apiKey = env.FORGE_CAD_API_KEY?.trim();
  if (explicitBaseUrl) {
    const provider = apiKey ? "FORGE_CAD_BASE_URL" : "FORGE_CAD_BASE_URL (no key)";
    return {
      baseUrl: trimSlash(explicitBaseUrl),
      model: model || "qwen3-coder:32b",
      aiderModel: `${apiKey ? "openai/" : "ollama/"}${model || "qwen3-coder:32b"}`,
      ...(apiKey ? { apiKey } : {}),
      provider,
    };
  }
  const config = agent ?? safeLoadConfig();
  const order: ProviderName[] = (() => {
    if (!env.FORGE_CAD_PROVIDER) return config.providerOrder;
    const names = env.FORGE_CAD_PROVIDER.split(",").map((name) => name.trim()).filter(Boolean);
    const known: ProviderName[] = ["anthropic", "openai", "gemini", "ollama", "bedrock"];
    if (names.some((name) => !known.includes(name as ProviderName))) {
      throw new Error("FORGE_CAD_PROVIDER must list anthropic, openai, gemini, ollama and/or bedrock.");
    }
    return names as ProviderName[];
  })();
  for (const name of order) {
    if (!COMPATIBLE_PROVIDERS.includes(name)) continue;
    const provider = config.providers[name];
    if (!provider?.baseUrl) continue;
    if (name === "ollama") {
      // Local, free, keyless. MAC still requires a non-empty api_key field.
      return {
        baseUrl: trimSlash(provider.baseUrl.endsWith("/v1") ? provider.baseUrl : `${provider.baseUrl}/v1`),
        model: model || provider.model,
        aiderModel: `ollama/${model || provider.model}`,
        apiKey: "ollama",
        provider: `ollama (${env.OLLAMA_BASE_URL ?? "http://localhost:11434"})`,
      };
    }
    if (!provider.apiKey) continue;                    // would 401 on every stage
    if (name === "gemini") {
      const base = trimSlash(provider.baseUrl);
      const compatible = base.includes("/openai") ? base : `${base}/openai`;
      return {
        baseUrl: compatible,
        model: model || provider.model,
        aiderModel: `openai/${model || provider.model}`,
        apiKey: provider.apiKey,
        provider: `gemini (${compatible})`,
      };
    }
    return {
      baseUrl: trimSlash(provider.baseUrl),
      model: model || provider.model,
      aiderModel: `openai/${model || provider.model}`,
      apiKey: provider.apiKey,
      provider: `${name} (${provider.baseUrl})`,
    };
  }
  // Nothing usable. Forge does NOT quietly pick a fallback endpoint here: a CAD
  // run that silently billed some other provider would be worse than one that
  // refuses. The shape stays valid so the pipeline can report *why* it refused
  // instead of throwing during config loading.
  return {
    baseUrl: env.FORGE_CAD_BASE_URL?.trim() || "http://127.0.0.1:11434/v1",
    model: model || "qwen3-coder:32b",
    aiderModel: `ollama/${model || "qwen3-coder:32b"}`,
    provider: "no OpenAI-compatible provider in PROVIDER_ORDER (set FORGE_CAD_BASE_URL/FORGE_CAD_MODEL/"
      + "FORGE_CAD_API_KEY, or put openai, gemini or ollama into PROVIDER_ORDER)",
  };
}

function safeLoadConfig(): AgentServerConfig {
  try {
    return loadConfig();
  } catch {
    // A half-configured Forge .env must not make CAD config unreadable; the
    // router's own values simply fall back to the Ollama default below.
    return { providerOrder: ["ollama"], providers: {
      anthropic: { baseUrl: "", model: "" }, openai: { baseUrl: "https://api.openai.com/v1", model: "gpt-4o" },
      gemini: { baseUrl: "", model: "" }, ollama: { baseUrl: "http://localhost:11434", model: "qwen3-coder:32b" },
      bedrock: { baseUrl: "", model: "" },
    } } as unknown as AgentServerConfig;
  }
}

export function loadCadConfig(env: Env = serverEnv(), agent?: AgentServerConfig): CadConfig {
  const provider = resolveCadLlm(env, agent);
  return {
    enabled: envFlag(env, "FORGE_CAD_ENABLED", true),
    macBaseUrl: trimSlash(env.FORGE_CAD_MAC_URL?.trim() || "http://127.0.0.1:8000"),
    requestTimeoutMs: envInt(env, "FORGE_CAD_REQUEST_TIMEOUT_MS", 30_000, 1_000, 300_000),
    jobTimeoutMs: envInt(env, "FORGE_CAD_JOB_TIMEOUT_MS", 900_000, 30_000, 3_600_000),
    pollIntervalMs: envInt(env, "FORGE_CAD_POLL_INTERVAL_MS", 2_000, 250, 60_000),
    attemptBudget: envInt(env, "FORGE_CAD_ATTEMPT_BUDGET", 3, 1, 10),
    artifactDir: resolve(env.FORGE_CAD_ARTIFACT_DIR?.trim() || resolve(homedir(), ".forge", "cad")),
    searchEnabled: envFlag(env, "FORGE_CAD_SEARCH", true),
    searchMaxResults: envInt(env, "FORGE_CAD_SEARCH_MAX_RESULTS", 8, 1, 10),
    maxDownloadBytes: envInt(env, "FORGE_CAD_MAX_DOWNLOAD_BYTES", 64 * 1_048_576, 1_024, 512 * 1_048_576),
    downloadTimeoutMs: envInt(env, "FORGE_CAD_DOWNLOAD_TIMEOUT_MS", 90_000, 1_000, 600_000),
    cascadeBin: env.FORGE_CAD_OCCT_BIN?.trim() || "opencascade-tools",
    cascadeTimeoutMs: envInt(env, "FORGE_CAD_OCCT_TIMEOUT_MS", 180_000, 5_000, 900_000),
    cascadeLinDeflection: envNumber(env, "FORGE_CAD_OCCT_LIN_DEFLECTION", 0.25, 0.001, 100),
    cascadeAngDeflection: envNumber(env, "FORGE_CAD_OCCT_ANG_DEFLECTION", 0.35, 0.001, 100),
    rejectTrivialPrimitive: envFlag(env, "FORGE_CAD_TRIVIAL_PRIMITIVE_GUARD", true),
    llm: provider,
  };
}
