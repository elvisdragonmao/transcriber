import type { DB } from "./db/index.js";
import type { AppConfig } from "./config.js";
import type { dataPaths } from "./config.js";
import type { SettingsStore } from "./settings.js";
import type { EventBus } from "./events.js";
import type { WorkerPoolLike } from "./workers/pool.js";
import type { LlmService } from "./llm/service.js";
import type { ObsidianService } from "./obsidian/service.js";

export interface AppContext {
  db: DB;
  config: AppConfig;
  paths: ReturnType<typeof dataPaths>;
  settings: SettingsStore;
  events: EventBus;
  workers: WorkerPoolLike;
  llm: LlmService;
  obsidian: ObsidianService;
  log: { info: (...a: any[]) => void; warn: (...a: any[]) => void; error: (...a: any[]) => void };
}
