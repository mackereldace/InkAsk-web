/**
 * Synthetic reader datasets; no network, OCR, image attachments, or model calls.
 * node --import tsx scripts/reader-stress.mts --pages 500,2000 --out /private/tmp
 * Add --verify to time an archive round trip (use a small page count for a smoke test).
 */
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { createHash } from "node:crypto";
import { unzipSync } from "fflate";
import { exportProject, importProject } from "../src/core/archive.ts";
import { DEFAULT_TEMPLATES } from "../src/core/templates.ts";
import type { HistoryMessage, Message, Note, PageText, Project, Rect } from "../src/types.ts";

const ROOTS_PER_PAGE = 5;
const LEVELS = 3;
const WIDTH = 612, HEIGHT = 792;
const selectedSentence = "这个阶段需要明确变量、条件与结论之间的关系。";
const passages = [
  "阅读数学材料时，首先需要辨认研究对象以及对象之间的依赖关系。定义给出了允许讨论的范围，条件限制了结论可以使用的情境。把一个长段落拆成几个可以检查的小判断，通常比一次记住整段表述更有效。遇到新的符号时，可以先列出它代表的量、取值范围和出现的位置。这样能够把抽象表达和具体例子联系起来。",
  "以函数的变化为例，平均变化率描述一段区间上的总体趋势，瞬时变化率则关注区间不断缩小时的局部行为。两者使用相似的差值，但讨论的尺度并不相同。理解极限过程时应同时检查自变量如何接近目标，以及表达式在接近过程中是否满足原有条件。单独看到一个公式，并不能替代这些条件的核对。",
  "当结论包含多个量词时，应先确认每个量词的作用范围。固定一个对象再寻找另一个对象，与寻找一个能够适用于全部对象的统一选择，往往产生不同的命题。可以使用简单反例检验自己的解释：如果把某个条件去掉，是否仍然能够得到相同结论？如果不能，反例中的失败位置就是理解该条件的重要线索。",
  "在计算过程中，保留中间步骤有助于检查符号与单位。一个结果即使形式简洁，也可能在代入边界值时暴露问题。可以先选择容易计算的输入，比较原表达式和变形后的表达式是否一致，再检查分母、根号和对数等位置是否引入了新的限制。有效的计算应当同时保持数值意义与逻辑条件。",
  "对原文进行追问时，可以把自己的困惑写成一个明确的问题，例如为什么某个假设不能省略，或者某一步变形依据了哪条性质。清楚的问题能够帮助我们区分符号不熟悉、计算步骤缺失和概念理解偏差。回答中给出的说明仍应回到原文的定义和条件，避免把补充解释误认为材料已经证明的内容。",
  "建立例子时可以从最简单的情形开始，再逐步增加限制或维度。每增加一个条件，都记录它改变了哪些步骤、保留了哪些结论。通过这种比较，能够看见证明的结构而不是只记住书写顺序。若某个例子无法推广，也应说明阻碍推广的具体原因，而不是直接把特殊情形的结果当作一般规律。",
  "对一个推导的复核可以分成三个层次：第一层检查对象和记号是否一致，第二层检查每一步操作是否合法，第三层检查最后结论是否回答了最初问题。三个层次相互关联，但不能相互替代。清楚地区分它们，有助于在长证明中定位错误，也能让后续的追问集中在真正需要解释的环节。",
  "阅读时保留局部上下文十分重要。相同的符号在不同章节可能具有不同约定，因此引用一段公式时，需要同时关注它附近的定义、假设和说明。我们可以在理解一个局部段落后回到章节结构，确认它与前后结论的关系。这样的往返阅读能够逐渐建立材料的整体框架。",
];

function options() {
  let counts = [500, 2000], out = "/private/tmp", verify = false;
  for (let index = 2; index < process.argv.length; index++) {
    const argument = process.argv[index];
    if (argument === "--help") {
      console.log("Usage: node --import tsx scripts/reader-stress.mts [--pages 500,2000] [--out /private/tmp] [--verify]");
      process.exit(0);
    } else if (argument === "--verify") verify = true;
    else if (argument === "--pages" || argument.startsWith("--pages=")) {
      const value = argument.includes("=") ? argument.slice(argument.indexOf("=") + 1) : process.argv[++index];
      counts = (value ?? "").split(",").map(Number);
    } else if (argument === "--out" || argument.startsWith("--out=")) {
      out = argument.includes("=") ? argument.slice(argument.indexOf("=") + 1) : process.argv[++index];
      if (!out) throw new Error("--out requires a directory.");
    } else throw new Error(`Unknown option: ${argument}`);
  }
  if (!counts.length || counts.some((count) => !Number.isSafeInteger(count) || count < 1 || count > 10000))
    throw new Error("--pages must contain comma-separated integers from 1 to 10000.");
  return { counts: [...new Set(counts)], out: resolve(out), verify };
}

