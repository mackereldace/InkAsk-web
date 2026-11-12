import { describe, expect, it } from "vitest";
import { copyProjectForEdit } from "../src/core/project-edit";
import type { Note, Project } from "../src/types";

function note(id: string): Note {
  return {
    id, title: id, anchor: { page: 1, rects: [[10, 10, 100, 30]], quote: "原文" },
    inheritedHistory: [{ role: "assistant", content: "较长的祖先回答".repeat(1000) }],
    collapsed: false, task: "explain", templateId: "explain", draft: "", draftAssetIds: ["figure"], createdAt: 1,
    messages: [{ id: `${id}-answer`, role: "assistant", content: "正在生成", assetIds: ["figure"], status: "streaming", createdAt: 1 }],
  };
}
function fixture(): Project {
  return {
    version: 1,
    document: { id: "pdf", name: "阅读.pdf", fingerprint: "pdf", pdf: new Blob(["%PDF-1.7"], { type: "application/pdf" }), pageCount: 1, createdAt: 1, updatedAt: 1 },
    notes: [note("first"), note("second"), note("third")],
    pages: [{ page: 1, text: "原文", words: [{ text: "原文", rect: [10, 10, 100, 30] }], source: "native", status: "ready", width: 600, height: 800 }],
    assets: [{ id: "figure", name: "figure.png", mime: "image/png", data: new Blob(["immutable-image"], { type: "image/png" }) }],
    templates: [{ id: "explain", task: "explain", name: "解释", body: "解释选文", version: 1 }],
    view: { page: 1, scale: 1, rotation: 0 },
  };
}

describe("copy-on-write project edits", () => {
  it("isolates streamed answer and attachment edits while preserving unrelated note identities", () => {
    const source = fixture(), next = copyProjectForEdit(source, "second", 42);
    next.notes[1].messages[0].content += "，新增的文字";
    next.notes[1].messages[0].assetIds.push("another-image");
    next.notes[1].draftAssetIds.length = 0;
    expect(source.notes[1].messages[0].content).toBe("正在生成");
    expect(source.notes[1].messages[0].assetIds).toEqual(["figure"]);
    expect(source.notes[1].draftAssetIds).toEqual(["figure"]);
    expect(next.notes).not.toBe(source.notes);
    expect(next.notes[0]).toBe(source.notes[0]);
    expect(next.notes[2]).toBe(source.notes[2]);
    expect(next.notes[1].inheritedHistory).toBe(source.notes[1].inheritedHistory);
    expect(next.document.updatedAt).toBe(42);
    expect(source.document.updatedAt).toBe(1);
  });

  it("allows page-status and document/view/template edits without mutating a saved source snapshot", () => {
    const source = fixture(), next = copyProjectForEdit(source, null, 9);
    next.pages[0].status = "error";
    next.document.name = "改名.pdf";
    next.view.scale = 2;
    next.templates[0].body = "新模板";
    expect(source.pages[0].status).toBe("ready");
    expect(source.document.name).toBe("阅读.pdf");
    expect(source.view.scale).toBe(1);
    expect(source.templates[0].body).toBe("解释选文");
    expect(next.pages[0].words).toBe(source.pages[0].words);
    expect(next.document.pdf).toBe(source.document.pdf);
    expect(next.assets).not.toBe(source.assets);
    expect(next.assets[0]).toBe(source.assets[0]);
    expect(next.assets[0].data).toBe(source.assets[0].data);
  });

  it("adds and removes notes without copying the existing answer tree", () => {
    const source = fixture(), next = copyProjectForEdit(source, null);
    const newNote = note("new");
    next.notes.push(newNote);
    expect(source.notes).toHaveLength(3);
    expect(next.notes.slice(0, 3).every((entry, index) => entry === source.notes[index])).toBe(true);
    next.notes.splice(1, 1);
    expect(source.notes.map((entry) => entry.id)).toEqual(["first", "second", "third"]);
    expect(next.notes.map((entry) => entry.id)).toEqual(["first", "third", "new"]);
  });

  it("retains the all-note edit contract when no scope is provided", () => {
    const source = fixture(), next = copyProjectForEdit(source);
    for (let index = 0; index < source.notes.length; index++) {
      expect(next.notes[index]).not.toBe(source.notes[index]);
      expect(next.notes[index].messages).not.toBe(source.notes[index].messages);
      expect(next.notes[index].messages[0]).not.toBe(source.notes[index].messages[0]);
      expect(next.notes[index].draftAssetIds).not.toBe(source.notes[index].draftAssetIds);
      expect(next.notes[index].inheritedHistory).toBe(source.notes[index].inheritedHistory);
      next.notes[index].messages[0].status = "stopped";
    }
    expect(source.notes.every((entry) => entry.messages[0].status === "streaming")).toBe(true);
  });

  it("leaves note identities intact when an asynchronous edit targets a deleted note", () => {
    const source = fixture(), next = copyProjectForEdit(source, "deleted-note");
    expect(next.notes).not.toBe(source.notes);
    expect(next.notes.every((entry, index) => entry === source.notes[index])).toBe(true);
  });
});
