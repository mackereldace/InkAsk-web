import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { createApp } from "../../server/app";

export interface ServerCall {
  method: string;
  url: string;
}

export interface DiskServer {
  app: FastifyInstance;
  dir: string;
  calls: ServerCall[];
  /** Replace global fetch with one that goes straight into Fastify's inject. */
  installFetch(): void;
  close(): Promise<void>;
}

/**
 * A real InkAsk service writing into a throwaway directory, reachable through a
 * `fetch` shim. Client code runs unmodified: same URLs, same bodies, real routes.
 */
export async function startDiskServer(): Promise<DiskServer> {
  const dir = await mkdtemp(join(tmpdir(), "inkask-store-"));
  const app = createApp({ dataDir: dir, logger: false });
  await app.ready();

  const calls: ServerCall[] = [];
  const original = globalThis.fetch;

  const API_ORIGIN = "http://127.0.0.1";

  const shim = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (!url.startsWith("/api/")) return original(input, init);
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push({ method, url });
    let payload: string | Uint8Array | undefined;
    if (init?.body instanceof Blob) payload = Buffer.from(await init.body.arrayBuffer());
    else if (typeof init?.body === "string") payload = init.body;
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const response = await app.inject({
      method: method as "GET",
      url,
      payload,
      headers: { host: "127.0.0.1", ...headers },
    });
    const body =
      response.statusCode === 204 || response.rawPayload.length === 0
        ? null
        : new Uint8Array(response.rawPayload);
    return new Response(body, {
      status: response.statusCode,
      headers: {
        "content-type": (response.headers["content-type"] as string) ?? "application/json",
      },
    });
  };

  return {
    app,
    dir,
    calls,
    installFetch: () => {
      globalThis.fetch = shim as typeof fetch;
    },
    close: async () => {
      globalThis.fetch = original;
      await app.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

/** Minimal localStorage so modules that guard with try/catch behave like a browser. */
export function installLocalStorage(): void {
  const store = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, String(value)),
      removeItem: (key: string) => void store.delete(key),
      clear: () => store.clear(),
      key: (index: number) => Array.from(store.keys())[index] ?? null,
      get length() {
        return store.size;
      },
    },
  });
}

export const API_ORIGIN = "http://127.0.0.1";
