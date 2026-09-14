import type {
  BedrockConfig, ProviderAdapter, ProviderRequest, ProviderResponse, ProviderStreamEvent,
  ProviderToolCall, ProviderToolCallAccumulator, ToolDefinition,
} from "@forge/shared";
import { ProviderHttpError, array, argumentsObject, callId, consumeCompletion, object, text } from "./http";
import { decodeEventStream, eventHeaderString, eventPayloadJson } from "./aws/eventStream";
import { hasAwsAuth, resolveAwsAuth, type AwsAuth } from "./aws/credentials";
import { signRequest } from "./aws/sigv4";

/**
 * Amazon Bedrock provider, using the model-agnostic **Converse** API
 * (`POST /model/{modelId}/converse` and `/converse-stream`) rather than the
 * per-vendor InvokeModel payloads — one request/response shape works for
 * Claude, Nova, Llama, Mistral and Cohere models alike.
 *
 * Auth: `AWS_BEARER_TOKEN_BEDROCK` (Bedrock API key) when set, otherwise
 * SigV4 with credentials from the environment or the user's AWS profile.
 * Streaming responses arrive as AWS event-stream binary frames, decoded in
 * providers/aws/eventStream.ts.
 */

const SERVICE = "bedrock";
const STOP_REASONS = ["end_turn", "tool_use", "stop_sequence"];

class BedrockHttpError extends ProviderHttpError {
  constructor(status: number, detail?: string) {
    super(status);
    // Bedrock error bodies carry a short `message` (validation/throttle text).
    // It never echoes request content or credentials, so it is safe to surface.
    if (detail) this.message = `Bedrock returned HTTP ${status}: ${detail}`;
  }
}

export function bedrockAvailable(config: BedrockConfig): boolean {
  return hasAwsAuth({
    ...(config.accessKeyId ? { accessKeyId: config.accessKeyId } : {}),
    ...(config.secretAccessKey ? { secretAccessKey: config.secretAccessKey } : {}),
    ...(config.sessionToken ? { sessionToken: config.sessionToken } : {}),
    ...(config.bearerToken ? { bearerToken: config.bearerToken } : {}),
    ...(config.profile ? { profile: config.profile } : {}),
  });
}

/** Converse `toolSpec.inputSchema.json` accepts plain JSON Schema, but rejects
 *  a few keywords zod emits; strip them recursively. */
function sanitizeSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeSchema);
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (key === "additionalProperties" || key === "$schema") continue;
    out[key] = sanitizeSchema(item);
  }
  return out;
}

function toolConfig(tools: ToolDefinition[]): Record<string, unknown> {
  return {
    tools: tools.map((tool) => ({
      toolSpec: {
        name: tool.name,
        ...(tool.description ? { description: tool.description } : {}),
        inputSchema: { json: sanitizeSchema(tool.parameters) },
      },
    })),
    toolChoice: { auto: {} },
  };
}

/** Bedrock tool-use ids must be `[a-zA-Z0-9_-]{1,64}`; remap anything else. */
function normalizeToolUseId(id: string, map: Map<string, string>): string {
  if (/^[a-zA-Z0-9_-]{1,64}$/.test(id)) return id;
  const existing = map.get(id);
  if (existing) return existing;
  let hash = 2166136261;
  for (const char of id) { hash ^= char.charCodeAt(0); hash = Math.imul(hash, 16777619); }
  const replacement = `forge-${(hash >>> 0).toString(36)}`.slice(0, 64);
  map.set(id, replacement);
  return replacement;
}

interface ConverseMessage { role: "user" | "assistant"; content: Record<string, unknown>[] }

