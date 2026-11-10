import { afterEach, describe, expect, it, vi } from "vitest";
import { streamChat } from "../src/chat";
afterEach(() => vi.unstubAllGlobals());
function response(packets: string[]) {
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const p of packets)
          controller.enqueue(new TextEncoder().encode(p));
        controller.close();
      },
    }),
  );
}
describe("browser streaming transport", () => {
  it("decodes split UTF-8 and SSE frames without duplicating deltas", async () => {
    const bytes = new TextEncoder().encode(
      'event: delta\ndata: {"text":"你好"}\n\nevent: completed\ndata: {}\n\n',
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            new ReadableStream({
              start(c) {
                for (let i = 0; i < bytes.length; i += 3)
                  c.enqueue(bytes.slice(i, i + 3));
                c.close();
              },
            }),
          ),
      ),
    );
    const output: string[] = [];
    await streamChat(
      { prompt: "test", history: [], images: [] },
      new AbortController().signal,
      (s) => output.push(s),
    );
    expect(output.join("")).toBe("你好");
  });
  it("rejects premature EOF and retains the partial text", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        response(['event: delta\ndata: {"text":"partial"}\n\n']),
      ),
    );
    const output: string[] = [];
    await expect(
      streamChat(
        { prompt: "test", history: [], images: [] },
        new AbortController().signal,
        (s) => output.push(s),
      ),
    ).rejects.toThrow("连接提前结束");
    expect(output).toEqual(["partial"]);
  });
  it("shows actionable JSON errors and provider error frames", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({ message: "请配置模型" }, { status: 503 }),
      ),
    );
    await expect(
      streamChat(
        { prompt: "x", history: [], images: [] },
        new AbortController().signal,
        () => {},
      ),
    ).rejects.toThrow("请配置模型");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        response(['event: error\ndata: {"message":"请稍后重试"}\n\n']),
      ),
    );
    await expect(
      streamChat(
        { prompt: "x", history: [], images: [] },
        new AbortController().signal,
        () => {},
      ),
    ).rejects.toThrow("请稍后重试");
  });
});
