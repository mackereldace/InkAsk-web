import "fake-indexeddb/auto";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { beforeEach, describe, expect, it } from "vitest";
import {
  importProject,
  exportMarkdown,
  exportProject,
} from "../src/core/archive";
import { createBranch, descendantIds } from "../src/core/branches";
import { buildContext } from "../src/core/context";
import { DEFAULT_TEMPLATES } from "../src/core/templates";
import type {
  Asset,
  Message,
  Note,
  Project,
  PromptTemplate,
} from "../src/types";

function message(
  id: string,
  role: "user" | "assistant",
  content: string,
  status: Message["status"] = "complete",
): Message {
  return {
    id,
    role,
    content,
    assetIds: [],
    status,
    createdAt: Date.now(),
  };
}

function note(overrides: Partial<Note> = {}): Note {
  return {
    id: "root-note",
    title: "训练集",
    anchor: {
      page: 1,
      rects: [[10, 10, 100, 20]],
      quote: "机器学习模型需要训练数据",
    },
    inheritedHistory: [],
    collapsed: false,
    task: "explain",
    templateId: DEFAULT_TEMPLATES[0].id,
    draft: "",
    draftAssetIds: [],
    messages: [],
    createdAt: 1,
    ...overrides,
  };
}

function projectFixture(): Project {
  const templates: PromptTemplate[] = structuredClone(DEFAULT_TEMPLATES);
  return {
    version: 1,
    document: {
      id: "document-old",
      name: "机器学习教材.pdf",
      fingerprint: "fingerprint-old",
      pdf: new Blob(["%PDF-1.7 fixture"], { type: "application/pdf" }),
      pageCount: 4,
      createdAt: 10,
      updatedAt: 20,
    },
    pages: [
      {
        page: 1,
        text: "机器学习模型需要训练数据，也需要合适的损失函数。",
        words: [],
        source: "native",
        status: "ready",
        width: 600,
        height: 800,
      },
      {
        page: 2,
        text: "",
        words: [],
        source: "ocr",
        status: "pending",
        width: 600,
        height: 800,
      },
      {
        page: 3,
        text: "",
        words: [],
        source: "ocr",
        status: "empty",
        width: 600,
        height: 800,
      },
      {
        page: 4,
        text: "训练数据用于估计模型参数；损失函数衡量预测误差。模型通过优化损失函数学习参数。",
        words: [],
        source: "native",
        status: "ready",
        width: 600,
        height: 800,
      },
    ],
    notes: [],
    assets: [],
    templates,
    view: { page: 1, scale: 1, rotation: 0 },
  };
}

