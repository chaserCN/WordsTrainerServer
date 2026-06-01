import type { FastifyInstance } from "fastify";
import type pg from "pg";

export async function registerHealthRoutes(app: FastifyInstance, pool: pg.Pool): Promise<void> {
  app.get("/health", async () => {
    const result = await pool.query<{ ok: number }>("SELECT 1 AS ok");
    return {
      ok: result.rows[0]?.ok === 1,
    };
  });
}