function line(page: number, root: number) {
  return `Page ${page}, note ${root}: Explain local change and check the assumptions.`;
}
function anchorRect(root: number): Rect { const y = 690 - (root - 1) * 110; return [52, y - 3, 536, y + 13]; }
function escapePdf(text: string) { return text.replace(/[\\()]/g, (character) => `\\${character}`); }

function makePdf(count: number): Buffer {
  const objects: Buffer[] = [
    Buffer.from("<< /Type /Catalog /Pages 2 0 R >>"),
    Buffer.from(`<< /Type /Pages /Kids [${Array.from({ length: count }, (_, index) => `${4 + index * 2} 0 R`).join(" ")}] /Count ${count} >>`),
    Buffer.from("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"),
  ];
  for (let page = 1; page <= count; page++) {
    const stream = [
      `BT /F1 18 Tf 52 746 Td (InkAsk Reader Stress - Page ${page} of ${count}) Tj ET`,
      ...Array.from({ length: ROOTS_PER_PAGE }, (_, index) => `BT /F1 12 Tf 52 ${690 - index * 110} Td (${escapePdf(line(page, index + 1))}) Tj ET`),
    ].join("\n");
    const contents = Buffer.from(stream, "ascii"), pageId = 4 + (page - 1) * 2;
    objects.push(Buffer.from(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${WIDTH} ${HEIGHT}] /Resources << /Font << /F1 3 0 R >> >> /Contents ${pageId + 1} 0 R >>`));
    objects.push(Buffer.concat([Buffer.from(`<< /Length ${contents.length} >>\nstream\n`), contents, Buffer.from("\nendstream")]));
  }
  const parts = [Buffer.from("%PDF-1.7\n%\xE2\xE3\xCF\xD3\n", "latin1")], offsets = [0];
  let length = parts[0].length;
  for (let index = 0; index < objects.length; index++) {
    offsets.push(length);
    const part = Buffer.concat([Buffer.from(`${index + 1} 0 obj\n`), objects[index], Buffer.from("\nendobj\n")]);
    parts.push(part); length += part.length;
  }
  const xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${length}\n%%EOF\n`;
  parts.push(Buffer.from(xref));
  return Buffer.concat(parts);
}

function answer(page: number, root: number, level: number): string {
  const start = (page + root + level) % passages.length;
  const prose = Array.from({ length: passages.length }, (_, index) => passages[(start + index) % passages.length]).join("\n\n").slice(0, 600);
  return `# 第 ${page} 页 · 便签 ${root} · 第 ${level} 层回答\n\n${selectedSentence}\n\n${prose}\n\n` +
    String.raw`局部变化可写为 $f(x)=x^2$，其导数是 $f'(x)=2x$。

$$f'(x)=\lim_{h\to0}\frac{f(x+h)-f(x)}{h}$$

- 核对变量的含义与范围。
- 回到原文检查结论所需的假设。[S1]

| 检查项 | 阅读目的 |
| --- | --- |
| 定义 | 确认对象 |
| 条件 | 判断适用范围 |
`;
}
function history(parent: Note): HistoryMessage[] {
  return [...parent.inheritedHistory.map((message) => ({ ...message })), ...parent.messages.map(({ role, content, assetIds }) => ({ role, content, ...(assetIds.length ? { assetIds: [...assetIds] } : {}) }))];
}
function makeProject(count: number, pdf: Buffer): Project {
  const createdAt = Date.now(), templateId = DEFAULT_TEMPLATES.find((template) => template.task === "explain")!.id;
  const pages: PageText[] = Array.from({ length: count }, (_, index) => {
    const page = index + 1;
    const words = Array.from({ length: ROOTS_PER_PAGE }, (_, root) => ({ text: line(page, root + 1) + "\n", rect: anchorRect(root + 1) }));
    return { page, words, text: words.map((word) => word.text).join(""), source: "native", status: "ready", width: WIDTH, height: HEIGHT };
  });
  const project: Project = {
    version: 1,
    document: { id: `stress-document-${count}`, name: `阅读性能验收 · ${count} 页 · ${count * ROOTS_PER_PAGE * LEVELS} 便签.pdf`, fingerprint: createHash("sha256").update(pdf).digest("hex"), pdf: new Blob([new Uint8Array(pdf).buffer], { type: "application/pdf" }), pageCount: count, createdAt, updatedAt: createdAt },
    pages, notes: [], assets: [], templates: structuredClone(DEFAULT_TEMPLATES), view: { page: 1, scale: .95, rotation: 0 },
  };
  for (let page = 1; page <= count; page++) {
    for (let root = 1; root <= ROOTS_PER_PAGE; root++) {
      let parent: Note | undefined;
      for (let level = 1; level <= LEVELS; level++) {
        const id = `stress-${count}-p${page}-n${root}-l${level}`;
        const sources = [{ id: "S1", page, text: line(page, root) }];
        const messages: Message[] = [
          { id: `${id}-question`, role: "user", content: `请解释第 ${page} 页的第 ${root} 处选文。这是第 ${level} 层追问。`, assetIds: [], status: "complete", createdAt },
          { id: `${id}-answer`, role: "assistant", content: answer(page, root, level), assetIds: [], sources, status: "complete", createdAt },
        ];
        const note: Note = {
          id, title: `第 ${page} 页 · 便签 ${root}${level > 1 ? ` · 追问 ${level - 1}` : ""}`,
          anchor: { page, quote: line(page, root), rects: [anchorRect(root)] },
          inheritedHistory: parent ? history(parent) : [], collapsed: false, task: "explain", templateId,
          draft: "", draftAssetIds: [], messages, createdAt,
          ...(parent ? { parentId: parent.id, parentMessageId: parent.messages[1].id, branchQuote: selectedSentence } : {}),
        };
        project.notes.push(note); parent = note;
      }
    }
  }
  if (project.notes.length !== count * ROOTS_PER_PAGE * LEVELS) throw new Error("Incorrect note count.");
  return project;
}

const { counts, out, verify } = options();
await mkdir(out, { recursive: true });
const metrics: Record<string, unknown>[] = [];
for (const pages of counts) {
  const started = performance.now(), pdf = makePdf(pages), project = makeProject(pages, pdf);
  const prepared = performance.now(), archive = await exportProject(project), compressed = new Uint8Array(await archive.arrayBuffer());
  const exported = performance.now();
  let jsonBytes = 0;
  unzipSync(compressed, { filter(file) { if (file.name === "manifest.json") jsonBytes = file.originalSize; return false; } });
  const prefix = resolve(out, `inkask-reader-stress-${pages}`);
  await writeFile(prefix + ".pdf", pdf);
  await writeFile(prefix + ".inkask", compressed);
  const generatedMs = performance.now() - started;
  let verifiedImportMs: number | undefined;
  if (verify) {
    const checkStarted = performance.now(), restored = await importProject(archive);
    if (restored.notes.length !== pages * ROOTS_PER_PAGE * LEVELS || restored.pages.length !== pages || restored.notes[2].inheritedHistory.length !== 4)
      throw new Error("Archive round trip lost fixture data.");
    verifiedImportMs = performance.now() - checkStarted;
  }
  const result = {
    pages, rootsPerPage: ROOTS_PER_PAGE, levels: LEVELS, notes: project.notes.length, messages: project.notes.length * 2,
    source: "native", answersApproxProseCharacters: 600, inheritedMessagesByLevel: [0, 2, 4],
    pdfBytes: pdf.length, jsonBytes, archiveBytes: compressed.length,
    prepareMs: Math.round(prepared - started), exportMs: Math.round(exported - prepared), generatedMs: Math.round(generatedMs),
    ...(verifiedImportMs === undefined ? {} : { verifiedImportMs: Math.round(verifiedImportMs) }),
    pdfPath: prefix + ".pdf", archivePath: prefix + ".inkask",
  };
  metrics.push(result); await writeFile(prefix + ".json", JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify(result));
}
await writeFile(resolve(out, "inkask-reader-stress-summary.json"), JSON.stringify(metrics, null, 2) + "\n");
