# 项目落盘（`.inkask/`）

笔记以前只活在浏览器 IndexedDB 里：清站点数据、换端口（5173 ↔ 8787）、换浏览器，看起来都像"笔记没了"。现在项目和附件由本机服务直接写到磁盘，浏览器只负责显示。

## 目录

```
<cwd>/.inkask/                       ← 默认（INKASK_DATA_DIR 可改）
├── providers.json                    API 设置与密钥（0700/0600，原有）
├── workspace.json                    文件夹与"资料 → 文件夹"归属
├── projects/
│   └── <projectId>/
│       └── project.json              元数据：pages / notes / templates / view / 附件引用
└── blobs/
    └── <sha 前两位>/<sha256>         原始字节：PDF、选区截图、提问附图
```

- **附件按内容寻址**：同一个 PDF 或同一张截图只存一份；删除资料时会把没有其他资料引用的附件一并清掉（`pruneBlobs`）。
- **元数据与字节分开提交**：`project.json` 先写临时文件再 `rename`，任何一步失败都保留上一版；附件不可变，传失败重试即可。
- **`INKASK_DATA_DIR`** 可把整个数据目录挪到备份盘或临时目录（`server/index.ts`）。`providers.json` 仍然固定在 `<cwd>/.inkask/`。

## 接口

全部只监听 `127.0.0.1`，并沿用服务的 Host / Origin 校验：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/api/projects` | 列表（只读元数据，不碰 PDF 字节） |
| `GET` | `/api/projects/:id` | 单个项目元数据（附件是 `{ binaryId, type }` 引用） |
| `PUT` | `/api/projects/:id` | 原子替换元数据；校验 `storageVersion`、`document.id` 与数组字段 |
| `DELETE` | `/api/projects/:id` | 删除并回收孤儿附件 |
| `PUT`/`GET` | `/api/blobs/:id` | 附件字节（`application/octet-stream`，按 sha256 命名） |
| `GET`/`PUT` | `/api/workspace` | 文件夹与归属（小文件，读改写） |
| `GET` | `/api/storage` | 数据目录、资料数、附件数与字节数（设置面板里显示的就是它） |

限制：单个项目 256 MB、单个附件 128 MB、项目 500 个、`workspace.json` 4 MB。超限返回 413，ID 不合法或格式不对返回 400。

## 客户端怎么用

`src/core/storage.ts` 的导出没有变（`saveProject` / `loadProject` / `listDocuments` / `deleteProject` / 文件夹系列），只是底层从 Dexie 换成了上面这些接口。保存入口、`ProjectSaveQueue` 的串行与合并、深快照隔离都保持原样，所以检查点、切换资料、页面隐藏时的立即保存行为不变。

**一次性迁移**：启动时 `prepareStorage()` 会读一遍浏览器里的旧数据，把磁盘上还没有的资料复制过去，然后写一个 `inkask:disk-migration:v1` 标记。旧数据**不删除**，迁移失败下次继续；文件夹与归属一起搬。设置面板的「本机存储」会显示当前目录与体积。

**强制再迁一次**：地址栏加 `?migrate=1`（例如 <http://127.0.0.1:5173/?migrate=1>）会忽略"已迁移"标记再扫一遍浏览器——换了浏览器 profile、恢复了站点数据、或者第一次迁移时服务没起来，都可以用它补。

**服务没起来时**：只读还能用——`listDocuments` / `loadProject` 会退回浏览器里那份旧数据；但**保存会明确失败**（"本地服务没有响应……"），不会偷偷把新内容写进浏览器，避免两份数据各写一半。

## 备份与迁移

- 备份：直接复制 `.inkask/`（`providers.json` 里有密钥，别随手分享）。或者在界面里「导出 → 完整项目」拿一个 `.inkask` 单文件。
- 换机器/换目录：复制 `.inkask/` 或设 `INKASK_DATA_DIR` 指过去。数据跟着**启动目录**走，所以从两个不同目录启动的两个副本各有各的 `.inkask/`。
- 清浏览器数据不再影响笔记；反过来，清楚浏览器数据后旧副本也就没了，剩下的以磁盘为准。

## 还没做

元数据仍是"一个项目一个 JSON"，30 000 条便签的项目一次保存仍要序列化整包（`docs/reader-performance.md` 的 P1 依旧成立）。落盘之后，P1 的收益会更直接：改成按便签分行写文件/分表，一次追问只写脏行。

另外没有做双向同步：磁盘是唯一真源，浏览器那份只在服务不可用时只读兜底。
