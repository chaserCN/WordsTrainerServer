import cors from "@fastify/cors";
import Fastify from "fastify";
import type pg from "pg";
import type { AppConfig } from "./config.js";
import { HttpError } from "./http.js";
import { registerAdminRoutes } from "./routes/admin.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerSyncRoutes } from "./routes/sync.js";
import { ObjectStorageService } from "./storage.js";

export function buildApp(pool: pg.Pool, config: AppConfig) {
  const app = Fastify({
    logger: true,
  });
  const objectStorage = new ObjectStorageService(config.objectStorage);

  app.register(cors, {
    origin: true,
  });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof HttpError) {
      reply.status(error.statusCode).send({
        error: error.errorCode,
        message: error.message,
      });
      return;
    }
    reply.send(error);
  });

  app.register((instance) => registerHealthRoutes(instance, pool));
  app.register((instance) => registerSyncRoutes(instance, pool));
  app.register((instance) => registerAdminRoutes(instance, pool, objectStorage));

  return app;
}
