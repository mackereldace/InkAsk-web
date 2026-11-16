import { describe, expect, it } from "vitest";
import { strFromU8, unzipSync } from "fflate";
import { buildNoteExportZip, NOTE_EXPORT_LIMITS, planNoteExport } from "../src/core/note-export";
import type { Asset, Message, Note, Project, Source } from "../src/types";

function asset(id: string, name: string, mime = "image/png"): Asset {
  return { id, name, mime, data: new Blob([new Uint8Array([137, 80, 78, 71, 1, 2, 3])], { type: mime }) };
}

function message(overrides: Partial<Message> & Pick<Message, "id" | "role">): Message {
  return {
    content: "",
    assetIds: [],
    status: "complete",
    createdAt: 1_700_000_000_000,
    ...overrides,
  };
}

function note(overrides: Partial<Note> & Pick<Note, "id">): Note {
  return {
    title: "便签",
    anchor: { page: 3, rects: [[10, 10, 100, 20]], quote: "一致有界" },
    inheritedHistory: [],
    collapsed: false,
    task: "explain",
    templateId: "t1",
    draft: "",
    draftAssetIds: [],
    messages: [],
    createdAt: 1_700_000_000_000,
    ...overrides,
  };
}

function project(notes: Note[], assets: Asset[] = []): Project {
  return {
    version: 1,
    document: {
      id: "doc",
      name: "第三周作业.pdf",
      fingerprint: "fp",
      pdf: new Blob([new Uint8Array([0x25, 0x50, 0x44, 0x46])], { type: "application/pdf" }),
      pageCount: 8,
      createdAt: 1,
      updatedAt: 2,
    },
    pages: [],
    notes,
    assets,
    templates: [{ id: "t1", name: "学术解释", task: "explain", body: "解释 {{selection}}", version: 1 }],
    view: { page: 1, scale: 1, rotation: 0 },
  };
}

const file = (files: { path: string; text: string }[], path: string): string =>
  files.find((entry) => entry.path === path)?.text ?? "";

const sources = (count: number, text: string): Source[] =>
  Array.from({ length: count }, (_, index) => ({
    id: `S${index + 1}`,
    page: index + 3,
    text,
    label: index === 0 ? "§定理 2" : undefined,
  }));