function toConverseMessages(request: ProviderRequest): {
  system: Record<string, unknown>[];
  messages: ConverseMessage[];
} {
  const system: Record<string, unknown>[] = [];
  const messages: ConverseMessage[] = [];
  const idMap = new Map<string, string>();
  const push = (role: "user" | "assistant", blocks: Record<string, unknown>[]): void => {
    if (!blocks.length) return;
    const previous = messages.at(-1);
    if (previous?.role === role) previous.content.push(...blocks);
    else messages.push({ role, content: blocks });
  };
  for (const message of request.messages) {
    if (message.role === "system") {
      if (message.content) system.push({ text: message.content });
      continue;
    }
    if (message.role === "tool") {
      push("user", [{
        toolResult: {
          toolUseId: normalizeToolUseId(message.toolCallId ?? "", idMap),
          content: [{ text: message.content || "(no output)" }],
          status: "success",
        },
      }]);
      continue;
    }
    const blocks: Record<string, unknown>[] = [];
    if (message.content) blocks.push({ text: message.content });
    if (message.role === "assistant") {
      for (const call of message.toolCalls ?? []) {
        blocks.push({
          toolUse: {
            toolUseId: normalizeToolUseId(call.id, idMap),
            name: call.name,
            input: call.args && Object.keys(call.args).length ? call.args : {},
          },
        });
      }
    }
    push(message.role === "assistant" ? "assistant" : "user", blocks);
  }
  return { system, messages };
}

function converseBody(request: ProviderRequest): Record<string, unknown> {
  const { system, messages } = toConverseMessages(request);
  if (!messages.length) throw new Error("Bedrock Converse requires at least one message.");
  return {
    messages,
    ...(system.length ? { system } : {}),
    ...(request.tools.length ? { toolConfig: toolConfig(request.tools) } : {}),
    inferenceConfig: { maxTokens: request.maxTokens ?? 4096 },
  };
}

function extractResponse(payload: Record<string, unknown>): { content: string; toolCalls: ProviderToolCall[]; stopReason: string } {
  const message = object(object(payload.output ?? {}).message ?? {});
  let content = "";
  const toolCalls: ProviderToolCall[] = [];
  for (const value of array(message.content)) {
    const block = object(value);
    if (text(block.text)) content += text(block.text);
    if (block.toolUse) {
      const toolUse = object(block.toolUse);
      toolCalls.push({
        id: text(toolUse.toolUseId) || callId(),
        name: text(toolUse.name),
        args: argumentsObject(toolUse.input),
      });
    }
  }
  return { content, toolCalls, stopReason: text(payload.stopReason) };
}

async function errorDetail(response: Response): Promise<string | undefined> {
  try {
    const body = await response.text();
    if (!body) return undefined;
    let parsed: unknown;
    try { parsed = JSON.parse(body.slice(0, 4096)); } catch { return body.slice(0, 200); }
    const message = text(object(parsed).message);
    return (message || body).slice(0, 200);
  } catch { return undefined; }
}

export class BedrockProvider implements ProviderAdapter {
  readonly name = "bedrock" as const;
  private cachedAuth: AwsAuth | null = null;

  constructor(private readonly config: BedrockConfig) {}

  complete(request: ProviderRequest): Promise<ProviderResponse> {
    return consumeCompletion(this.streamComplete(request));
  }

  private async auth(signal?: AbortSignal): Promise<AwsAuth> {
    signal?.throwIfAborted();
    const cached = this.cachedAuth;
    if (cached && (!cached.expiresAt || cached.expiresAt - 60_000 > Date.now())) return cached;
    const resolved = await resolveAwsAuth({
      ...(this.config.accessKeyId ? { accessKeyId: this.config.accessKeyId } : {}),
      ...(this.config.secretAccessKey ? { secretAccessKey: this.config.secretAccessKey } : {}),
      ...(this.config.sessionToken ? { sessionToken: this.config.sessionToken } : {}),
      ...(this.config.bearerToken ? { bearerToken: this.config.bearerToken } : {}),
      ...(this.config.profile ? { profile: this.config.profile } : {}),
    });
    this.cachedAuth = resolved;
    return resolved;
  }