describe("prompt templates and context", () => {
  it("reports pending and empty pages accurately and supplies cited retrieval", () => {
    const project = projectFixture();
    const selected = note({
      inheritedHistory: [{ role: "assistant", content: "祖先上下文" }],
      messages: [message("m1", "user", "当前便签问题")],
    });
    project.notes = [selected];

    const result = buildContext({
      project,
      note: selected,
      question: "损失函数如何帮助模型学习参数？",
      template: project.templates[0],
    });

    expect(result.coverage).toContain("已可检索 2/4 页");
    expect(result.coverage).toContain("尚未识别 1 页");
    expect(result.coverage).toContain("已识别但无可检索文字 1 页");
    expect(result.sources.length).toBeGreaterThan(0);
    expect(result.sources[0]).toMatchObject({ id: "S1", page: 1 });
    expect(result.sources[0].text).toContain("机器学习模型需要训练数据");
    expect(result.sources.every((source) => /^S\d+$/.test(source.id))).toBe(
      true,
    );
    expect(result.prompt).toContain(`[${result.sources[0].id}]`);
    expect(result.prompt).not.toContain("祖先上下文");
    expect(result.prompt).not.toContain("当前便签问题");
    expect(result.history.map((item) => item.content)).toEqual([
      "祖先上下文",
      "当前便签问题",
    ]);
    expect(result.prompt).not.toMatch(
      /\{\{(?:task|document_title|page_number|coverage|selected_text|context_with_source_ids|branch_quote|question|attachment_descriptions)\}\}/,
    );
  });

  it("trims retrieval then oldest history while retaining protected inputs", () => {
    const project = projectFixture();
    const selected = note({
      branchQuote: "这段分支回答必须保留",
      inheritedHistory: [
        { role: "user", content: `最早历史 ${"甲".repeat(2_000)}` },
        { role: "assistant", content: `第二段历史 ${"乙".repeat(2_000)}` },
      ],
      messages: [message("m1", "user", `当前消息 ${"丙".repeat(2_000)}`)],
    });
    project.notes = [selected];

    const result = buildContext({
      project,
      note: selected,
      question: `请解释损失函数 ${"丁".repeat(500)}`,
      template: project.templates[0],
      budget: 1_200,
    });

    expect(result.truncated).toBe(true);
    expect(result.sources.map((source) => source.id)).toEqual(["S1"]);
    expect(result.history).toHaveLength(0);
    expect(result.prompt).toContain("机器学习模型需要训练数据");
    expect(result.prompt).toContain("请解释损失函数");
    expect(result.prompt).toContain("这段分支回答必须保留");
    expect(result.prompt).not.toContain("最早历史");
    expect(result.prompt).not.toContain("当前消息");
  });

  it("interpolates editable variables, preserves unknown placeholders, and restores required fields", () => {
    const project = projectFixture();
    const selected = note({
      branchQuote: "被追问的完整回答",
      inheritedHistory: [
        { role: "user", content: "不应重新嵌入 prompt 的历史甲" },
        { role: "assistant", content: "不应重新嵌入 prompt 的历史乙" },
      ],
    });
    project.notes = [selected];
    const custom: PromptTemplate = {
      id: "user-template",
      name: "用户模板",
      task: "custom",
      body: "文档 {{ document_title }}，第 {{page_number}} 页。保留 {{unknown_name}}。",
      version: 1,
    };

    const result = buildContext({
      project,
      note: selected,
      question: "这个结论为什么成立？",
      template: custom,
    });

    expect(result.prompt).toContain("文档 机器学习教材.pdf，第 1 页");
    expect(result.prompt).toContain("{{unknown_name}}");
    expect(result.prompt).toContain("【选中的原文】");
    expect(result.prompt).toContain("【附近内容与相关文档片段】");
    expect(result.prompt).toContain("[S1] 第 1 页");
    expect(result.prompt).toContain("【用户问题】\n这个结论为什么成立？");
    expect(result.prompt).toContain("【分支所针对的回答】\n被追问的完整回答");
    expect(result.prompt).not.toContain("不应重新嵌入 prompt");
  });

  it("describes a native PDF without text as OCR-eligible and keeps S1 without keyword matches", () => {
    const project = projectFixture();
    project.document.pageCount = 1;
    project.pages = [
      {
        page: 1,
        text: "",
        words: [],
        source: "native",
        status: "empty",
        width: 600,
        height: 800,
      },
    ];
    const selected = note({
      anchor: { page: 1, rects: [[1, 2, 3, 4]], quote: "扫描图中的公式" },
    });
    project.notes = [selected];

    const result = buildContext({
      project,
      note: selected,
      question: "xyzzy 完全无关",
      template: project.templates[0],
    });

    expect(result.coverage).toContain("未提取到文字、可按需 OCR 1 页");
    expect(result.coverage).not.toContain("已识别但无可检索文字");
    expect(result.sources).toEqual([
      expect.objectContaining({ id: "S1", page: 1, text: "扫描图中的公式" }),
    ]);
  });

  it("caps API history at 40 messages and marks implicit image truncation", () => {
    const project = projectFixture();
    project.assets = Array.from({ length: 21 }, (_, index) => ({
      id: `image-${index}`,
      name: `image-${index}.png`,
      mime: "image/png",
      data: new Blob(["x"]),
    }));
    const selected = note({
      draftAssetIds: project.assets.map((asset) => asset.id),
      inheritedHistory: Array.from({ length: 45 }, (_, index) => ({
        role: index % 2 ? "assistant" : "user",
        content: `历史 ${index}`,
      })),
    });
    project.notes = [selected];

    const result = buildContext({
      project,
      note: selected,
      question: "继续",
      template: project.templates[0],
      budget: 1_000_000,
    });

    expect(result.history).toHaveLength(40);
    expect(result.history[0].content).toBe("历史 5");
    expect(result.history.at(-1)?.content).toBe("历史 44");
    expect(result.truncated).toBe(true);
  });
});

