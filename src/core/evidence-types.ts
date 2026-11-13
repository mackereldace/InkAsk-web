import type { Rect } from "../types";

export type EvidenceRole = "theorem" | "proof" | "definition" | "note" | "body" | "heading" | "caption" | "marginal";
export interface EvidenceBlock {
  id: string;
  page: number;
  text: string;
  /** UTF-16 offsets in the unchanged PageText.text. */
  start: number;
  end: number;
  rects: Rect[];
  role: EvidenceRole;
  label: string;
  section?: string;
}
