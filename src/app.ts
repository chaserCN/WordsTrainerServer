import cors from "@fastify/cors";
import Fastify from "fastify";
import type pg from "pg";
import type { AppConfig } from "./config.js";
import { HttpError } from "./http.js";
import { registerAdminRoutes } from "./routes/admin.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerMediaRoutes } from "./routes/media.js";
import { registerSyncRoutes } from "./routes/sync.js";
import { ObjectStorageService } from "./storage.js";

export function buildApp(pool: pg.Pool, config: AppConfig) {
  const app = Fastify({
    logger: true,
    bodyLimit: 25 * 1024 * 1024,
  });
  const objectStorage = new ObjectStorageService(config.objectStorage);

  app.addContentTypeParser(/^audio\/.*$/i, { parseAs: "buffer" }, (_request, body, done) => {
    done(null, body);
  });
  app.addContentTypeParser(/^image\/.*$/i, { parseAs: "buffer" }, (_request, body, done) => {
    done(null, body);
  });
  app.addContentTypeParser("application/octet-stream", { parseAs: "buffer" }, (_request, body, done) => {
    done(null, body);
  });

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
  app.register((instance) => registerMediaRoutes(instance, pool, config.localMediaRoot));
  app.register((instance) => registerSyncRoutes(instance, pool));
  app.register((instance) => registerAdminRoutes(instance, pool, objectStorage, config.localMediaRoot));

  return app;
}
