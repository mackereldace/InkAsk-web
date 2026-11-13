import { describe, expect, it } from "vitest";
import { anchorEvidenceBlocks, pageEvidenceBlocks } from "../src/core/evidence-blocks";
import type { PageText, Rect } from "../src/types";

type Run = {text: string; rect: Rect};
const run = (text: string, y: number, x = 40, width = 500, height = 10): Run => ({text,rect:[x,y,x+width,y+height]});
function page(runs: Run[], overrides: Partial<PageText> = {}): PageText {
  return {page:3,text:runs.map(r=>r.text).join(""),words:runs,source:"native",status:"ready",width:600,height:840,...overrides};
}
const box = (rects: Rect[]) => rects.reduce((a,b)=>[Math.min(a[0],b[0]),Math.min(a[1],b[1]),Math.max(a[2],b[2]),Math.max(a[3],b[3])] as Rect);

describe("page evidence blocks", () => {
  it("separates heading, theorem, complete proof and editor notes with unchanged source ranges", () => {
    const p=page([
      run("T9：一致有界与连续函数族\n",760,100,330,15),
      run("题目 5：设函数族一致有界，且满足 Hölder 条件。\n",730),
      run("∀f∈E, |f(s)-f(t)| ≤ Cρ(s,t)^α。\n",708,100,350),
      run("求证该函数族列紧。\n",686),
      run("Pf: 对任意 ε>0，令 δ=(ε/C)^(1/α)。\n",650),
      run("于是 |f(s)-f(t)|<Cδ^α=ε。\n",620,120,330),
      run("∴ E 等度连续，结合题设与 AA 定理，E 列紧。",590),
      run("□\n",590,555,8),
      run("整理者注（待核对）\n",540,160,280,15),
      run("1. T9 原稿漏写指数，正文已经补正。\n",510),
      run("2. T5 使用 Arzelà–Ascoli 定理。",490),
    ]);
    const blocks=pageEvidenceBlocks(p);
    expect(blocks.map(b=>b.role)).toEqual(["heading","theorem","proof","note","note","note"]);
    expect(blocks.find(b=>b.role==="theorem")?.label).toBe("T9 · 题设");
    const proof=blocks.find(b=>b.role==="proof")!;
    expect(proof.text).toContain("δ=(ε/C)^(1/α)");
    expect(proof.text).toContain("E 列紧。□");
    expect(proof.label).toBe("T9 · 证明");
    for(const [index,b] of blocks.entries()){
      expect(b.text).toBe(p.text.slice(b.start,b.end));
      expect(b.rects.length).toBeGreaterThan(0);
      if(index)expect(b.start).toBeGreaterThanOrEqual(blocks[index-1].end);
    }
  });
  it("keeps page numbers and picture captions out of one large spatial block", () => {
    const p=page([run("6 ",800,525,8),run("原图 3 第3页：某个定理的手写原稿",300,140,350)],{page:6});
    const blocks=pageEvidenceBlocks(p);
    expect(blocks.map(b=>b.role)).toEqual(["marginal","caption"]);
    expect(box(blocks[1].rects)[3]-box(blocks[1].rects)[1]).toBe(10);
    expect(blocks[1].text).not.toContain("6 ");
  });
  it("does not merge alternating two-column prose into page-width crops", () => {
    const p=page([
      run("Left first sentence. ",700,25,220),run("Right first sentence. ",700,350,220),
      run("Left second sentence. ",680,25,220),run("Right second sentence. ",680,350,220),
    ]);
    const blocks=pageEvidenceBlocks(p);
    expect(blocks).toHaveLength(4);
    expect(blocks.every(b=>{const r=box(b.rects);return r[2]-r[0]===220;})).toBe(true);
    expect(blocks.map(b=>b.text)).toEqual(p.words.map(w=>w.text.trim()));
  });
  it("uses geometry to identify the selected occurrence of a repeated phrase", () => {
    const p=page([run("定义一：共同术语。\n",700),run("定义二：共同术语。",300)]);
    const selected=anchorEvidenceBlocks(p,{page:3,quote:"共同术语",rects:[[100,300,160,310]]});
    expect(selected).toHaveLength(1);
    expect(selected[0].text).toBe("定义二：共同术语。");
    expect(anchorEvidenceBlocks(p,{page:3,quote:"共同术语",rects:[]})).toEqual([]);
    expect(anchorEvidenceBlocks(p,{page:2,quote:"定义二",rects:[]})).toEqual([]);
  });
  it("maps extraction whitespace differences without changing text or offsets", () => {
    const p=page([run("A  quoted\nphrase.",700)],{text:"A quoted phrase."});
    const blocks=pageEvidenceBlocks(p);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({text:"A quoted phrase.",start:0,end:16,rects:[p.words[0].rect]});
  });
  it("supports text-only logical paragraphs, including whitespace-only blank lines", () => {
    const text="T9: Compact function families\n\n题目：函数族一致有界。\n  \nPf: $\\delta=(\\epsilon/C)^{1/\\alpha}$。由此得到结论。\n\n整理者注：这里只记录原稿。";
    const p=page([],{text});
    const blocks=pageEvidenceBlocks(p);
    expect(blocks.map(b=>b.role)).toEqual(["heading","theorem","proof","note"]);
    expect(blocks.every(b=>b.rects.length===0)).toBe(true);
    expect(blocks.every(b=>b.text===text.slice(b.start,b.end))).toBe(true);
    const found=anchorEvidenceBlocks(p,{page:3,quote:"函数族一致有界",rects:[]});
    expect(found).toHaveLength(1);
    expect(found[0].role).toBe("theorem");
  });
  it("soft-limits long prose only at complete sentence boundaries, keeping math and code intact", () => {
    const prose=`${"argument ".repeat(40)}ends here. `;
    const formula=`$$x=${"a+b.".repeat(200)}c$$`;
    const code="```text\n"+"not a sentence. ".repeat(80)+"\n```";
    const text=prose+prose+formula+". "+prose+code+". End.";
    const blocks=pageEvidenceBlocks(page([],{text}));
    expect(blocks.length).toBeGreaterThan(1);
    expect(blocks.some(b=>b.text.includes(formula))).toBe(true);
    expect(blocks.some(b=>b.text.includes(code))).toBe(true);
    expect(blocks.every(b=>!b.text.includes("$$")||b.text.includes(formula))).toBe(true);
    expect(blocks.every(b=>!b.text.includes("```")||b.text.includes(code))).toBe(true);
  });
  it("does not split an unmarked native equation run at internal punctuation", () => {
    const formula="∀x∈E: "+"f(x). g(x). ".repeat(80)+" = ε.";
    const p=page([run("Pf: A proof follows.\n",700),run(formula,650,80,450)]);
    const blocks=pageEvidenceBlocks(p);
    expect(blocks.some(b=>b.text.includes(formula))).toBe(true);
    expect(blocks.filter(b=>b.text.includes("∀x∈E"))).toHaveLength(1);
  });
  it("keeps display math intact across blank lines before semantic segmentation", () => {
    const formula="$$\\begin{aligned}\na&=b,\n\nc&=d\n\\end{aligned}$$";
    const text="Pf: We use\n"+formula+"\nDone.\n\nT10: Next statement\n\n题目：另一个命题。";
    const blocks=pageEvidenceBlocks(page([],{text}));
    expect(blocks.some(b=>b.text.includes(formula))).toBe(true);
    expect(blocks.every(b=>(b.text.match(/\$\$/g)?.length??0)%2===0)).toBe(true);
    expect(blocks.find(b=>b.text.includes(formula))?.role).toBe("proof");
    expect(blocks.find(b=>b.role==="heading")?.section).toBe("T10");
  });
  it("ignores fake semantic boundaries inside fenced code with blank lines", () => {
    const code="```text\nfirst line\n\nT9: not a section\n\n整理者注：not a note\n\n原图 3: not a caption\n```";
    const text="Pf: An example follows.\n"+code+"\nDone.\n\nT10: Real section\n\n题目：真正的题设。";
    const blocks=pageEvidenceBlocks(page([],{text}));
    expect(blocks.some(b=>b.text.includes(code))).toBe(true);
    expect(blocks.every(b=>(b.text.match(/```/g)?.length??0)%2===0)).toBe(true);
    expect(blocks.filter(b=>b.role==="heading").map(b=>b.section)).toEqual(["T10"]);
    expect(blocks.some(b=>b.role==="caption"||b.role==="note")).toBe(false);
  });
  it("does not break positioned fenced code at large spatial gaps", () => {
    const runs=[run("Pf: Example.\n",760),run("~~~text\n",730),run("T9: literal text\n\n",400,300,220,18),run("原图 3: literal caption\n",200),run("~~~\nDone.",150)];
    const p=page(runs),code=p.text.slice(p.text.indexOf("~~~"),p.text.lastIndexOf("~~~")+3);
    const blocks=pageEvidenceBlocks(p);
    expect(blocks.some(b=>b.text.includes(code))).toBe(true);
    expect(blocks.every(b=>(b.text.match(/~~~/g)?.length??0)%2===0)).toBe(true);
    expect(blocks.some(b=>b.role==="heading"||b.role==="caption")).toBe(false);
  });
  it("does not consume following sections for currencies or unpaired inline delimiters", () => {
    for(const prefix of ["Price: $10.","Press the ` key.","An unclosed $$ display marker.","An unclosed \\( inline marker.","Escaped currency: \\$10."]){
      const text=prefix+"\n\nT9: New theorem\n\n题目：函数族一致有界。\n\nPf: This proof is independent.";
      const blocks=pageEvidenceBlocks(page([],{text}));
      expect(blocks.find(b=>b.role==="heading")?.section,prefix).toBe("T9");
      expect(blocks.some(b=>b.role==="theorem"),prefix).toBe(true);
      expect(blocks.some(b=>b.role==="proof"),prefix).toBe(true);
    }
  });
  it("respects escaped interior closers in valid inline math and code", () => {
    for(const [open,close] of [["$a\\$","b$"],["`a\\`","b`"],["\\(a\\\\)","b\\)"]]){
      const runs=[run("Pf: A literal follows. ",760),run(open,700),run("T9: literal content",420,100,300,18),run(close,350),run("\n\nT10: Real section\n\n题目：真正的题设。",300)];
      const p=page(runs),literal=p.text.slice(p.text.indexOf(open),p.text.indexOf(close)+close.length);
      const blocks=pageEvidenceBlocks(p);
      expect(blocks.some(b=>b.text.includes(literal)),open).toBe(true);
      expect(blocks.filter(b=>b.role==="heading").map(b=>b.section),open).toEqual(["T10"]);
    }
  });
  it("still protects an actual unclosed Markdown fence through the end of the page", () => {
    const text="Pf: Example code.\n```text\n\nT9: literal heading\n\n题目：literal example";
    const blocks=pageEvidenceBlocks(page([],{text}));
    expect(blocks).toHaveLength(1);
    expect(blocks[0].text).toBe(text);
    expect(blocks[0].role).toBe("proof");
  });
  it("caches immutable pages and versions IDs when extraction text or geometry changes", () => {
    const p=page([run("A short paragraph.",700)]),first=pageEvidenceBlocks(p);
    expect(pageEvidenceBlocks(p)).toBe(first);
    const changed=page({...p}.words.map(w=>({...w,rect:[w.rect[0]+2,...w.rect.slice(1)] as Rect})),{text:p.text});
    expect(pageEvidenceBlocks(changed)[0].id).not.toBe(first[0].id);
    const same=page(p.words.map(w=>({...w,rect:[...w.rect]})));
    expect(pageEvidenceBlocks(same)[0].id).toBe(first[0].id);
  });
});
