import { randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  unlink,
} from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type {
  ApiProtocol,
  ProviderProfile,
  ProviderSettings,
} from "../src/types.js";
import {
  getProvider,
  PROVIDERS,
  type PrivateProviderConfig,
} from "./provider-catalog.js";

const STORE_VERSION = 1;
const MAX_CONFIG_BYTES = 512 * 1024;
const MAX_API_KEY_LENGTH = 16_384;
const MAX_MODEL_LENGTH = 256;
const MAX_BASE_URL_LENGTH = 2_048;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;
const PROTOCOLS = new Set<ApiProtocol>([
  "responses",
  "chat-completions",
  "anthropic",
]);

interface StoredState {
  version: 1;
  activeProviderId: string | null;
  profiles: Record<string, PrivateProviderConfig>;
}

export interface ConfigSnapshot {
  settings: ProviderSettings;
  activeConfig: PrivateProviderConfig | null;
  hasProfiles: boolean;
}

export interface SettingsStore {
  snapshot(): Promise<ConfigSnapshot>;
  prepare(input: unknown): Promise<PrivateProviderConfig>;
  save(input: unknown): Promise<ProviderSettings>;
  remove(providerId: unknown): Promise<ProviderSettings>;
}

export class ConfigValidationError extends Error {
  constructor(message: string) {
    super(message);
  }
}

export class ConfigStoreError extends Error {
  constructor() {
    super("Settings storage is unavailable.");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(
  value: unknown,
  field: string,
  maxLength: number,
): string {
  if (
    typeof value !== "string" ||
    value.length > maxLength ||
    CONTROL_CHARACTER.test(value)
  ) {
    throw new ConfigValidationError(`${field}不符合要求。`);
  }
  return value;
}

export function normalizeBaseURL(value: unknown): string {
  const raw = requireString(
    value,
    "服务地址",
    MAX_BASE_URL_LENGTH,
  ).trim();
  if (!raw) throw new ConfigValidationError("请填写服务地址。");

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigValidationError("服务地址格式无效。");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new ConfigValidationError("服务地址必须使用 HTTPS 或本机 HTTP。");
  }
  if (
    url.protocol === "http:" &&
    !["localhost", "127.0.0.1", "[::1]", "::1"].includes(url.hostname)
  ) {
    throw new ConfigValidationError("HTTP 服务地址只能指向本机回环地址。");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new ConfigValidationError("服务地址不能包含账号、查询参数或片段。");
  }

  let pathname = url.pathname.replace(/\/+$/, "");
  for (const suffix of ["/chat/completions", "/responses", "/messages"]) {
    if (pathname.endsWith(suffix)) {
      pathname = pathname.slice(0, -suffix.length).replace(/\/+$/, "");
      break;
    }
  }
  return `${url.origin}${pathname}`;
}

function normalizeInput(
  value: unknown,
  existing?: PrivateProviderConfig,
): PrivateProviderConfig {
  if (!isRecord(value)) {
    throw new ConfigValidationError("设置内容格式无效。");
  }

  const providerId = requireString(value.providerId, "服务商", 80).trim();
  const provider = getProvider(providerId);
  if (!provider) throw new ConfigValidationError("不支持该服务商。");

  const baseURL = normalizeBaseURL(value.baseURL);
  const model = requireString(value.model, "模型", MAX_MODEL_LENGTH).trim();
  if (!model) throw new ConfigValidationError("请填写模型。");

  if (
    typeof value.protocol !== "string" ||
    !PROTOCOLS.has(value.protocol as ApiProtocol)
  ) {
    throw new ConfigValidationError("API 协议不受支持。");
  }
  if (typeof value.supportsImages !== "boolean") {
    throw new ConfigValidationError("图片支持设置无效。");
  }

  let apiKey = "";
  if (value.apiKey !== undefined) {
    apiKey = requireString(
      value.apiKey,
      "API Key",
      MAX_API_KEY_LENGTH,
    ).trim();
  }
  if (apiKey && CONTROL_CHARACTER.test(apiKey)) {
    throw new ConfigValidationError("API Key 格式无效。");
  }

  const sameEndpoint =
    existing?.providerId === providerId && existing.baseURL === baseURL;
  if (!apiKey && sameEndpoint) apiKey = existing.apiKey;
  if (
    !apiKey &&
    existing?.apiKey &&
    existing.providerId === providerId &&
    existing.baseURL !== baseURL
  ) {
    throw new ConfigValidationError("服务地址变更后需要重新填写 API Key。");
  }
  if (provider.requiresKey && !apiKey) {
    throw new ConfigValidationError("该服务商需要 API Key。");
  }

  return {
    providerId,
    baseURL,
    model,
    protocol: value.protocol as ApiProtocol,
    supportsImages: value.supportsImages,
    apiKey,
  };
}

function validateStoredConfig(
  providerId: string,
  value: unknown,
): PrivateProviderConfig {
  if (!isRecord(value)) throw new ConfigStoreError();
  try {
    const normalized = normalizeInput({
      providerId,
      baseURL: value.baseURL,
      model: value.model,
      protocol: value.protocol,
      supportsImages: value.supportsImages,
      apiKey: value.apiKey,
    });
    if (typeof value.apiKey !== "string") throw new ConfigStoreError();
    return normalized;
  } catch (error) {
    if (error instanceof ConfigStoreError) throw error;
    throw new ConfigStoreError();
  }
}

function parseStoredState(value: unknown): StoredState {
  if (!isRecord(value) || value.version !== STORE_VERSION) {
    throw new ConfigStoreError();
  }
  if (
    value.activeProviderId !== null &&
    typeof value.activeProviderId !== "string"
  ) {
    throw new ConfigStoreError();
  }
  if (!isRecord(value.profiles)) throw new ConfigStoreError();

  const entries = Object.entries(value.profiles);
  if (entries.length > PROVIDERS.length) throw new ConfigStoreError();
  const profiles: Record<string, PrivateProviderConfig> = {};
  for (const [providerId, profile] of entries) {
    if (
      !getProvider(providerId) ||
      (profile as { providerId?: unknown })?.providerId !== providerId
    ) {
      throw new ConfigStoreError();
    }
    profiles[providerId] = validateStoredConfig(providerId, profile);
  }
  const activeProviderId = value.activeProviderId as string | null;
  if (
    activeProviderId !== null &&
    !Object.prototype.hasOwnProperty.call(profiles, activeProviderId)
  ) {
    throw new ConfigStoreError();
  }
  return { version: STORE_VERSION, activeProviderId, profiles };
}

function sanitizeProfile(profile: PrivateProviderConfig): ProviderProfile {
  return {
    providerId: profile.providerId,
    baseURL: profile.baseURL,
    model: profile.model,
    protocol: profile.protocol,
    supportsImages: profile.supportsImages,
    hasKey: Boolean(profile.apiKey),
  };
}

function sanitizeState(state: StoredState): ProviderSettings {
  const profiles = PROVIDERS.flatMap((provider) => {
    const profile = state.profiles[provider.id];
    return profile ? [sanitizeProfile(profile)] : [];
  });
  return {
    providers: PROVIDERS,
    profiles,
    activeProviderId: state.activeProviderId,
  };
}

function emptyState(): StoredState {
  return { version: STORE_VERSION, activeProviderId: null, profiles: {} };
}

export class ConfigStore implements SettingsStore {
  readonly filePath: string;
  private state: StoredState | undefined;
  private loading: Promise<StoredState> | undefined;
  private corrupt = false;
  private saveQueue: Promise<void> = Promise.resolve();

