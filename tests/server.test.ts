import { describe, expect, it } from 'vitest';
import type { ResponsesClient, StreamEvent } from '../server/app.js';
import { createApp } from '../server/app.js';

function clientFrom(events: StreamEvent[]): ResponsesClient {
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

const validBody = {
  prompt: '解释这段推导。',
  history: [],
  images: [],
};

describe('InkAsk API', () => {
  it('reports configuration without exposing the API key', async () => {
    const app = createApp({ apiKey: 'secret-test-key', model: 'test-model' });
    const response = await app.inject({ method: 'GET', url: '/api/status' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      configured: true,
      model: 'test-model',
      contextBudget: 12000,
    });
    expect(response.body).not.toContain('secret-test-key');
    await app.close();
  });

  it('returns actionable guidance when credentials are absent', async () => {
    const app = createApp();
    const response = await app.inject({ method: 'POST', url: '/api/chat', payload: validBody });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ error: 'not_configured' });
    expect(response.body).toContain('.env');
    await app.close();
  });

  it('rejects malformed chat requests', async () => {
    const app = createApp({ client: clientFrom([]), model: 'test-model' });
    const response = await app.inject({
      method: 'POST',
      url: '/api/chat',
      payload: { prompt: '', history: [], images: [] },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: 'invalid_request' });
    await app.close();
  });

  it('rejects image values that are not generated image data URLs', async () => {
    const app = createApp({ client: clientFrom([]), model: 'test-model' });
    const response = await app.inject({
      method: 'POST',
      url: '/api/chat',
      payload: { ...validBody, images: ['https://example.com/untrusted.png'] },
    });
    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it('streams start, tokens and completion as SSE', async () => {
    let captured: { body?: Record<string, unknown>; signal?: AbortSignal } = {};
    const client: ResponsesClient = {
      responses: {
        async create(body, options) {
          captured = { body, signal: options?.signal };
          return (async function* () {
            yield { type: 'response.output_text.delta', delta: '先看 ' };
            yield { type: 'response.output_text.delta', delta: '$x^2$' };
            yield { type: 'response.completed' };
          })();
        },
      },
    };
    const app = createApp({ client, model: 'test-model' });
    const image = 'data:image/png;base64,iVBORw0KGgo=';
    const response = await app.inject({
      method: 'POST',
      url: '/api/chat',
      payload: {
        ...validBody,
        history: [{ role: 'assistant', content: '上一轮回答。', images: [] }],
        images: [image],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/event-stream');
    expect(response.body).toContain('event: start');
    expect(response.body).toContain('event: delta');
    expect(response.body).toContain('先看 ');
    expect(response.body).toContain('$x^2$');
    expect(response.body.match(/event: completed/g)).toHaveLength(1);
    expect(captured.body).toMatchObject({ model: 'test-model', stream: true });
    expect(String(captured.body?.instructions)).toContain('InkAsk 阅读学习助手');
    expect(captured.signal).toBeInstanceOf(AbortSignal);
    expect(captured.body?.input).toEqual([
      {
        role: 'assistant',
        content: [{ type: 'input_text', text: '上一轮回答。' }],
      },
      {
        role: 'user',
        content: [
          { type: 'input_text', text: '解释这段推导。' },
          { type: 'input_image', image_url: image, detail: 'auto' },
        ],
      },
    ]);
    await app.close();
  });

  it('maps authentication failures to safe SSE errors', async () => {
    const client: ResponsesClient = {
      responses: {
        async create() {
          throw Object.assign(new Error('upstream message contains secret-style detail'), {
            status: 401,
          });
        },
      },
    };
    const app = createApp({ client, model: 'test-model' });
    const response = await app.inject({ method: 'POST', url: '/api/chat', payload: validBody });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('event: error');
    expect(response.body).toContain('authentication_error');
    expect(response.body).not.toContain('secret-style detail');
    await app.close();
  });

  it('aborts the upstream request when the client disconnects', async () => {
    let upstreamSignal: AbortSignal | undefined;
    const client: ResponsesClient = {
      responses: {
        async create(_body, options) {
          upstreamSignal = options?.signal;
          return (async function* () {
            yield { type: 'response.output_text.delta', delta: 'partial' };
            await new Promise<void>((resolve) => {
              if (upstreamSignal?.aborted) return resolve();
              upstreamSignal?.addEventListener('abort', () => resolve(), { once: true });
            });
          })();
        },
      },
    };
    const app = createApp({ client, model: 'test-model' });
    await app.listen({ host: '127.0.0.1', port: 0 });

    try {
      const address = app.server.address();
      if (!address || typeof address === 'string') throw new Error('Missing test port');
      const browserAbort = new AbortController();
      const response = await fetch(`http://127.0.0.1:${address.port}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validBody),
        signal: browserAbort.signal,
      });
      expect(response.status).toBe(200);
      const reader = response.body?.getReader();
      if (!reader) throw new Error('Missing response stream');
      await reader.read();
      browserAbort.abort();
      await reader.cancel().catch(() => undefined);

      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Upstream was not aborted')), 1_000);
        const check = () => {
          if (!upstreamSignal?.aborted) return;
          clearTimeout(timeout);
          resolve();
        };
        upstreamSignal?.addEventListener('abort', check, { once: true });
        check();
      });
    } finally {
      await app.close();
    }
  });

  it('blocks untrusted origins and accepts local development origins', async () => {
    const app = createApp({ client: clientFrom([]), model: 'test-model' });
    const blocked = await app.inject({
      method: 'GET',
      url: '/api/status',
      headers: { host: '127.0.0.1:8787', origin: 'https://example.com' },
    });
    expect(blocked.statusCode).toBe(403);

    const allowed = await app.inject({
      method: 'GET',
      url: '/api/status',
      headers: { host: '127.0.0.1:8787', origin: 'http://localhost:5173' },
    });
    expect(allowed.statusCode).toBe(200);
    expect(allowed.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    await app.close();
  });
});
