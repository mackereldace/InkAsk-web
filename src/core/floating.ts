export interface ScreenBox { left: number; top: number; right: number; bottom: number }
export function floatingPosition(anchor: ScreenBox, size: { width: number; height: number }, boundary: ScreenBox, gap = 10) {
  const inset = 8;
  const width = Math.max(1, Math.min(size.width, boundary.right - boundary.left - inset * 2));
  const height = Math.max(1, Math.min(size.height, boundary.bottom - boundary.top - inset * 2));
  const below = boundary.bottom - anchor.bottom - gap - inset;
  const above = anchor.top - boundary.top - gap - inset;
  const side = below >= height || below >= above ? "below" : "above";
  const top = side === "below" ? anchor.bottom + gap : anchor.top - gap - height;
  return { width, maxHeight: boundary.bottom - boundary.top - inset * 2,
    left: Math.max(boundary.left + inset, Math.min(anchor.left, boundary.right - width - inset)),
    top: Math.max(boundary.top + inset, Math.min(top, boundary.bottom - height - inset)), side };
}
