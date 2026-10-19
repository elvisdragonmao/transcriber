import { loadConfig } from "./config.js";
import { buildApp } from "./app.js";

const config = loadConfig();
const built = await buildApp(config);

let closing = false;
const shutdown = async (sig: string) => {
  if (closing) return;
  closing = true;
  built.app.log.info(`${sig} received: pausing running stages at safe boundaries and stopping workers`);
  const force = setTimeout(() => process.exit(1), 30_000);
  try {
    await built.close();
  } finally {
    clearTimeout(force);
    process.exit(0);
  }
};
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

await built.app.listen({ host: config.host, port: config.port });
built.app.log.info(`transcriber listening on http://${config.host}:${config.port} (mock worker: ${config.mockWorker})`);
