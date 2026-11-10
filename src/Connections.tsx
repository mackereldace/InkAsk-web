import { useLayoutEffect, useRef, useState } from "react";
import { screenRect, type PageViewport } from "./pdf";
import type { Note } from "./types";
export default function Connections({
  notes,
  viewport,
}: {
  notes: Note[];
  viewport?: PageViewport;
}) {
  const ref = useRef<SVGSVGElement>(null),
    [paths, setPaths] = useState<string[]>([]);
  useLayoutEffect(() => {
    const spread = ref.current?.parentElement,
      paper = spread?.querySelector(".pdf-page");
    if (!spread || !paper || !viewport) return;
    const measure = () => {
      const box = spread.getBoundingClientRect(),
        page = paper.getBoundingClientRect();
      const next = notes.flatMap((n) => {
        const card = document.getElementById(`note-${n.id}`);
        if (!card || !spread.contains(card)) return [];
        const target = card.getBoundingClientRect(),
          r = screenRect(viewport, n.anchor.rects[0]);
        const x1 = page.right - box.left,
          y1 = page.top - box.top + (r[1] + r[3]) / 2,
          x2 = target.left - box.left,
          y2 = target.top - box.top + 23,
          m = (x1 + x2) / 2;
        return [`M ${x1} ${y1} C ${m} ${y1}, ${m} ${y2}, ${x2} ${y2}`];
      });
      setPaths((p) => (p.join("|") === next.join("|") ? p : next));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(spread);
    for (const note of notes) {
      const el = document.getElementById(`note-${note.id}`);
      if (el) observer.observe(el);
    }
    return () => observer.disconnect();
  }, [notes, viewport]);
  return (
    <svg ref={ref} className="connection-lines" aria-hidden="true">
      {paths.map((d, i) => (
        <path key={i} d={d} />
      ))}
    </svg>
  );
}