describe("note directory export", () => {
  it("writes one file per note in reading order and mirrors the tree in the README", () => {
    const root = note({ id: "n1", title: "一致有界" });
    const child = note({ id: "n2", title: "追问切分", parentId: "n1" });
    const sibling = note({ id: "n3", title: "另一处", createdAt: 1_700_000_100_000 });
    const plan = planNoteExport(project([child, sibling, root]), { now: 1_800_000_000_000 });

    expect(plan.root).toBe("第三周作业");
    expect(plan.files.map((entry) => entry.path)).toEqual([
      "README.md",
      "notes/0001-一致有界.md",
      "notes/0002-追问切分.md",
      "notes/0003-另一处.md",
    ]);
    const readme = file(plan.files, "README.md");
    expect(readme).toContain("- [第 3 页 · 一致有界](notes/0001-一致有界.md)");
    expect(readme).toContain("  - [第 3 页 · 追问切分](notes/0002-追问切分.md)");
    expect(readme).toContain("3 条便签");
    expect(readme).toContain("2027-01-15T08:00:00.000Z");

    const child1 = file(plan.files, "notes/0002-追问切分.md");
    expect(child1).toContain('parent_id: "n1"');
    expect(child1).toContain('parent: "0001-一致有界.md"');
    expect(child1).toContain("depth: 1");
  });

  it("keeps answer markdown, math and code blocks byte-for-byte", () => {
    const answer = "设 $a=\\frac{b}{2}$ 且\n\n```js\nconst a = 1;\n\nconst b = 2;\n```\n\n| 列 | 值 |\n| --- | --- |\n| x | 1 |";
    const p = project([
      note({
        id: "n1",
        messages: [
          message({ id: "m1", role: "user", content: "解释 $a=\\frac{b}{2}$" }),
          message({ id: "m2", role: "assistant", content: answer }),
        ],
      }),
    ]);
    const text = file(planNoteExport(p).files, "notes/0001-便签.md");
    expect(text).toContain("解释 $a=\\frac{b}{2}$");
    expect(text).toContain(answer);
    expect(text).toContain("- 任务：解释 · 模板：学术解释");
  });

  it("numbers rounds and marks stopped or failed answers instead of hiding them", () => {
    const p = project([
      note({
        id: "n1",
        messages: [
          message({ id: "m1", role: "user", content: "第一问" }),
          message({ id: "m2", role: "assistant", content: "第一答" }),
          message({ id: "m3", role: "user", content: "第二问" }),
          message({ id: "m4", role: "assistant", content: "半截", status: "stopped" }),
          message({ id: "m5", role: "user", content: "第三问" }),
          message({ id: "m6", role: "assistant", content: "", status: "error", error: "上下文超限" }),
        ],
      }),
    ]);
    const text = file(planNoteExport(p).files, "notes/0001-便签.md");
    expect(text).toContain("## 提问\n\n第一问");
    expect(text).toContain("## 提问 2\n\n第二问");
    expect(text).toContain("## 回答 2\n\n半截");
    expect(text).toContain("⏹ 生成被中止");
    expect(text).toContain("⚠️ 生成失败：上下文超限");
    expect(text).toContain("## 提问 3");
  });

  it("repeats a message template only when it differs from the note's template", () => {
    const p = project([
      note({
        id: "n1",
        messages: [
          message({
            id: "m1",
            role: "user",
            content: "问一",
            template: { id: "t1", name: "学术解释", task: "explain", body: "解释", version: 1 },
          }),
          message({
            id: "m2",
            role: "user",
            content: "问二",
            template: { id: "t9", name: "旧模板", task: "custom", body: "自定义", version: 1 },
          }),
        ],
      }),
    ]);
    const text = file(planNoteExport(p).files, "notes/0001-便签.md");
    expect(text).not.toContain("> 模板：学术解释");
    expect(text).toContain("> 模板：旧模板");
    expect(text).toContain('template: "学术解释"');
  });

  it("renders citations with page, label and clipped source text", () => {
    const long = "证".repeat(NOTE_EXPORT_LIMITS.sourceChars + 40);
    const p = project([
      note({
        id: "n1",
        messages: [
          message({ id: "m1", role: "user", content: "为什么一致有界" }),
          message({
            id: "m2",
            role: "assistant",
            content: "因为……",
            sources: [...sources(1, long), { id: "S2", page: 5, text: "短引用", textRange: [3, 9] }],
          }),
        ],
      }),
    ]);
    const text = file(planNoteExport(p).files, "notes/0001-便签.md");
    expect(text).toContain("### 本次参考来源");
    expect(text).toContain("- **S1 · 第 3 页 · §定理 2**");
    expect(text).toContain("- **S2 · 第 5 页**（选区 3–9）");
    expect(text).toContain("…（已截断，共 2040 字");
    expect(text).toContain("> 短引用");
  });

  it("respects a custom clipping limit", () => {
    const p = project([
      note({
        id: "n1",
        messages: [message({ id: "m1", role: "assistant", content: "答", sources: sources(1, "字".repeat(500)) })],
      }),
    ]);
    const text = file(planNoteExport(p, { sourceChars: 200 }).files, "notes/0001-便签.md");
    expect(text).toContain("…（已截断，共 500 字");
    const quoted = text.split("\n").filter((line) => line.startsWith("  > "));
    expect(quoted[0]).toHaveLength("  > ".length + 200);
    expect(quoted[1]).toContain("已截断");
  });

  it("sanitizes file names, keeps CJK titles, and never overwrites a duplicate", () => {
    const p = project([
      note({ id: "n1", title: "a/b:c*d?e|f", createdAt: 1 }),
      note({ id: "n2", title: "a/b:c*d?e|f", createdAt: 2 }),
      note({ id: "n3", title: "   ...  ", createdAt: 3 }),
      note({ id: "n4", title: "长".repeat(NOTE_EXPORT_LIMITS.nameChars + 20), createdAt: 4 }),
    ]);
    const paths = planNoteExport(p).files.map((entry) => entry.path);
    expect(paths[1]).toBe("notes/0001-a-b-c-d-e-f.md");
    expect(paths[2]).toBe("notes/0002-a-b-c-d-e-f.md");
    expect(paths[3]).toBe("notes/0003-note.md");
    expect(paths[4]).toHaveLength("notes/0004-".length + NOTE_EXPORT_LIMITS.nameChars + ".md".length);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it("escapes front matter values so quotes and newlines stay parseable", () => {
    const p = project([note({ id: "n1", title: '带"引号"和\n换行' })]);
    const plan = planNoteExport(p);
    const text = plan.files[1].text;
    expect(plan.files[1].path).toBe("notes/0001-带-引号-和-换行.md");
    const title = /^title: (.*)$/m.exec(text)?.[1] ?? "";
    expect(JSON.parse(title)).toBe('带"引号"和\n换行');
  });

  it("keeps orphaned and cyclic parents visible without recursing forever", () => {
    const p = project([
      note({ id: "orphan", title: "父便签已删", parentId: "gone" }),
      note({ id: "a", title: "环 A", parentId: "b" }),
      note({ id: "b", title: "环 B", parentId: "a" }),
    ]);
    const plan = planNoteExport(p);
    const readme = file(plan.files, "README.md");
    expect(plan.files.filter((entry) => entry.path.startsWith("notes/"))).toHaveLength(3);
    expect(readme.match(/环 A/g)?.length).toBe(1);
    expect(readme.match(/环 B/g)?.length).toBe(1);
    expect(file(plan.files, "notes/0001-父便签已删.md")).toContain("depth: 0");
  });

  it("copies referenced images and reports references it cannot resolve", () => {
    const p = project(
      [
        note({
          id: "n1",
          sourceAssetId: "crop-1",
          messages: [
            message({ id: "m1", role: "user", content: "看图", assetIds: ["img-1", "missing"] }),
            message({ id: "m2", role: "assistant", content: "好的" }),
          ],
        }),
      ],
      [asset("img-1", "截图 2026-11-12.png"), asset("crop-1", "crop.png")],
    );
    const plan = planNoteExport(p);
    expect(plan.assets.map((entry) => entry.path)).toEqual([
      "assets/001-crop.png",
      "assets/002-截图-2026-11-12.png",
    ]);
    expect(plan.stats.images).toBe(2);
    const text = file(plan.files, "notes/0001-便签.md");
    expect(text).toContain("## 选区截图");
    expect(text).toContain("![图片](../assets/001-crop.png)");
    expect(text).toContain("![图片](../assets/002-截图-2026-11-12.png)");
    expect(text).toContain("（图片缺失：missing）");
  });

  it("says images were skipped when the caller turns them off", () => {
    const p = project(
      [note({ id: "n1", messages: [message({ id: "m1", role: "user", content: "问", assetIds: ["img-1"] })] })],
      [asset("img-1", "a.png")],
    );
    const plan = planNoteExport(p, { includeAssets: false });
    expect(plan.assets).toHaveLength(0);
    expect(file(plan.files, "notes/0001-便签.md")).toContain("（图片未导出：img-1）");
  });

  it("omits the PDF line from the README when the PDF is not included", () => {
    const plan = planNoteExport(project([note({ id: "n1" })]), { includePdf: false });
    expect(plan.includePdf).toBe(false);
    expect(file(plan.files, "README.md")).not.toContain("document.pdf —— 原始 PDF");
  });

  it("still produces a usable directory for a project without notes", () => {
    const plan = planNoteExport(project([]));
    expect(plan.files.map((entry) => entry.path)).toEqual(["README.md"]);
    expect(file(plan.files, "README.md")).toContain("（这个项目还没有便签）");
  });

  it("refuses an export that would produce an unreasonable number of notes", () => {
    const notes = Array.from({ length: NOTE_EXPORT_LIMITS.notes + 1 }, (_, index) =>
      note({ id: `n${index}` }),
    );
    expect(() => planNoteExport(project(notes))).toThrow(/便签过多/);
  });

  it("zips the tree under a single root folder with the PDF and images", async () => {
    const p = project(
      [
        note({
          id: "n1",
          sourceAssetId: "crop-1",
          messages: [message({ id: "m1", role: "assistant", content: "答" })],
        }),
      ],
      [asset("crop-1", "crop.png")],
    );
    const blob = await buildNoteExportZip(p, { now: 1_800_000_000_000 });
    expect(blob.type).toBe("application/zip");
    const entries = unzipSync(new Uint8Array(await blob.arrayBuffer()));
    expect(Object.keys(entries).sort()).toEqual([
      "第三周作业/README.md",
      "第三周作业/assets/001-crop.png",
      "第三周作业/document.pdf",
      "第三周作业/notes/0001-便签.md",
    ]);
    expect(strFromU8(entries["第三周作业/notes/0001-便签.md"])).toContain("# 便签");
    expect([...entries["第三周作业/document.pdf"]]).toEqual([0x25, 0x50, 0x44, 0x46]);
    expect([...entries["第三周作业/assets/001-crop.png"]]).toEqual([137, 80, 78, 71, 1, 2, 3]);
  });

  it("keeps NFC-normalised names so macOS and Linux produce the same paths", () => {
    const decomposed = "e\u0301tude"; // e + combining acute
    const plan = planNoteExport(project([note({ id: "n1", title: decomposed })]));
    expect(plan.files[1].path).toBe("notes/0001-étude.md");
  });
});
