/**
 * Environment configuration.
 *
 * Every credential, model id and tunable comes from the environment — nothing
 * is hardcoded. Server only: never import this from a client component.
 */

import { z } from 'zod';

import { parseDnsResultOrder, type DnsResultOrder } from '@/lib/net/dns';

const optionalString = z
  .string()
  .transform((value) => (value.trim().length === 0 ? undefined : value.trim()))
  .optional()
  .or(z.literal('').transform(() => undefined));

const intFrom = (fallback: number) =>
  z
    .string()
    .optional()
    .transform((value) => {
      if (value === undefined || value.trim() === '') return fallback;
      const parsed = Number.parseInt(value.trim(), 10);
      return Number.isFinite(parsed) ? parsed : fallback;
    });

const floatFrom = (fallback: number) =>
  z
    .string()
    .optional()
    .transform((value) => {
      if (value === undefined || value.trim() === '') return fallback;
      const parsed = Number.parseFloat(value.trim());
      return Number.isFinite(parsed) ? parsed : fallback;
    });

const boolFrom = (fallback: boolean) =>
  z
    .string()
    .optional()
    .transform((value) => {
      if (value === undefined || value.trim() === '') return fallback;
      const normalised = value.trim().toLowerCase();
      if (['true', '1', 'yes', 'on'].includes(normalised)) return true;
      if (['false', '0', 'no', 'off'].includes(normalised)) return false;
      return fallback;
    });

