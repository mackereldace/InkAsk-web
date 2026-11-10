import type { ChatRequest } from "./types";
export async function streamChat(
  request: ChatRequest,
  signal: AbortSignal,
  onDelta: (text: string) => void,
) {
  const response = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
    signal,
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(
      body.error?.message ||
        body.message ||
        (typeof body.error === "string" ? body.error : "") ||
        `请求失败 (${response.status})`,
    );
  }
  if (!response.body) throw new Error("浏览器未提供响应流");
  const reader = response.body.getReader(),
    decoder = new TextDecoder();
  let buffer = "",
    complete = false;
  function parse(packet: string) {
    let event = "message";
    const data: string[] = [];
    for (const line of packet.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
    }
    if (!data.length) return;
    const value = JSON.parse(data.join("\n"));
    if (event === "delta") onDelta(value.text ?? value.delta ?? "");
    if (event === "error")
      throw new Error(value.message || value.error || "AI 回答中断");
    if (event === "completed") complete = true;
  }
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done }).replace(/\r\n/g, "\n");
      let p: number;
      while ((p = buffer.indexOf("\n\n")) !== -1) {
        parse(buffer.slice(0, p));
        buffer = buffer.slice(p + 2);
      }
      if (done) break;
    }
    if (buffer.trim()) parse(buffer);
    if (!complete) throw new Error("连接提前结束，已保留部分回答");
  } finally {
    reader.releaseLock();
  }
}
export async function dataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("图片读取失败"));
    reader.readAsDataURL(blob);
  });
}
