import OpenAI from "openai";
import type { ResponsesClient, StreamEvent } from "./app.js";
import type { PrivateProviderConfig } from "./provider-catalog.js";

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_ANTHROPIC_MAX_TOKENS = 8192;
const MAX_SSE_EVENT_BYTES = 1024 * 1024;
const MAX_ERROR_BODY_BYTES = 32 * 1024;

interface CreateProviderOptions {
  fetch?: typeof fetch;
}

interface ChatMessage {
  role: "user" | "assistant";
  text: string;
  images: string[];
}

interface NormalizedInput {
  system: string;
  messages: ChatMessage[];
}

interface RequestScope {
  signal: AbortSignal;
  userSignal?: AbortSignal;
  timedOut: boolean;
  cleanup: () => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function abortError(): Error {
  return new DOMException("Request aborted.", "AbortError");
}

function safeStatus(status?: number): {
  code: string;
  message: string;
} {
  if (status === 401 || status === 403) {
    return {
      code: "authentication_error",
      message: "AI 服务鉴权失败，请检查服务配置。",
    };
  }
  if (status === 408) {
    return { code: "timeout", message: "AI 服务响应超时，请稍后重试。" };
  }
  if (status === 429) {
    return { code: "rate_limit", message: "AI 服务请求过于频繁，请稍后重试。" };
  }
  if (status === undefined || status >= 500) {
    return {
      code: "upstream_unavailable",
      message: "暂时无法连接 AI 服务，请检查网络后重试。",
    };
  }
  return { code: "upstream_error", message: "AI 服务返回错误，请稍后重试。" };
}

function failureEvent(
  type: "response.failed" | "response.incomplete",
  code: string,
  message: string,
  status?: number,
): StreamEvent {
  return {
    type,
    error: {
      code,
      message,
      ...(status === undefined ? {} : { status }),
    },
  };
}

function statusFromError(value: unknown): number | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.status === "number") return value.status;
  return statusFromError(value.error);
}

function providerFailure(
  status: number | undefined,
  kind: "response.failed" | "response.incomplete" = "response.failed",
): StreamEvent {
  const safe = safeStatus(status);
  return failureEvent(kind, safe.code, safe.message, status);
}

function requestScope(userSignal?: AbortSignal): RequestScope {
  const controller = new AbortController();
  let timedOut = false;
  const abort = () => controller.abort();
  if (userSignal?.aborted) controller.abort();
  userSignal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, DEFAULT_TIMEOUT_MS);
  return {
    signal: controller.signal,
    userSignal,
    get timedOut() {
      return timedOut;
    },
    cleanup() {
      clearTimeout(timer);
      userSignal?.removeEventListener("abort", abort);
    },
  } as RequestScope;
}