  constructor(filePath: string) {
    this.filePath = resolve(filePath);
  }

  private async load(): Promise<StoredState> {
    if (this.state) return this.state;
    if (this.corrupt) throw new ConfigStoreError();
    if (this.loading) return this.loading;

    this.loading = (async () => {
      const directory = dirname(this.filePath);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await chmod(directory, 0o700);

      let metadata: Awaited<ReturnType<typeof lstat>>;
      try {
        metadata = await lstat(this.filePath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          this.state = emptyState();
          return this.state;
        }
        this.corrupt = true;
        throw new ConfigStoreError();
      }
      if (!metadata.isFile() || metadata.size > MAX_CONFIG_BYTES) {
        this.corrupt = true;
        throw new ConfigStoreError();
      }

      await chmod(this.filePath, 0o600);
      try {
        const raw = await readFile(this.filePath, "utf8");
        if (Buffer.byteLength(raw, "utf8") > MAX_CONFIG_BYTES) {
          throw new ConfigStoreError();
        }
        const parsed = JSON.parse(raw);
        this.state = parseStoredState(parsed);
        return this.state;
      } catch {
        this.corrupt = true;
        throw new ConfigStoreError();
      }
    })().finally(() => {
      this.loading = undefined;
    });
    return this.loading;
  }

  private async write(state: StoredState): Promise<void> {
    const directory = dirname(this.filePath);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    const temporary = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(temporary, "wx", 0o600);
      await handle.writeFile(JSON.stringify(state), "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await chmod(temporary, 0o600);
      await rename(temporary, this.filePath);
      await chmod(this.filePath, 0o600);
    } catch {
      await handle?.close().catch(() => undefined);
      await unlink(temporary).catch(() => undefined);
      throw new ConfigStoreError();
    }
  }

  private async withSave<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.saveQueue;
    let release!: () => void;
    this.saveQueue = new Promise<void>((resolveNext) => {
      release = resolveNext;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  async prepare(input: unknown): Promise<PrivateProviderConfig> {
    const state = await this.load();
    const providerId =
      isRecord(input) && typeof input.providerId === "string"
        ? input.providerId.trim()
        : "";
    return normalizeInput(input, state.profiles[providerId]);
  }

  async save(input: unknown): Promise<ProviderSettings> {
    return this.withSave(async () => {
      const state = await this.load();
      const providerId =
        isRecord(input) && typeof input.providerId === "string"
          ? input.providerId.trim()
          : "";
      const profile = normalizeInput(input, state.profiles[providerId]);
      const next: StoredState = {
        version: STORE_VERSION,
        activeProviderId: profile.providerId,
        profiles: { ...state.profiles, [profile.providerId]: profile },
      };
      await this.write(next);
      this.state = next;
      return sanitizeState(next);
    });
  }

  async remove(providerId: unknown): Promise<ProviderSettings> {
    return this.withSave(async () => {
      const id = requireString(providerId, "服务商", 80).trim();
      if (!getProvider(id)) {
        throw new ConfigValidationError("不支持该服务商。");
      }
      const state = await this.load();
      const profiles = { ...state.profiles };
      delete profiles[id];
      const next: StoredState = {
        version: STORE_VERSION,
        activeProviderId:
          state.activeProviderId === id ? null : state.activeProviderId,
        profiles,
      };
      await this.write(next);
      this.state = next;
      return sanitizeState(next);
    });
  }

  async snapshot(): Promise<ConfigSnapshot> {
    const state = await this.load();
    const storedActive = state.activeProviderId
      ? state.profiles[state.activeProviderId]
      : null;
    return {
      settings: sanitizeState(state),
      activeConfig: storedActive ? { ...storedActive } : null,
      hasProfiles: Object.keys(state.profiles).length > 0,
    };
  }
}
