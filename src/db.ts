import pg from "pg";
import { loadConfig } from "./config.js";

const { Pool } = pg;

export function createPool(): pg.Pool {
  const config = loadConfig();
  return new Pool({
    connectionString: config.databaseUrl,
    max: 10,
  });
}

export async function closePool(pool: pg.Pool): Promise<void> {
  await pool.end();
}
