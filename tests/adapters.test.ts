import { describe, expect, it } from "vitest";
import type { StreamEvent } from "../server/app.js";
import { createProviderClient } from "../server/adapters.js";
import type { PrivateProviderConfig } from "../server/provider-catalog.js";

const image = "data:image/png;base64,aGVsbG8=";

function config(
  protocol: PrivateProviderConfig["protocol"],
  overrides: Partial<PrivateProviderConfig> = {},
): PrivateProviderConfig {
  return {
    providerId: protocol,
    baseURL: `https://provider.example/v1`,
    model: "fixture-model",
    protocol,
    supportsImages: true,
    apiKey: "fixture-key",
    ...overrides,
  };
}

function sseResponse(
  raw: string | Uint8Array,
  options: { chunkSize?: number; cancel?: () => void } = {},
): Response {
  const bytes = typeof raw === "string" ? new TextEncoder().encode(raw) : raw;
  const chunkSize = options.chunkSize ?? (bytes.length || 1);
  let offset = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.length) {
        controller.close();
        return;
      }
      const end = Math.min(bytes.length, offset + chunkSize);
      controller.enqueue(bytes.slice(offset, end));
      offset = end;
    },
    cancel() {
      options.cancel?.();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream; charset=utf-8" },
  });
}

function data(payload: unknown, lineEnding = "\n"): string {
  return `data: ${JSON.stringify(payload)}${lineEnding}${lineEnding}`;
}

