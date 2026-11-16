import "dotenv/config";
import { resolve } from "node:path";
import { createApp } from "./app.js";
import { ConfigStore } from "./config.js";

const port = Number.parseInt(process.env.PORT ?? "8787", 10);
const listenPort = Number.isFinite(port) ? port : 8787;
// Project data defaults to `<cwd>/.inkask`; INKASK_DATA_DIR points it elsewhere
// (backup on another disk, or a throwaway directory while testing).
const dataDir = process.env.INKASK_DATA_DIR
  ? resolve(process.env.INKASK_DATA_DIR)
  : resolve(process.cwd(), ".inkask");
// Provider settings stay where they have always been: `<cwd>/.inkask/providers.json`.
const configStore = new ConfigStore(resolve(process.cwd(), ".inkask/providers.json"));
const app = createApp({
  configStore,
  apiKey: process.env.OPENAI_API_KEY,
  baseURL: process.env.OPENAI_BASE_URL,
  model: process.env.OPENAI_MODEL,
  staticRoot: resolve(process.cwd(), "dist"),
  dataDir,
  logger: true,
});

try {
  await app.listen({ host: "127.0.0.1", port: listenPort });
} catch (error) {
  app.log.error(error);
  process.exitCode = 1;
}