describe("nested branches", () => {
  it("freezes three levels of context without sibling leakage", () => {
    const project = projectFixture();
    const root = note({
      messages: [
        message("root-q", "user", "根问题"),
        message("root-a", "assistant", "根回答"),
      ],
    });
    project.notes = [root];
    const level1 = createBranch(project, root, "root-a", "根回答中的一段");
    level1.messages.push(
      message("level1-q", "user", "一级问题"),
      message("level1-a", "assistant", "一级回答"),
    );
    project.notes.push(level1);
    const level2 = createBranch(project, level1, "level1-a");
    level2.messages.push(
      message("level2-q", "user", "二级问题"),
      message("level2-a", "assistant", "二级回答"),
    );
    project.notes.push(level2);
    const level3 = createBranch(project, level2, "level2-a");
    project.notes.push(level3);
    const sibling = createBranch(project, root, "root-a", "另一个分支");
    project.notes.push(sibling);

    expect(level3.anchor).toEqual(root.anchor);
    expect(level3.anchor.rects).not.toBe(root.anchor.rects);
    expect(level3.inheritedHistory.map((item) => item.content)).toEqual([
      "根问题",
      "根回答",
      "一级问题",
      "一级回答",
      "二级问题",
      "二级回答",
    ]);
    expect(
      level3.inheritedHistory.some((item) => item.content === "另一个分支"),
    ).toBe(false);
    expect(level3.branchQuote).toBe("二级回答");
    expect(level3.templateId).toBe("template-custom-v1");

    root.messages[0].content = "根消息后来被修改";
    expect(level3.inheritedHistory[0].content).toBe("根问题");
    expect(descendantIds(project.notes, root.id)).toEqual(
      expect.arrayContaining([level1.id, level2.id, level3.id, sibling.id]),
    );
    expect(descendantIds(project.notes, level1.id)).toEqual([
      level2.id,
      level3.id,
    ]);
  });
});