const ServerEnvSchema = z.object({
  // --- MongoDB ---
  MONGODB_URI: optionalString,
  MONGODB_DB: z.string().optional().transform((v) => (v && v.trim() ? v.trim() : 'wireup')),
  // `auto` (default): use Mongo when MONGODB_URI is set, otherwise run on the
  // in-process store (loudly). `true`/`false` force one side explicitly.
  WIREUP_IN_MEMORY_STORE: z
    .string()
    .optional()
    .transform((v) => {
      const normalised = v?.trim().toLowerCase();
      if (normalised === 'true' || normalised === '1' || normalised === 'yes' || normalised === 'on') return 'memory';
      if (normalised === 'false' || normalised === '0' || normalised === 'no' || normalised === 'off') return 'mongo';
      return 'auto';
    }),

  // --- Amazon Bedrock ---
  AWS_REGION: z.string().optional().transform((v) => (v && v.trim() ? v.trim() : 'us-east-1')),
  AWS_ACCESS_KEY_ID: optionalString,
  AWS_SECRET_ACCESS_KEY: optionalString,
  AWS_SESSION_TOKEN: optionalString,
  BEDROCK_MODEL_ID: optionalString,
  BEDROCK_VALIDATION_MODEL_ID: optionalString,
  BEDROCK_FIXER_MODEL_ID: optionalString,
  BEDROCK_CODEGEN_MODEL_ID: optionalString,
  BEDROCK_MAX_TOKENS: intFrom(8000),
  // Upper bound the structured caller may raise maxTokens to after a response
  // is cut short (stopReason "max_tokens"). Kimi K2.5 caps output at 16k.
  BEDROCK_MAX_TOKENS_CEILING: intFrom(16_000),
  BEDROCK_TEMPERATURE: floatFrom(0.2),
  BEDROCK_TOP_P: floatFrom(0.9),
  BEDROCK_TIMEOUT_MS: intFrom(120_000),
  BEDROCK_MAX_RETRIES: intFrom(2),

  // --- Direct model APIs (optional; Bedrock stays the default transport) ---
  // When set AND the routed model id matches the family, calls go direct
  // (Astra: OpenAI Responses; Fable: Anthropic Messages). Otherwise the same
  // model ids are served through Bedrock Converse.
  OPENAI_API_KEY: optionalString,
  ANTHROPIC_API_KEY: optionalString,
  GEMINI_API_KEY: optionalString,

  // Reasoning effort per operation for the Astra/Fable families
  // (low|medium|high|xhigh|max; generic models ignore these).
  WIREUP_MODEL_EFFORT_EXPANSION: optionalString,
  WIREUP_MODEL_EFFORT_R2: optionalString,
  WIREUP_MODEL_EFFORT_REVIEW: optionalString,
  WIREUP_MODEL_EFFORT_VALIDATION: optionalString,
  WIREUP_MODEL_EFFORT_FIX: optionalString,

  // Run the continuation pass as a StateGraph (checkpoints + steer folding
  // at node boundaries). Default on; any error falls back to the legacy
  // path, so this flag can never break the build.
  WIREUP_ENABLE_GRAPH_PASS: boolFrom(true),

  // --- Agent behaviour ---
  WIREUP_MAX_FIX_ITERATIONS: intFrom(3),
  WIREUP_ENABLE_LLM_FIXER: boolFrom(true),
  WIREUP_ENABLE_LLM_VALIDATION: boolFrom(true),
  // AI-first firmware authoring: the model writes the sketch logic against the
  // grounded pin plan; the rooting gate keeps the managed blocks authoritative
  // and falls back to the deterministic template on any violation.
  WIREUP_ENABLE_LLM_CODEGEN: boolFrom(true),
  // Host compile gate: type-check generated/edited firmware against the stub
  // Arduino core with g++/clang++ before a revision is frozen. Skipped
  // honestly when no compiler is on PATH.
  WIREUP_ENABLE_FIRMWARE_COMPILE: boolFrom(true),
  // Real simulation loop: cross-compile to AVR/ESP machine code with
  // arduino-cli and execute in avr8js emulator. Validates actual peripheral
  // behavior, not just type-checking. Default off until proven stable.
  WIREUP_ENABLE_REAL_SIM_LOOP: boolFrom(false),
  // Max iterations for the real sim validation (separate from fix iterations
  // because real AVR execution is expensive).
  WIREUP_MAX_SIM_ITERATIONS: intFrom(2),
  // Wall-clock timeout per simulation run (ms) to prevent infinite loops.
  WIREUP_SIM_TIMEOUT_MS: intFrom(30_000),
  WIREUP_AUTOSEED_COMPONENTS: boolFrom(true),
  WIREUP_MAX_REVISIONS: intFrom(12),
  WIREUP_MAX_EVENTS: intFrom(1500),

  // --- Everflow (the iteration loop over the project graph) ---
  // Passes per trigger before the loop yields (each pass is idempotent and
  // small; the loop also stops as soon as it stops making progress).
  WIREUP_EVERFLOW_MAX_PASSES: intFrom(3),
  // Open human-channel tasks allowed per project before new asks stay parked.
  WIREUP_EVERFLOW_MAX_HUMAN_TASKS: intFrom(12),
  // Act phase: the loop's own engineering moves inside a pass (revalidate a
  // drifted design, reprove behaviour in the emulator, run a targeted fix
  // pass) BEFORE it files asks — humans are asked only what the loop could
  // not close itself. Every move is fingerprint-guarded, budgeted, recorded
  // and offline-complete; switching this off restores the ask-only loop.
  WIREUP_ENABLE_EVERFLOW_ACTIONS: boolFrom(true),
  // BACKSTOP on loop-driven fix passes per project (never the normal way work
  // finishes; the build's own fix loop and the idea ladder repair first).
  WIREUP_EVERFLOW_MAX_REPAIRS: intFrom(2),
  // BACKSTOP on behavioural re-runs per project (the fingerprint guard, not
  // this cap, is what normally stops repeats).
  WIREUP_EVERFLOW_MAX_REPROOFS: intFrom(3),
  // Research tool: allow the agent to pull a snippet from the cited page
  // (best-effort; offline sources always work and web findings are flagged
  // for human review).
  WIREUP_ENABLE_WEB_DOCS: boolFrom(true),
  WIREUP_WEB_DOCS_TIMEOUT_MS: intFrom(4000),

  // --- Idea graph (recursive decomposition + per-node tests + reviewer + swarm) ---
  // Master switch. When off, the everflow loop behaves exactly as before.
  WIREUP_ENABLE_IDEA_GRAPH: boolFrom(true),
  // BACKSTOP on total expansions (never the normal way the graph finishes):
  // hitting it files an ask and says so out loud.
  WIREUP_IDEA_GRAPH_MAX_EXPANSIONS: intFrom(40),
  // Targeted repairs allowed per node before the ladder escalates to a
  // left-drawer ask (default-on-expiry: defer).
  WIREUP_IDEA_GRAPH_MAX_NODE_REPAIRS: intFrom(2),
  // Tier-2 mid-turn steering: only ever active when the configured model is
  // gpt-6-astra; the default persisted (Tier-1) path is guarded and can
  // never be broken by this flag.
  WIREUP_ENABLE_MID_TURN_STEER: boolFrom(false),
  // Optional per-swarm-role model overrides (fall back to the shared
  // validation model, then the main model — never to a silently different
  // model).
  WIREUP_SWARM_ROLE_MODEL_HARDWARE: optionalString,
  WIREUP_SWARM_ROLE_MODEL_FIRMWARE: optionalString,
  WIREUP_SWARM_ROLE_MODEL_WEB: optionalString,
  WIREUP_SWARM_ROLE_MODEL_MECHANICS: optionalString,

  // --- Networking ---
  WIREUP_DNS_RESULT_ORDER: optionalString,

  // --- Terminal ---
  // Path-delimiter-separated folders the terminal feature may run in.
  // Defaults to cwd + homedir if not set. Use this to add any folder.
  // Windows: "C:\\Projects;D:\\Work"  Unix: "/home/you/projects:/home/you"
  WIREUP_TERMINAL_ROOTS: optionalString,
  // Master switch for terminal feature (default: enabled)
  WIREUP_TERMINAL_ENABLED: boolFrom(true),
  // Allow freeform folder entry vs picker-only (default: false)
  WIREUP_TERMINAL_FREEFORM: boolFrom(false),
  // Max concurrent terminal sessions (default: 3, max: 16)
  WIREUP_TERMINAL_MAX_SESSIONS: intFrom(3),
  // Max lines per session buffer (default: 6000, max: 50000)
  WIREUP_TERMINAL_MAX_LINES: intFrom(6000),

  NODE_ENV: z.string().optional().transform((v) => v ?? 'development'),
});

