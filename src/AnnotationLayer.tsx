import type { ReactNode } from "react";
import type { Rect } from "./types";

export interface ReadingAnnotation {
  id: string;
  title: string;
  rects: Rect[];
  preview?: ReactNode;
}

/** Identical entry markers and highlights for PDF pages and answer documents. */
export default function AnnotationLayer({ annotations, width, activeId, onFocus }: {
  annotations: ReadingAnnotation[];
  width: number;
  activeId?: string;
  onFocus: (id: string) => void;
}) {
  const used: number[] = [];
  return <div className="annotation-layer" aria-label="原处便签">
    {annotations.map((annotation, index) => {
      let top = Math.max(0, (annotation.rects[0]?.[1] ?? index * 32) - 4);
      while (used.some((value) => Math.abs(value - top) < 27)) top += 28;
      used.push(top);
      return <div key={annotation.id} className="annotation-item" data-annotation-id={annotation.id}>
        {annotation.rects.map((rect, rectIndex) => <div key={rectIndex} className={"highlight " + (annotation.id === activeId ? "active" : "")}
          style={{ left: rect[0], top: rect[1], width: rect[2] - rect[0], height: rect[3] - rect[1] }} />)}
        <button className={"anchor-dot " + (annotation.id === activeId ? "active" : "")} style={{ top, left: Math.max(0, width - 26) }}
          onClick={() => onFocus(annotation.id)} aria-label={`打开便签 ${index + 1}：${annotation.title}`}
          aria-describedby={annotation.preview ? `annotation-preview-${annotation.id}` : undefined}>
          {index + 1}
        </button>
        {annotation.preview && <div id={`annotation-preview-${annotation.id}`} role="tooltip" className="annotation-preview" style={{ top, right: 34 }}>
          {annotation.preview}
        </div>}
      </div>;
    })}
  </div>;
}
