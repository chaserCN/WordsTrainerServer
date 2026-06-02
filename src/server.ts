import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { closePool, createPool } from "./db.js";

const config = loadConfig();
const pool = createPool(config);
const app = buildApp(pool, config);

const shutdown = async () => {
  await app.close();
  await closePool(pool);
};

process.on("SIGINT", () => {
  shutdown().finally(() => process.exit(0));
});

process.on("SIGTERM", () => {
  shutdown().finally(() => process.exit(0));
});

await app.listen({
  host: config.host,
  port: config.port,
});