export interface ServerEnv {
  models: {
    openaiApiKey?: string;
    anthropicApiKey?: string;
    geminiApiKey?: string;
    effortExpansion?: string;
    effortR2?: string;
    effortReview?: string;
    effortValidation?: string;
    effortFix?: string;
    enableGraphPass: boolean;
  };
  mongodb: {
    uri: string;
    dbName: string;
  };
  store: {
    /** `memory` = in-process store (data lost on restart, stated everywhere). */
    mode: 'mongo' | 'memory';
    /** True when memory mode came from the auto default rather than an explicit opt-in. */
    autoSelected: boolean;
  };
  bedrock: {
    region: string;
    accessKeyId?: string;
    secretAccessKey?: string;
    sessionToken?: string;
    modelId?: string;
    validationModelId?: string;
    fixerModelId?: string;
    codegenModelId?: string;
    maxTokens: number;
    maxTokensCeiling: number;
    temperature: number;
    topP: number;
    timeoutMs: number;
    maxRetries: number;
  };
  agent: {
    maxFixIterations: number;
    enableLlmFixer: boolean;
    enableLlmValidation: boolean;
    enableLlmCodegen: boolean;
    enableFirmwareCompile: boolean;
    enableRealSimLoop: boolean;
    maxSimIterations: number;
    simTimeoutMs: number;
    autoseedComponents: boolean;
    maxRevisions: number;
    maxEvents: number;
    everflowMaxPasses: number;
    everflowMaxHumanTasks: number;
    everflowActionsEnabled: boolean;
    everflowMaxRepairs: number;
    everflowMaxReproofs: number;
    webDocsEnabled: boolean;
    webDocsTimeoutMs: number;
    ideaGraphEnabled: boolean;
    ideaGraphMaxExpansions: number;
    ideaGraphMaxNodeRepairs: number;
    enableMidTurnSteer: boolean;
    swarmRoleModels: {
      hardware?: string;
      firmware?: string;
      web?: string;
      mechanics?: string;
    };
  };
  net: {
    dnsResultOrder: DnsResultOrder;
  };
  terminal: {
    roots?: string;
    enabled: boolean;
    freeform: boolean;
    maxSessions: number;
    maxLines: number;
  };
  nodeEnv: string;
}

export class EnvError extends Error {
  readonly missing: string[];