describe("project archive", () => {
  function archiveFixture(): Project {
    const project = projectFixture();
    const asset: Asset = {
      id: "asset-old",
      name: "figure.png",
      mime: "image/png",
      data: new Blob([new Uint8Array([1, 2, 3, 4])], { type: "image/png" }),
      source: { page: 1, rect: [20, 20, 200, 120] },
    };
    const root = note({
      id: "note-old",
      draftAssetIds: ["asset-old"],
      messages: [
        message("question-old", "user", "看图 ![figure](asset:asset-old)"),
        {
          ...message(
            "answer-old",
            "assistant",
            "回答中也有 ![again](inkask://asset/asset-old)",
            "streaming",
          ),
          assetIds: ["asset-old"],
          sources: [{ id: "S1", page: 1, text: "来源" }],
        },
      ],
    });
    project.assets = [asset];
    project.notes = [root];
    return project;
  }

  it("round-trips blobs, hierarchy, and image references with all IDs remapped", async () => {
    const project = archiveFixture();
    const child = createBranch(
      project,
      project.notes[0],
      "answer-old",
      "引用的回答",
    );
    child.messages = [
      { ...message("child-q", "user", "看图"), assetIds: ["asset-old"] },
    ];
    project.notes.push(child);

    const archive = await exportProject(project);
    const imported = await importProject(archive);

    expect(imported.document.id).not.toBe(project.document.id);
    expect(imported.notes.map((item) => item.id)).not.toContain("note-old");
    expect(imported.assets[0].id).not.toBe("asset-old");
    expect(await imported.document.pdf.text()).toBe("%PDF-1.7 fixture");
    expect(
      Array.from(new Uint8Array(await imported.assets[0].data.arrayBuffer())),
    ).toEqual([1, 2, 3, 4]);
    expect(imported.notes[0].messages[0].content).toContain(
      `asset:${imported.assets[0].id}`,
    );
    expect(imported.notes[0].messages[1].content).toContain(
      `inkask://asset/${imported.assets[0].id}`,
    );
    expect(imported.notes[0].messages[1].status).toBe("stopped");
    expect(imported.notes[1].parentId).toBe(imported.notes[0].id);
    expect(imported.notes[1].parentMessageId).toBe(
      imported.notes[0].messages[1].id,
    );
    expect(
      imported.notes[1].inheritedHistory.map((item) => item.content).join("\n"),
    ).toContain(imported.assets[0].id);
    expect(exportMarkdown(imported)).toContain("第 1 页");
    expect(exportMarkdown(imported)).toContain("[S1]");
  });

  it("rejects prototype keys, missing assets, and invalid ZIP data", async () => {
    const project = archiveFixture();
    const archive = await exportProject(project);

    const rewrite = async (
      manifestChange: (text: string) => string,
    ): Promise<Blob> => {
      const entries = unzipSync(new Uint8Array(await archive.arrayBuffer()));
      const manifest = manifestChange(strFromU8(entries["manifest.json"]));
      entries["manifest.json"] = strToU8(manifest);
      return new Blob([zipSync(entries)], { type: "application/zip" });
    };

    const polluted = await rewrite((text) =>
      text.replace(
        '"formatVersion":1',
        '"__proto__":{"polluted":true},"formatVersion":1',
      ),
    );
    await expect(importProject(polluted)).rejects.toThrow(/Forbidden key/);

    const missingAsset = await rewrite((text) => {
      const manifest = JSON.parse(text);
      manifest.project.assets[0].archivePath = "assets/missing.png";
      return JSON.stringify(manifest);
    });
    await expect(importProject(missingAsset)).rejects.toThrow(
      /Asset figure\.png is missing/,
    );

    const missingAssetUri = await rewrite((text) => {
      const manifest = JSON.parse(text);
      manifest.project.notes[0].messages[0].content =
        "![missing](asset:absent-asset)";
      return JSON.stringify(manifest);
    });
    await expect(importProject(missingAssetUri)).rejects.toThrow(
      /Content references missing asset absent-asset/,
    );
    await expect(importProject(new Blob(["not a zip"]))).rejects.toThrow(
      /valid InkAsk ZIP/,
    );
  });
});

describe("IndexedDB persistence", () => {
  beforeEach(async () => {
    const storage = await import("../src/core/storage");
    await storage.deleteProject("storage-doc");
  });

  it("saves blobs, lists documents, and repairs interrupted streams on load", async () => {
    const storage = await import("../src/core/storage");
    const project = projectFixture();
    project.document.id = "storage-doc";
    project.document.name = "持久化测试.pdf";
    project.notes = [
      {
        ...note(),
        messages: [
          message("stream-message", "assistant", "半截回答", "streaming"),
        ],
      },
    ];

    await storage.saveProject(project);
    const loaded = await storage.loadProject("storage-doc");
    const documents = await storage.listDocuments();

    expect(await loaded?.document.pdf.text()).toBe("%PDF-1.7 fixture");
    expect(loaded?.notes[0].messages[0].status).toBe("stopped");
    expect(documents.some((document) => document.id === "storage-doc")).toBe(
      true,
    );
    await storage.deleteProject("storage-doc");
    expect(await storage.loadProject("storage-doc")).toBeUndefined();
  });
});
