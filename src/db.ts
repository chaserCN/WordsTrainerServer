import pg from "pg";
import { loadConfig, type AppConfig } from "./config.js";

const { Pool } = pg;

export function createPool(config: Pick<AppConfig, "databaseUrl"> = loadConfig()): pg.Pool {
  return new Pool({
    connectionString: config.databaseUrl,
    max: 10,
  });
}

export async function closePool(pool: pg.Pool): Promise<void> {
  await pool.end();
}
