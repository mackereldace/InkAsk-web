import { describe, expect, it } from "vitest";
import { sourceEvidencePreview, sourceRectGroups } from "../src/core/source-preview";
import { citationClaimText } from "../src/core/citation-claim";
import type { PageText, Source } from "../src/types";

describe("evidence crops", () => {
  it("separates distant page numbers and captions, and neighboring columns", () => {
    expect(sourceRectGroups([[290,799,300,810],[150,326,530,337]])).toHaveLength(2);
    const groups=sourceRectGroups([[20,700,150,710],[20,680,150,690],[350,700,480,710],[350,680,480,690]]);
    expect(groups).toHaveLength(2);
    expect(groups.map((group)=>group.length)).toEqual([2,2]);
    expect(sourceRectGroups([[20,700,150,710],[20,680,150,690],[50,660,120,670]])).toHaveLength(1);
    expect(sourceRectGroups([[20,700,300,710],[20,680,150,690],[290,660,300,670]])).toHaveLength(1);
    expect(sourceRectGroups([[20,700,180,710],[20,680,150,690],[250,680,260,690]])).toHaveLength(1);
  });
  it("keeps stored evidence anchors authoritative, without sharing another source's anchor", () => {
    const first: Source={id:"S2",page:1,text:"a long proof ".repeat(80),blockId:"proof",label:"T9 · 证明",rects:[[20,200,200,220]]};
    const second: Source={...first,id:"S3",text:"another argument",rects:[[20,200,90,220],[110,200,200,220]]};
    const a=sourceEvidencePreview(first,undefined,"unrelated"),b=sourceEvidencePreview(second);
    expect(a.parts[0].anchor?.rects).toEqual(first.rects);
    expect(b.parts[0].anchor?.rects).toEqual(second.rects);
    expect(a.parts[0].anchor?.quote).toBe(first.text);
    expect(b.parts[0].anchor?.quote).toBe(second.text);
  });
  it("resolves old large contexts into relevant small blocks without rewriting the record", () => {
    const lines=[
      ["T9 一致有界",760,18],
      ["题目5. E 一致有界，且满足 Holder 条件。",730,10],
      ["Pf: 由 Holder 条件得到等度连续，再用 AA 定理。",700,10],
      ["整理者注",660,16],
      ["1. T8 的不动点唯一性，与本题不同。".repeat(24),630,10],
    ] as const;
    const page: PageText={page:1,text:lines.map(([text])=>text).join("\n"),words:lines.map(([text,y,height])=>({text:text+"\n",rect:[20,y,500,y+height]})),width:600,height:800,status:"ready",source:"native"};
    const source:Source={id:"S2",page:1,text:page.text,rects:page.words.map(w=>w.rect)};
    const original=JSON.stringify(source);
    const result=sourceEvidencePreview(source,page,"题设 E 一致有界");
    expect(result.kind).toBe("context");
    expect(result.parts.length).toBeGreaterThan(0);
    expect(result.parts.length).toBeLessThanOrEqual(2);
    expect(result.parts.map(p=>p.text).join(" ")).not.toContain("不动点唯一性");
    expect(result.parts.some(p=>p.label.includes("题设"))).toBe(true);
    const combined=sourceEvidencePreview(source,page,"题设 E 一致有界，证明用 Holder 条件推出等度连续");
    expect(combined.parts.some(p=>p.label.includes("题设"))).toBe(true);
    expect(combined.parts.some(p=>p.label.includes("证明"))).toBe(true);
    expect(JSON.stringify(source)).toBe(original);
  });
  it("shows an explicit text fallback for missing or ambiguous positions", () => {
    const result=sourceEvidencePreview({id:"S2",page:8,text:"unmatched passage"});
    expect(result).toMatchObject({kind:"unresolved",parts:[{text:"unmatched passage"}]});
    expect(result.parts[0].anchor).toBeUndefined();
  });
});

describe("citation assertion context", () => {
  it("retains one TeX formula and excludes citation labels from the assertion", () => {
    expect(citationClaimText({children:[{type:"text",value:"例如 "},{tagName:"span",properties:{className:["katex"]},children:[{tagName:"annotation",children:[{value:"f(x)=x^2"}]},{value:"duplicate rendering"}]},{tagName:"a",properties:{href:"#source-S2"},children:[{value:"[S2]"}]}]})).toBe("例如  f(x)=x^2 ");
  });
});