  /** Signed (or bearer-authenticated) fetch to the Converse endpoint. */
  private async send(operation: "converse" | "converse-stream", body: string, signal?: AbortSignal): Promise<Response> {
    const auth = await this.auth(signal);
    signal?.throwIfAborted();
    const url = `${this.config.baseUrl.replace(/\/$/, "")}/model/${this.config.model}/${operation}`;
    const accept = operation === "converse-stream" ? "application/vnd.amazon.eventstream" : "application/json";
    if (auth.kind === "bearer") {
      return fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", accept, authorization: `Bearer ${auth.bearerToken}` },
        body, signal, redirect: "error",
      });
    }
    const signed = signRequest({
      method: "POST", url, body, region: this.config.region, service: SERVICE,
      headers: { "content-type": "application/json", accept },
      credentials: auth.credentials!,
    });
    return fetch(signed.url, { method: "POST", headers: signed.headers, body: signed.body, signal, redirect: "error" });
  }

  async *streamComplete(request: ProviderRequest): AsyncGenerator<ProviderStreamEvent> {
    const body = JSON.stringify(converseBody(request));
    if (!this.config.streaming) {
      yield* this.nonStreaming(body, request.signal);
      return;
    }
    const response = await this.send("converse-stream", body, request.signal);
    if (!response.ok) throw new BedrockHttpError(response.status, await errorDetail(response));
    if (!response.body) throw new Error("Bedrock returned no response body.");

    let content = "";
    let stopReason = "";
    let stopped = false;
    const calls = new Map<number, ProviderToolCallAccumulator>();
    for await (const frame of decodeEventStream(response.body)) {
      request.signal?.throwIfAborted();
      if (eventHeaderString(frame, ":message-type") === "exception") {
        const type = eventHeaderString(frame, ":exception-type") || "exception";
        const detail = text(object(eventPayloadJson(frame) ?? {}).message);
        throw new Error(`Bedrock stream ${type}${detail ? `: ${detail.slice(0, 200)}` : "."}`);
      }
      const event = eventPayloadJson(frame);
      if (!event) continue;

      if (event.contentBlockStart) {
        const start = object(event.contentBlockStart);
        const index = Number(start.contentBlockIndex ?? 0);
        const block = object(start.start ?? {});
        if (block.toolUse) {
          const toolUse = object(block.toolUse);
          calls.set(index, { id: text(toolUse.toolUseId) || callId(), name: text(toolUse.name), argumentsJson: "" });
        } else if (text(block.text)) {
          content += text(block.text);
          yield { type: "text", delta: text(block.text) };
        }
      } else if (event.contentBlockDelta) {
        const deltaEvent = object(event.contentBlockDelta);
        const index = Number(deltaEvent.contentBlockIndex ?? 0);
        const delta = object(deltaEvent.delta ?? {});
        if (text(delta.text)) {
          content += text(delta.text);
          yield { type: "text", delta: text(delta.text) };
        }
        if (delta.toolUse) {
          const call = calls.get(index);
          if (!call) throw new Error("Bedrock tool input delta has no matching content block.");
          call.argumentsJson += text(object(delta.toolUse).input);
          if (call.argumentsJson.length > 2_097_152) throw new Error("Tool arguments are too large.");
        }
        // `reasoningContent` deltas are internal to thinking models: ignored,
        // exactly like Gemini's `thought` parts.
      } else if (event.messageDelta) {
        stopReason = text(object(event.messageDelta).stopReason);
      } else if (event.messageStop) {
        stopped = true;
      }
    }
    if (!stopped) throw new Error("Bedrock stream ended before messageStop.");
    if (!STOP_REASONS.includes(stopReason)) {
      throw new Error(`Bedrock stopped for reason "${stopReason || "unknown"}" (response truncated or filtered).`);
    }
    const toolCalls = [...calls.entries()].sort(([a], [b]) => a - b).map(([, call]) => ({
      id: call.id, name: call.name,
      args: call.argumentsJson ? argumentsObject(call.argumentsJson) : {},
    }));
    if (toolCalls.some((call) => !call.name) || (!content && !toolCalls.length)) {
      throw new Error("Bedrock returned an empty response.");
    }
    yield { type: "complete", response: { content, toolCalls } };
  }

  private async *nonStreaming(body: string, signal?: AbortSignal): AsyncGenerator<ProviderStreamEvent> {
    const response = await this.send("converse", body, signal);
    if (!response.ok) throw new BedrockHttpError(response.status, await errorDetail(response));
    const payload = object(await response.json());
    const { content, toolCalls, stopReason } = extractResponse(payload);
    if (!STOP_REASONS.includes(stopReason)) {
      throw new Error(`Bedrock stopped for reason "${stopReason || "unknown"}" (response truncated or filtered).`);
    }
    if (toolCalls.some((call) => !call.name) || (!content && !toolCalls.length)) {
      throw new Error("Bedrock returned an empty response.");
    }
    if (content) yield { type: "text", delta: content };
    yield { type: "complete", response: { content, toolCalls } };
  }
}