  constructor(missing: string[], detail?: string) {
    super(
      `Wireup is missing required environment configuration: ${missing.join(', ')}. ` +
        `Copy .env.example to .env and fill it in.${detail ? ` ${detail}` : ''}`,
    );
    this.name = 'EnvError';
    this.missing = missing;
  }
}

let cached: ServerEnv | null = null;

function read(): ServerEnv {
  const parsed = ServerEnvSchema.parse(process.env);

  return {
    models: {
      openaiApiKey: parsed.OPENAI_API_KEY,
      anthropicApiKey: parsed.ANTHROPIC_API_KEY,
      geminiApiKey: parsed.GEMINI_API_KEY,
      effortExpansion: parsed.WIREUP_MODEL_EFFORT_EXPANSION,
      effortR2: parsed.WIREUP_MODEL_EFFORT_R2,
      effortReview: parsed.WIREUP_MODEL_EFFORT_REVIEW,
      effortValidation: parsed.WIREUP_MODEL_EFFORT_VALIDATION,
      effortFix: parsed.WIREUP_MODEL_EFFORT_FIX,
      enableGraphPass: parsed.WIREUP_ENABLE_GRAPH_PASS,
    },
    mongodb: {
      uri: parsed.MONGODB_URI ?? '',
      dbName: parsed.MONGODB_DB ?? 'wireup',
    },
    store: {
      mode:
        parsed.WIREUP_IN_MEMORY_STORE === 'memory'
          ? 'memory'
          : parsed.WIREUP_IN_MEMORY_STORE === 'mongo'
            ? 'mongo'
            : parsed.MONGODB_URI && parsed.MONGODB_URI.trim().length > 0
              ? 'mongo'
              : 'memory',
      autoSelected: parsed.WIREUP_IN_MEMORY_STORE === 'auto',
    },
    bedrock: {
      region: parsed.AWS_REGION ?? 'us-east-1',
      accessKeyId: parsed.AWS_ACCESS_KEY_ID,
      secretAccessKey: parsed.AWS_SECRET_ACCESS_KEY,
      sessionToken: parsed.AWS_SESSION_TOKEN,
      modelId: parsed.BEDROCK_MODEL_ID,
      validationModelId: parsed.BEDROCK_VALIDATION_MODEL_ID,
      fixerModelId: parsed.BEDROCK_FIXER_MODEL_ID,
      codegenModelId: parsed.BEDROCK_CODEGEN_MODEL_ID,
      maxTokens: parsed.BEDROCK_MAX_TOKENS,
      maxTokensCeiling: Math.max(parsed.BEDROCK_MAX_TOKENS, parsed.BEDROCK_MAX_TOKENS_CEILING),
      temperature: parsed.BEDROCK_TEMPERATURE,
      topP: parsed.BEDROCK_TOP_P,
      timeoutMs: parsed.BEDROCK_TIMEOUT_MS,
      maxRetries: parsed.BEDROCK_MAX_RETRIES,
    },
    agent: {
      maxFixIterations: Math.max(0, parsed.WIREUP_MAX_FIX_ITERATIONS),
      enableLlmFixer: parsed.WIREUP_ENABLE_LLM_FIXER,
      enableLlmValidation: parsed.WIREUP_ENABLE_LLM_VALIDATION,
      enableLlmCodegen: parsed.WIREUP_ENABLE_LLM_CODEGEN,
      enableFirmwareCompile: parsed.WIREUP_ENABLE_FIRMWARE_COMPILE,
      enableRealSimLoop: parsed.WIREUP_ENABLE_REAL_SIM_LOOP,
      maxSimIterations: Math.max(0, parsed.WIREUP_MAX_SIM_ITERATIONS),
      simTimeoutMs: Math.max(1000, parsed.WIREUP_SIM_TIMEOUT_MS),
      autoseedComponents: parsed.WIREUP_AUTOSEED_COMPONENTS,
      maxRevisions: Math.max(1, parsed.WIREUP_MAX_REVISIONS),
      maxEvents: Math.max(50, parsed.WIREUP_MAX_EVENTS),
      everflowMaxPasses: Math.max(1, parsed.WIREUP_EVERFLOW_MAX_PASSES),
      everflowMaxHumanTasks: Math.max(1, parsed.WIREUP_EVERFLOW_MAX_HUMAN_TASKS),
      everflowActionsEnabled: parsed.WIREUP_ENABLE_EVERFLOW_ACTIONS,
      everflowMaxRepairs: Math.max(0, parsed.WIREUP_EVERFLOW_MAX_REPAIRS),
      everflowMaxReproofs: Math.max(0, parsed.WIREUP_EVERFLOW_MAX_REPROOFS),
      webDocsEnabled: parsed.WIREUP_ENABLE_WEB_DOCS,
      webDocsTimeoutMs: Math.max(500, parsed.WIREUP_WEB_DOCS_TIMEOUT_MS),
      ideaGraphEnabled: parsed.WIREUP_ENABLE_IDEA_GRAPH,
      ideaGraphMaxExpansions: Math.max(1, parsed.WIREUP_IDEA_GRAPH_MAX_EXPANSIONS),
      ideaGraphMaxNodeRepairs: Math.max(0, parsed.WIREUP_IDEA_GRAPH_MAX_NODE_REPAIRS),
      enableMidTurnSteer: parsed.WIREUP_ENABLE_MID_TURN_STEER,
      swarmRoleModels: {
        ...(parsed.WIREUP_SWARM_ROLE_MODEL_HARDWARE ? { hardware: parsed.WIREUP_SWARM_ROLE_MODEL_HARDWARE } : {}),
        ...(parsed.WIREUP_SWARM_ROLE_MODEL_FIRMWARE ? { firmware: parsed.WIREUP_SWARM_ROLE_MODEL_FIRMWARE } : {}),
        ...(parsed.WIREUP_SWARM_ROLE_MODEL_WEB ? { web: parsed.WIREUP_SWARM_ROLE_MODEL_WEB } : {}),
        ...(parsed.WIREUP_SWARM_ROLE_MODEL_MECHANICS ? { mechanics: parsed.WIREUP_SWARM_ROLE_MODEL_MECHANICS } : {}),
      },
    },
    net: {
      dnsResultOrder: parseDnsResultOrder(parsed.WIREUP_DNS_RESULT_ORDER),
    },
    terminal: {
      roots: parsed.WIREUP_TERMINAL_ROOTS,
      enabled: parsed.WIREUP_TERMINAL_ENABLED,
      freeform: parsed.WIREUP_TERMINAL_FREEFORM,
      maxSessions: Math.min(16, Math.max(1, parsed.WIREUP_TERMINAL_MAX_SESSIONS)),
      maxLines: Math.min(50000, Math.max(100, parsed.WIREUP_TERMINAL_MAX_LINES)),
    },
    nodeEnv: parsed.NODE_ENV ?? 'development',
  };
}

