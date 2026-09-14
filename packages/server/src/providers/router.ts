import type {
  AgentServerConfig, ProviderAdapter, ProviderName, ProviderRequest, ProviderResponse, ProviderStreamEvent,
} from "@forge/shared";
import { AnthropicProvider } from "./anthropic";
import { OpenAIProvider } from "./openai";
import { GeminiProvider } from "./gemini";
import { OllamaProvider } from "./ollama";
import { consumeCompletion, ProviderHttpError } from "./http";

export class ProviderRouter implements ProviderAdapter {
  readonly name = "router" as const;
  constructor(private readonly adapters: ProviderAdapter[], private readonly timeoutMs = 120_000) {
    if (!adapters.length) throw new Error("No providers configured. Set an API key or include ollama in PROVIDER_ORDER.");
  }

  complete(request: ProviderRequest): Promise<ProviderResponse> {
    return consumeCompletion(this.streamComplete(request));
  }

  async *streamComplete(request: ProviderRequest): AsyncGenerator<ProviderStreamEvent> {
    const failures: string[] = [];
    for (const adapter of this.adapters) {
      request.signal?.throwIfAborted();
      const controller = new AbortController();
      const abort = () => controller.abort(request.signal?.reason);
      request.signal?.addEventListener("abort", abort, { once: true });
      const timer = setTimeout(() => controller.abort(new Error("Provider request timed out.")), this.timeoutMs);
      let emitted = false;
      try {
        for await (const event of adapter.streamComplete({ ...request, signal: controller.signal })) {
          request.signal?.throwIfAborted();
          if (event.type === "text" && event.delta) emitted = true;
          if (event.type === "complete") {
            // Never hand malformed, duplicate, or unexpected tool calls to the loop.
            const ids = new Set(event.response.toolCalls.map((call) => call.id));
            if (ids.size !== event.response.toolCalls.length) throw new Error("Duplicate provider tool call IDs.");
            if (!request.tools.length && event.response.toolCalls.length) throw new Error("Provider ignored the no-tools policy.");
            if (!event.response.content.trim() && !event.response.toolCalls.length) throw new Error("Empty provider response.");
            yield event;
            return;
          }
          yield event;
        }
        throw new Error("Provider stream ended without completion.");
      } catch (error) {
        request.signal?.throwIfAborted(); // Cancellation must never trigger fallback.
        const reason = error instanceof ProviderHttpError ? `HTTP ${error.status}` : "request/stream failure";
        failures.push(`${adapter.name}: ${reason}`);
        console.warn(`[providers] ${adapter.name}: ${reason}; trying next configured provider.`);
        // No tools execute before a complete response. Partial text can safely
        // be reset, even when a primary fails midway through its SSE stream.
        if (emitted) yield { type: "reset" };
      } finally {
        clearTimeout(timer);
        request.signal?.removeEventListener("abort", abort);
        controller.abort();
      }
    }
    throw new Error(`All configured providers failed (${failures.join("; ")}). Check API keys, models, and Ollama availability.`);
  }
}

export function createProviderRouter(config: AgentServerConfig): ProviderRouter {
  const providers: Record<ProviderName, ProviderAdapter> = {
    anthropic: new AnthropicProvider(config.providers.anthropic),
    openai: new OpenAIProvider(config.providers.openai),
    gemini: new GeminiProvider(config.providers.gemini),
    ollama: new OllamaProvider(config.providers.ollama),
  };
  const active = config.providerOrder.filter((name) => name === "ollama" || Boolean(config.providers[name].apiKey));
  console.info(`[providers] Priority: ${active.join(" -> ") || "none"}`);
  return new ProviderRouter(active.map((name) => providers[name]), config.providerTimeoutMs);
}
