import type { Anchor, AnchorFragment } from "../types";

/** Validated multi-page anchors retain their first-page legacy fields. */
export function anchorFragments(anchor: Anchor): AnchorFragment[] {
  return anchor.fragments ?? [anchor];
}

export function anchorPage(anchor: Anchor, page: number): AnchorFragment | undefined {
  return anchorFragments(anchor).find(fragment => fragment.page === page);
}

export function clonePdfAnchor(anchor: Anchor, remapQuote: (text: string) => string = text => text): Anchor {
  const cloneFragment = (fragment: AnchorFragment): AnchorFragment => ({
    page: fragment.page,
    rects: fragment.rects.map(rect => [...rect]),
    quote: remapQuote(fragment.quote),
  });
  return {
    ...cloneFragment(anchor),
    ...(anchor.fragments ? { fragments: anchor.fragments.map(cloneFragment) } : {}),
  };
}

export function anchorPagesLabel(anchor: Anchor): string {
  const pages = anchorFragments(anchor).map(fragment => fragment.page);
  if (pages.length === 1) return `第 ${pages[0]} 页`;
  const consecutive = pages.every((page, index) => index === 0 || page === pages[index - 1] + 1);
  return `第 ${consecutive ? `${pages[0]}–${pages.at(-1)}` : pages.join("、")} 页`;
}
