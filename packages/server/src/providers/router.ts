import type {
  AgentServerConfig, ProviderAdapter, ProviderRequest, ProviderResponse, ProviderStreamEvent,
} from "@forge/shared";
import { BedrockProvider, bedrockAvailable } from "./bedrock";
import { consumeCompletion, ProviderHttpError } from "./http";

export class ProviderRouter implements ProviderAdapter {
  readonly name = "router" as const;
  constructor(private readonly adapters: ProviderAdapter[], private readonly timeoutMs = 120_000) {
    if (!adapters.length) throw new Error("No providers configured. Configure Bedrock via AWS credentials or AWS_BEARER_TOKEN_BEDROCK.");
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
    throw new Error(`All configured providers failed (${failures.join("; ")}). Check Bedrock credentials and that the model id is enabled.`);
  }
}

export function createProviderRouter(config: AgentServerConfig): ProviderRouter {
  const providers: ProviderAdapter[] = [];
  if (bedrockAvailable(config.bedrock)) providers.push(new BedrockProvider(config.bedrock));
  console.info(`[providers] Priority: ${providers.map((provider) => provider.name).join(" -> ") || "none"}`);
  return new ProviderRouter(providers, config.providerTimeoutMs);
}
