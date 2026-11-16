#!/usr/bin/env node
/**
 * 把 `.inkask` 备份直接摊成「笔记目录」写进磁盘，便于 git 管理。
 *
 *   npx tsx scripts/export-notes.mts ~/Downloads/week3-homework.inkask ./notes-out
 *   npx tsx scripts/export-notes.mts backup.inkask ./notes-out --no-pdf
 *
 * 与界面里的「导出 → 笔记目录」同源（都用 src/core/note-export.ts），
 * 区别只是这里直接落盘，不用先解压 zip。
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { importProject } from "../src/core/archive";
import { planNoteExport } from "../src/core/note-export";

const [input, output = "notes-out", ...flags] = process.argv.slice(2);
if (!input) {
  console.error("用法: npx tsx scripts/export-notes.mts <项目.inkask> [输出目录] [--no-pdf] [--no-assets]");
  process.exit(2);
}

const includePdf = !flags.includes("--no-pdf");
const includeAssets = !flags.includes("--no-assets");
const target = resolve(output);

const project = await importProject(new Blob([await readFile(input)], { type: "application/zip" }));
const plan = planNoteExport(project, { includePdf, includeAssets });

await mkdir(target, { recursive: true });
for (const file of plan.files) {
  const path = join(target, file.path);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, file.text, "utf8");
}
for (const entry of plan.assets) {
  const path = join(target, entry.path);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, new Uint8Array(await entry.asset.data.arrayBuffer()));
}
if (plan.includePdf) {
  await writeFile(join(target, "document.pdf"), new Uint8Array(await project.document.pdf.arrayBuffer()));
}

console.log(
  `${target}\n  便签 ${plan.stats.notes} · 消息 ${plan.stats.messages} · 图片 ${plan.stats.images}` +
    ` · PDF ${includePdf ? "含" : "不含"}`,
);
