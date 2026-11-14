export type Rect = [number, number, number, number];
export type Task = "explain" | "formula" | "summarize" | "translate" | "custom";
export interface WordBox {
  text: string;
  rect: Rect;
  confidence?: number;
}
export interface PageText {
  page: number;
  text: string;
  words: WordBox[];
  source: "native" | "ocr";
  status: "pending" | "ready" | "empty" | "error";
  width: number;
  height: number;
}
export interface AnchorFragment {
  page: number;
  rects: Rect[];
  quote: string;
}
export interface Anchor extends AnchorFragment {
  /** Page-local pieces in document order. Absent for legacy/single-page anchors. */
  fragments?: AnchorFragment[];
}
export interface Source {
  rects?: Rect[];
  id: string;
  page: number;
  text: string;
  /** Evidence metadata is optional so existing answers keep their original sources. */
  blockId?: string;
  label?: string;
  textRange?: [number, number];
}
export interface Asset {
  id: string;
  name: string;
  mime: string;
  data: Blob;
  source?: { page: number; rect?: Rect };
}
export interface HistoryMessage {
  role: "user" | "assistant";
  content: string;
  assetIds?: string[];
}
export interface PromptTemplate {
  id: string;
  name: string;
  task: Task;
  body: string;
  version: number;
}
export interface ContextResult {
  prompt: string;
  sources: Source[];
  coverage: string;
  truncated: boolean;
  history: HistoryMessage[];
}
export interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  assetIds: string[];
  status: "complete" | "streaming" | "stopped" | "error";
  createdAt: number;
  error?: string;
  prompt?: string;
  template?: PromptTemplate;
  sources?: Source[];
  coverage?: string;
  history?: HistoryMessage[];
}
export interface AnswerAnchor {
  start: number;
  end: number;
  quote: string;
}
export interface Note {
  id: string;
  title: string;
  anchor: Anchor;
  parentId?: string;
  parentMessageId?: string;
  branchQuote?: string;
  answerAnchor?: AnswerAnchor;
  sourceAssetId?: string;
  /** Ordered source crops; sourceAssetId remains the first crop for compatibility. */
  sourceAssetIds?: string[];
  inheritedHistory: HistoryMessage[];
  collapsed: boolean;
  task: Task;
  templateId: string;
  draft: string;
  draftAssetIds: string[];
  messages: Message[];
  createdAt: number;
}
export interface InkDocument {
  id: string;
  name: string;
  fingerprint: string;
  pdf: Blob;
  pageCount: number;
  createdAt: number;
  updatedAt: number;
}
export interface Project {
  version: 1;
  document: InkDocument;
  pages: PageText[];
  notes: Note[];
  assets: Asset[];
  templates: PromptTemplate[];
  view: { page: number; scale: number; rotation: number; direction?: "vertical" | "horizontal" };
}
export interface ChatRequest {
  prompt: string;
  history: { role: "user" | "assistant"; content: string; images?: string[] }[];
  images: string[];
}
export interface ApiStatus {
  configured: boolean;
  model: string;
  contextBudget: number;
  providerId?: string;
  supportsImages?: boolean;
}

export type ApiProtocol = "responses" | "chat-completions" | "anthropic";
export interface ProviderDefinition {
  id: string;
  name: string;
  shortName: string;
  baseURL: string;
  protocol: ApiProtocol;
  models: string[];
  supportsImages: boolean;
  requiresKey: boolean;
  docsURL: string;
  alternateURLs?: { name: string; url: string }[];
  hint?: string;
}
export interface ProviderProfile {
  providerId: string;
  baseURL: string;
  model: string;
  protocol: ApiProtocol;
  supportsImages: boolean;
  hasKey: boolean;
}
export interface ProviderSettings {
  providers: ProviderDefinition[];
  profiles: ProviderProfile[];
  activeProviderId: string | null;
}
export interface ProviderConfigInput {
  providerId: string;
  baseURL: string;
  model: string;
  protocol: ApiProtocol;
  supportsImages: boolean;
  apiKey?: string;
}
