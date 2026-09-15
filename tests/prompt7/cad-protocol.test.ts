import { expect, test } from "bun:test";
import { clientMessageSchema } from "../../packages/shared/src/agent-schemas";
import { loadCadConfig, resolveCadLlm } from "../../packages/server/src/cad/config";

/**
 * Prompt 7 wired itself into Prompt 3/4's protocol with exactly two changes:
 * `AgentMode` gained "cad", and the client union gained `cad_generate`. These
 * tests pin both, and pin the things that must NOT have changed — the Ask /
 * Agent / Plan messages validate exactly as before, and a `user_message` in
 * cad mode is still rejected (a text-to-model run is not an agent turn).
 */

test("cad_generate validates, and rejects junk the same way user_message does", () => {
  expect(clientMessageSchema.safeParse({ type: "cad_generate", prompt: "a standard M8 hex bolt" }).success).toBe(true);
  expect(clientMessageSchema.safeParse({ type: "cad_generate", prompt: "   " }).success).toBe(false);
  expect(clientMessageSchema.safeParse({ type: "cad_generate", prompt: "" }).success).toBe(false);
  expect(clientMessageSchema.safeParse({ type: "cad_generate", prompt: "x".repeat(4_001) }).success).toBe(false);
  // strictObject: a CAD request cannot smuggle extra fields into the server.
  expect(clientMessageSchema.safeParse({ type: "cad_generate", prompt: "wheel", mode: "agent" }).success).toBe(false);
});

test("Prompt 4's protocol messages are unaffected by the new mode", () => {
  for (const mode of ["ask", "agent", "plan"]) {
    expect(clientMessageSchema.safeParse({ type: "user_message", content: "hi", mode }).success).toBe(true);
  }
  expect(clientMessageSchema.safeParse({ type: "user_message", content: "hi", mode: "cad" }).success).toBe(false);
  expect(clientMessageSchema.safeParse({ type: "cancel" }).success).toBe(true);
  expect(clientMessageSchema.safeParse({ type: "approve_plan" }).success).toBe(true);
  expect(clientMessageSchema.safeParse({ type: "mcp_reload" }).success).toBe(true);
  expect(clientMessageSchema.safeParse({ type: "init", workspaceRoot: "/tmp/x" }).success).toBe(true);
});

test("a bogus CAD provider is rejected at config time, not silently ignored", () => {
  expect(() => loadCadConfig({ FORGE_CAD_PROVIDER: "gpt4all" } as never)).toThrow(/must list anthropic, openai, gemini, ollama and\/or bedrock/);
  // Deflection values reach the CLI as-is, so garbage is refused too.
  expect(() => loadCadConfig({ FORGE_CAD_OCCT_LIN_DEFLECTION: "wide" } as never)).toThrow(/FORGE_CAD_OCCT_LIN_DEFLECTION/);
});

test("CAD config defaults to the documented local sidecar and a 3-attempt budget", () => {
  const config = loadCadConfig({ FORGE_CAD_MAC_URL: "", FORGE_CAD_ARTIFACT_DIR: "" } as NodeJS.ProcessEnv);
  expect(config.macBaseUrl).toBe("http://127.0.0.1:8000");
  expect(config.attemptBudget).toBe(3);
  expect(config.artifactDir).toBe(`${process.env.HOME}/.forge/cad`);
  expect(config.cascadeBin).toBe("opencascade-tools");
  expect(config.searchEnabled).toBe(true);
  expect(config.rejectTrivialPrimitive).toBe(true);
  expect(() => loadCadConfig({ FORGE_CAD_ATTEMPT_BUDGET: "0" } as NodeJS.ProcessEnv)).toThrow(/between 1 and 10/);
  expect(() => loadCadConfig({ FORGE_CAD_ENABLED: "sometimes" } as NodeJS.ProcessEnv)).toThrow(/boolean/);
});

test("MAC is pointed at whichever OpenAI-compatible endpoint Forge already routes to", () => {
  const agentConfig = {
    providerOrder: ["anthropic", "openai", "gemini", "ollama"],
    providers: {
      anthropic: { baseUrl: "https://api.anthropic.com", model: "claude" },
      openai: { baseUrl: "https://api.openai.com/v1", model: "gpt-4o", apiKey: "sk-openai" },
      gemini: { baseUrl: "https://generativelanguage.googleapis.com/v1beta", model: "gemini-2.5-flash", apiKey: "g-key" },
      ollama: { baseUrl: "http://localhost:11434", model: "qwen3-coder:32b" },
      bedrock: { baseUrl: "", model: "" },
    },
  } as never;

  const openai = resolveCadLlm({}, agentConfig);
  expect(openai.baseUrl).toBe("https://api.openai.com/v1");
  expect(openai.model).toBe("gpt-4o");
  expect(openai.apiKey).toBe("sk-openai");
  expect(openai.aiderModel).toBe("openai/gpt-4o");

  // Anthropic/Bedrock are not OpenAI-compatible, so an order that lists only
  // those falls to Gemini's OpenAI-compat path, then Ollama.
  const gemini = resolveCadLlm({ FORGE_CAD_PROVIDER: "anthropic,gemini" } as never, agentConfig);
  expect(gemini.baseUrl).toBe("https://generativelanguage.googleapis.com/v1beta/openai");
  expect(gemini.model).toBe("gemini-2.5-flash");

  const ollama = resolveCadLlm({ FORGE_CAD_PROVIDER: "ollama" } as never, agentConfig);
  expect(ollama.baseUrl).toBe("http://localhost:11434/v1");
  expect(ollama.apiKey).toBe("ollama");            // keyless, but /api/run needs a value

  const explicit = resolveCadLlm({
    FORGE_CAD_BASE_URL: "https://api.deepseek.com/v1", FORGE_CAD_MODEL: "deepseek-chat", FORGE_CAD_API_KEY: "ds-key",
  } as never, agentConfig);
  expect(explicit.baseUrl).toBe("https://api.deepseek.com/v1");
  expect(explicit.model).toBe("deepseek-chat");
  expect(explicit.apiKey).toBe("ds-key");

  // Nothing compatible at all: still a usable object, with a message naming the
  // real setting to fix (never a crash at config time).
  const nothing = resolveCadLlm({} as never, {
    providerOrder: ["anthropic"], providers: { anthropic: { baseUrl: "https://api.anthropic.com", model: "claude" } },
  } as never);
  expect(nothing.provider).toContain("no OpenAI-compatible provider");
  // Refusing beats guessing: no key means the pipeline never contacts a model.
  expect(nothing.apiKey).toBeUndefined();
  const config = loadCadConfig({} as never, {
    providerOrder: ["anthropic"], providers: { anthropic: { baseUrl: "https://api.anthropic.com", model: "claude" } },
  } as never);
  expect(config.llm.apiKey).toBeUndefined();
});

test("the sidecar's per-job config maps Forge's budget onto MAC's own retry loop", async () => {
  const { macJobConfig } = await import("../../packages/server/src/cad/macClient");
  const base = loadCadConfig({ FORGE_CAD_ATTEMPT_BUDGET: "3" } as NodeJS.ProcessEnv);
  const job = macJobConfig({ ...base, llm: { ...base.llm, baseUrl: "https://api.openai.com/v1", model: "gpt-4o" } });
  expect(job.MAX_RETRIES).toBe(2);          // 3 total attempts = first pass + 2 repairs
  expect(job.WORKFLOW_ID).toBe("original");
  expect(job.CODER_MODEL).toBe("gpt-4o");
  expect(job.SPEC_PLANNER_KWARGS).toEqual({});
});
