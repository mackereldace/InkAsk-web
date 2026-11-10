// Explicitly separate from npm dev/start. Deterministic UI QA; no external calls.
import { resolve } from "node:path";
import { createApp, type ResponsesClient } from "../server/app";
const client: ResponsesClient = {
  responses: {
    async create() {
      return (async function* () {
        const text =
          "**本机模拟回答，用于界面验收。**\n\n导数表示函数在某一点的瞬时变化率。[S1]\n\n$$f\prime(x)=\\lim_{h\\to0}\\frac{f(x+h)-f(x)}{h}$$\n\n例如 $f(x)=x^2$，则 $f\prime(x)=2x$。\n\n$$\\begin{pmatrix}1&0\\\\0&1\\end{pmatrix}$$\n\n| 概念 | 含义 |\n| --- | --- |\n| 割线 | 平均变化率 |\n| 切线 | 瞬时变化率 |\n\n```python\ndef derivative(x):\n    return 2 * x\n```\n\n你可以针对这段回答创建分支追问。";
        for (const chunk of text.match(/.{1,30}|\n/g) ?? []) {
          await new Promise((r) => setTimeout(r, 20));
          yield { type: "response.output_text.delta", delta: chunk };
        }
        yield { type: "response.completed", response: { status: "completed" } };
      })();
    },
  },
};
const app = createApp({
  apiKey: "test-only-not-a-real-key",
  model: "本机模拟 · 非真实 AI",
  client,
  staticRoot: resolve("dist"),
  logger: false,
});
await app.listen({ host: "127.0.0.1", port: 8790 });
console.log("UI QA fixture: http://127.0.0.1:8790 (no external AI calls)");
