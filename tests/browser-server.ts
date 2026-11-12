// Explicitly separate from npm dev/start. Deterministic UI QA; no external calls.
import { resolve } from "node:path";
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createApp, type ResponsesClient } from "../server/app";
import { ConfigStore } from "../server/config";
const client: ResponsesClient = {
  responses: {
    async create(body) {
      return (async function* () {
        let text =
          "**本机模拟回答，用于界面验收。**\n\n导数表示函数在某一点的瞬时变化率。[S1]\n\n$$f^{\\prime}(x)=\\lim_{h\\to0}\\frac{f(x+h)-f(x)}{h}$$\n\n例如 $f(x)=x^2$，则 $f^{\\prime}(x)=2x$。\n\n$$\\begin{pmatrix}1&0\\\\0&1\\end{pmatrix}$$\n\n| 概念 | 含义 |\n| --- | --- |\n| 割线 | 平均变化率 |\n| 切线 | 瞬时变化率 |\n\n```python\ndef derivative(x):\n    return 2 * x\n```\n\n你可以针对这段回答创建分支追问。";
        const asset = JSON.stringify(body).match(/asset:([a-zA-Z0-9-]+)/)?.[1];
        if (asset) text += `\n\n附图：\n\n![原文截图](asset:${asset})`;
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
  configStore: new ConfigStore(
    join(
      await mkdtemp(join(tmpdir(), "inkask-ui-settings-")),
      "providers.json",
    ),
  ),
  clientFactory: () => client,
  apiKey: "test-only-not-a-real-key",
  model: "本机模拟 · 非真实 AI",
  client,
  staticRoot: resolve("dist"),
  logger: false,
});
await app.listen({ host: "127.0.0.1", port: 8790 });
console.log("UI QA fixture: http://127.0.0.1:8790 (no external AI calls)");
