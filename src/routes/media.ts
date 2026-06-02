import type { FastifyInstance } from "fastify";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type pg from "pg";
import { requireHouseholdSync } from "../auth.js";
import type { AppConfig } from "../config.js";
import { badRequest, notFound, requiredUUID } from "../http.js";
import type { ObjectStorageService } from "../storage.js";

type IdParams = {
  mediaId?: string;
};

export async function registerMediaRoutes(
  app: FastifyInstance,
  pool: pg.Pool,
  config: AppConfig,
  objectStorage: ObjectStorageService,
): Promise<void> {
  app.get<{ Params: IdParams }>("/v1/media/:mediaId", async (request, reply) => {
    requireHouseholdSync(request, config);
    const mediaId = requiredUUID(request.params.mediaId, "mediaId");
    const result = await pool.query<{
      storage_key: string;
      mime_type: string;
      byte_size: number | null;
    }>(
      `
      SELECT storage_key, mime_type, byte_size
      FROM media_objects
      WHERE id = $1 AND upload_status = 'ready'
      `,
      [mediaId],
    );
    if (!result.rowCount) {
      notFound("media not found");
    }

    const media = result.rows[0];
    if (/^https?:\/\//i.test(media.storage_key)) {
      badRequest("media is stored externally");
    }

    const root = path.resolve(config.localMediaRoot);
    const filePath = path.resolve(root, media.storage_key);
    if (!filePath.startsWith(`${root}${path.sep}`)) {
      badRequest("invalid media storage key");
    }

    try {
      const data = await readFile(filePath);
      reply.type(media.mime_type);
      if (media.byte_size != null) {
        reply.header("Content-Length", String(media.byte_size));
      }
      reply.header("Cache-Control", "public, max-age=31536000, immutable");
      return data;
    } catch {
      const downloadUrl = await objectStorage.createDownloadUrl(media.storage_key);
      if (!downloadUrl) {
        notFound("media file not found");
      }
      reply.header("Cache-Control", "private, max-age=300");
      return reply.redirect(downloadUrl);
    }
  });
}
