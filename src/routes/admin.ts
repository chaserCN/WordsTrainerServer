import type { FastifyInstance } from "fastify";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type pg from "pg";
import { requireAdmin } from "../auth.js";
import type { AppConfig } from "../config.js";
import {
  badRequest,
  notFound,
  optionalNumber,
  optionalString,
  optionalUUID,
  requiredString,
  requiredUUID,
} from "../http.js";
import { bodyLimits, createRateLimit, endpointRateLimits } from "../limits.js";
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

type DailyActivityQuery = {
  dayKey?: string;
  timeZone?: string;
};

type Queryable = Pick<pg.Pool, "query">;

type DeletedMediaObject = {
  id: string;
  storage_key: string;
  sha256?: string | null;
  mime_type?: string | null;
  byte_size: string | number | null;
  created_at?: Date | string;
  updated_at?: Date | string;
};

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

function adminTimeZone(value: unknown): string {
  const text = optionalString(value, "timeZone") ?? "Europe/Kiev";
  if (!/^[A-Za-z0-9_+\-./]{1,64}$/.test(text)) {
    badRequest("timeZone must be an IANA time zone");
  }
  const normalized = text === "Europe/Kyiv" ? "Europe/Kiev" : text;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: normalized });
    return normalized;
  } catch {
    badRequest("timeZone must be an IANA time zone");
  }
}

function studyDayKey(date: Date, timeZone: string): string {
  const shifted = new Date(date.getTime() - 4 * 60 * 60 * 1000);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(shifted);
  const byType = new Map(parts.map((part) => [part.type, part.value]));
  return `${byType.get("year")}-${byType.get("month")}-${byType.get("day")}`;
}

function requestedDayKey(value: unknown, timeZone: string): string {
  const dayKey = optionalString(value, "dayKey") ?? studyDayKey(new Date(), timeZone);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dayKey)) {
    badRequest("dayKey must be YYYY-MM-DD");
  }
  return dayKey;
}

function optionalBoolean(value: unknown, field: string, defaultValue: boolean): boolean {
  if (value == null) {
    return defaultValue;
  }
  if (typeof value !== "boolean") {
    badRequest(`${field} must be a boolean`);
  }
  return value;
}

async function removeLocalMediaFiles(config: AppConfig, media: DeletedMediaObject[]): Promise<{
  deletedFileCount: number;
  failedFiles: string[];
}> {
  const root = path.resolve(config.localMediaRoot);
  let deletedFileCount = 0;
  const failedFiles: string[] = [];

  for (const item of media) {
    if (/^https?:\/\//i.test(item.storage_key)) {
      continue;
    }
    const filePath = path.resolve(root, item.storage_key);
    if (!filePath.startsWith(`${root}${path.sep}`)) {
      failedFiles.push(item.storage_key);
      continue;
    }
    try {
      await rm(filePath, { force: true });
      deletedFileCount += 1;
    } catch {
      failedFiles.push(item.storage_key);
    }
  }

  return { deletedFileCount, failedFiles };
}

async function listOrphanMediaObjects(
  client: Queryable,
  olderThanMinutes: number,
): Promise<DeletedMediaObject[]> {
  const result = await client.query<DeletedMediaObject>(
    `
    SELECT id, storage_key, sha256, mime_type, byte_size, created_at, updated_at
    FROM media_objects
    WHERE created_at <= now() - ($1::text || ' minutes')::interval
      AND NOT EXISTS (
        SELECT 1 FROM users WHERE users.avatar_media_id = media_objects.id
      )
      AND NOT EXISTS (
        SELECT 1 FROM decks WHERE decks.avatar_media_id = media_objects.id
      )
      AND NOT EXISTS (
        SELECT 1
        FROM deck_version_cards
        WHERE deck_version_cards.image_media_id = media_objects.id
           OR deck_version_cards.audio_word_media_id = media_objects.id
      )
      AND NOT EXISTS (
        SELECT 1
        FROM deck_version_examples
        WHERE deck_version_examples.image_media_id = media_objects.id
           OR deck_version_examples.audio_example_media_id = media_objects.id
      )
    ORDER BY created_at, id
    `,
    [olderThanMinutes],
  );
  return result.rows;
}