/** Cached, validated server environment. */
export function env(): ServerEnv {
  if (!cached) cached = read();
  return cached;
}

/** Force a re-read (used by tests/scripts after mutating process.env). */
export function resetEnvCache(): void {
  cached = null;
}

export function requireMongoEnv(): ServerEnv['mongodb'] {
  const { mongodb } = env();
  if (!mongodb.uri) throw new EnvError(['MONGODB_URI']);
  return mongodb;
}

export function requireBedrockEnv(): ServerEnv['bedrock'] {
  const { bedrock } = env();
  const missing: string[] = [];
  if (!bedrock.modelId) missing.push('BEDROCK_MODEL_ID');
  const hasStaticCreds = Boolean(bedrock.accessKeyId && bedrock.secretAccessKey);
  const hasChainCreds = Boolean(
    process.env.AWS_PROFILE ||
      process.env.AWS_ROLE_ARN ||
      process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI ||
      process.env.AWS_EC2_METADATA_DISABLED,
  );
  if (!hasStaticCreds && !hasChainCreds) {
    missing.push('AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY');
  }
  if (missing.length > 0) {
    throw new EnvError(missing, 'Bedrock calls cannot be made without a model id and credentials.');
  }
  return bedrock;
}

/** Client-safe environment (NEXT_PUBLIC_* only). */
export const publicEnv = {
  appName: process.env.NEXT_PUBLIC_APP_NAME ?? 'Wireup',
};
