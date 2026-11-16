# 验证记录

最后更新：2026-11-16（`v0.1.0`）。更早的验收原文保留在文末「历史记录」，其中数字已过时。

## 一句话状态

代码、构建与自动测试通过；项目与附件已经从浏览器搬到磁盘（`.inkask/`）；下面「未验」仍是空白区——真实模型、Safari 与大文档吞吐在交付前没有重新测量。

## 当前基线

| 项 | 结果 |
| --- | --- |
| 环境 | Node v26.12.0 / npm 11.20.0（要求 Node ≥ 22），macOS |
| `npm run check`（tsc --noEmit） | 通过 |
| `npm test`（vitest） | **261 项 / 26 个文件全绿**（模拟模型，无真实调用） |
| `npm run build`（tsc + vite build） | 通过 |
| 本机服务 | `npm start` 监听 `127.0.0.1:8787`；`/api/status`、`/api/projects`、`/api/storage` 均 200 |
| 启动面板 | `./启动 InkAsk.command --check` 通过；能认出命令行实例并整串停止 / 接管重启 |

## 本轮（2026-11-16）实际验证过的

### 1. 项目落盘（服务端 `.inkask/`）

- 用真实备份 `week3-homework.inkask` 导入后：`projects/<id>/project.json` 241.6 KB + 4 个附件；回读的便签/消息结构与写入前一致，PDF 字节 SHA-256 相同。
- 真实 HTTP 层：`PUT /api/blobs/:id` → `PUT /api/projects/:id` → 磁盘出现 `projects/…/project.json` 与 `blobs/xx/<sha>`；`DELETE` 后附件被回收（`/api/storage` 归零）。
- 迁移：fake-indexeddb 里放 v1（整包）与 v2（引用式）两代数据 → `prepareStorage()` 复制到磁盘、**旧记录不删**、第二次运行不重复搬；中途失败不写「已迁移」标记，下次启动重试（均由测试固定）。
- 服务不可用：只读退回浏览器副本，保存明确报错、不会两边各写一半（测试固定）。

### 2. API 配置

- 把旧机器的 `providers.json` 复制进新目录后**无需重启**即生效（`ConfigStore` 按文件 size+mtime 重新读取，测试固定）。
- 真实请求：`POST /api/chat` → DeepSeek 流式返回「连接正常」（约 1.0 s）；日志里没有密钥。
- 密钥位置审计：遍历 **409 个 git 对象**，用真实密钥全长与末 8 位片段逐字节搜索，**0 命中**；`providers.json` / `.inkask/` 从未进入版本库。

### 3. 笔记目录导出

- 单测 16 项（顺序、父子链接、正文逐字节保真、引用截断、文件名清洗、孤儿/环状父便签、缺失图片、zip 结构、NFC 归一）。
- 真实备份：6 便签 / 8 消息 / 3 图 → zip 1.33 MB；中文文件名带 UTF-8 标志，`ditto -x -k`（Finder 同一解压器）与 Python `zipfile` 解出的名字都正确。
- CLI `npm run export:notes` 落盘结构与 zip 一致。

### 4. 公式排版

- 先修了一个真问题：dev 模式（5173）下 KaTeX 字体返回 **403**——`node_modules` 当时是项目外的符号链接，被 Vite 的 `/@fs` 白名单拦掉，浏览器只好用系统字体凑（∫ 变细、`|f(x)|` 撑开）。改成真实目录后 `GET …/KaTeX_Size1-Regular.woff2` → `200 · font/woff2 · wOF2`。
- 排版调整：行内 1.15em、块级公式单独 1.28em + 0.18px 描边、`katex-display` 上下留白 `1em → 0.5em`、正文行距 `1.95 → 1.8`；`\middle|` 规整为 `\mid`（范数 `\middle\|` 与代码块内不动，测试固定）。

### 5. 仓库与交付

- `启动 InkAsk.command`：体检（Node/依赖/运行资源/dist 新旧）、后台启动、状态/启停/重启/日志/重建/开发模式；能识别 `npm run dev` 起的实例（显示「运行中 · 命令行启动」）并整串停止或接管。
- 仓库搬家到 `工程设计/InkAsk-web` 后：git 干净、远端同步、`261` 项测试与构建全部通过、字体 200、`/api/storage` 指向新目录。

## 未验（交付前的空白，如实记录）

- **真实模型质量**：所有 UI 验收都走 `tests/browser-server.ts` 的确定性模拟模型；长文、多图、超长对话的真实时延、费用与稳定性未测。
- **Safari**：只做过普通阅读、扫描页检测与滚动的功能级验收；大文档、选区与本次排版改动都没在 Safari 复测。
- **Windows**：`start-windows.cmd` 仅静态审查，没有实机。
- **超大文档**：2000 页 / 30 000 便签的性能结论来自 2026-11-12 的一次测量，本轮未重测；`docs/reader-performance.md` 的 P1（便签分行存储）尚未实施，元数据仍是「一个项目一个 JSON」。
- **容量边界**：`.inkask` 解压上限 512 MiB、单附件 64 MiB 等限制没有用接近上限的样本压过。

## 复现

```sh
npm ci
npm run check && npm test && npm run build
npm start                          # http://127.0.0.1:8787
npx tsx tests/browser-server.ts    # 模拟服务：http://127.0.0.1:8790
npm run export:notes -- <项目.inkask> <输出目录>
```

大文档样本与压测见 `docs/reader-performance.md`；落盘与迁移见 `docs/storage.md`；导出格式见 `docs/note-export.md`。

## 历史记录（2026-11-10 首版验收，原文保留）

2026-11-10，Node.js 26.12.0，本机浏览器。

- TypeScript 检查、生产构建通过。
- 26 项自动测试：Responses SSE 完成与提前断流、鉴权/限流/网络错误、客户端中止、UTF-8 分块、提示词变量和预算、分支隔离、归档完整性、图片引用重映射、IndexedDB 恢复。
- 实际浏览器：原生 PDF 选文创建便签；中英文扫描页本地 OCR；区域框选与局部识别；截图参与提问；流式 Markdown、行内/块级公式、矩阵、表格、代码和图片展示。
- 浏览器中创建根便签加三级嵌套分支，验证深层面包屑；共 5 张便签的项目成功导出，再导入为独立副本，公式、图片、OCR 和便签关系保留。
- 开发地址未配置 AI 密钥时，PDF、OCR 与保存功能可使用，发送按钮提示配置。

UI 问答验收使用 `tests/browser-server.ts` 的确定性模拟模型，页面与回答明确显示「本机模拟 / 非真实 AI」。没有调用真实模型；真实提供方质量、费用和时延尚未验证。

两个实现工作区已完成真实差异检查和 `worktree_finish` 的独立类型/模块测试。MiniMax 独立审查代理被提供方以 HTTP 400「duplicate tool name」拒绝启动；该快照保持无改动，未将其算作审查通过。后续代码复核由主智能体完成。

界面验收截图保存在本机 `artifacts/`，不纳入源码提交。
