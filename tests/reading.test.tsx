import { createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import AnswerReader from "../src/AnswerReader";
import ContinuousPdf from "../src/ContinuousPdf";
import { createBranch } from "../src/core/branches";
import { buildContext } from "../src/core/context";
import { answerFor, parentReadingTarget, readingTrail } from "../src/core/reading";
import { DEFAULT_TEMPLATES } from "../src/core/templates";
import type { PDFDocumentProxy } from "../src/pdf";
import type { Message, Note, Project } from "../src/types";
import AnnotationLayer from "../src/AnnotationLayer";
import { Markdown, MathText } from "../src/Markdown";
import { normalizeMathMarkdown, mathExcerpt, codeSpan } from "../src/core/math-markdown";
import { exportProject, importProject } from "../src/core/archive";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";

vi.mock("../src/PdfPage", () => ({ default: ({ notes }: { notes: Note[] }) => <div data-live-pdf="true">{notes.map((n) => <span key={n.id}>{n.title}</span>)}</div> }));

function message(id: string, content: string, role: Message["role"] = "assistant"): Message {
  return { id, role, content, assetIds: [], status: "complete", createdAt: 1 };
}
function fixture(): Project {
  return {
    version: 1,
    document: { id: "pdf", name: "教材.pdf", fingerprint: "pdf", pdf: new Blob(), pageCount: 3, createdAt: 1, updatedAt: 1 },
    pages: [1, 2, 3].map((page) => ({ page, text: `第 ${page} 页原始文字`, words: [], source: "native", status: "ready", width: 600, height: 800 })),
    notes: [{ id: "root", title: "导数是什么", anchor: { page: 2, rects: [[10, 10, 100, 30]], quote: "原 PDF 中的定义" },
      inheritedHistory: [], collapsed: false, task: "explain", templateId: DEFAULT_TEMPLATES[0].id,
      draft: "", draftAssetIds: [], createdAt: 1,
      messages: [message("q", "请解释导数", "user"), message("a1", "较早回答中选中的一句话"), message("a2", "后来的另一份回答")] }],
    assets: [], templates: structuredClone(DEFAULT_TEMPLATES), view: { page: 2, scale: 1, rotation: 0 },
  };
}

describe("reading answers as nested documents", () => {
  it("keeps cross-page selection coordinates through branching and archive round trips", async () => {
    const p = fixture();
    p.document.pdf = new Blob(["%PDF-1.4 fixture"], {type: "application/pdf"});
    p.notes[0].anchor = {page: 2, quote: "End of page two\nStart of page three", rects: [[10, 20, 200, 40]], fragments: [
      {page: 2, quote: "End of page two", rects: [[10, 20, 200, 40]]},
      {page: 3, quote: "Start of page three", rects: [[15, 700, 220, 720]]},
    ]};
    const child = createBranch(p, p.notes[0], "a1", "follow up");
    p.notes.push(child);
    expect(child.anchor.fragments).toEqual(p.notes[0].anchor.fragments);
    expect(child.anchor.fragments?.[0].rects[0]).not.toBe(p.notes[0].anchor.fragments![0].rects[0]);
    const restored = await importProject(await exportProject(p));
    expect(restored.notes[0].anchor).toEqual(p.notes[0].anchor);
    expect(restored.notes[1].anchor.fragments).toEqual(p.notes[0].anchor.fragments);
    p.notes[0].anchor.fragments![1].page = 4;
    await expect(importProject(await exportProject(p))).rejects.toThrow(/page range/);
  });
  it("returns to the exact parent answer and retains each level of the reading chain", () => {
    const p = fixture();
    const child = createBranch(p, p.notes[0], "a1", "选中的一句话");
    child.messages = [message("child-answer", "第二层回答")];
    p.notes.push(child);
    const grandchild = createBranch(p, child, "child-answer", "第二层");
    p.notes.push(grandchild);
    expect(parentReadingTarget(p.notes, child.id)).toEqual({ noteId: "root", messageId: "a1" });
    expect(answerFor(p.notes[0], "a1")?.content).toBe("较早回答中选中的一句话");
    expect(answerFor(p.notes[0])?.id).toBe("a2");
    expect(readingTrail(p.notes, grandchild.id).map((n) => n.id)).toEqual(["root", child.id, grandchild.id]);
    expect(parentReadingTarget(p.notes, "root")).toBeUndefined();
    expect(child.inheritedHistory.map((m) => m.content)).not.toContain("后来的另一份回答");
  });

  it("uses answer selections as the next task's input while keeping PDF citations separate", () => {
    const p = fixture();
    const child = createBranch(p, p.notes[0], "a1", "选中的一句话", "translate");
    p.notes.push(child);
    const result = buildContext({ project: p, note: child, question: "", template: p.templates.find((t) => t.id === child.templateId)! });
    expect(child.task).toBe("translate");
    expect(result.prompt).toContain("【选中的原文】\n选中的一句话");
    expect(result.prompt).toContain("当前选文来自该回答，不是 PDF 原文");
    expect(result.sources[0].page).toBe(2);
    expect(result.sources[0].text).toContain("原 PDF 中的定义");
    expect(result.history.at(-1)?.content).toBe("较早回答中选中的一句话");
  });

  it("renders the chosen answer in the reading surface and child notes as links", () => {
    const p = fixture();
    const child = createBranch(p, p.notes[0], "a1", "选中的一句话");
    child.messages = [message("child-a", "子回答正文不应嵌入父回答")];
    p.notes.push(child);
    const noop = () => {};
    const html = renderToStaticMarkup(<AnswerReader note={p.notes[0]} project={p} messageId="a1" busy={false} apiReady
      context={(note) => buildContext({ project: p, note, question: "", template: p.templates[0] })}
      onUpdate={noop} onSend={noop} onStop={noop} onSelect={noop} onClearSelection={noop} onBranch={noop} onDelete={noop}
      onPage={noop} onFocus={noop} onAttach={noop} onSourceImage={() => {}} onScreenshot={noop} onRetry={noop} />);
    expect(html).toContain('aria-label="回答阅读页"');
    expect(html).toContain('aria-label="AI 回答正文"');
    expect(html).toContain("较早回答中选中的一句话");
    expect(html).toContain('aria-label="原处便签"');
    expect(html).not.toContain('class="answer-note-links"');
    expect(html).not.toContain("子回答正文不应嵌入父回答");
    expect(html).not.toContain("后来的另一份回答</p>");
    expect(html).not.toContain('class="composer"');
  });

  it("bounds a malformed cyclic breadcrumb instead of looping forever", () => {
    const p = fixture();
    p.notes[0].parentId = "root";
    expect(readingTrail(p.notes, "root")).toHaveLength(1);
  });
});

describe("continuous PDF reading", () => {
  it("keeps every page in scroll order and only PDF source notes on the PDF", () => {
    const p = fixture();
    const child = createBranch(p, p.notes[0], "a1", "AI 回答中的子便签");
    p.notes.push(child);
    const html = renderToStaticMarkup(<ContinuousPdf pdf={{ numPages: 3 } as PDFDocumentProxy} project={p}
      scrollRoot={createRef<HTMLDivElement>()} pageSizes={new Map()} regionMode={false} onSelect={() => {}} onClearSelection={() => {}} onFocus={() => {}}
      onPageChange={() => {}} onError={() => {}} />);
    expect([...html.matchAll(/data-pdf-page="(\d+)"/g)].map((m) => m[1])).toEqual(["1", "2", "3"]);
    expect(html).toContain("导数是什么");
    expect(html).not.toContain("AI 回答中的子便签");
    expect((html.match(/data-live-pdf/g) ?? [])).toHaveLength(1);
    expect(html).not.toContain('class="sheet-heading"');
    expect(html).not.toContain('class="page-caption"');
    expect(html).not.toContain('class="page-note-links"');
    expect(html).not.toContain("教材.pdf");
  });
});

describe("consistent math and annotation surfaces", () => {
  it("uses the same original-position marker and math preview at every level", () => {
    const html = renderToStaticMarkup(<AnnotationLayer width={600} activeId="child" onFocus={() => {}}
      annotations={[{ id: "child", title: "公式", rects: [[20, 40, 180, 65]], preview: <MathText>{"选中的 $f(x)=x^2$"}</MathText> }]} />);
    expect(html).toContain('class="highlight active"');
    expect(html).toContain('class="anchor-dot active"');
    expect(html).toContain("left:574px");
    expect(html).toContain('role="tooltip"');
    expect(html).toContain('class="katex"');
  });

  it("renders TeX bracket delimiters in answers, source selections and questions", () => {
    const p = fixture();
    p.notes[0].branchQuote = "\\(x^2\\)";
    p.notes[0].messages = [message("q", "\\(q=1\\)", "user"), message("answer", "\\[f(x)=x^2\\]")];
    const noop = () => {};
    const html = renderToStaticMarkup(<AnswerReader note={p.notes[0]} project={p} busy={false} apiReady
      context={(note) => buildContext({ project: p, note, question: "", template: p.templates[0] })}
      onUpdate={noop} onSend={noop} onStop={noop} onSelect={noop} onClearSelection={noop} onBranch={noop}
      onDelete={noop} onPage={noop} onFocus={noop} onAttach={noop} onSourceImage={() => {}} onScreenshot={noop} onRetry={noop} />);
    expect((html.match(/class="katex"/g) ?? []).length).toBeGreaterThanOrEqual(3);
    expect(html).not.toContain("katex-error");
  });

  it("preserves code examples and does not cut formulas in note titles", () => {
    const code = "```tex\n\\(x\\)\n```\n`\\[y\\]`";
    expect(normalizeMathMarkdown(code)).toBe(code);
    const prose = "说明 \\(x^2\\) 与 \\[y=2\\]";
    const html = renderToStaticMarkup(<Markdown message={{ content: prose + "\n\n" + code }} project={fixture()} onPage={() => {}} />);
    expect((html.match(/class="katex"/g) ?? [])).toHaveLength(2);
    const formula = "$\\frac{x^2+1}{x^2-1}+\\sum_{n=1}^{100}n$";
    expect(mathExcerpt("看看 " + formula + " 其余文字", 12)).toBe("看看 " + formula + "…");
    expect(normalizeMathMarkdown("单个 ` 然后 \\(x\\)")).toContain("$x$");
  });

  it("preserves optional answer anchors through project backups and ID remapping", async () => {
    const p = fixture();
    p.document.pdf = new Blob(["%PDF-1.7 fixture"]);
    p.assets = [{ id: "fig", name: "figure.png", mime: "image/png", data: new Blob(["x"]) }];
    const quote = "`asset:fig`";
    const anchor = { start: 2, end: 2 + quote.length, quote };
    const child = createBranch(p, p.notes[0], "a1", quote, "custom", anchor);
    p.notes.push(child);
    const archive = await exportProject(p);
    const imported = await importProject(archive);
    const importedAnchor = imported.notes[1].answerAnchor!;
    expect(importedAnchor).not.toBe(anchor);
    expect(importedAnchor.quote).toBe(imported.notes[1].branchQuote);
    expect(importedAnchor.quote).toContain(imported.assets[0].id);
    expect(importedAnchor.end - importedAnchor.start).toBe(importedAnchor.quote.length);
    await expect(importProject(await exportProject(imported))).resolves.toBeDefined();

    const files = unzipSync(new Uint8Array(await archive.arrayBuffer()));
    const manifest = JSON.parse(strFromU8(files["manifest.json"]));
    manifest.project.notes[1].answerAnchor.start = -1;
    files["manifest.json"] = strToU8(JSON.stringify(manifest));
    await expect(importProject(new Blob([new Uint8Array(zipSync(files))]))).rejects.toThrow("answer anchor");
  });

  it("keeps indented code and raw code-span backticks intact in child notes", () => {
    const source = "    \\(x\\)\n    \\[y\\]\n\n正文 \\(z\\)";
    const html = renderToStaticMarkup(<Markdown message={{ content: source }} project={fixture()} onPage={() => {}} />);
    expect(html).toContain("\\(x\\)");
    expect(html).toContain("\\[y\\]");
    expect((html.match(/class="katex"/g) ?? [])).toHaveLength(1);
    for (const raw of ["`x`", " x ", "  ", "`x ", "a`b"]) {
      const rendered = renderToStaticMarkup(<Markdown message={{ content: codeSpan(raw) }} project={fixture()} onPage={() => {}} />);
      expect(rendered).toContain(`<code>${raw}</code>`);
    }
  });
});
