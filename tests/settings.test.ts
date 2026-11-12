import { mkdir, mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type {
  ProviderClientFactory,
  ResponsesClient,
  StreamEvent,
} from "../server/app.js";
import { createApp } from "../server/app.js";
import { ConfigStore } from "../server/config.js";
import type { ProviderConfigInput } from "../src/types.js";

const openAIConfig: ProviderConfigInput = {
  providerId: "openai",
  baseURL: "https://api.openai.com/v1",
  model: "gpt-test",
  protocol: "responses",
  supportsImages: true,
  apiKey: "secret-openai-key",
};

const geminiConfig: ProviderConfigInput = {
  providerId: "gemini",
  baseURL: "https://generativelanguage.googleapis.com/v1beta/openai",
  model: "gemini-test",
  protocol: "chat-completions",
  supportsImages: true,
  apiKey: "secret-gemini-key",
};

const validChat = {
  prompt: "解释这段内容。",
  history: [],
  images: [],
};

function completedClient(
  events: StreamEvent[] = [{ type: "response.completed" }],
): ResponsesClient {
  return {
    responses: {
      async create() {
        return (async function* () {
          yield* events;
        })();
      },
    },
  };
}

async function temporaryStore(): Promise<{
  directory: string;
  filePath: string;
  store: ConfigStore;
}> {
  const directory = await mkdtemp(join(tmpdir(), "inkask-settings-"));
  const filePath = join(directory, ".inkask", "providers.json");
  return { directory, filePath, store: new ConfigStore(filePath) };
}

describe("InkAsk provider settings", () => {
  it("atomically persists private profiles with private permissions", async () => {
    const { directory, filePath, store } = await temporaryStore();
    const saved = await store.save(openAIConfig);
    const directoryMode = (await stat(join(directory, ".inkask"))).mode & 0o777;
    const fileMode = (await stat(filePath)).mode & 0o777;

    expect(directoryMode).toBe(0o700);
    expect(fileMode).toBe(0o600);
    expect(saved.activeProviderId).toBe("openai");
    expect(saved.profiles[0]).toMatchObject({
      providerId: "openai",
      model: "gpt-test",
      hasKey: true,
    });
    expect(JSON.stringify(saved)).not.toContain("secret-openai-key");

    const reloaded = new ConfigStore(filePath);
    const snapshot = await reloaded.snapshot();
    expect(snapshot.activeConfig?.apiKey).toBe("secret-openai-key");
    expect(snapshot.settings.activeProviderId).toBe("openai");
    expect(JSON.stringify(snapshot.settings)).not.toContain(
      "secret-openai-key",
    );
  });

  it("retains a key only for the same provider and endpoint", async () => {
    const { store } = await temporaryStore();
    await store.save(openAIConfig);

    const retained = await store.save({
      ...openAIConfig,
      apiKey: "",
      model: "gpt-test-updated",
    });
    expect(retained.profiles[0]).toMatchObject({
      model: "gpt-test-updated",
      hasKey: true,
    });

    await expect(
      store.save({
        ...openAIConfig,
        baseURL: "https://example.com/v1",
        apiKey: "",
      }),
    ).rejects.toThrow("服务地址变更后需要重新填写 API Key");

    await expect(
      store.prepare({
        ...geminiConfig,
        apiKey: "",
      }),
    ).rejects.toThrow("该服务商需要 API Key");

    const changedEndpoint = await store.save({
      ...openAIConfig,
      baseURL: "https://example.com/v1/responses",
      apiKey: "new-endpoint-key",
    });
    expect(changedEndpoint.profiles[0].baseURL).toBe("https://example.com/v1");
    expect(JSON.stringify(changedEndpoint)).not.toContain("new-endpoint-key");
  });

  it("returns sanitized settings and provider status", async () => {
    const { store } = await temporaryStore();
    await store.save(openAIConfig);
    const factory: ProviderClientFactory = () => completedClient();
    const app = createApp({ configStore: store, clientFactory: factory });

    const saved = await app.inject({
      method: "PUT",
      url: "/api/settings",
      payload: openAIConfig,
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.body).not.toContain("secret-openai-key");

    const settings = await app.inject({ method: "GET", url: "/api/settings" });
    expect(settings.statusCode).toBe(200);
    expect(settings.json()).toMatchObject({
      activeProviderId: "openai",
      profiles: [{ providerId: "openai", hasKey: true }],
    });
    expect(settings.body).not.toContain("secret-openai-key");

    const status = await app.inject({ method: "GET", url: "/api/status" });
    expect(status.json()).toEqual({
      configured: true,
      model: "gpt-test",
      contextBudget: 12000,
      providerId: "openai",
      supportsImages: true,
    });
    expect(status.body).not.toContain("secret-openai-key");
    await app.close();
  });

  it("tests unsaved values with the saved key and never returns it", async () => {
    const { store } = await temporaryStore();
    await store.save(openAIConfig);
    let capturedKey = "";
    let probeBody: Record<string, unknown> | undefined;
    const factory: ProviderClientFactory = (config) => {
      capturedKey = config.apiKey;
      return {
        responses: {
          async create(body) {
            probeBody = body;
            return (async function* () {
              yield { type: "response.output_text.delta", delta: "OK" };
              yield { type: "response.completed" };
            })();
          },
        },
      };
    };
    const app = createApp({ configStore: store, clientFactory: factory });

    const tested = await app.inject({
      method: "POST",
      url: "/api/settings/test",
      payload: {
        ...openAIConfig,
        apiKey: "",
        model: "unsaved-model",
      },
    });
    expect(tested.statusCode).toBe(200);
    expect(tested.json()).toMatchObject({ ok: true });
    expect(capturedKey).toBe("secret-openai-key");
    expect(tested.body).not.toContain("secret-openai-key");
    expect(probeBody).toMatchObject({
      model: "unsaved-model",
      input: "只回复 OK",
      stream: true,
      max_output_tokens: 1024,
    });

    const snapshot = await store.snapshot();
    expect(snapshot.activeConfig?.model).toBe("gpt-test");
    await app.close();
  });

  it("returns safe probe failures without provider details", async () => {
    const { store } = await temporaryStore();
    await store.save(openAIConfig);
    const factory: ProviderClientFactory = () => {
      throw Object.assign(
        new Error("provider leaked secret-openai-key and internal detail"),
        { status: 401 },
      );
    };
    const app = createApp({ configStore: store, clientFactory: factory });
    const response = await app.inject({
      method: "POST",
      url: "/api/settings/test",
      payload: { ...openAIConfig, apiKey: "" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      ok: false,
      message: "鉴权失败，请检查 API Key。",
    });
    expect(response.body).not.toContain("secret-openai-key");
    expect(response.body).not.toContain("internal detail");
    await app.close();
  });

  it("never echoes secrets from validation or chat failures", async () => {
    const { store } = await temporaryStore();
    await store.save(openAIConfig);
    const factory: ProviderClientFactory = () => {
      throw new Error("factory attempted to reveal secret-openai-key");
    };
    const app = createApp({ configStore: store, clientFactory: factory });

    const invalid = await app.inject({
      method: "PUT",
      url: "/api/settings",
      payload: {
        ...openAIConfig,
        baseURL: "http://not-loopback.example/v1",
        apiKey: "request-secret-that-must-not-leak",
      },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.body).not.toContain("request-secret-that-must-not-leak");

    const chat = await app.inject({
      method: "POST",
      url: "/api/chat",
      payload: validChat,
    });
    expect(chat.statusCode).toBe(503);
    expect(chat.body).not.toContain("secret-openai-key");
    await app.close();
  });

  it("clears a profile and deselects it", async () => {
    const { store } = await temporaryStore();
    await store.save(openAIConfig);
    const app = createApp({
      configStore: store,
      clientFactory: () => completedClient(),
    });

    const removed = await app.inject({
      method: "DELETE",
      url: "/api/settings/openai",
    });
    expect(removed.statusCode).toBe(200);
    expect(removed.json()).toMatchObject({
      profiles: [],
      activeProviderId: null,
    });

    const status = await app.inject({ method: "GET", url: "/api/status" });
    expect(status.json()).toMatchObject({ configured: false, model: "" });
    await app.close();
  });

  it("keeps an in-flight chat on its old snapshot while switching providers", async () => {
    const { store } = await temporaryStore();
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolveGate) => {
      releaseFirst = resolveGate;
    });
    let firstStarted!: () => void;
    const firstStartedPromise = new Promise<void>((resolveStarted) => {
      firstStarted = resolveStarted;
    });
    const factoryCalls: PrivateProviderConfigForTest[] = [];
    const factory: ProviderClientFactory = (config) => {
      factoryCalls.push({
        providerId: config.providerId,
        model: config.model,
      });
      if (config.providerId === "openai") {
        firstStarted();
        return {
          responses: {
            async create() {
              return (async function* () {
                yield { type: "response.output_text.delta", delta: "old" };
                await firstGate;
                yield { type: "response.completed" };
              })();
            },
          },
        };
      }
      return completedClient([
        { type: "response.output_text.delta", delta: "new" },
        { type: "response.completed" },
      ]);
    };
    const environmentClient = completedClient([
      { type: "response.output_text.delta", delta: "env" },
      { type: "response.completed" },
    ]);
    const app = createApp({
      configStore: store,
      client: environmentClient,
      model: "environment-model",
      clientFactory: factory,
    });

    const initialStatus = await app.inject({
      method: "GET",
      url: "/api/status",
    });
    expect(initialStatus.json()).toMatchObject({
      configured: true,
      model: "environment-model",
    });

    await app.inject({
      method: "PUT",
      url: "/api/settings",
      payload: openAIConfig,
    });
    const firstChat = app.inject({
      method: "POST",
      url: "/api/chat",
      payload: validChat,
    });
    await firstStartedPromise;

    const switched = await app.inject({
      method: "PUT",
      url: "/api/settings",
      payload: geminiConfig,
    });
    expect(switched.json()).toMatchObject({ activeProviderId: "gemini" });
    releaseFirst();

    const firstResponse = await firstChat;
    expect(firstResponse.body).toContain('"text":"old"');
    expect(factoryCalls[0]).toEqual({
      providerId: "openai",
      model: "gpt-test",
    });

    const secondResponse = await app.inject({
      method: "POST",
      url: "/api/chat",
      payload: validChat,
    });
    expect(secondResponse.body).toContain('"text":"new"');
    expect(factoryCalls[1]).toEqual({
      providerId: "gemini",
      model: "gemini-test",
    });
    const finalStatus = await app.inject({
      method: "GET",
      url: "/api/status",
    });
    expect(finalStatus.json()).toMatchObject({
      providerId: "gemini",
      model: "gemini-test",
    });
    await app.close();
  });

  it("rejects images before calling an image-disabled provider", async () => {
    const { store } = await temporaryStore();
    await store.save({
      providerId: "custom",
      baseURL: "http://127.0.0.1:1234/v1",
      model: "text-only",
      protocol: "chat-completions",
      supportsImages: false,
    });
    let upstreamCalls = 0;
    const factory: ProviderClientFactory = () => ({
      responses: {
        async create() {
          upstreamCalls += 1;
          return (async function* () {
            yield { type: "response.completed" };
          })();
        },
      },
    });
    const app = createApp({ configStore: store, clientFactory: factory });
    const response = await app.inject({
      method: "POST",
      url: "/api/chat",
      payload: {
        ...validChat,
        images: ["data:image/png;base64,iVBORw0KGgo="],
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: "images_not_supported",
    });
    expect(upstreamCalls).toBe(0);
    await app.close();
  });

  it("validates URLs, protocols, model fields and missing keys", async () => {
    const { store } = await temporaryStore();
    const cases = [
      { ...openAIConfig, baseURL: "http://example.com/v1" },
      {
        ...openAIConfig,
        baseURL: "https://user:password@example.com/v1",
      },
      { ...openAIConfig, baseURL: "https://example.com/v1?token=secret" },
      { ...openAIConfig, baseURL: "https://example.com/v1#fragment" },
      { ...openAIConfig, protocol: "unknown" },
      { ...openAIConfig, model: "   " },
      { ...openAIConfig, supportsImages: "yes" },
      { ...openAIConfig, providerId: "unknown" },
      { ...openAIConfig, apiKey: undefined },
    ];
    for (const input of cases) {
      await expect(store.prepare(input)).rejects.toThrow();
    }

    const stripped = await store.prepare({
      providerId: "custom",
      baseURL: "http://[::1]:8080/v1/chat/completions/",
      model: "local-model",
      protocol: "chat-completions",
      supportsImages: true,
    });
    expect(stripped.baseURL).toBe("http://[::1]:8080/v1");
  });

  it("fails closed on a corrupt private config without leaking its contents", async () => {
    const { directory, filePath, store } = await temporaryStore();
    await mkdir(join(directory, ".inkask"), { recursive: true, mode: 0o700 });
    await writeFile(
      filePath,
      JSON.stringify({
        version: 1,
        secret: "do-not-leak",
        profiles: "broken",
      }),
      { mode: 0o600 },
    );
    const app = createApp({
      configStore: store,
      apiKey: "environment-secret",
      model: "environment-model",
      clientFactory: () => completedClient(),
    });

    const settings = await app.inject({
      method: "GET",
      url: "/api/settings",
    });
    expect(settings.statusCode).toBe(500);
    expect(settings.json()).toMatchObject({ error: "settings_unavailable" });
    expect(settings.body).not.toContain("do-not-leak");

    const chat = await app.inject({
      method: "POST",
      url: "/api/chat",
      payload: validChat,
    });
    expect(chat.statusCode).toBe(503);
    expect(chat.body).not.toContain("do-not-leak");
    expect(chat.body).not.toContain("environment-secret");
    await app.close();
  });

  it("does not create a store or expose settings when legacy mode is used", async () => {
    const app = createApp({
      client: completedClient(),
      model: "legacy-model",
    });
    const settings = await app.inject({
      method: "GET",
      url: "/api/settings",
    });
    expect(settings.statusCode).toBe(503);
    const status = await app.inject({ method: "GET", url: "/api/status" });
    expect(status.json()).toEqual({
      configured: true,
      model: "legacy-model",
      contextBudget: 12000,
    });
    await app.close();
  });
});

type PrivateProviderConfigForTest = {
  providerId: string;
  model: string;
};
