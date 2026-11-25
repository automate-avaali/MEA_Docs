// The interface every chat LLM implements (Mistral, Fanar). The app never calls a provider directly — it goes
// through ./llm.ts, which picks the order (MISTRAL_ENABLED=true → Mistral first, Fanar as the fallback).

export type ChatMsg = { role: "system" | "user" | "assistant"; content: string };

/**
 * Filled in while a stream runs. `finishReason` is "length" when the answer hit max_tokens — the caller then asks
 * it to continue. `provider` says who produced it, e.g. "mistral/mistral-small-latest".
 */
export type StreamState = { finishReason: string | null; provider?: string };

export type Completion = { text: string; usage?: { prompt_tokens: number; completion_tokens: number } };

export interface LlmProvider {
  readonly name: "mistral" | "fanar";
  /** Model id sent to the API. */
  model(): string;
  /** Tokens one request may use in total (prompt + answer). */
  contextTokens(): number;
  /** Has what it needs to be called (API key / server URL). */
  configured(): boolean;
  /** Streams the answer text. Rejects on HTTP errors; `opts.signal` covers the whole stream. */
  streamChat(messages: ChatMsg[], opts: { maxTokens?: number; signal?: AbortSignal; state?: StreamState }): Promise<AsyncGenerator<string, void, unknown>>;
  /** One-shot (non-streaming) completion. */
  completeChat(messages: ChatMsg[], opts: { maxTokens?: number; signal?: AbortSignal }): Promise<Completion>;
}
