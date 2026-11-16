# 笔记目录导出（Markdown per note）

`导出 → 笔记目录 (.zip)` 把一个项目输出成**可提交进 Git、可全文检索**的目录：一条便签一个 `.md`，外加一棵 README 索引树、原 PDF 和用到的图片。实现在 `src/core/note-export.ts`，UI 入口在 `src/App.tsx`，测试在 `tests/note-export.test.ts`。

## 目录结构

```
第三周作业/
├── README.md                  ← 便签树（带相对链接）+ 导出说明
├── document.pdf               ← 原 PDF，未做任何改写
├── notes/
│   ├── 0001-一致有界.md
│   └── 0002-追问切分.md        ← 文件名前的编号 = 阅读顺序（深度优先）
└── assets/
    ├── 001-crop.png            ← 选区截图
    └── 002-截图-2026-11-12.png  ← 提问附图
```

文件名规则：`<四位序号>-<标题 slug>.md`。slug 会做 NFC 归一（macOS 的 NFD 与 Linux 一致）、把 `\u0000-\u001f < > : " / \ | ? *` 和空白折成 `-`、去掉首尾的点与横线、按**码位**截断到 48 字（不会切断代理对）；标题被清空时退回 `note`。序号前缀保证唯一，因此同标题的两条便签也不会互相覆盖。

## 单个便签文件

```markdown
---
id: "8f3c…"
title: "一致有界"
page: 3
pages: [3, 4]          ← 仅跨页选文时出现
task: explain
template: "学术解释"
created: "2026-11-12T15:12:00.000Z"
depth: 1
parent_id: "8f3c…"
parent: "0001-一致有界.md"
parent_message: "5d21…"
messages: 2
children: 1
---

# 一致有界

> 设函数族一致有界……
> — 第 3 页

- 定位：第 3–4 页
- 任务：解释 · 模板：学术解释
- 便签 ID：`8f3c…`

## 选区截图

![图片](../assets/001-crop.png)

## 提问

解释 $a=\frac{b}{2}$

## 回答

……模型返回的原始 Markdown……

### 本次参考来源

- **S1 · 第 3 页 · §定理 2**
  > 证：对任意 ε>0……

## 子便签

- [追问切分](0002-追问切分.md)· 第 3 页
```

约定：

- **front matter 是机器可读的那一半**：`id` / `page` / `task` / `parent_id` / `parent` / `created` 都是稳定值，可以用脚本直接遍历。字符串用 JSON 转义（YAML 双引号标量的合法子集），所以标题里带引号、换行也安全。
- **正文是原样**：`## 回答` 里的内容就是保存下来的 Markdown，公式、表格、代码块、换行都不改写；不重新检索、不重新生成、不重写已存回答。
- **多轮**：同一条便签里第 2 轮起编号为 `## 提问 2` / `## 回答 2`；被中止的标 `⏹`，失败的标 `⚠️` 并写出错误原文。
- **引用**：`### 本次参考来源` 列出 `S1 · 第 N 页 · 小节`，原文按上限截断（默认 2000 字，`sourceChars` 可调），截断行会写明总字数。
- **图片**：`../assets/…` 相对链接；引用不到字节时写 `（图片缺失：id）`，关掉图片导出时写 `（图片未导出：id）`，都不中断导出。
- **祖先问答不重复写入**（存在 `inheritedHistory` 里），这样不同分支可以逐条对比；需要完整还原用 `完整项目 (.inkask)`。

## 边界与取舍

- 上限：便签 20 000 条、图片 2 000 张（超限直接报错，不静默截断）；压缩级别 6。
- 不包含便签坐标、选区矩形与词框——目录是给人读和给 Git 存的，`.inkask` 才是完整还原。
- 不做双向同步：这里只导出。要“文件为准 + IndexedDB 当缓存”的同步层，需要先做 `docs/reader-performance.md` 的 P1（便签分行存储）。

## 命令行（把 .inkask 直接摊成目录）

界面上是下载 zip；想直接进 Git 可以走 CLI，同一个 `planNoteExport`：

```sh
npm run export:notes -- ~/Downloads/week3-homework.inkask ./week3-notes
# 或： npx tsx scripts/export-notes.mts <项目.inkask> <输出目录> [--no-pdf] [--no-assets]
```

输出结构与 zip 解开后一样（`README.md` / `notes/` / `assets/` / `document.pdf`），不经过压缩，落盘即可 `git add`。
- 读的是**已保存**的便签状态；正在生成的便签按当前已收到的内容导出（状态标 `stopped`/`streaming` 时按已存内容写出，与界面一致）。

## 验证

`tests/note-export.test.ts` 覆盖：阅读顺序与 README 树、父子相对链接、正文逐字节保真、多轮编号、中止/失败标记、引用截断与选区元数据、文件名清洗（含中文与长标题）、同标题不覆盖、front matter 转义、孤儿与环状父便签、缺失/跳过的图片、空项目、便签超限报错、zip 结构与字节内容、NFC 归一。