async function deleteOrphanMediaObjects(
  client: Queryable,
  olderThanMinutes: number,
): Promise<DeletedMediaObject[]> {
  const result = await client.query<DeletedMediaObject>(
    `
    DELETE FROM media_objects
    WHERE id IN (
      SELECT id
      FROM media_objects
      WHERE created_at <= now() - ($1::text || ' minutes')::interval
        AND NOT EXISTS (
          SELECT 1 FROM users WHERE users.avatar_media_id = media_objects.id
        )
        AND NOT EXISTS (
          SELECT 1 FROM decks WHERE decks.avatar_media_id = media_objects.id
        )
        AND NOT EXISTS (
          SELECT 1
          FROM deck_version_cards
          WHERE deck_version_cards.image_media_id = media_objects.id
             OR deck_version_cards.audio_word_media_id = media_objects.id
        )
        AND NOT EXISTS (
          SELECT 1
          FROM deck_version_examples
          WHERE deck_version_examples.image_media_id = media_objects.id
             OR deck_version_examples.audio_example_media_id = media_objects.id
        )
    )
    RETURNING id, storage_key, sha256, mime_type, byte_size, created_at, updated_at
    `,
    [olderThanMinutes],
  );
  return result.rows;
}

async function listOrphanMediaObjectsByIds(
  client: Queryable,
  mediaIds: string[],
  olderThanMinutes: number,
): Promise<DeletedMediaObject[]> {
  if (!mediaIds.length) {
    return [];
  }
  const result = await client.query<DeletedMediaObject>(
    `
    SELECT id, storage_key, sha256, mime_type, byte_size, created_at, updated_at
    FROM media_objects
    WHERE id = ANY($2::uuid[])
      AND created_at <= now() - ($1::text || ' minutes')::interval
      AND NOT EXISTS (
        SELECT 1 FROM users WHERE users.avatar_media_id = media_objects.id
      )
      AND NOT EXISTS (
        SELECT 1 FROM decks WHERE decks.avatar_media_id = media_objects.id
      )
      AND NOT EXISTS (
        SELECT 1
        FROM deck_version_cards
        WHERE deck_version_cards.image_media_id = media_objects.id
           OR deck_version_cards.audio_word_media_id = media_objects.id
      )
      AND NOT EXISTS (
        SELECT 1
        FROM deck_version_examples
        WHERE deck_version_examples.image_media_id = media_objects.id
           OR deck_version_examples.audio_example_media_id = media_objects.id
      )
    ORDER BY created_at, id
    `,
    [olderThanMinutes, mediaIds],
  );
  return result.rows;
}

async function deleteOrphanMediaObjectsByIds(
  client: Queryable,
  mediaIds: string[],
  olderThanMinutes: number,
): Promise<DeletedMediaObject[]> {
  if (!mediaIds.length) {
    return [];
  }
  const result = await client.query<DeletedMediaObject>(
    `
    DELETE FROM media_objects
    WHERE id = ANY($2::uuid[])
      AND created_at <= now() - ($1::text || ' minutes')::interval
      AND NOT EXISTS (
        SELECT 1 FROM users WHERE users.avatar_media_id = media_objects.id
      )
      AND NOT EXISTS (
        SELECT 1 FROM decks WHERE decks.avatar_media_id = media_objects.id
      )
      AND NOT EXISTS (
        SELECT 1
        FROM deck_version_cards
        WHERE deck_version_cards.image_media_id = media_objects.id
           OR deck_version_cards.audio_word_media_id = media_objects.id
      )
      AND NOT EXISTS (
        SELECT 1
        FROM deck_version_examples
        WHERE deck_version_examples.image_media_id = media_objects.id
           OR deck_version_examples.audio_example_media_id = media_objects.id
      )
    RETURNING id, storage_key, sha256, mime_type, byte_size, created_at, updated_at
    `,
    [olderThanMinutes, mediaIds],
  );
  return result.rows;
}