function endpoint(baseURL: string, path: string): string {
  return `${baseURL.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

function textFromPart(part: unknown): string {
  if (!isRecord(part)) return "";
  if (
    ["input_text", "text", "output_text"].includes(String(part.type)) &&
    typeof part.text === "string"
  ) {
    return part.text;
  }
  return "";
}

function imageFromPart(part: unknown): string | undefined {
  if (!isRecord(part) || part.type !== "input_image") return undefined;
  if (typeof part.image_url === "string") return part.image_url;
  if (isRecord(part.image_url) && typeof part.image_url.url === "string") {
    return part.image_url.url;
  }
  return undefined;
}

function normalizeInput(body: Record<string, unknown>): NormalizedInput {
  const systemParts: string[] = [];
  if (typeof body.instructions === "string" && body.instructions.trim()) {
    systemParts.push(body.instructions.trim());
  }

  const messages: ChatMessage[] = [];
  const input = body.input;
  const items =
    typeof input === "string"
      ? [{ role: "user", content: input }]
      : Array.isArray(input)
        ? input
        : [];

  for (const item of items) {
    if (!isRecord(item) || typeof item.role !== "string") continue;
    if (item.role === "system" || item.role === "developer") {
      if (typeof item.content === "string" && item.content.trim()) {
        systemParts.push(item.content.trim());
      }
      continue;
    }
    if (item.role !== "user" && item.role !== "assistant") continue;

    const texts: string[] = [];
    const images: string[] = [];
    if (typeof item.content === "string") {
      texts.push(item.content);
    } else if (Array.isArray(item.content)) {
      for (const part of item.content) {
        const text = textFromPart(part);
        if (text) texts.push(text);
        if (item.role === "user") {
          const image = imageFromPart(part);
          if (image) images.push(image);
        }
      }
    }
    messages.push({
      role: item.role,
      text: texts.join("\n"),
      images,
    });
  }

  return { system: systemParts.join("\n\n"), messages };
}

function chatContent(
  message: ChatMessage,
): string | Array<Record<string, unknown>> {
  if (message.role === "assistant" || !message.images.length) {
    return message.text;
  }
  return [
    ...(message.text ? [{ type: "text", text: message.text }] : []),
    ...message.images.map((url) => ({
      type: "image_url",
      image_url: { url },
    })),
  ];
}

function anthropicContent(
  message: ChatMessage,
): string | Array<Record<string, unknown>> {
  if (message.role === "assistant") return message.text;
  if (!message.images.length && message.text) return message.text;

  const content: Array<Record<string, unknown>> = [];
  if (message.text) content.push({ type: "text", text: message.text });
  for (const image of message.images) {
    const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,([\s\S]+)$/.exec(
      image,
    );
    if (!match) {
      throw new Error("INVALID_IMAGE_DATA_URL");
    }
    content.push({
      type: "image",
      source: {
        type: "base64",
        media_type: match[1].toLowerCase(),
        data: match[2].replace(/\s+/g, ""),
      },
    });
  }
  return content;
}

function maxTokensFrom(body: Record<string, unknown>): number | undefined {
  const value = body.max_output_tokens ?? body.max_tokens;
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
}

async function readLimitedBody(
  response: Response,
  scope: RequestScope,
): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let size = 0;
  try {
    while (true) {
      const { done, value } = await readWithAbort(reader, scope);
      if (done) break;
      size += value.byteLength;
      if (size > MAX_ERROR_BODY_BYTES) throw new Error("BODY_TOO_LARGE");
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return text;
  } finally {
    await reader.cancel().catch(() => undefined);
    try {
      reader.releaseLock();
    } catch {
      // A cancelled reader can already be detached by some fetch mocks.
    }
  }
}

async function readWithAbort(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  scope: RequestScope,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (scope.signal.aborted) throw abortError();
  const pending = reader.read();
  let listener: (() => void) | undefined;
  let rejectAbort: ((reason?: unknown) => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
    listener = () => reject(abortError());
    scope.signal.addEventListener("abort", listener, { once: true });
  });
  try {
    // The stream may abort synchronously inside reader.read().
    if (scope.signal.aborted) rejectAbort?.(abortError());
    return await Promise.race([pending, aborted]);
  } finally {
    if (listener) scope.signal.removeEventListener("abort", listener);
  }
}

function appendDecoded(
  buffer: string,
  chunk: string,
  pendingCarriageReturn: { value: boolean },
): string {
  let text = chunk;
  if (pendingCarriageReturn.value) {
    text = text.startsWith("\n") ? `\n${text.slice(1)}` : `\n${text}`;
    pendingCarriageReturn.value = false;
  }
  if (text.endsWith("\r")) {
    text = text.slice(0, -1);
    pendingCarriageReturn.value = true;
  }
  return buffer + text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function eventData(frame: string): string | undefined {
  const data: string[] = [];
  for (const line of frame.split("\n")) {
    if (!line || line.startsWith(":")) continue;
    if (line === "data") {
      data.push("");
      continue;
    }
    if (line.startsWith("data:")) {
      let value = line.slice(5);
      if (value.startsWith(" ")) value = value.slice(1);
      data.push(value);
    }
  }
  return data.length ? data.join("\n") : undefined;
}

async function* readSseData(
  response: Response,
  scope: RequestScope,
): AsyncGenerator<string> {
  if (!response.body) throw new Error("MISSING_RESPONSE_BODY");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const pendingCarriageReturn = { value: false };
  let buffer = "";
  let completed = false;
  try {
    while (!completed) {
      const result = await readWithAbort(reader, scope);
      if (result.done) {
        buffer = appendDecoded(buffer, decoder.decode(), pendingCarriageReturn);
        if (pendingCarriageReturn.value) {
          buffer += "\n";
          pendingCarriageReturn.value = false;
        }
        completed = true;
      } else {
        buffer = appendDecoded(
          buffer,
          decoder.decode(result.value, { stream: true }),
          pendingCarriageReturn,
        );
      }

      if (!completed && buffer.length > MAX_SSE_EVENT_BYTES) {
        throw new Error("SSE_EVENT_TOO_LARGE");
      }
      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = eventData(frame);
        if (data !== undefined) yield data;
        boundary = buffer.indexOf("\n\n");
      }
      if (buffer.length > MAX_SSE_EVENT_BYTES) {
        throw new Error("SSE_EVENT_TOO_LARGE");
      }
    }

    if (buffer.trim()) {
      const data = eventData(buffer);
      if (data !== undefined) yield data;
    }
  } finally {
    if (!completed || scope.signal.aborted) {
      await reader.cancel().catch(() => undefined);
    }
    try {
      reader.releaseLock();
    } catch {
      // A fetch implementation may release its cancelled stream eagerly.
    }
  }
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error("INVALID_SSE_JSON");
  }
}

function inStreamErrorEvent(value: unknown): StreamEvent | undefined {
  if (!isRecord(value)) return undefined;
  const rawError =
    value.type === "error"
      ? (value.error ?? value)
      : isRecord(value.error)
        ? value.error
        : undefined;
  if (!rawError) return undefined;
  return providerFailure(statusFromError(rawError));
}

async function fetchEventStream(
  fetcher: typeof fetch,
  url: string,
  init: RequestInit,
  scope: RequestScope,
): Promise<Response | StreamEvent> {
  try {
    const response = await fetcher(url, {
      ...init,
      signal: scope.signal,
      redirect: "error",
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      return providerFailure(response.status);
    }
    const contentType =
      response.headers.get("content-type")?.toLowerCase() ?? "";
    if (!contentType.includes("text/event-stream")) {
      const body = await readLimitedBody(response, scope);
      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch {
        return failureEvent(
          "response.failed",
          "invalid_stream",
          "AI 服务返回了无法识别的响应。",
          response.status,
        );
      }
      return (
        inStreamErrorEvent(parsed) ??
        failureEvent(
          "response.failed",
          "invalid_stream",
          "AI 服务没有返回可流式读取的回答。",
          response.status,
        )
      );
    }
    return response;
  } catch (error) {
    if (scope.userSignal?.aborted) throw abortError();
    if (scope.timedOut) {
      return failureEvent(
        "response.failed",
        "timeout",
        "AI 服务响应超时，请稍后重试。",
        undefined,
      );
    }
    if (error instanceof Error && error.name === "AbortError") throw error;
    return providerFailure(undefined);
  }
}

function chatFinishEvent(finishReason: string): {
  event: StreamEvent;
  terminal: true;
} {
  if (finishReason === "stop") {
    return {
      terminal: true,
      event: { type: "response.completed", response: { status: "completed" } },
    };
  }
  const safeCode =
    finishReason === "length"
      ? "output_limit"
      : finishReason === "content_filter"
        ? "content_filter"
        : finishReason === "tool_calls"
          ? "tool_calls_unsupported"
          : "non_stop_finish";
  return {
    terminal: true,
    event: failureEvent(
      "response.incomplete",
      safeCode,
      "AI 未能完整生成回答，请重试。",
    ),
  };
}

async function* chatEvents(
  body: Record<string, unknown>,
  config: PrivateProviderConfig,
  fetcher: typeof fetch,
  options?: { signal?: AbortSignal },
): AsyncGenerator<StreamEvent> {
  const normalized = normalizeInput(body);
  if (!normalized.messages.length) {
    yield providerFailure(400);
    return;
  }
  const messages: Array<Record<string, unknown>> = [];
  if (normalized.system) {
    messages.push({ role: "system", content: normalized.system });
  }
  messages.push(
    ...normalized.messages.map((message) => ({
      role: message.role,
      content: chatContent(message),
    })),
  );
  const maxTokens = maxTokensFrom(body);
  const scope = requestScope(options?.signal);
  let terminal = false;
  try {
    const streamResult = await fetchEventStream(
      fetcher,
      endpoint(config.baseURL, "chat/completions"),
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(config.apiKey
            ? { Authorization: `Bearer ${config.apiKey}` }
            : {}),
        },
        body: JSON.stringify({
          model: config.model,
          messages,
          stream: true,
          ...(maxTokens === undefined ? {} : { max_tokens: maxTokens }),
          ...(typeof body.temperature === "number"
            ? { temperature: body.temperature }
            : {}),
          ...(typeof body.top_p === "number" ? { top_p: body.top_p } : {}),
        }),
      },
      scope,
    );
    if (!(streamResult instanceof Response)) {
      yield streamResult;
      return;
    }

    for await (const data of readSseData(streamResult, scope)) {
      if (scope.userSignal?.aborted) return;
      if (data.trim() === "[DONE]") continue;
      let payload: unknown;
      try {
        payload = parseJson(data);
      } catch {
        yield failureEvent(
          "response.failed",
          "invalid_stream",
          "AI 响应格式无效，请重试。",
        );
        return;
      }
      const streamError = inStreamErrorEvent(payload);
      if (streamError) {
        yield streamError;
        return;
      }
      if (!isRecord(payload) || !Array.isArray(payload.choices)) continue;
      const choice = payload.choices[0];
      if (!isRecord(choice)) continue;
      const delta = isRecord(choice.delta) ? choice.delta : {};
      if (typeof delta.content === "string" && delta.content) {
        yield { type: "response.output_text.delta", delta: delta.content };
      }
      if (typeof choice.finish_reason === "string" && choice.finish_reason) {
        const finish = chatFinishEvent(choice.finish_reason);
        terminal = true;
        yield finish.event;
        return;
      }
    }
    if (!terminal) {
      yield failureEvent(
        "response.failed",
        "incomplete_stream",
        "AI 响应意外中断，请重试。",
      );
    }
  } catch {
    if (scope.userSignal?.aborted) return;
    if (scope.timedOut) {
      yield failureEvent(
        "response.failed",
        "timeout",
        "AI 服务响应超时，请稍后重试。",
      );
      return;
    }
    yield providerFailure(undefined);
  } finally {
    scope.cleanup();
  }
}

async function* anthropicEvents(
  body: Record<string, unknown>,
  config: PrivateProviderConfig,
  fetcher: typeof fetch,
  options?: { signal?: AbortSignal },
): AsyncGenerator<StreamEvent> {
  if (!config.apiKey) {
    yield providerFailure(401);
    return;
  }
  const normalized = normalizeInput(body);
  if (!normalized.messages.length) {
    yield providerFailure(400);
    return;
  }

  let messages: Array<{ role: string; content: unknown }>;
  try {
    messages = normalized.messages.map((message) => ({
      role: message.role,
      content: anthropicContent(message),
    }));
  } catch {
    yield failureEvent(
      "response.failed",
      "invalid_image",
      "图片格式无效，请重新附加图片。",
    );
    return;
  }

  const scope = requestScope(options?.signal);
  let stopReason: string | undefined;
  let terminal = false;
  try {
    const streamResult = await fetchEventStream(
      fetcher,
      endpoint(config.baseURL, "messages"),
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": config.apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: config.model,
          messages,
          stream: true,
          max_tokens: maxTokensFrom(body) ?? DEFAULT_ANTHROPIC_MAX_TOKENS,
          ...(normalized.system ? { system: normalized.system } : {}),
          ...(typeof body.temperature === "number"
            ? { temperature: body.temperature }
            : {}),
          ...(typeof body.top_p === "number" ? { top_p: body.top_p } : {}),
        }),
      },
      scope,
    );
    if (!(streamResult instanceof Response)) {
      yield streamResult;
      return;
    }

    for await (const data of readSseData(streamResult, scope)) {
      if (scope.userSignal?.aborted) return;
      let payload: unknown;
      try {
        payload = parseJson(data);
      } catch {
        yield failureEvent(
          "response.failed",
          "invalid_stream",
          "AI 响应格式无效，请重试。",
        );
        return;
      }
      const streamError = inStreamErrorEvent(payload);
      if (streamError) {
        yield streamError;
        return;
      }
      if (!isRecord(payload)) continue;
      if (payload.type === "content_block_delta" && isRecord(payload.delta)) {
        if (
          payload.delta.type === "text_delta" &&
          typeof payload.delta.text === "string" &&
          payload.delta.text
        ) {
          yield {
            type: "response.output_text.delta",
            delta: payload.delta.text,
          };
        }
      } else if (payload.type === "message_delta" && isRecord(payload.delta)) {
        if (typeof payload.delta.stop_reason === "string") {
          stopReason = payload.delta.stop_reason;
        }
      } else if (payload.type === "message_stop") {
        terminal = true;
        if (stopReason === "end_turn" || stopReason === "stop_sequence") {
          yield {
            type: "response.completed",
            response: { status: "completed" },
          };
        } else {
          const code =
            stopReason === "max_tokens"
              ? "output_limit"
              : stopReason === "refusal"
                ? "content_filter"
                : "incomplete_stop";
          yield failureEvent(
            "response.incomplete",
            code,
            "AI 未能完整生成回答，请重试。",
          );
        }
        return;
      }
    }
    if (!terminal) {
      yield failureEvent(
        "response.failed",
        "incomplete_stream",
        "AI 响应意外中断，请重试。",
      );
    }
  } catch {
    if (scope.userSignal?.aborted) return;
    if (scope.timedOut) {
      yield failureEvent(
        "response.failed",
        "timeout",
        "AI 服务响应超时，请稍后重试。",
      );
      return;
    }
    yield providerFailure(undefined);
  } finally {
    scope.cleanup();
  }
}

async function* responsesEvents(
  body: Record<string, unknown>,
  config: PrivateProviderConfig,
  fetcher: typeof fetch,
  options?: { signal?: AbortSignal },
): AsyncGenerator<StreamEvent> {
  try {
    const sdk = new OpenAI({
      apiKey: config.apiKey || "not-required",
      baseURL: config.baseURL,
      fetch: ((input, init) =>
        fetcher(input, {
          ...init,
          redirect: "error",
        })) as typeof fetch,
      maxRetries: 0,
      timeout: DEFAULT_TIMEOUT_MS,
    });
    const stream = (await sdk.responses.create(body as never, {
      signal: options?.signal,
    })) as unknown as AsyncIterable<Record<string, unknown>>;
    for await (const raw of stream) {
      if (options?.signal?.aborted) return;
      const type = typeof raw.type === "string" ? raw.type : undefined;
      if (type === "error" || type === "response.failed") {
        yield providerFailure(statusFromError(raw));
        return;
      }
      if (
        type === "response.output_text.delta" &&
        typeof raw.delta === "string"
      ) {
        yield { type, delta: raw.delta };
        continue;
      }
      if (type === "response.completed") {
        const response = isRecord(raw.response) ? raw.response : {};
        yield {
          type,
          response: {
            status:
              typeof response.status === "string"
                ? response.status
                : "completed",
          },
        };
        return;
      }
      if (type === "response.incomplete") {
        yield failureEvent(
          "response.incomplete",
          "response_incomplete",
          "AI 未能完整生成回答，请重试。",
        );
        return;
      }
      yield { type };
    }
  } catch (error) {
    if (options?.signal?.aborted) return;
    yield providerFailure(statusFromError(error));
  }
}

export function createProviderClient(
  config: PrivateProviderConfig,
  options: CreateProviderOptions = {},
): ResponsesClient {
  const fetcher = options.fetch ?? globalThis.fetch;
  if (!fetcher) {
    throw new Error("No fetch implementation is available.");
  }

  return {
    responses: {
      async create(body, requestOptions) {
        if (config.protocol === "responses") {
          return responsesEvents(body, config, fetcher, requestOptions);
        }
        if (config.protocol === "anthropic") {
          return anthropicEvents(body, config, fetcher, requestOptions);
        }
        return chatEvents(body, config, fetcher, requestOptions);
      },
    },
  };
}
