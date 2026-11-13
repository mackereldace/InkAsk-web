export interface SelectionBox { left: number; top: number; right: number; bottom: number }

/** Resolve only blank space; a real text run always remains browser-owned. */
export function blankTextTarget<T extends SelectionBox>(
  lines: readonly (readonly T[])[], point: { x: number; y: number }, travel: -1 | 0 | 1, vertical = false,
): T | undefined {
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return;
  const primary = vertical ? point.x : point.y, inline = vertical ? point.y : point.x;
  const start = (box: SelectionBox) => vertical ? box.left : box.top;
  const end = (box: SelectionBox) => vertical ? box.right : box.bottom;
  const inlineStart = (box: SelectionBox) => vertical ? box.top : box.left;
  const inlineEnd = (box: SelectionBox) => vertical ? box.bottom : box.right;
  const inlineDistance = (box: SelectionBox) => Math.max(inlineStart(box) - inline, inline - inlineEnd(box), 0);
  const valid = (box: T) => [box.left, box.top, box.right, box.bottom].every(Number.isFinite) && box.right >= box.left && box.bottom >= box.top;
  const rows = lines.map(line => line.filter(valid)).filter(line => line.length).map(line => ({
    line,
    start: Math.min(...line.map(start)),
    end: Math.max(...line.map(end)),
    inlineDistance: Math.min(...line.map(inlineDistance)),
  })).sort((a, b) => a.start - b.start || a.end - b.end);
  if (!rows.length || rows.some(row => row.line.some(box => point.x >= box.left && point.x <= box.right && point.y >= box.top && point.y <= box.bottom))) return;
  const centerDistance = (row: typeof rows[number]) => Math.abs((row.start + row.end) / 2 - primary);
  const overlapping = rows.filter(row => primary >= row.start && primary <= row.end)
    .sort((a, b) => centerDistance(a) - centerDistance(b) || a.inlineDistance - b.inlineDistance);
  let row = overlapping[0];
  if (!row) {
    const before = rows.filter(candidate => candidate.end < primary).sort((a, b) => b.end - a.end || centerDistance(a) - centerDistance(b))[0];
    const after = rows.filter(candidate => candidate.start > primary).sort((a, b) => a.start - b.start || centerDistance(a) - centerDistance(b))[0];
    row = travel > 0 ? after ?? before : travel < 0 ? before ?? after
      : !before ? after : !after ? before
      : primary - before.end <= after.start - primary ? before : after;
  }
  return row?.line.reduce((nearest, box) => inlineDistance(box) < inlineDistance(nearest) ? box : nearest);
}
