import { useEffect, useRef, useState } from "react";
import {
  Check,
  ChevronDown,
  ExternalLink,
  KeyRound,
  Loader2,
  PlugZap,
  RotateCcw,
  ShieldCheck,
  Sparkles,
  Trash2,
} from "lucide-react";
import type {
  ApiStatus,
  ProviderConfigInput,
  ProviderDefinition,
  ProviderSettings,
} from "./types";

async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const headers = new Headers(options?.headers);
  if (options?.body != null && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const r = await fetch(path, {
    ...options,
    headers,
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok || body.ok === false)
    throw new Error(
      typeof body.message === "string"
        ? body.message
        : "暂时无法完成操作，请稍后重试。",
    );
  return body;
}
export default function ApiSettings({
  status,
  onChange,
}: {
  status: ApiStatus;
  onChange: (status: ApiStatus) => void;
}) {
  const [snapshot, setSnapshot] = useState<ProviderSettings>(),
    [selected, setSelected] = useState(""),
    [form, setForm] = useState<ProviderConfigInput>(),
    [key, setKey] = useState(""),
    [busy, setBusy] = useState<"save" | "test" | "clear">(),
    [result, setResult] = useState<{ ok: boolean; text: string }>(),
    [error, setError] = useState("");
  const generation = useRef(0);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    const load = ++generation.current;
    void api<ProviderSettings>("/api/settings")
      .then((s) => {
        if (!alive.current || load !== generation.current) return;
        setSnapshot(s);
        choose(s.activeProviderId ?? s.providers[0]?.id, s);
      })
      .catch(() => {
        if (alive.current)
          setError("无法读取模型设置。请确认本地 API 服务已运行，然后重试。");
      });
    return () => {
      alive.current = false;
      generation.current++;
    };
  }, []);
  function choose(id: string, s = snapshot) {
    if (!s) return;
    const p = s.providers.find((p) => p.id === id);
    if (!p) return;
    const saved = s.profiles.find((x) => x.providerId === id);
    generation.current++;
    setSelected(id);
    setForm({
      providerId: id,
      baseURL: saved?.baseURL ?? p.baseURL,
      model: saved?.model ?? p.models[0] ?? "",
      protocol: saved?.protocol ?? p.protocol,
      supportsImages: saved?.supportsImages ?? p.supportsImages,
    });
    setKey("");
    setResult(undefined);
    setError("");
  }
  const provider = snapshot?.providers.find((p) => p.id === selected),
    saved = snapshot?.profiles.find((p) => p.providerId === selected);
  const savedEndpoint =
    saved?.baseURL.replace(/\/+$/, "") ===
    form?.baseURL.trim().replace(/\/+$/, "");
  const hasKey = Boolean(saved?.hasKey && savedEndpoint);
  const needsKey = Boolean(provider?.requiresKey && !hasKey && !key.trim());
  function edit(changes: Partial<ProviderConfigInput>) {
    setForm((f) => (f ? { ...f, ...changes } : f));
    setResult(undefined);
  }
  function payload() {
    return { ...form!, ...(key.trim() ? { apiKey: key.trim() } : {}) };
  }
  async function action(kind: "save" | "test" | "clear") {
    if (!form || !provider || busy) return;
    setBusy(kind);
    setResult(undefined);
    setError("");
    const epoch = generation.current;
    try {
      if (kind === "test") {
        const r = await api<{
          ok: boolean;
          message: string;
          latencyMs: number;
        }>("/api/settings/test", {
          method: "POST",
          body: JSON.stringify(payload()),
        });
        if (epoch === generation.current && alive.current)
          setResult({
            ok: true,
            text: `${r.message || "连接成功"}${Number.isFinite(r.latencyMs) ? ` · ${(r.latencyMs / 1000).toFixed(1)} 秒` : ""}（尚未保存）`,
          });
      } else {
        const s = await api<ProviderSettings>(
          kind === "clear"
            ? `/api/settings/${encodeURIComponent(selected)}`
            : "/api/settings",
          {
            method: kind === "clear" ? "DELETE" : "PUT",
            ...(kind === "clear" ? {} : { body: JSON.stringify(payload()) }),
          },
        );
        const currentStatus = await api<ApiStatus>("/api/status");
        onChange(currentStatus);
        if (!alive.current) return;
        setSnapshot(s);
        if (epoch === generation.current) {
          choose(selected, s);
          setResult({
            ok: true,
            text:
              kind === "clear"
                ? "已清除该服务商的本机配置。"
                : "已保存并启用，可直接在便签中提问。",
          });
        }
      }
    } catch (e) {
      if (epoch === generation.current && alive.current)
        setResult({
          ok: false,
          text: e instanceof Error ? e.message : "操作失败，请重试。",
        });
    } finally {
      if (alive.current) setBusy(undefined);
    }
  }
  if (!snapshot)
    return (
      <div className="api-loading" role="status">
        {error ? (
          <>
            <span>{error}</span>
            <button
              className="secondary"
              onClick={() => {
                setError("");
                void api<ProviderSettings>("/api/settings")
                  .then((s) => {
                    setSnapshot(s);
                    choose(s.activeProviderId ?? s.providers[0]?.id, s);
                  })
                  .catch(() => setError("仍无法连接本地服务，请重启 InkAsk。"));
              }}
            >
              重新连接
            </button>
          </>
        ) : (
          <>
            <Loader2 size={17} className="spin" />
            正在读取模型设置…
          </>
        )}
      </div>
    );
  if (!provider || !form) return null;
  const valid = Boolean(form.baseURL.trim() && form.model.trim() && !needsKey);
  return (
    <section className="api-settings" aria-label="API 服务配置">
      <div className="api-section-heading">
        <div>
          <h3>模型服务</h3>
          <p>选好服务商，填入密钥，就可以开始对话。</p>
        </div>
        <span
          className={
            "connection-pill " + (status.configured ? "configured" : "")
          }
        >
          <span className="status-dot" />
          {status.configured ? "已配置" : "待配置"}
        </span>
      </div>
      <div className="provider-layout">
        <nav className="provider-list" aria-label="选择 AI 服务商">
          {snapshot.providers.map((p) => (
            <button
              type="button"
              key={p.id}
              className={
                "provider-item " + (selected === p.id ? "selected" : "")
              }
              disabled={Boolean(busy)}
              onClick={() => choose(p.id)}
              aria-pressed={selected === p.id}
            >
              <span className={"provider-logo provider-" + p.id}>
                {p.shortName}
              </span>
              <span className="provider-label">
                {p.name}
                {snapshot.activeProviderId === p.id ? (
                  <small>使用中</small>
                ) : snapshot.profiles.some((s) => s.providerId === p.id) ? (
                  <small>已保存</small>
                ) : null}
              </span>
              {selected === p.id && <ChevronDown size={11} />}
            </button>
          ))}
        </nav>
        <div className="provider-form">
          <div className="provider-form-heading">
            <span className={"provider-logo large provider-" + provider.id}>
              {provider.shortName}
            </span>
            <div>
              <h4>{provider.name}</h4>
              <span>
                {saved?.hasKey
                  ? "密钥已安全保存于本机"
                  : provider.requiresKey
                    ? "使用你自己的 API Key"
                    : "本地或自定义模型服务"}
              </span>
            </div>
            {provider.docsURL && (
              <a
                href={provider.docsURL}
                target="_blank"
                rel="noreferrer"
                title="打开服务商文档"
              >
                <ExternalLink size={14} />
              </a>
            )}
          </div>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void action("save");
            }}
            autoComplete="off"
          >
            <label className="api-field">
              <span>
                API 密钥 {!provider.requiresKey && <small>可选</small>}
                {hasKey && (
                  <span className="field-saved">
                    <Check size={11} />
                    已保存
                  </span>
                )}
              </span>
              <div className="key-input">
                <KeyRound size={14} />
                <input
                  aria-label="API 密钥"
                  type="password"
                  name="inkask-provider-key"
                  autoComplete="new-password"
                  spellCheck={false}
                  value={key}
                  disabled={Boolean(busy)}
                  placeholder={
                    hasKey
                      ? "已保存 · 填写新密钥可替换"
                      : provider.requiresKey
                        ? "粘贴此服务商的 API Key"
                        : "通常无需填写"
                  }
                  onChange={(e) => {
                    setKey(e.target.value);
                    setResult(undefined);
                  }}
                />
              </div>
            </label>
            {!savedEndpoint && saved?.hasKey && (
              <p className="api-field-hint">
                地址已改变，请重新填写密钥后保存。
              </p>
            )}
            <label className="api-field">
              <span>模型名称</span>
              <input
                aria-label="模型名称"
                type="text"
                list={`models-${provider.id}`}
                autoComplete="off"
                spellCheck={false}
                placeholder="输入服务商控制台中的模型 ID"
                value={form.model}
                disabled={Boolean(busy)}
                onChange={(e) => edit({ model: e.target.value })}
              />
              <datalist id={`models-${provider.id}`}>
                {provider.models.map((m) => (
                  <option key={m} value={m} />
                ))}
              </datalist>
            </label>
            {!!provider.models.length && (
              <div className="model-suggestions">
                {provider.models.slice(0, 3).map((m) => (
                  <button
                    key={m}
                    type="button"
                    disabled={Boolean(busy)}
                    className={form.model === m ? "selected" : ""}
                    onClick={() => edit({ model: m })}
                  >
                    {m}
                  </button>
                ))}
              </div>
            )}
            <div className="endpoint-preview">
              <div>
                <span>接口地址</span>
                {form.baseURL === provider.baseURL && (
                  <small>
                    <Sparkles size={10} />
                    自动填写
                  </small>
                )}
              </div>
              <code>{form.baseURL || "在高级设置中填写你的接口地址"}</code>
              {provider.alternateURLs && (
                <select
                  aria-label="接口地域"
                  disabled={Boolean(busy)}
                  value={
                    [
                      provider.baseURL,
                      ...provider.alternateURLs.map((a) => a.url),
                    ].includes(form.baseURL)
                      ? form.baseURL
                      : "custom"
                  }
                  onChange={(e) => {
                    if (e.target.value !== "custom")
                      edit({ baseURL: e.target.value });
                  }}
                >
                  <option value={provider.baseURL}>默认地域</option>
                  {provider.alternateURLs.map((a) => (
                    <option value={a.url} key={a.url}>
                      {a.name}
                    </option>
                  ))}
                  <option value="custom" disabled>
                    自定义地址
                  </option>
                </select>
              )}
            </div>
            {provider.hint && <p className="api-field-hint">{provider.hint}</p>}
            <details
              key={provider.id}
              className="api-advanced"
              open={provider.id === "custom" ? true : undefined}
            >
              <summary>
                高级设置 <ChevronDown size={12} />
              </summary>
              <label className="api-field">
                <span>
                  Base URL
                  <button
                    type="button"
                    className="restore-url"
                    disabled={!provider.baseURL || Boolean(busy)}
                    onClick={() =>
                      edit({
                        baseURL: provider.baseURL,
                        protocol: provider.protocol,
                      })
                    }
                  >
                    <RotateCcw size={10} />
                    恢复默认
                  </button>
                </span>
                <input
                  aria-label="Base URL"
                  spellCheck={false}
                  placeholder="https://your-api.example/v1"
                  value={form.baseURL}
                  disabled={Boolean(busy)}
                  onChange={(e) => edit({ baseURL: e.target.value })}
                />
              </label>
              <label className="api-field">
                <span>接口类型</span>
                <select
                  aria-label="接口类型"
                  value={form.protocol}
                  disabled={Boolean(busy)}
                  onChange={(e) =>
                    edit({
                      protocol: e.target
                        .value as ProviderConfigInput["protocol"],
                    })
                  }
                >
                  <option value="chat-completions">
                    OpenAI 兼容 · 标准对话
                  </option>
                  <option value="responses">OpenAI Responses</option>
                  <option value="anthropic">Anthropic Messages</option>
                </select>
              </label>
            </details>
            <label className="vision-switch">
              <input
                type="checkbox"
                checked={form.supportsImages}
                disabled={Boolean(busy)}
                onChange={(e) => edit({ supportsImages: e.target.checked })}
              />
              <span>
                此模型支持图片输入<small>用于文档截图、图表和公式识别</small>
              </span>
            </label>
            {result && (
              <div
                role={result.ok ? "status" : "alert"}
                className={"api-result " + (result.ok ? "success" : "failure")}
              >
                {result.ok ? <Check size={14} /> : <span>!</span>}
                <span>{result.text}</span>
              </div>
            )}
            <div className="api-actions">
              <button
                type="button"
                className="secondary"
                disabled={!valid || Boolean(busy)}
                onClick={() => void action("test")}
              >
                {busy === "test" ? (
                  <Loader2 className="spin" size={14} />
                ) : (
                  <PlugZap size={14} />
                )}
                测试连接
              </button>
              <button
                type="submit"
                className="primary"
                disabled={!valid || Boolean(busy)}
              >
                {busy === "save" ? (
                  <Loader2 className="spin" size={14} />
                ) : (
                  <Check size={14} />
                )}
                保存并使用
              </button>
            </div>
            {saved && (
              <button
                type="button"
                className="clear-provider"
                disabled={Boolean(busy)}
                onClick={() => void action("clear")}
              >
                <Trash2 size={11} />
                清除此服务商的本机配置
              </button>
            )}
          </form>
        </div>
      </div>
      <p className="api-privacy">
        <ShieldCheck size={13} />
        <span>
          密钥仅保存在本机服务，不随
          PDF、便签或项目备份导出。测试连接会向选定服务发送一条简短请求。
        </span>
      </p>
    </section>
  );
}
