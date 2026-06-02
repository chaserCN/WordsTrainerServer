import type { FastifyInstance } from "fastify";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type pg from "pg";
import { requireAdmin } from "../auth.js";
import {
  badRequest,
  notFound,
  optionalNumber,
  optionalString,
  optionalUUID,
  requiredString,
  requiredUUID,
} from "../http.js";
import type { ObjectStorageService } from "../storage.js";

type IdParams = {
  userId?: string;
  deckId?: string;
  versionId?: string;
  cardId?: string;
  exampleId?: string;
  mediaId?: string;
  groupId?: string;
};

type Queryable = Pick<pg.Pool, "query">;

function body(requestBody: unknown): Record<string, unknown> {
  if (requestBody == null || typeof requestBody !== "object" || Array.isArray(requestBody)) {
    badRequest("JSON object body is required");
  }
  return requestBody as Record<string, unknown>;
}

function requiredArray(value: unknown, field: string): Record<string, unknown>[] {
  if (!Array.isArray(value)) {
    badRequest(`${field} must be an array`);
  }
  return value.map((item, index) => {
    if (item == null || typeof item !== "object" || Array.isArray(item)) {
      badRequest(`${field}[${index}] must be an object`);
    }
    return item as Record<string, unknown>;
  });
}

function contentStatus(value: unknown, field: string): string {
  const status = optionalString(value, field) ?? "active";
  if (!["active", "inactive", "archived"].includes(status)) {
    badRequest(`${field} must be active, inactive, or archived`);
  }
  return status;
}

function appRole(value: unknown, field: string): string {
  const role = optionalString(value, field) ?? "learner";
  if (!["admin", "editor", "learner"].includes(role)) {
    badRequest(`${field} must be admin, editor, or learner`);
  }
  return role;
}

function groupRole(value: unknown, field: string): string {
  const role = optionalString(value, field) ?? "learner";
  if (!["owner", "editor", "learner"].includes(role)) {
    badRequest(`${field} must be owner, editor, or learner`);
  }
  return role;
}

function optionalInteger(value: unknown, field: string, defaultValue: number): number {
  const numberValue = optionalNumber(value, field);
  if (numberValue == null) {
    return defaultValue;
  }
  if (!Number.isInteger(numberValue)) {
    badRequest(`${field} must be an integer`);
  }
  return numberValue;
}

function requireSingleBlank(template: string): void {
  const count = template.split("{{blank}}").length - 1;
  if (count !== 1) {
    badRequest("template must contain exactly one {{blank}}");
  }
}

function safeFileName(value: string | null): string {
  if (!value) {
    return "file";
  }
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || "file";
}

function mediaStorageKey(fileName: string | null): string {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `media/${year}/${month}/${randomUUID()}-${safeFileName(fileName)}`;
}

async function requireDraftVersion(client: Queryable, deckId: string, versionId: string): Promise<void> {
  const result = await client.query(
    `
    SELECT status
    FROM deck_versions
    WHERE deck_id = $1 AND id = $2
    `,
    [deckId, versionId],
  );
  if (!result.rowCount) {
    notFound("deck version not found");
  }
  if (result.rows[0].status !== "draft") {
    badRequest("published deck versions are not editable");
  }
}

async function requireDeckVersion(client: Queryable, deckId: string, versionId: string): Promise<void> {
  const result = await client.query(
    `
    SELECT 1
    FROM deck_versions
    WHERE deck_id = $1 AND id = $2
    `,
    [deckId, versionId],
  );
  if (!result.rowCount) {
    notFound("deck version not found");
  }
}

async function requireCard(client: Queryable, versionId: string, cardId: string): Promise<void> {
  const result = await client.query(
    `
    SELECT 1
    FROM deck_version_cards
    WHERE deck_version_id = $1 AND card_id = $2
    `,
    [versionId, cardId],
  );
  if (!result.rowCount) {
    notFound("card not found");
  }
}

