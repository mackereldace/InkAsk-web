interface ClaimNode { type?: string; value?: string; tagName?: string; properties?: Record<string, unknown>; children?: ClaimNode[] }
const annotation = (node: ClaimNode): string | undefined => node.tagName === "annotation" ? node.children?.map((child) => child.value ?? "").join("") : node.children?.map(annotation).find((value) => value !== undefined);
/** Read the surrounding assertion, keeping one TeX representation for each formula. */
export function citationClaimText(node?: ClaimNode): string {
  if (!node) return "";
  if (node.tagName === "a" && String(node.properties?.href ?? "").startsWith("#source-")) return "";
  const classes = node.properties?.className;
  if (Array.isArray(classes) && classes.includes("katex")) return ` ${annotation(node) ?? ""} `;
  return node.value ?? node.children?.map(citationClaimText).join("") ?? "";
}