async function collect(iterable: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

function requestURL(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

describe("Responses adapter", () => {
  it("passes Responses bodies through the OpenAI SDK with injected fetch", async () => {
    let calls = 0;
    let capturedURL = "";
    let capturedBody: Record<string, unknown> = {};
    let capturedAuthorization = "";
    const fetcher = (async (
      input: Parameters<typeof fetch>[0],
      init?: RequestInit,
    ) => {
      calls += 1;
      capturedURL = requestURL(input);
      capturedBody = JSON.parse(String(init?.body));
      capturedAuthorization = new Headers(init?.headers).get("authorization") ?? "";
      return sseResponse(
        data({
          type: "response.output_text.delta",
          delta: "SDK 文本",
          sequence_number: 1,
        }) +
          data({
            type: "response.completed",
            response: { status: "completed" },
            sequence_number: 2,
          }),
      );
    }) as typeof fetch;
    const client = createProviderClient(config("responses"), { fetch: fetcher });

    const events = await collect(
      await client.responses.create({
        model: "fixture-model",
        instructions: "system",
        input: [{ role: "user", content: "hello" }],
        stream: true,
      }),
    );

    expect(calls).toBe(1);
    expect(capturedURL).toBe("https://provider.example/v1/responses");
    expect(capturedBody).toMatchObject({
      model: "fixture-model",
      instructions: "system",
      stream: true,
    });
    expect(capturedAuthorization).toBe("Bearer fixture-key");
    expect(events).toContainEqual({
      type: "response.output_text.delta",
      delta: "SDK 文本",
    });
    expect(events.at(-1)?.type).toBe("response.completed");
  });

  it("does not retry SDK HTTP failures and sanitizes the failure", async () => {
    let calls = 0;
    const fetcher = (async () => {
      calls += 1;
      return new Response('{"error":{"message":"fixture-secret"}}', {
        status: 401,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    const client = createProviderClient(config("responses"), { fetch: fetcher });

    const events = await collect(
      await client.responses.create({
        model: "fixture-model",
        input: "hello",
        stream: true,
      }),
    );

    expect(calls).toBe(1);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "response.failed",
        error: expect.objectContaining({ code: "authentication_error", status: 401 }),
      }),
    );
    expect(JSON.stringify(events)).not.toContain("fixture-secret");
  });
});

describe("Chat Completions adapter", () => {
  it("converts history, text, and images and exposes only content deltas", async () => {
    let capturedURL = "";
    let captured: Record<string, unknown> = {};
    let authorization = "";
    const raw =
      data(
        {
          choices: [
            {
              delta: { reasoning_content: "hidden reasoning", content: "先看 " },
              finish_reason: null,
            },
          ],
        },
        "\r\n",
      ) +
      data(
        {
          choices: [
            {
              delta: { content: "公式 😊" },
              finish_reason: null,
            },
          ],
        },
        "\r\n",
      ) +
      data(
        {
          choices: [
            {
              delta: {},
              finish_reason: "stop",
            },
          ],
        },
        "\r\n",
      ) +
      "data: [DONE]\r\n\r\n";
    const fetcher = (async (
      input: Parameters<typeof fetch>[0],
      init?: RequestInit,
    ) => {
      capturedURL = requestURL(input);
      captured = JSON.parse(String(init?.body));
      authorization = new Headers(init?.headers).get("authorization") ?? "";
      return sseResponse(raw, { chunkSize: 1 });
    }) as typeof fetch;
    const client = createProviderClient(config("chat-completions"), {
      fetch: fetcher,
    });

    const events = await collect(
      await client.responses.create({
        model: "fixture-model",
        instructions: "阅读规则",
        input: [
          { role: "assistant", content: "上一轮回答" },
          {
            role: "user",
            content: [
              { type: "input_text", text: "解释图片" },
              { type: "input_image", image_url: image, detail: "auto" },
            ],
          },
        ],
        max_output_tokens: 77,
        stream: true,
      }),
    );

    expect(capturedURL).toBe("https://provider.example/v1/chat/completions");
    expect(authorization).toBe("Bearer fixture-key");
    expect(captured).toMatchObject({
      model: "fixture-model",
      stream: true,
      max_tokens: 77,
      messages: [
        { role: "system", content: "阅读规则" },
        { role: "assistant", content: "上一轮回答" },
        {
          role: "user",
          content: [
            { type: "text", text: "解释图片" },
            { type: "image_url", image_url: { url: image } },
          ],
        },
      ],
    });
    expect(
      events
        .filter((event) => event.type === "response.output_text.delta")
        .map((event) => event.delta),
    ).toEqual(["先看 ", "公式 😊"]);
    expect(events.at(-1)?.type).toBe("response.completed");
    expect(JSON.stringify(events)).not.toContain("hidden reasoning");
  });

  it("maps finish reasons and premature EOF to safe terminal failures", async () => {
    const lengthClient = createProviderClient(config("chat-completions"), {
      fetch: (async () =>
        sseResponse(
          data({
            choices: [{ delta: {}, finish_reason: "length" }],
          }),
        )) as typeof fetch,
    });
    const lengthEvents = await collect(
      await lengthClient.responses.create({
        model: "fixture-model",
        input: "hello",
        stream: true,
      }),
    );
    expect(lengthEvents.at(-1)).toMatchObject({
      type: "response.incomplete",
      error: { code: "output_limit" },
    });

    const eofClient = createProviderClient(config("chat-completions"), {
      fetch: (async () =>
        sseResponse(data({ choices: [{ delta: { content: "partial" } }] }))) as typeof fetch,
    });
    const eofEvents = await collect(
      await eofClient.responses.create({
        model: "fixture-model",
        input: "hello",
        stream: true,
      }),
    );
    expect(eofEvents.at(-1)).toMatchObject({
      type: "response.failed",
      error: { code: "incomplete_stream" },
    });
    expect(eofEvents.some((event) => event.type === "response.completed")).toBe(false);
  });

  it("handles HTTP 200 JSON errors without leaking provider details", async () => {
    const fetcher = (async () =>
      new Response(
        JSON.stringify({
          error: {
            type: "authentication_error",
            status: 401,
            message: "provider-secret-and-key",
          },
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      )) as typeof fetch;
    const client = createProviderClient(config("chat-completions"), {
      fetch: fetcher,
    });
    const events = await collect(
      await client.responses.create({
        model: "fixture-model",
        input: "hello",
        stream: true,
      }),
    );
    expect(events.at(-1)).toMatchObject({
      type: "response.failed",
      error: { code: "authentication_error", status: 401 },
    });
    expect(JSON.stringify(events)).not.toContain("provider-secret-and-key");
  });

  it("cancels the reader and upstream request when aborted", async () => {
    const abort = new AbortController();
    let cancelled = false;
    let upstreamSignal: AbortSignal | undefined;
    const raw = data({ choices: [{ delta: { content: "first" } }] });
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(raw));
      },
      cancel() {
        cancelled = true;
      },
    });
    const fetcher = (async (
      _input: Parameters<typeof fetch>[0],
      init?: RequestInit,
    ) => {
      upstreamSignal = init?.signal ?? undefined;
      return new Response(body, {
        headers: { "content-type": "text/event-stream" },
      });
    }) as typeof fetch;
    const client = createProviderClient(config("chat-completions"), {
      fetch: fetcher,
    });
    const iterator = (
      await client.responses.create(
        { model: "fixture-model", input: "hello", stream: true },
        { signal: abort.signal },
      )
    )[Symbol.asyncIterator]();

    expect((await iterator.next()).value).toEqual({
      type: "response.output_text.delta",
      delta: "first",
    });
    abort.abort();
    expect(await iterator.next()).toEqual({ done: true, value: undefined });
    expect(upstreamSignal?.aborted).toBe(true);
    expect(cancelled).toBe(true);
  });

  it("rejects oversized or non-SSE event data without unbounded buffering", async () => {
    const huge = `data: ${"x".repeat(1024 * 1024 + 1)}`;
    const client = createProviderClient(config("chat-completions"), {
      fetch: (async () => sseResponse(huge)) as typeof fetch,
    });
    const events = await collect(
      await client.responses.create({
        model: "fixture-model",
        input: "hello",
        stream: true,
      }),
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "response.failed" });
    expect(events[0].type).not.toBe("response.completed");
  });
});