function mediaSummary(media: DeletedMediaObject[]) {
  const totalByteSize = media.reduce((sum, item) => sum + Number(item.byte_size ?? 0), 0);
  return {
    media: media.map((item) => ({
      id: item.id,
      storage_key: item.storage_key,
      sha256: item.sha256 ?? null,
      mime_type: item.mime_type ?? null,
      byte_size: item.byte_size == null ? null : Number(item.byte_size),
      created_at: item.created_at,
      updated_at: item.updated_at,
    })),
    mediaCount: media.length,
    totalByteSize,
  };
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

async function cloneUserAssignments(
  client: Queryable,
  sourceUserId: string,
  targetUserId: string,
): Promise<pg.QueryResultRow[]> {
  if (sourceUserId === targetUserId) {
    badRequest("sourceUserId and target user must be different");
  }
  await requireUser(client, sourceUserId);
  await requireUser(client, targetUserId);
  const result = await client.query(
    `
    INSERT INTO deck_assignments (user_id, deck_id, deck_version_id, status, server_revision)
    SELECT $2, deck_id, NULL, status, nextval('server_revision_seq')
    FROM deck_assignments
    WHERE user_id = $1
    ON CONFLICT (user_id, deck_id) DO UPDATE SET
      deck_version_id = NULL,
      status = excluded.status,
      server_revision = nextval('server_revision_seq'),
      updated_at = now()
    RETURNING user_id, deck_id, deck_version_id, status, server_revision, assigned_at, updated_at
    `,
    [sourceUserId, targetUserId],
  );
  return result.rows;
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
  config: AppConfig,
  objectStorage: ObjectStorageService,
): Promise<void> {
  const adminRateLimit = createRateLimit(endpointRateLimits.admin);
  const mediaUploadRateLimit = createRateLimit(endpointRateLimits.mediaUpload);

  app.addHook("preHandler", async (request) => {
    requireAdmin(request, config);
    await adminRateLimit(request);
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

  app.put<{ Params: IdParams }>("/v1/admin/users/:userId", async (request) => {
    const userId = requiredUUID(request.params.userId, "userId");
    const data = body(request.body);
    const hasDisplayName = Object.hasOwn(data, "displayName");
    const hasRole = Object.hasOwn(data, "role");
    const hasAvatarMediaId = Object.hasOwn(data, "avatarMediaId");

    if (!hasDisplayName && !hasRole && !hasAvatarMediaId) {
      badRequest("at least one user field is required");
    }

    const displayName = hasDisplayName ? requiredString(data.displayName, "displayName") : null;
    const role = hasRole ? appRole(data.role, "role") : null;
    const avatarMediaId = hasAvatarMediaId ? optionalUUID(data.avatarMediaId, "avatarMediaId") : null;

    const result = await pool.query(
      `
      UPDATE users
      SET display_name = CASE WHEN $2 THEN $3 ELSE display_name END,
          role = CASE WHEN $4 THEN $5::app_role ELSE role END,
          avatar_media_id = CASE WHEN $6 THEN $7::uuid ELSE avatar_media_id END,
          updated_at = now()
      WHERE id = $1
      RETURNING id, display_name, role, avatar_media_id, created_at, updated_at
      `,
      [userId, hasDisplayName, displayName, hasRole, role, hasAvatarMediaId, avatarMediaId],
    );
    if (!result.rowCount) {
      notFound("user not found");
    }
    return { user: result.rows[0] };
  });

  app.get<{ Params: IdParams }>("/v1/admin/users/:userId", async (request) => {
    const userId = requiredUUID(request.params.userId, "userId");
    const [user, assignments, stats] = await Promise.all([
      pool.query(
        `
        SELECT id, display_name, role, avatar_media_id, created_at, updated_at
        FROM users
        WHERE id = $1
        `,
        [userId],
      ),
      pool.query(
        `
        SELECT deck_assignments.user_id,
               deck_assignments.deck_id,
               NULL::uuid AS deck_version_id,
               deck_assignments.status,
               deck_assignments.server_revision,
               deck_assignments.assigned_at,
               deck_assignments.updated_at,
               decks.title,
               decks.avatar_system_name,
               decks.avatar_media_id,
               decks.language_code,
               decks.current_version_id,
               NULL::int AS assigned_version_number,
               NULL::deck_version_status AS assigned_version_status,
               current_versions.version_number AS current_version_number,
               current_versions.status AS current_version_status
        FROM deck_assignments
        JOIN decks ON decks.id = deck_assignments.deck_id
        LEFT JOIN deck_versions AS current_versions ON current_versions.id = decks.current_version_id
        WHERE deck_assignments.user_id = $1
        ORDER BY decks.title
        `,
        [userId],
      ),
      pool.query(
        `
        SELECT
          (SELECT COUNT(*) FROM deck_assignments WHERE user_id = $1) AS assignment_count,
          (SELECT COUNT(*) FROM deck_assignments WHERE user_id = $1 AND status = 'active') AS active_assignment_count,
          (SELECT COUNT(*) FROM card_progress WHERE user_id = $1) AS progress_count,
          (SELECT COUNT(*) FROM study_reviews WHERE user_id = $1) AS review_count,
          (SELECT COUNT(*) FROM practice_reviews WHERE user_id = $1) AS practice_review_count,
          (SELECT COUNT(*) FROM deck_matching_records WHERE user_id = $1) AS matching_record_count,
          (SELECT COUNT(*) FROM matching_attempts WHERE user_id = $1) AS matching_attempt_count
        `,
        [userId],
      ),
    ]);
    if (!user.rowCount) {
      notFound("user not found");
    }
    return {
      user: user.rows[0],
      assignments: assignments.rows,
      stats: stats.rows[0],
    };
  });

  app.get<{ Params: IdParams; Querystring: DailyActivityQuery }>("/v1/admin/users/:userId/daily-activity", async (request) => {
    const userId = requiredUUID(request.params.userId, "userId");
    const timeZone = adminTimeZone(request.query.timeZone);
    const dayKey = requestedDayKey(request.query.dayKey, timeZone);

    const [user, activity] = await Promise.all([
      pool.query("SELECT id FROM users WHERE id = $1", [userId]),
      pool.query(
        `
        WITH study AS (
          SELECT
            COUNT(*)::int AS total_count,
            COUNT(*) FILTER (WHERE outcome IN ('remembered', 'correct'))::int AS passed_count,
            MIN(reviewed_at) AS first_at,
            MAX(reviewed_at) AS last_at
          FROM study_reviews
          WHERE user_id = $1
            AND to_char((reviewed_at AT TIME ZONE $2) - interval '4 hours', 'YYYY-MM-DD') = $3
        ),
        practice AS (
          SELECT
            COUNT(*)::int AS total_count,
            COUNT(*) FILTER (WHERE outcome IN ('remembered', 'correct'))::int AS passed_count,
            MIN(practiced_at) AS first_at,
            MAX(practiced_at) AS last_at
          FROM practice_reviews
          WHERE user_id = $1
            AND to_char((practiced_at AT TIME ZONE $2) - interval '4 hours', 'YYYY-MM-DD') = $3
        ),
        matching AS (
          SELECT
            COUNT(*)::int AS total_count,
            COUNT(*) FILTER (WHERE mode = 'matching')::int AS columns_count,
            COUNT(*) FILTER (WHERE mode = 'matching_audio')::int AS audio_columns_count,
            MIN(completed_at) AS first_at,
            MAX(completed_at) AS last_at
          FROM matching_attempts
          WHERE user_id = $1
            AND to_char((completed_at AT TIME ZONE $2) - interval '4 hours', 'YYYY-MM-DD') = $3
        )
        SELECT
          study.total_count AS study_review_count,
          study.passed_count AS study_passed_count,
          practice.total_count AS practice_review_count,
          practice.passed_count AS practice_passed_count,
          matching.total_count AS matching_attempt_count,
          matching.columns_count AS matching_columns_count,
          matching.audio_columns_count AS matching_audio_columns_count,
          LEAST(
            COALESCE(study.first_at, 'infinity'::timestamptz),
            COALESCE(practice.first_at, 'infinity'::timestamptz),
            COALESCE(matching.first_at, 'infinity'::timestamptz)
          ) AS first_activity_at,
          GREATEST(
            COALESCE(study.last_at, '-infinity'::timestamptz),
            COALESCE(practice.last_at, '-infinity'::timestamptz),
            COALESCE(matching.last_at, '-infinity'::timestamptz)
          ) AS last_activity_at
        FROM study, practice, matching
        `,
        [userId, timeZone, dayKey],
      ),
    ]);
    if (!user.rowCount) {
      notFound("user not found");
    }

    const row = activity.rows[0];
    const studyReviewCount = Number(row.study_review_count);
    const practiceReviewCount = Number(row.practice_review_count);
    const matchingAttemptCount = Number(row.matching_attempt_count);
    return {
      userId,
      dayKey,
      timeZone,
      active: studyReviewCount + practiceReviewCount + matchingAttemptCount > 0,
      studyReviews: {
        total: studyReviewCount,
        passed: Number(row.study_passed_count),
      },
      practiceReviews: {
        total: practiceReviewCount,
        passed: Number(row.practice_passed_count),
      },
      matchingAttempts: {
        total: matchingAttemptCount,
        columns: Number(row.matching_columns_count),
        audioColumns: Number(row.matching_audio_columns_count),
      },
      firstActivityAt: row.first_activity_at instanceof Date && Number.isFinite(row.first_activity_at.getTime())
        ? row.first_activity_at.toISOString()
        : null,
      lastActivityAt: row.last_activity_at instanceof Date && Number.isFinite(row.last_activity_at.getTime())
        ? row.last_activity_at.toISOString()
        : null,
    };
  });

  app.post<{ Params: IdParams }>("/v1/admin/users/:userId/clone-assignments", async (request, reply) => {
    const targetUserId = requiredUUID(request.params.userId, "userId");
    const data = body(request.body);
    const sourceUserId = requiredUUID(data.sourceUserId, "sourceUserId");

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const assignments = await cloneUserAssignments(client, sourceUserId, targetUserId);
      await client.query("COMMIT");
      reply.status(201);
      return { assignments };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  });

  app.post<{ Params: IdParams }>("/v1/admin/users/:userId/test-learner", async (request, reply) => {
    const sourceUserId = requiredUUID(request.params.userId, "userId");
    const data = body(request.body ?? {});
    const requestedDisplayName = Object.hasOwn(data, "displayName")
      ? requiredString(data.displayName, "displayName")
      : null;

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const sourceUser = await client.query(
        `
        SELECT id, display_name, avatar_media_id
        FROM users
        WHERE id = $1
        `,
        [sourceUserId],
      );
      if (!sourceUser.rowCount) {
        notFound("user not found");
      }
      const displayName = requestedDisplayName ?? `${sourceUser.rows[0].display_name} Test`;
      const user = await client.query(
        `
        INSERT INTO users (display_name, role, avatar_media_id)
        VALUES ($1, 'learner', $2)
        RETURNING id, display_name, role, avatar_media_id, created_at, updated_at
        `,
        [displayName, sourceUser.rows[0].avatar_media_id],
      );
      const assignments = await cloneUserAssignments(client, sourceUserId, user.rows[0].id);
      await client.query("COMMIT");
      reply.status(201);
      return {
        user: user.rows[0],
        assignments,
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  });

  app.post<{ Params: IdParams }>("/v1/admin/users/:userId/reset-study-data", async (request) => {
    const userId = requiredUUID(request.params.userId, "userId");
    const data = body(request.body ?? {});
    const deckId = optionalUUID(data.deckId, "deckId");
    const dryRun = optionalBoolean(data.dryRun, "dryRun", false);

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await requireUser(client, userId);
      if (deckId) {
        await requireDeck(client, deckId);
      }
      const params = [userId, deckId];
      const counts = await client.query(
        `
        SELECT
          (SELECT COUNT(*) FROM study_reviews WHERE user_id = $1 AND ($2::uuid IS NULL OR deck_id = $2)) AS review_count,
          (SELECT COUNT(*) FROM practice_reviews WHERE user_id = $1 AND ($2::uuid IS NULL OR deck_id = $2)) AS practice_review_count,
          (SELECT COUNT(*) FROM card_progress WHERE user_id = $1 AND ($2::uuid IS NULL OR deck_id = $2)) AS progress_count,
          (SELECT COUNT(*) FROM deck_matching_records WHERE user_id = $1 AND ($2::uuid IS NULL OR deck_id = $2)) AS matching_record_count,
          (SELECT COUNT(*) FROM matching_attempts WHERE user_id = $1 AND ($2::uuid IS NULL OR deck_id = $2)) AS matching_attempt_count
        `,
        params,
      );
      if (!dryRun) {
        await client.query(
          "DELETE FROM study_reviews WHERE user_id = $1 AND ($2::uuid IS NULL OR deck_id = $2)",
          params,
        );
        await client.query(
          "DELETE FROM practice_reviews WHERE user_id = $1 AND ($2::uuid IS NULL OR deck_id = $2)",
          params,
        );
        await client.query(
          "DELETE FROM card_progress WHERE user_id = $1 AND ($2::uuid IS NULL OR deck_id = $2)",
          params,
        );
        await client.query(
          "DELETE FROM deck_matching_records WHERE user_id = $1 AND ($2::uuid IS NULL OR deck_id = $2)",
          params,
        );
        await client.query(
          "DELETE FROM matching_attempts WHERE user_id = $1 AND ($2::uuid IS NULL OR deck_id = $2)",
          params,
        );
      }
      await client.query("COMMIT");
      return {
        dryRun,
        deleted: {
          reviews: Number(counts.rows[0].review_count),
          practiceReviews: Number(counts.rows[0].practice_review_count),
          progress: Number(counts.rows[0].progress_count),
          matchingRecords: Number(counts.rows[0].matching_record_count),
          matchingAttempts: Number(counts.rows[0].matching_attempt_count),
        },
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
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

  app.post("/v1/admin/media/upload", {
    bodyLimit: bodyLimits.mediaUpload,
    preHandler: mediaUploadRateLimit,
  }, async (request, reply) => {
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
    const absolutePath = path.resolve(config.localMediaRoot, storageKey);
    const root = path.resolve(config.localMediaRoot);
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

  app.post("/v1/admin/media/delete-orphans", async (request) => {
    const data = request.body == null ? {} : body(request.body);
    const dryRun = optionalBoolean(data.dryRun, "dryRun", true);
    const olderThanMinutes = optionalInteger(data.olderThanMinutes, "olderThanMinutes", 60);
    if (olderThanMinutes < 0) {
      badRequest("olderThanMinutes must be non-negative");
    }

    if (dryRun) {
      const media = await listOrphanMediaObjects(pool, olderThanMinutes);
      return {
        dryRun,
        olderThanMinutes,
        ...mediaSummary(media),
        deletedFileCount: 0,
        failedFiles: [],
      };
    }

    const client = await pool.connect();
    let deletedMedia: DeletedMediaObject[] = [];
    try {
      await client.query("BEGIN");
      deletedMedia = await deleteOrphanMediaObjects(client, olderThanMinutes);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }

    const fileCleanup = await removeLocalMediaFiles(config, deletedMedia);
    return {
      dryRun,
      olderThanMinutes,
      ...mediaSummary(deletedMedia),
      deletedFileCount: fileCleanup.deletedFileCount,
      failedFiles: fileCleanup.failedFiles,
    };
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

  app.put<{ Params: IdParams }>("/v1/admin/decks/:deckId", async (request) => {
    const deckId = requiredUUID(request.params.deckId, "deckId");
    const data = body(request.body);
    const hasTitle = Object.hasOwn(data, "title");
    const hasLanguageCode = Object.hasOwn(data, "languageCode");
    const hasAvatarSystemName = Object.hasOwn(data, "avatarSystemName");
    const hasAvatarMediaId = Object.hasOwn(data, "avatarMediaId");

    if (!hasTitle && !hasLanguageCode && !hasAvatarSystemName && !hasAvatarMediaId) {
      badRequest("at least one deck field is required");
    }

    const title = hasTitle ? requiredString(data.title, "title") : null;
    const languageCode = hasLanguageCode ? requiredString(data.languageCode, "languageCode") : null;
    const avatarSystemName = hasAvatarSystemName ? optionalString(data.avatarSystemName, "avatarSystemName") : null;
    const avatarMediaId = hasAvatarMediaId ? optionalUUID(data.avatarMediaId, "avatarMediaId") : null;

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query(
        `
        UPDATE decks
        SET title = CASE WHEN $2 THEN $3 ELSE title END,
            language_code = CASE WHEN $4 THEN $5 ELSE language_code END,
            avatar_system_name = CASE WHEN $6 THEN $7 ELSE avatar_system_name END,
            avatar_media_id = CASE WHEN $8 THEN $9::uuid ELSE avatar_media_id END,
            updated_at = now()
        WHERE id = $1
        RETURNING id, title, avatar_system_name, avatar_media_id, language_code, current_version_id, created_at, updated_at
        `,
        [
          deckId,
          hasTitle,
          title,
          hasLanguageCode,
          languageCode,
          hasAvatarSystemName,
          avatarSystemName,
          hasAvatarMediaId,
          avatarMediaId,
        ],
      );
      if (!result.rowCount) {
        notFound("deck not found");
      }
      await client.query(
        `
        UPDATE deck_assignments
        SET server_revision = nextval('server_revision_seq'),
            updated_at = now()
        WHERE deck_id = $1
        `,
        [deckId],
      );
      await client.query("COMMIT");
      return { deck: result.rows[0] };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
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

  app.get<{ Params: IdParams }>("/v1/admin/decks/:deckId/versions", async (request) => {
    const deckId = requiredUUID(request.params.deckId, "deckId");
    await requireDeck(pool, deckId);

    const result = await pool.query(
      `
      SELECT deck_versions.id,
             deck_versions.deck_id,
             deck_versions.version_number,
             deck_versions.status,
             deck_versions.manifest,
             deck_versions.server_revision,
             deck_versions.created_at,
             deck_versions.published_at,
             COUNT(DISTINCT deck_version_cards.card_id)::int AS card_count,
             COUNT(DISTINCT deck_version_examples.example_id)::int AS example_count
      FROM deck_versions
      LEFT JOIN deck_version_cards ON deck_version_cards.deck_version_id = deck_versions.id
      LEFT JOIN deck_version_examples ON deck_version_examples.deck_version_id = deck_versions.id
      WHERE deck_versions.deck_id = $1
      GROUP BY deck_versions.id
      ORDER BY deck_versions.version_number DESC
      `,
      [deckId],
    );
    return { versions: result.rows };
  });

  app.post<{ Params: IdParams }>("/v1/admin/decks/:deckId/prune-versions", async (request) => {
    const deckId = requiredUUID(request.params.deckId, "deckId");
    const data = request.body == null ? {} : body(request.body);
    const dryRun = optionalBoolean(data.dryRun, "dryRun", true);
    const keepPublishedVersions = optionalInteger(data.keepPublishedVersions, "keepPublishedVersions", 1);
    const deleteDrafts = optionalBoolean(data.deleteDrafts, "deleteDrafts", true);
    const deleteOrphanMedia = optionalBoolean(data.deleteOrphanMedia, "deleteOrphanMedia", true);
    const orphanMediaOlderThanMinutes = optionalInteger(data.orphanMediaOlderThanMinutes, "orphanMediaOlderThanMinutes", 0);
    if (keepPublishedVersions < 1) {
      badRequest("keepPublishedVersions must be at least 1");
    }
    if (orphanMediaOlderThanMinutes < 0) {
      badRequest("orphanMediaOlderThanMinutes must be non-negative");
    }

    const client = await pool.connect();
    let prunedVersions: pg.QueryResultRow[] = [];
    let deletedMedia: DeletedMediaObject[] = [];
    try {
      await client.query("BEGIN");
      await requireDeck(client, deckId);
      const versionResult = await client.query(
        `
        WITH ranked_versions AS (
          SELECT deck_versions.id,
                 deck_versions.deck_id,
                 deck_versions.version_number,
                 deck_versions.status,
                 deck_versions.manifest,
                 deck_versions.server_revision,
                 deck_versions.created_at,
                 deck_versions.published_at,
                 decks.current_version_id,
                 CASE WHEN deck_versions.status = 'published'
                   THEN row_number() OVER (
                     PARTITION BY deck_versions.deck_id, deck_versions.status
                     ORDER BY deck_versions.version_number DESC
                   )
                 END AS published_rank
          FROM deck_versions
          JOIN decks ON decks.id = deck_versions.deck_id
          WHERE deck_versions.deck_id = $1
        )
        SELECT id, deck_id, version_number, status, manifest, server_revision, created_at, published_at
        FROM ranked_versions
        WHERE id <> current_version_id
          AND (
            (status = 'draft' AND $3::boolean)
            OR (status IN ('published', 'archived') AND published_rank > $2::int)
          )
        ORDER BY version_number
        `,
        [deckId, keepPublishedVersions, deleteDrafts],
      );
      prunedVersions = versionResult.rows;
      const versionIds = prunedVersions.map((version) => version.id);

      const mediaResult = versionIds.length
        ? await client.query<{ id: string }>(
          `
          SELECT DISTINCT media_id AS id
          FROM (
            SELECT image_media_id AS media_id FROM deck_version_cards WHERE deck_version_id = ANY($1::uuid[])
            UNION
            SELECT audio_word_media_id AS media_id FROM deck_version_cards WHERE deck_version_id = ANY($1::uuid[])
            UNION
            SELECT image_media_id AS media_id FROM deck_version_examples WHERE deck_version_id = ANY($1::uuid[])
            UNION
            SELECT audio_example_media_id AS media_id FROM deck_version_examples WHERE deck_version_id = ANY($1::uuid[])
          ) version_media
          WHERE media_id IS NOT NULL
          `,
          [versionIds],
        )
        : { rows: [] };
      const mediaIds = mediaResult.rows.map((media) => media.id);

      if (versionIds.length) {
        await client.query("DELETE FROM deck_versions WHERE deck_id = $1 AND id = ANY($2::uuid[])", [
          deckId,
          versionIds,
        ]);
      }
      if (deleteOrphanMedia) {
        deletedMedia = dryRun
          ? await listOrphanMediaObjectsByIds(client, mediaIds, orphanMediaOlderThanMinutes)
          : await deleteOrphanMediaObjectsByIds(client, mediaIds, orphanMediaOlderThanMinutes);
      }

      if (dryRun) {
        await client.query("ROLLBACK");
      } else {
        await client.query("COMMIT");
      }
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }

    const fileCleanup = dryRun ? { deletedFileCount: 0, failedFiles: [] } : await removeLocalMediaFiles(config, deletedMedia);
    return {
      dryRun,
      keepPublishedVersions,
      deleteDrafts,
      deleteOrphanMedia,
      orphanMediaOlderThanMinutes,
      versions: prunedVersions,
      versionCount: prunedVersions.length,
      ...mediaSummary(deletedMedia),
      deletedFileCount: fileCleanup.deletedFileCount,
      failedFiles: fileCleanup.failedFiles,
    };
  });

  app.delete<{ Params: IdParams }>("/v1/admin/decks/:deckId/versions/:versionId", async (request) => {
    const deckId = requiredUUID(request.params.deckId, "deckId");
    const versionId = requiredUUID(request.params.versionId, "versionId");
    const data = request.body == null ? {} : body(request.body);
    const deleteOrphanMedia = optionalBoolean(data.deleteOrphanMedia, "deleteOrphanMedia", true);
    const orphanMediaOlderThanMinutes = optionalInteger(data.orphanMediaOlderThanMinutes, "orphanMediaOlderThanMinutes", 5);
    if (orphanMediaOlderThanMinutes < 0) {
      badRequest("orphanMediaOlderThanMinutes must be non-negative");
    }

    const client = await pool.connect();
    let deletedMedia: DeletedMediaObject[] = [];
    let deletedVersion: unknown;
    try {
      await client.query("BEGIN");
      const version = await client.query(
        `
        SELECT deck_versions.id,
               deck_versions.deck_id,
               deck_versions.version_number,
               deck_versions.status,
               deck_versions.manifest,
               deck_versions.server_revision,
               deck_versions.created_at,
               deck_versions.published_at,
               decks.current_version_id
        FROM deck_versions
        JOIN decks ON decks.id = deck_versions.deck_id
        WHERE deck_versions.deck_id = $1 AND deck_versions.id = $2
        FOR UPDATE
        `,
        [deckId, versionId],
      );
      if (!version.rowCount) {
        notFound("deck version not found");
      }
      if (version.rows[0].status !== "draft") {
        badRequest("only draft deck versions can be deleted");
      }
      if (version.rows[0].current_version_id === versionId) {
        badRequest("current deck version cannot be deleted");
      }

      const deleted = await client.query(
        `
        DELETE FROM deck_versions
        WHERE deck_id = $1 AND id = $2
        RETURNING id, deck_id, version_number, status, manifest, server_revision, created_at, published_at
        `,
        [deckId, versionId],
      );
      deletedVersion = deleted.rows[0];

      if (deleteOrphanMedia) {
        deletedMedia = await deleteOrphanMediaObjects(client, orphanMediaOlderThanMinutes);
      }

      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }

    const fileCleanup = await removeLocalMediaFiles(config, deletedMedia);
    return {
      version: deletedVersion,
      deletedMedia: deletedMedia.map((media) => ({
        id: media.id,
        storage_key: media.storage_key,
        byte_size: media.byte_size == null ? null : Number(media.byte_size),
      })),
      deletedMediaCount: deletedMedia.length,
      deletedFileCount: fileCleanup.deletedFileCount,
      failedFiles: fileCleanup.failedFiles,
    };
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

    const [cards, examples, forms, distractors, mediaObjects] = await Promise.all([
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
      pool.query(
        `
        SELECT media_objects.id,
               media_objects.storage_key,
               media_objects.sha256,
               media_objects.mime_type,
               media_objects.byte_size::int AS byte_size,
               media_objects.width::int AS width,
               media_objects.height::int AS height,
               media_objects.upload_status,
               media_objects.created_at,
               media_objects.updated_at
        FROM media_objects
        WHERE media_objects.id IN (
          SELECT image_media_id FROM deck_version_cards WHERE deck_version_id = $1 AND image_media_id IS NOT NULL
          UNION
          SELECT audio_word_media_id FROM deck_version_cards WHERE deck_version_id = $1 AND audio_word_media_id IS NOT NULL
          UNION
          SELECT image_media_id FROM deck_version_examples WHERE deck_version_id = $1 AND image_media_id IS NOT NULL
          UNION
          SELECT audio_example_media_id FROM deck_version_examples WHERE deck_version_id = $1 AND audio_example_media_id IS NOT NULL
          UNION
          SELECT avatar_media_id FROM decks WHERE id = $2 AND avatar_media_id IS NOT NULL
        )
        ORDER BY media_objects.storage_key
        `,
        [versionId, deckId],
      ),
    ]);

    return {
      version: version.rows[0],
      cards: cards.rows,
      examples: examples.rows,
      forms: forms.rows,
      distractors: distractors.rows,
      mediaObjects: mediaObjects.rows,
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
    if (Object.hasOwn(data, "deckVersionId") && data.deckVersionId != null) {
      badRequest("deckVersionId is no longer supported; assignments always follow the current deck version");
    }
    const status = contentStatus(data.status, "status");

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await requireUser(client, userId);
      await requireDeck(client, deckId);
      const result = await client.query(
        `
        INSERT INTO deck_assignments (user_id, deck_id, deck_version_id, status)
        VALUES ($1, $2, NULL, $3)
        ON CONFLICT (user_id, deck_id) DO UPDATE SET
          deck_version_id = NULL,
          status = excluded.status,
          server_revision = nextval('server_revision_seq'),
          updated_at = now()
        RETURNING user_id, deck_id, deck_version_id, status, server_revision, assigned_at, updated_at
        `,
        [userId, deckId, status],
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