async function requireExample(client: Queryable, versionId: string, exampleId: string): Promise<void> {
  const result = await client.query(
    `
    SELECT 1
    FROM deck_version_examples
    WHERE deck_version_id = $1 AND example_id = $2
    `,
    [versionId, exampleId],
  );
  if (!result.rowCount) {
    notFound("example not found");
  }
}

async function requireUser(client: Queryable, userId: string): Promise<void> {
  const result = await client.query("SELECT 1 FROM users WHERE id = $1", [userId]);
  if (!result.rowCount) {
    notFound("user not found");
  }
}

async function requireDeck(client: Queryable, deckId: string): Promise<void> {
  const result = await client.query("SELECT 1 FROM decks WHERE id = $1", [deckId]);
  if (!result.rowCount) {
    notFound("deck not found");
  }
}

async function requireGroup(client: Queryable, groupId: string): Promise<void> {
  const result = await client.query("SELECT 1 FROM study_groups WHERE id = $1", [groupId]);
  if (!result.rowCount) {
    notFound("group not found");
  }
}

export async function registerAdminRoutes(
  app: FastifyInstance,
  pool: pg.Pool,
  objectStorage: ObjectStorageService,
  localMediaRoot: string,
): Promise<void> {
  app.addHook("preHandler", async (request) => {
    requireAdmin(request);
  });

  app.get("/v1/admin/users", async () => {
    const result = await pool.query(`
      SELECT users.id,
             users.display_name,
             users.role,
             users.avatar_media_id,
             users.created_at,
             users.updated_at
      FROM users
      ORDER BY users.created_at DESC
    `);
    return { users: result.rows };
  });

  app.post("/v1/admin/users", async (request, reply) => {
    const data = body(request.body);
    const displayName = requiredString(data.displayName, "displayName");
    const role = appRole(data.role, "role");
    const avatarMediaId = optionalUUID(data.avatarMediaId, "avatarMediaId");

    const result = await pool.query(
      `
      INSERT INTO users (display_name, role, avatar_media_id)
      VALUES ($1, $2, $3)
      RETURNING id, display_name, role, avatar_media_id, created_at, updated_at
      `,
      [displayName, role, avatarMediaId],
    );
    reply.status(201);
    return { user: result.rows[0] };
  });

  app.get("/v1/admin/groups", async () => {
    const result = await pool.query(`
      SELECT study_groups.id,
             study_groups.title,
             study_groups.created_at,
             study_groups.updated_at,
             COALESCE(COUNT(group_members.user_id), 0)::int AS member_count
      FROM study_groups
      LEFT JOIN group_members ON group_members.group_id = study_groups.id
      GROUP BY study_groups.id
      ORDER BY study_groups.created_at DESC
    `);
    return { groups: result.rows };
  });

  app.post("/v1/admin/groups", async (request, reply) => {
    const data = body(request.body);
    const title = requiredString(data.title, "title");

    const result = await pool.query(
      `
      INSERT INTO study_groups (title)
      VALUES ($1)
      RETURNING id, title, created_at, updated_at
      `,
      [title],
    );
    reply.status(201);
    return { group: result.rows[0] };
  });

  app.get<{ Params: IdParams }>("/v1/admin/groups/:groupId", async (request) => {
    const groupId = requiredUUID(request.params.groupId, "groupId");
    const group = await pool.query(
      `
      SELECT id, title, created_at, updated_at
      FROM study_groups
      WHERE id = $1
      `,
      [groupId],
    );
    if (!group.rowCount) {
      notFound("group not found");
    }
    const members = await pool.query(
      `
      SELECT group_members.group_id,
             group_members.user_id,
             users.display_name,
             users.role AS app_role,
             group_members.role,
             group_members.joined_at
      FROM group_members
      JOIN users ON users.id = group_members.user_id
      WHERE group_members.group_id = $1
      ORDER BY users.display_name
      `,
      [groupId],
    );
    return { group: group.rows[0], members: members.rows };
  });

  app.put<{ Params: IdParams }>("/v1/admin/groups/:groupId", async (request) => {
    const groupId = requiredUUID(request.params.groupId, "groupId");
    const data = body(request.body);
    const title = requiredString(data.title, "title");
    const result = await pool.query(
      `
      UPDATE study_groups
      SET title = $2,
          updated_at = now()
      WHERE id = $1
      RETURNING id, title, created_at, updated_at
      `,
      [groupId, title],
    );
    if (!result.rowCount) {
      notFound("group not found");
    }
    return { group: result.rows[0] };
  });

  app.put<{ Params: IdParams }>("/v1/admin/groups/:groupId/members/:userId", async (request) => {
    const groupId = requiredUUID(request.params.groupId, "groupId");
    const userId = requiredUUID(request.params.userId, "userId");
    const data = body(request.body ?? {});
    const role = groupRole(data.role, "role");

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await requireGroup(client, groupId);
      await requireUser(client, userId);
      const result = await client.query(
        `
        INSERT INTO group_members (group_id, user_id, role)
        VALUES ($1, $2, $3)
        ON CONFLICT (group_id, user_id) DO UPDATE SET
          role = excluded.role
        RETURNING group_id, user_id, role, joined_at
        `,
        [groupId, userId, role],
      );
      await client.query("COMMIT");
      return { member: result.rows[0] };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  });

  app.delete<{ Params: IdParams }>("/v1/admin/groups/:groupId/members/:userId", async (request) => {
    const groupId = requiredUUID(request.params.groupId, "groupId");
    const userId = requiredUUID(request.params.userId, "userId");
    const result = await pool.query(
      `
      DELETE FROM group_members
      WHERE group_id = $1 AND user_id = $2
      RETURNING group_id, user_id
      `,
      [groupId, userId],
    );
    if (!result.rowCount) {
      notFound("group member not found");
    }
    return { deletedMember: result.rows[0] };
  });

  app.post("/v1/admin/media", async (request, reply) => {
    const data = body(request.body);
    const storageKey = requiredString(data.storageKey, "storageKey");
    const mimeType = requiredString(data.mimeType, "mimeType");
    const sha256 = optionalString(data.sha256, "sha256");
    const byteSize = optionalNumber(data.byteSize, "byteSize");
    const width = optionalNumber(data.width, "width");
    const height = optionalNumber(data.height, "height");

    const result = await pool.query(
      `
      INSERT INTO media_objects (storage_key, sha256, mime_type, byte_size, width, height)
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (storage_key) DO UPDATE SET
        sha256 = excluded.sha256,
        mime_type = excluded.mime_type,
        byte_size = excluded.byte_size,
        width = excluded.width,
        height = excluded.height,
        upload_status = 'ready',
        updated_at = now()
      RETURNING id, storage_key, sha256, mime_type, byte_size, width, height, upload_status, created_at, updated_at
      `,
      [storageKey, sha256, mimeType, byteSize, width, height],
    );
    reply.status(201);
    return { media: result.rows[0] };
  });

  app.post("/v1/admin/media/upload", async (request, reply) => {
    if (!Buffer.isBuffer(request.body)) {
      badRequest("binary media body is required");
    }
    const bytes = request.body;
    if (bytes.length === 0) {
      badRequest("media body must not be empty");
    }
    const contentType = String(request.headers["content-type"] ?? "").split(";")[0]?.trim();
    if (!contentType) {
      badRequest("Content-Type header is required");
    }
    const fileNameHeader = request.headers["x-file-name"];
    const fileName = Array.isArray(fileNameHeader) ? fileNameHeader[0] : fileNameHeader ?? null;
    const storageKey = mediaStorageKey(fileName);
    const absolutePath = path.resolve(localMediaRoot, storageKey);
    const root = path.resolve(localMediaRoot);
    if (!absolutePath.startsWith(`${root}${path.sep}`)) {
      badRequest("invalid media storage key");
    }
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, bytes);

    const result = await pool.query(
      `
      INSERT INTO media_objects (storage_key, sha256, mime_type, byte_size)
      VALUES ($1, $2, $3, $4)
      RETURNING id, storage_key, sha256, mime_type, byte_size, width, height, upload_status, created_at, updated_at
      `,
      [storageKey, createHash("sha256").update(bytes).digest("hex"), contentType, bytes.length],
    );
    reply.status(201);
    return { media: result.rows[0] };
  });

  app.post("/v1/admin/media/upload-url", async (request, reply) => {
    const data = body(request.body);
    const fileName = optionalString(data.fileName, "fileName");
    const storageKey = optionalString(data.storageKey, "storageKey") ?? mediaStorageKey(fileName);
    const mimeType = requiredString(data.mimeType, "mimeType");
    const sha256 = optionalString(data.sha256, "sha256");
    const byteSize = optionalNumber(data.byteSize, "byteSize");
    const width = optionalNumber(data.width, "width");
    const height = optionalNumber(data.height, "height");

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const media = await client.query(
        `
        INSERT INTO media_objects (storage_key, sha256, mime_type, byte_size, width, height, upload_status)
        VALUES ($1, $2, $3, $4, $5, $6, 'pending')
        ON CONFLICT (storage_key) DO UPDATE SET
          sha256 = excluded.sha256,
          mime_type = excluded.mime_type,
          byte_size = excluded.byte_size,
          width = excluded.width,
          height = excluded.height,
          upload_status = 'pending',
          updated_at = now()
        RETURNING id, storage_key, sha256, mime_type, byte_size, width, height, upload_status, created_at, updated_at
        `,
        [storageKey, sha256, mimeType, byteSize, width, height],
      );
      const upload = await objectStorage.createUploadUrl({ storageKey, mimeType });
      await client.query("COMMIT");
      reply.status(201);
      return {
        media: media.rows[0],
        upload,
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  });

  app.post<{ Params: IdParams }>("/v1/admin/media/:mediaId/complete", async (request) => {
    const mediaId = requiredUUID(request.params.mediaId, "mediaId");
    const data = body(request.body ?? {});
    const sha256 = optionalString(data.sha256, "sha256");
    const byteSize = optionalNumber(data.byteSize, "byteSize");
    const width = optionalNumber(data.width, "width");
    const height = optionalNumber(data.height, "height");

    const result = await pool.query(
      `
      UPDATE media_objects
      SET sha256 = COALESCE($2, sha256),
          byte_size = COALESCE($3, byte_size),
          width = COALESCE($4, width),
          height = COALESCE($5, height),
          upload_status = 'ready',
          updated_at = now()
      WHERE id = $1
      RETURNING id, storage_key, sha256, mime_type, byte_size, width, height, upload_status, created_at, updated_at
      `,
      [mediaId, sha256, byteSize, width, height],
    );
    if (!result.rowCount) {
      notFound("media not found");
    }
    return { media: result.rows[0] };
  });

  app.post<{ Params: IdParams }>("/v1/admin/media/:mediaId/failed", async (request) => {
    const mediaId = requiredUUID(request.params.mediaId, "mediaId");
    const result = await pool.query(
      `
      UPDATE media_objects
      SET upload_status = 'failed',
          updated_at = now()
      WHERE id = $1
      RETURNING id, storage_key, sha256, mime_type, byte_size, width, height, upload_status, created_at, updated_at
      `,
      [mediaId],
    );
    if (!result.rowCount) {
      notFound("media not found");
    }
    return { media: result.rows[0] };
  });

  app.get("/v1/admin/decks", async () => {
    const result = await pool.query(`
      SELECT decks.id,
             decks.title,
             decks.avatar_system_name,
             decks.avatar_media_id,
             decks.language_code,
             decks.current_version_id,
             deck_versions.version_number AS current_version_number,
             deck_versions.status AS current_version_status,
             decks.created_at,
             decks.updated_at
      FROM decks
      LEFT JOIN deck_versions ON deck_versions.id = decks.current_version_id
      ORDER BY decks.created_at DESC
    `);
    return { decks: result.rows };
  });

  app.post("/v1/admin/decks", async (request, reply) => {
    const data = body(request.body);
    const title = requiredString(data.title, "title");
    const languageCode = requiredString(data.languageCode, "languageCode");
    const avatarSystemName = optionalString(data.avatarSystemName, "avatarSystemName");
    const avatarMediaId = optionalUUID(data.avatarMediaId, "avatarMediaId");

    const result = await pool.query(
      `
      INSERT INTO decks (title, avatar_system_name, avatar_media_id, language_code)
      VALUES ($1, $2, $3, $4)
      RETURNING id, title, avatar_system_name, avatar_media_id, language_code, current_version_id, created_at, updated_at
      `,
      [title, avatarSystemName, avatarMediaId, languageCode],
    );
    reply.status(201);
    return { deck: result.rows[0] };
  });

  app.post<{ Params: IdParams }>("/v1/admin/decks/:deckId/versions", async (request, reply) => {
    const deckId = requiredUUID(request.params.deckId, "deckId");
    const data = body(request.body ?? {});
    const manifest = data.manifest ?? {};

    await requireDeck(pool, deckId);
    const result = await pool.query(
      `
      WITH next_version AS (
        SELECT COALESCE(MAX(version_number), 0) + 1 AS version_number
        FROM deck_versions
        WHERE deck_id = $1
      )
      INSERT INTO deck_versions (deck_id, version_number, manifest)
      SELECT $1, next_version.version_number, $2::jsonb
      FROM next_version
      RETURNING id, deck_id, version_number, status, manifest, server_revision, created_at, published_at
      `,
      [deckId, JSON.stringify(manifest)],
    );
    reply.status(201);
    return { version: result.rows[0] };
  });

  app.get<{ Params: IdParams }>("/v1/admin/decks/:deckId/versions/:versionId", async (request) => {
    const deckId = requiredUUID(request.params.deckId, "deckId");
    const versionId = requiredUUID(request.params.versionId, "versionId");

    const version = await pool.query(
      `
      SELECT deck_versions.id,
             deck_versions.deck_id,
             deck_versions.version_number,
             deck_versions.status,
             deck_versions.manifest,
             deck_versions.server_revision,
             deck_versions.created_at,
             deck_versions.published_at
      FROM deck_versions
      WHERE deck_versions.deck_id = $1 AND deck_versions.id = $2
      `,
      [deckId, versionId],
    );
    if (!version.rowCount) {
      notFound("deck version not found");
    }

    const [cards, examples, forms, distractors] = await Promise.all([
      pool.query("SELECT * FROM deck_version_cards WHERE deck_version_id = $1 ORDER BY sort_order, display_word", [
        versionId,
      ]),
      pool.query("SELECT * FROM deck_version_examples WHERE deck_version_id = $1 ORDER BY card_id, sort_order", [
        versionId,
      ]),
      pool.query("SELECT * FROM deck_version_word_forms WHERE deck_version_id = $1 ORDER BY card_id, sort_order", [
        versionId,
      ]),
      pool.query("SELECT * FROM deck_version_distractors WHERE deck_version_id = $1 ORDER BY example_id, priority", [
        versionId,
      ]),
    ]);

    return {
      version: version.rows[0],
      cards: cards.rows,
      examples: examples.rows,
      forms: forms.rows,
      distractors: distractors.rows,
    };
  });

  app.put<{ Params: IdParams }>(
    "/v1/admin/decks/:deckId/versions/:versionId/cards/:cardId",
    async (request) => {
      const deckId = requiredUUID(request.params.deckId, "deckId");
      const versionId = requiredUUID(request.params.versionId, "versionId");
      const cardId = requiredUUID(request.params.cardId, "cardId");
      const data = body(request.body);
      const status = contentStatus(data.status, "status");
      const lemma = requiredString(data.lemma, "lemma");
      const displayWord = requiredString(data.displayWord, "displayWord");
      const partOfSpeech = optionalString(data.partOfSpeech, "partOfSpeech");
      const translation = requiredString(data.translation, "translation");
      const shortDefinition = optionalString(data.shortDefinition, "shortDefinition");
      const memoryHint = optionalString(data.memoryHint, "memoryHint");
      const etymology = optionalString(data.etymology, "etymology");
      const usageNote = optionalString(data.usageNote, "usageNote");
      const synonymNote = optionalString(data.synonymNote, "synonymNote");
      const grammarNote = optionalString(data.grammarNote, "grammarNote");
      const notes = optionalString(data.notes, "notes");
      const imageMediaId = optionalUUID(data.imageMediaId, "imageMediaId");
      const audioWordMediaId = optionalUUID(data.audioWordMediaId, "audioWordMediaId");
      const sortOrder = optionalInteger(data.sortOrder, "sortOrder", 0);

      await requireDraftVersion(pool, deckId, versionId);
      const result = await pool.query(
        `
        INSERT INTO deck_version_cards (
          deck_version_id,
          card_id,
          status,
          lemma,
          display_word,
          part_of_speech,
          translation,
          short_definition,
          memory_hint,
          etymology,
          usage_note,
          synonym_note,
          grammar_note,
          notes,
          image_media_id,
          audio_word_media_id,
          sort_order
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
        ON CONFLICT (deck_version_id, card_id) DO UPDATE SET
          status = excluded.status,
          lemma = excluded.lemma,
          display_word = excluded.display_word,
          part_of_speech = excluded.part_of_speech,
          translation = excluded.translation,
          short_definition = excluded.short_definition,
          memory_hint = excluded.memory_hint,
          etymology = excluded.etymology,
          usage_note = excluded.usage_note,
          synonym_note = excluded.synonym_note,
          grammar_note = excluded.grammar_note,
          notes = excluded.notes,
          image_media_id = excluded.image_media_id,
          audio_word_media_id = excluded.audio_word_media_id,
          sort_order = excluded.sort_order
        RETURNING *
        `,
        [
          versionId,
          cardId,
          status,
          lemma,
          displayWord,
          partOfSpeech,
          translation,
          shortDefinition,
          memoryHint,
          etymology,
          usageNote,
          synonymNote,
          grammarNote,
          notes,
          imageMediaId,
          audioWordMediaId,
          sortOrder,
        ],
      );
      return { card: result.rows[0] };
    },
  );

  app.delete<{ Params: IdParams }>(
    "/v1/admin/decks/:deckId/versions/:versionId/cards/:cardId",
    async (request) => {
      const deckId = requiredUUID(request.params.deckId, "deckId");
      const versionId = requiredUUID(request.params.versionId, "versionId");
      const cardId = requiredUUID(request.params.cardId, "cardId");

      await requireDraftVersion(pool, deckId, versionId);
      const result = await pool.query(
        `
        DELETE FROM deck_version_cards
        WHERE deck_version_id = $1 AND card_id = $2
        RETURNING card_id
        `,
        [versionId, cardId],
      );
      if (!result.rowCount) {
        notFound("card not found");
      }
      return { deletedCardId: result.rows[0].card_id };
    },
  );

  app.put<{ Params: IdParams }>(
    "/v1/admin/decks/:deckId/versions/:versionId/cards/:cardId/examples/:exampleId",
    async (request) => {
      const deckId = requiredUUID(request.params.deckId, "deckId");
      const versionId = requiredUUID(request.params.versionId, "versionId");
      const cardId = requiredUUID(request.params.cardId, "cardId");
      const exampleId = requiredUUID(request.params.exampleId, "exampleId");
      const data = body(request.body);
      const template = requiredString(data.template, "template");
      const answer = requiredString(data.answer, "answer");
      const answerFormKey = optionalString(data.answerFormKey, "answerFormKey");
      const translation = optionalString(data.translation, "translation");
      const note = optionalString(data.note, "note");
      const imageMediaId = optionalUUID(data.imageMediaId, "imageMediaId");
      const audioExampleMediaId = optionalUUID(data.audioExampleMediaId, "audioExampleMediaId");
      const sortOrder = optionalInteger(data.sortOrder, "sortOrder", 0);

      requireSingleBlank(template);
      await requireDraftVersion(pool, deckId, versionId);
      await requireCard(pool, versionId, cardId);

      const result = await pool.query(
        `
        INSERT INTO deck_version_examples (
          deck_version_id,
          example_id,
          card_id,
          template,
          answer,
          answer_form_key,
          translation,
          note,
          image_media_id,
          audio_example_media_id,
          sort_order
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        ON CONFLICT (deck_version_id, example_id) DO UPDATE SET
          card_id = excluded.card_id,
          template = excluded.template,
          answer = excluded.answer,
          answer_form_key = excluded.answer_form_key,
          translation = excluded.translation,
          note = excluded.note,
          image_media_id = excluded.image_media_id,
          audio_example_media_id = excluded.audio_example_media_id,
          sort_order = excluded.sort_order
        RETURNING *
        `,
        [
          versionId,
          exampleId,
          cardId,
          template,
          answer,
          answerFormKey,
          translation,
          note,
          imageMediaId,
          audioExampleMediaId,
          sortOrder,
        ],
      );
      return { example: result.rows[0] };
    },
  );

  app.delete<{ Params: IdParams }>(
    "/v1/admin/decks/:deckId/versions/:versionId/examples/:exampleId",
    async (request) => {
      const deckId = requiredUUID(request.params.deckId, "deckId");
      const versionId = requiredUUID(request.params.versionId, "versionId");
      const exampleId = requiredUUID(request.params.exampleId, "exampleId");

      await requireDraftVersion(pool, deckId, versionId);
      const result = await pool.query(
        `
        DELETE FROM deck_version_examples
        WHERE deck_version_id = $1 AND example_id = $2
        RETURNING example_id
        `,
        [versionId, exampleId],
      );
      if (!result.rowCount) {
        notFound("example not found");
      }
      return { deletedExampleId: result.rows[0].example_id };
    },
  );

  app.put<{ Params: IdParams }>(
    "/v1/admin/decks/:deckId/versions/:versionId/cards/:cardId/forms",
    async (request) => {
      const deckId = requiredUUID(request.params.deckId, "deckId");
      const versionId = requiredUUID(request.params.versionId, "versionId");
      const cardId = requiredUUID(request.params.cardId, "cardId");
      const data = body(request.body);
      const forms = requiredArray(data.forms, "forms").map((form) => ({
        formKey: requiredString(form.formKey, "forms.formKey"),
        text: requiredString(form.text, "forms.text"),
        sortOrder: optionalInteger(form.sortOrder, "forms.sortOrder", 0),
      }));

      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await requireDraftVersion(client, deckId, versionId);
        await requireCard(client, versionId, cardId);
        await client.query(
          "DELETE FROM deck_version_word_forms WHERE deck_version_id = $1 AND card_id = $2",
          [versionId, cardId],
        );
        for (const form of forms) {
          await client.query(
            `
            INSERT INTO deck_version_word_forms (deck_version_id, card_id, form_key, text, sort_order)
            VALUES ($1, $2, $3, $4, $5)
            `,
            [versionId, cardId, form.formKey, form.text, form.sortOrder],
          );
        }
        const result = await client.query(
          `
          SELECT *
          FROM deck_version_word_forms
          WHERE deck_version_id = $1 AND card_id = $2
          ORDER BY sort_order, form_key, text
          `,
          [versionId, cardId],
        );
        await client.query("COMMIT");
        return { forms: result.rows };
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
  );

  app.put<{ Params: IdParams }>(
    "/v1/admin/decks/:deckId/versions/:versionId/examples/:exampleId/distractors",
    async (request) => {
      const deckId = requiredUUID(request.params.deckId, "deckId");
      const versionId = requiredUUID(request.params.versionId, "versionId");
      const exampleId = requiredUUID(request.params.exampleId, "exampleId");
      const data = body(request.body);
      const distractors = requiredArray(data.distractors, "distractors").map((distractor) => ({
        id: optionalUUID(distractor.id, "distractors.id") ?? randomUUID(),
        text: requiredString(distractor.text, "distractors.text"),
        sourceCardId: optionalUUID(distractor.sourceCardId, "distractors.sourceCardId"),
        priority: optionalInteger(distractor.priority, "distractors.priority", 0),
      }));

      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await requireDraftVersion(client, deckId, versionId);
        await requireExample(client, versionId, exampleId);
        await client.query(
          "DELETE FROM deck_version_distractors WHERE deck_version_id = $1 AND example_id = $2",
          [versionId, exampleId],
        );
        for (const distractor of distractors) {
          await client.query(
            `
            INSERT INTO deck_version_distractors (
              id,
              deck_version_id,
              example_id,
              text,
              source_card_id,
              priority
            )
            VALUES ($1, $2, $3, $4, $5, $6)
            `,
            [
              distractor.id,
              versionId,
              exampleId,
              distractor.text,
              distractor.sourceCardId,
              distractor.priority,
            ],
          );
        }
        const result = await client.query(
          `
          SELECT *
          FROM deck_version_distractors
          WHERE deck_version_id = $1 AND example_id = $2
          ORDER BY priority, text
          `,
          [versionId, exampleId],
        );
        await client.query("COMMIT");
        return { distractors: result.rows };
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
  );

  app.post<{ Params: IdParams }>("/v1/admin/decks/:deckId/publish", async (request) => {
    const deckId = requiredUUID(request.params.deckId, "deckId");
    const data = body(request.body);
    const versionId = requiredUUID(data.versionId, "versionId");

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await requireDraftVersion(client, deckId, versionId);
      const version = await client.query(
        `
        UPDATE deck_versions
        SET status = 'published',
            published_at = COALESCE(published_at, now()),
            server_revision = nextval('server_revision_seq')
        WHERE deck_id = $1 AND id = $2
        RETURNING id, deck_id, version_number, status, manifest, server_revision, created_at, published_at
        `,
        [deckId, versionId],
      );
      const deck = await client.query(
        `
        UPDATE decks
        SET current_version_id = $2,
            updated_at = now()
        WHERE id = $1
        RETURNING id, title, avatar_system_name, avatar_media_id, language_code, current_version_id, created_at, updated_at
        `,
        [deckId, versionId],
      );
      await client.query("COMMIT");
      return {
        deck: deck.rows[0],
        version: version.rows[0],
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  });

  app.post<{ Params: IdParams }>("/v1/admin/decks/:deckId/assignments", async (request, reply) => {
    const deckId = requiredUUID(request.params.deckId, "deckId");
    const data = body(request.body);
    const userId = requiredUUID(data.userId, "userId");
    const deckVersionId = optionalUUID(data.deckVersionId, "deckVersionId");
    const status = contentStatus(data.status, "status");

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await requireUser(client, userId);
      await requireDeck(client, deckId);
      if (deckVersionId) {
        await requireDeckVersion(client, deckId, deckVersionId);
      }
      const result = await client.query(
        `
        INSERT INTO deck_assignments (user_id, deck_id, deck_version_id, status)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (user_id, deck_id) DO UPDATE SET
          deck_version_id = excluded.deck_version_id,
          status = excluded.status,
          server_revision = nextval('server_revision_seq'),
          updated_at = now()
        RETURNING user_id, deck_id, deck_version_id, status, server_revision, assigned_at, updated_at
        `,
        [userId, deckId, deckVersionId, status],
      );
      await client.query("COMMIT");
      reply.status(201);
      return { assignment: result.rows[0] };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  });
}
