import 'dotenv/config';
import { resolve } from 'node:path';
import { createApp } from './app.js';

const port = Number.parseInt(process.env.PORT ?? '8787', 10);
const listenPort = Number.isFinite(port) ? port : 8787;
const app = createApp({
  apiKey: process.env.OPENAI_API_KEY,
  baseURL: process.env.OPENAI_BASE_URL,
  model: process.env.OPENAI_MODEL,
  staticRoot: resolve(process.cwd(), 'dist'),
  logger: true,
});

try {
  await app.listen({ host: '127.0.0.1', port: listenPort });
} catch (error) {
  app.log.error(error);
  process.exitCode = 1;
}