describe("Anthropic adapter", () => {
  it("converts top-level system, images, and SSE text to Responses events", async () => {
    let capturedURL = "";
    let captured: Record<string, unknown> = {};
    let headers: Headers | undefined;
    const raw =
      "event: content_block_delta\r\n" +
      'data: {"type":"content_block_delta","delta":\r\n' +
      'data: {"type":"text_delta","text":"公式 😊"}}\r\n\r\n' +
      data({
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
      }, "\r\n") +
      data({ type: "message_stop" }, "\r\n");
    const fetcher = (async (
      input: Parameters<typeof fetch>[0],
      init?: RequestInit,
    ) => {
      capturedURL = requestURL(input);
      captured = JSON.parse(String(init?.body));
      headers = new Headers(init?.headers);
      return sseResponse(raw, { chunkSize: 1 });
    }) as typeof fetch;
    const client = createProviderClient(config("anthropic"), { fetch: fetcher });

    const events = await collect(
      await client.responses.create({
        model: "fixture-model",
        instructions: "系统规则",
        max_output_tokens: 321,
        input: [
          { role: "assistant", content: "历史回答" },
          {
            role: "user",
            content: [
              { type: "input_text", text: "看图解释" },
              { type: "input_image", image_url: image },
            ],
          },
        ],
        stream: true,
      }),
    );

    expect(capturedURL).toBe("https://provider.example/v1/messages");
    expect(headers?.get("x-api-key")).toBe("fixture-key");
    expect(headers?.get("anthropic-version")).toBe("2023-06-01");
    expect(captured).toMatchObject({
      model: "fixture-model",
      system: "系统规则",
      max_tokens: 321,
      stream: true,
      messages: [
        { role: "assistant", content: "历史回答" },
        {
          role: "user",
          content: [
            { type: "text", text: "看图解释" },
            {
              type: "image",
              source: {
                type: "base64",
                media_type: "image/png",
                data: "aGVsbG8=",
              },
            },
          ],
        },
      ],
    });
    expect(events).toContainEqual({
      type: "response.output_text.delta",
      delta: "公式 😊",
    });
    expect(events.at(-1)?.type).toBe("response.completed");
  });

  it("waits for message_stop and maps non-success stop reasons", async () => {
    const raw =
      data({
        type: "content_block_delta",
        delta: { type: "text_delta", text: "partial" },
      }) +
      data({
        type: "message_delta",
        delta: { stop_reason: "max_tokens" },
      }) +
      data({ type: "message_stop" });
    const client = createProviderClient(config("anthropic"), {
      fetch: (async () => sseResponse(raw)) as typeof fetch,
    });
    const events = await collect(
      await client.responses.create({
        model: "fixture-model",
        input: "hello",
        stream: true,
      }),
    );

    expect(events.at(-1)).toMatchObject({
      type: "response.incomplete",
      error: { code: "output_limit" },
    });
    expect(events.some((event) => event.type === "response.completed")).toBe(false);
  });

  it("does not complete on EOF and sanitizes in-stream errors", async () => {
    const eofClient = createProviderClient(config("anthropic"), {
      fetch: (async () =>
        sseResponse(
          data({
            type: "content_block_delta",
            delta: { type: "text_delta", text: "partial" },
          }) +
            data({
              type: "message_delta",
              delta: { stop_reason: "end_turn" },
            }),
        )) as typeof fetch,
    });
    const eofEvents = await collect(
      await eofClient.responses.create({
        model: "fixture-model",
        input: "hello",
        stream: true,
      }),
    );
    expect(eofEvents.at(-1)).toMatchObject({
      type: "response.failed",
      error: { code: "incomplete_stream" },
    });

    const errorClient = createProviderClient(config("anthropic"), {
      fetch: (async () =>
        sseResponse(
          data({
            type: "error",
            error: {
              type: "authentication_error",
              status: 401,
              message: "anthropic-secret-detail",
            },
          }),
        )) as typeof fetch,
    });
    const errorEvents = await collect(
      await errorClient.responses.create({
        model: "fixture-model",
        input: "hello",
        stream: true,
      }),
    );
    expect(errorEvents.at(-1)).toMatchObject({
      type: "response.failed",
      error: { code: "authentication_error", status: 401 },
    });
    expect(JSON.stringify(errorEvents)).not.toContain("anthropic-secret-detail");
    expect(JSON.stringify(errorEvents)).not.toContain("fixture-key");
  });
});
