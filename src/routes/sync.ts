import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { requireHouseholdSync, selectedUserHeader } from "../auth.js";
import {
  badRequest,
  optionalNumber,
  optionalString,
  optionalUUID,
  requiredString,
  requiredUUID,
} from "../http.js";

type Queryable = Pick<pg.Pool, "query">;

type ChangesQuery = {
  sinceRevision?: string;
};

type UserRow = {
  id: string;
  display_name: string;
  avatar_media_id: string | null;
  role: string;
  created_at: string;
  updated_at: string;
};

type ReviewEventInput = {
  clientEventId: string;
  deckId: string;
  deckVersionId: string | null;
  cardId: string;
  mode: string;
  outcome: string;
  reviewedAt: string;
  durationMs: number | null;
  wasNew: boolean;
  previousState: string | null;
  newState: string | null;
};

type ProgressInput = {
  cardId: string;
  deckId: string;
  fsrsData: unknown;
  dueAt: string | null;
  state: string | null;
  updatedAt: string | null;
};

type MatchingRecordInput = {
  deckId: string;
  deckVersionId: string | null;
  bestDurationSeconds: number;
  pairCount: number;
  achievedAt: string;
};

function studyMode(value: unknown, field: string): string {
  const mode = requiredString(value, field);
  switch (mode) {
  case "flashcards":
  case "recall":
  case "matching":
  case "cloze_multiple_choice":
  case "cloze_typing":
    return mode;
  case "clozeMultipleChoice":
    return "cloze_multiple_choice";
  case "clozeTyping":
    return "cloze_typing";
  default:
    badRequest(`${field} must be a valid study mode`);
  }
}

function reviewOutcome(value: unknown, field: string): string {
  const outcome = requiredString(value, field);
  if (!["remembered", "forgot", "correct", "incorrect"].includes(outcome)) {
    badRequest(`${field} must be remembered, forgot, correct, or incorrect`);
  }
  return outcome;
}

function optionalTimestamp(value: unknown, field: string): string | null {
  const text = optionalString(value, field);
  if (text == null) {
    return null;
  }
  if (Number.isNaN(Date.parse(text))) {
    badRequest(`${field} must be a valid timestamp`);
  }
  return text;
}

function requiredTimestamp(value: unknown, field: string): string {
  const text = requiredString(value, field);
  if (Number.isNaN(Date.parse(text))) {
    badRequest(`${field} must be a valid timestamp`);
  }
  return text;
}

function optionalNonNegativeInteger(value: unknown, field: string): number | null {
  const numberValue = optionalNumber(value, field);
  if (numberValue == null) {
    return null;
  }
  if (!Number.isInteger(numberValue) || numberValue < 0) {
    badRequest(`${field} must be a non-negative integer`);
  }
  return numberValue;
}

async function assignedDeckRows(
  pool: pg.Pool,
  userId: string,
  sinceRevision?: string,
): Promise<pg.QueryResult["rows"]> {
  const revisionFilter = sinceRevision
    ? "AND (deck_assignments.server_revision > $2 OR deck_versions.server_revision > $2)"
    : "";
  const params = sinceRevision ? [userId, sinceRevision] : [userId];
  const result = await pool.query(
    `
    SELECT deck_assignments.user_id,
           deck_assignments.deck_id,
           deck_assignments.deck_version_id,
           deck_assignments.status AS assignment_status,
           deck_assignments.server_revision AS assignment_revision,
           decks.title,
           decks.avatar_system_name,
           decks.avatar_media_id,
           decks.language_code,
           decks.current_version_id,
           deck_versions.version_number,
           deck_versions.status AS version_status,
           deck_versions.manifest,
           deck_versions.server_revision AS version_revision,
           deck_versions.published_at
    FROM deck_assignments
    JOIN decks ON decks.id = deck_assignments.deck_id
    LEFT JOIN deck_versions ON deck_versions.id = COALESCE(deck_assignments.deck_version_id, decks.current_version_id)
    WHERE deck_assignments.user_id = $1
      ${revisionFilter}
    ORDER BY decks.title
    `,
    params,
  );
  return result.rows;
}

async function assignedContentRows(
  pool: pg.Pool,
  userId: string,
  sinceRevision?: string,
): Promise<{
  cards: pg.QueryResult["rows"];
  examples: pg.QueryResult["rows"];
  forms: pg.QueryResult["rows"];
  distractors: pg.QueryResult["rows"];
}> {
  const revisionFilter = sinceRevision
    ? "AND (deck_assignments.server_revision > $2 OR deck_versions.server_revision > $2)"
    : "";
  const params = sinceRevision ? [userId, sinceRevision] : [userId];
  const assignedVersions = `
    WITH assigned_versions AS (
      SELECT deck_versions.id
      FROM deck_assignments
      JOIN decks ON decks.id = deck_assignments.deck_id
      JOIN deck_versions ON deck_versions.id = COALESCE(deck_assignments.deck_version_id, decks.current_version_id)
      WHERE deck_assignments.user_id = $1
        AND deck_assignments.status = 'active'
        AND deck_versions.status = 'published'
        ${revisionFilter}
    )
  `;
  const [cards, examples, forms, distractors] = await Promise.all([
    pool.query(
      `
      ${assignedVersions}
      SELECT deck_version_cards.*
      FROM assigned_versions
      JOIN deck_version_cards ON deck_version_cards.deck_version_id = assigned_versions.id
      ORDER BY deck_version_cards.sort_order, deck_version_cards.display_word
      `,
      params,
    ),
    pool.query(
      `
      ${assignedVersions}
      SELECT deck_version_examples.*
      FROM assigned_versions
      JOIN deck_version_examples ON deck_version_examples.deck_version_id = assigned_versions.id
      ORDER BY deck_version_examples.card_id, deck_version_examples.sort_order
      `,
      params,
    ),
    pool.query(
      `
      ${assignedVersions}
      SELECT deck_version_word_forms.*
      FROM assigned_versions
      JOIN deck_version_word_forms ON deck_version_word_forms.deck_version_id = assigned_versions.id
      ORDER BY deck_version_word_forms.card_id, deck_version_word_forms.sort_order
      `,
      params,
    ),
    pool.query(
      `
      ${assignedVersions}
      SELECT deck_version_distractors.*
      FROM assigned_versions
      JOIN deck_version_distractors ON deck_version_distractors.deck_version_id = assigned_versions.id
      ORDER BY deck_version_distractors.example_id, deck_version_distractors.priority
      `,
      params,
    ),
  ]);
  return {
    cards: cards.rows,
    examples: examples.rows,
    forms: forms.rows,
    distractors: distractors.rows,
  };
}

function parseRevision(value: unknown): bigint {
  if (typeof value !== "string" || value.trim() === "") {
    return 0n;
  }
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) {
    badRequest("sinceRevision must be a non-negative integer");
  }
  return BigInt(trimmed);
}

async function latestRevision(pool: pg.Pool): Promise<string> {
  const result = await pool.query<{ revision: string }>(
    `
    SELECT GREATEST(
      COALESCE((SELECT MAX(server_revision) FROM deck_versions), 0),
      COALESCE((SELECT MAX(server_revision) FROM deck_assignments), 0),
      COALESCE((SELECT MAX(server_revision) FROM card_progress), 0),
      COALESCE((SELECT MAX(server_revision) FROM study_reviews), 0),
      COALESCE((SELECT MAX(server_revision) FROM deck_matching_records), 0)
    )::text AS revision
    `,
  );
  return result.rows[0]?.revision ?? "0";
}

async function allUserRows(pool: pg.Pool): Promise<UserRow[]> {
  const result = await pool.query<UserRow>(
    `
    SELECT id, display_name, avatar_media_id, role, created_at, updated_at
    FROM users
    ORDER BY display_name
    `,
  );
  return result.rows;
}

function emptyContent() {
  return {
    cards: [],
    examples: [],
    forms: [],
    distractors: [],
  };
}

async function selectedSyncUserId(request: Parameters<typeof selectedUserHeader>[0], pool: pg.Pool): Promise<string> {
  const userId = selectedUserHeader(request);
  if (!userId) {
    badRequest("x-flashgame-user-id header is required");
  }
  const result = await pool.query("SELECT 1 FROM users WHERE id = $1", [userId]);
  if (!result.rowCount) {
    badRequest("selected user not found");
  }
  return userId;
}

function body(requestBody: unknown): Record<string, unknown> {
  if (requestBody == null || typeof requestBody !== "object" || Array.isArray(requestBody)) {
    badRequest("JSON object body is required");
  }
  return requestBody as Record<string, unknown>;
}

function parseReviews(value: unknown): ReviewEventInput[] {
  if (value == null) {
    return [];
  }
  if (!Array.isArray(value)) {
    badRequest("reviews must be an array");
  }
  return value.map((item, index) => {
    if (item == null || typeof item !== "object" || Array.isArray(item)) {
      badRequest(`reviews[${index}] must be an object`);
    }
    const review = item as Record<string, unknown>;
    if (typeof review.wasNew !== "boolean") {
      badRequest(`reviews[${index}].wasNew must be a boolean`);
    }
    return {
      clientEventId: requiredUUID(review.clientEventId, `reviews[${index}].clientEventId`),
      deckId: requiredUUID(review.deckId, `reviews[${index}].deckId`),
      deckVersionId: optionalUUID(review.deckVersionId, `reviews[${index}].deckVersionId`),
      cardId: requiredUUID(review.cardId, `reviews[${index}].cardId`),
      mode: studyMode(review.mode, `reviews[${index}].mode`),
      outcome: reviewOutcome(review.outcome, `reviews[${index}].outcome`),
      reviewedAt: requiredTimestamp(review.reviewedAt, `reviews[${index}].reviewedAt`),
      durationMs: optionalNonNegativeInteger(review.durationMs, `reviews[${index}].durationMs`),
      wasNew: review.wasNew,
      previousState: optionalString(review.previousState, `reviews[${index}].previousState`),
      newState: optionalString(review.newState, `reviews[${index}].newState`),
    };
  });
}

function parseProgress(value: unknown): ProgressInput[] {
  if (value == null) {
    return [];
  }
  if (!Array.isArray(value)) {
    badRequest("progress must be an array");
  }
  return value.map((item, index) => {
    if (item == null || typeof item !== "object" || Array.isArray(item)) {
      badRequest(`progress[${index}] must be an object`);
    }
    const progress = item as Record<string, unknown>;
    const fsrsData = progress.fsrsData;
    if (fsrsData == null || typeof fsrsData !== "object") {
      badRequest(`progress[${index}].fsrsData must be an object`);
    }
    return {
      cardId: requiredUUID(progress.cardId, `progress[${index}].cardId`),
      deckId: requiredUUID(progress.deckId, `progress[${index}].deckId`),
      fsrsData,
      dueAt: optionalTimestamp(progress.dueAt, `progress[${index}].dueAt`),
      state: optionalString(progress.state, `progress[${index}].state`),
      updatedAt: optionalTimestamp(progress.updatedAt, `progress[${index}].updatedAt`),
    };
  });
}

function parseMatchingRecords(value: unknown): MatchingRecordInput[] {
  if (value == null) {
    return [];
  }
  if (!Array.isArray(value)) {
    badRequest("matchingRecords must be an array");
  }
  return value.map((item, index) => {
    if (item == null || typeof item !== "object" || Array.isArray(item)) {
      badRequest(`matchingRecords[${index}] must be an object`);
    }
    const record = item as Record<string, unknown>;
    const bestDurationSeconds = optionalNumber(
      record.bestDurationSeconds,
      `matchingRecords[${index}].bestDurationSeconds`,
    );
    const pairCount = optionalNumber(record.pairCount, `matchingRecords[${index}].pairCount`);
    if (bestDurationSeconds == null || bestDurationSeconds <= 0) {
      badRequest(`matchingRecords[${index}].bestDurationSeconds must be a positive number`);
    }
    if (pairCount == null || !Number.isInteger(pairCount) || pairCount <= 0) {
      badRequest(`matchingRecords[${index}].pairCount must be a positive integer`);
    }
    return {
      deckId: requiredUUID(record.deckId, `matchingRecords[${index}].deckId`),
      deckVersionId: optionalUUID(record.deckVersionId, `matchingRecords[${index}].deckVersionId`),
      bestDurationSeconds,
      pairCount,
      achievedAt: requiredTimestamp(record.achievedAt, `matchingRecords[${index}].achievedAt`),
    };
  });
}

async function requireReviewTarget(
  client: Queryable,
  userId: string,
  review: ReviewEventInput,
): Promise<void> {
  const result = await client.query(
    `
    SELECT deck_versions.id
    FROM deck_assignments
    JOIN decks ON decks.id = deck_assignments.deck_id
    JOIN deck_versions ON deck_versions.deck_id = decks.id
    JOIN deck_version_cards ON deck_version_cards.deck_version_id = deck_versions.id
    WHERE deck_assignments.user_id::text = $1
      AND deck_assignments.deck_id::text = $2
      AND deck_assignments.status = 'active'
      AND deck_versions.status = 'published'
      AND deck_version_cards.card_id::text = $3
      AND (
        ($4::text IS NOT NULL AND deck_versions.id::text = $4)
        OR ($4::text IS NULL AND deck_versions.id = COALESCE(deck_assignments.deck_version_id, decks.current_version_id))
      )
    LIMIT 1
    `,
    [userId, review.deckId, review.cardId, review.deckVersionId],
  );
  if (!result.rowCount) {
    badRequest("review target is not assigned to this user");
  }
}

async function requireProgressTarget(
  client: Queryable,
  userId: string,
  progress: ProgressInput,
): Promise<void> {
  const result = await client.query(
    `
    SELECT 1
    FROM deck_assignments
    JOIN decks ON decks.id = deck_assignments.deck_id
    JOIN deck_versions ON deck_versions.id = COALESCE(deck_assignments.deck_version_id, decks.current_version_id)
    JOIN deck_version_cards ON deck_version_cards.deck_version_id = deck_versions.id
    WHERE deck_assignments.user_id::text = $1
      AND deck_assignments.deck_id::text = $2
      AND deck_assignments.status = 'active'
      AND deck_versions.status = 'published'
      AND deck_version_cards.card_id::text = $3
    LIMIT 1
    `,
    [userId, progress.deckId, progress.cardId],
  );
  if (!result.rowCount) {
    badRequest("progress target is not assigned to this user");
  }
}

async function requireMatchingTarget(
  client: Queryable,
  userId: string,
  record: MatchingRecordInput,
): Promise<void> {
  const result = await client.query(
    `
    SELECT 1
    FROM deck_assignments
    JOIN decks ON decks.id = deck_assignments.deck_id
    JOIN deck_versions ON deck_versions.deck_id = decks.id
    WHERE deck_assignments.user_id::text = $1
      AND deck_assignments.deck_id::text = $2
      AND deck_assignments.status = 'active'
      AND deck_versions.status = 'published'
      AND (
        ($3::text IS NOT NULL AND deck_versions.id::text = $3)
        OR ($3::text IS NULL AND deck_versions.id = COALESCE(deck_assignments.deck_version_id, decks.current_version_id))
      )
    LIMIT 1
    `,
    [userId, record.deckId, record.deckVersionId],
  );
  if (!result.rowCount) {
    badRequest("matching record target is not assigned to this user");
  }
}

export async function registerSyncRoutes(app: FastifyInstance, pool: pg.Pool): Promise<void> {
  app.get("/v1/bootstrap", async (request) => {
    requireHouseholdSync(request);

    const users = await allUserRows(pool);
    const requestedUserId = selectedUserHeader(request);
    const requestedUserExists = requestedUserId && users.some((user) => user.id === requestedUserId);
    const userId = requestedUserExists ? requestedUserId : users[0]?.id ?? null;

    const [assignments, content, media, progress, reviews, matchingRecords, reviewsRevision] = userId
      ? await Promise.all([
          assignedDeckRows(pool, userId),
          assignedContentRows(pool, userId),
          pool.query(
            `
            SELECT media_objects.id,
                   media_objects.storage_key,
                   media_objects.sha256,
                   media_objects.mime_type,
                   media_objects.byte_size::int AS byte_size,
                   media_objects.width::int AS width,
                   media_objects.height::int AS height,
                   media_objects.updated_at
            FROM media_objects
            WHERE media_objects.id IN (
              SELECT decks.avatar_media_id
              FROM deck_assignments
              JOIN decks ON decks.id = deck_assignments.deck_id
              WHERE deck_assignments.user_id = $1 AND decks.avatar_media_id IS NOT NULL
              UNION
              SELECT users.avatar_media_id
              FROM users
              WHERE users.id = $1 AND users.avatar_media_id IS NOT NULL
              UNION
              SELECT deck_version_cards.image_media_id
              FROM deck_assignments
              JOIN decks ON decks.id = deck_assignments.deck_id
              JOIN deck_version_cards ON deck_version_cards.deck_version_id = COALESCE(deck_assignments.deck_version_id, decks.current_version_id)
              WHERE deck_assignments.user_id = $1 AND deck_version_cards.image_media_id IS NOT NULL
              UNION
              SELECT deck_version_cards.audio_word_media_id
              FROM deck_assignments
              JOIN decks ON decks.id = deck_assignments.deck_id
              JOIN deck_version_cards ON deck_version_cards.deck_version_id = COALESCE(deck_assignments.deck_version_id, decks.current_version_id)
              WHERE deck_assignments.user_id = $1 AND deck_version_cards.audio_word_media_id IS NOT NULL
              UNION
              SELECT deck_version_examples.image_media_id
              FROM deck_assignments
              JOIN decks ON decks.id = deck_assignments.deck_id
              JOIN deck_version_examples ON deck_version_examples.deck_version_id = COALESCE(deck_assignments.deck_version_id, decks.current_version_id)
              WHERE deck_assignments.user_id = $1 AND deck_version_examples.image_media_id IS NOT NULL
              UNION
              SELECT deck_version_examples.audio_example_media_id
              FROM deck_assignments
              JOIN decks ON decks.id = deck_assignments.deck_id
              JOIN deck_version_examples ON deck_version_examples.deck_version_id = COALESCE(deck_assignments.deck_version_id, decks.current_version_id)
              WHERE deck_assignments.user_id = $1 AND deck_version_examples.audio_example_media_id IS NOT NULL
            )
            ORDER BY media_objects.storage_key
            `,
            [userId],
          ),
          pool.query(
            `
            SELECT user_id,
                   card_id,
                   deck_id,
                   fsrs_data,
                   due_at,
                   state,
                   updated_at,
                   server_revision
            FROM card_progress
            WHERE user_id = $1
            ORDER BY updated_at DESC
            `,
            [userId],
          ),
          pool.query(
            `
            SELECT *
            FROM study_reviews
            WHERE user_id = $1
            ORDER BY server_revision
            `,
            [userId],
          ),
          pool.query(
            `
            SELECT *
            FROM deck_matching_records
            WHERE user_id = $1
            ORDER BY server_revision
            `,
            [userId],
          ),
          pool.query<{ revision: string }>(
            `
            SELECT COALESCE(MAX(server_revision), 0)::text AS revision
            FROM study_reviews
            WHERE user_id = $1
            `,
            [userId],
          ),
        ])
      : [
          [],
          emptyContent(),
          { rows: [] },
          { rows: [] },
          { rows: [] },
          { rows: [] },
          { rows: [{ revision: "0" }] },
        ];

    return {
      user: users.find((user) => user.id === userId) ?? null,
      users,
      assignments,
      content,
      media: media.rows,
      progress: progress.rows,
      reviews: reviews.rows,
      matchingRecords: matchingRecords.rows,
      reviewsRevision: reviewsRevision.rows[0]?.revision ?? "0",
      serverRevision: await latestRevision(pool),
    };
  });

  app.get<{ Querystring: ChangesQuery }>("/v1/sync/changes", async (request) => {
    requireHouseholdSync(request);
    const userId = await selectedSyncUserId(request, pool);
    const sinceRevision = parseRevision(request.query.sinceRevision).toString();

    const [assignments, content, progress, reviews, matchingRecords] = await Promise.all([
      assignedDeckRows(pool, userId, sinceRevision),
      assignedContentRows(pool, userId, sinceRevision),
      pool.query(
        `
        SELECT *
        FROM card_progress
        WHERE user_id = $1 AND server_revision > $2
        ORDER BY server_revision
        `,
        [userId, sinceRevision],
      ),
      pool.query(
        `
        SELECT *
        FROM study_reviews
        WHERE user_id = $1 AND server_revision > $2
        ORDER BY server_revision
        `,
        [userId, sinceRevision],
      ),
      pool.query(
        `
        SELECT *
        FROM deck_matching_records
        WHERE user_id = $1 AND server_revision > $2
        ORDER BY server_revision
        `,
        [userId, sinceRevision],
      ),
    ]);

    return {
      assignments,
      content,
      progress: progress.rows,
      reviews: reviews.rows,
      matchingRecords: matchingRecords.rows,
      serverRevision: await latestRevision(pool),
    };
  });

  app.post("/v1/sync/events", async (request) => {
    requireHouseholdSync(request);
    const userId = await selectedSyncUserId(request, pool);
    const data = body(request.body);
    const reviews = parseReviews(data.reviews);
    const progressItems = parseProgress(data.progress);
    const matchingRecords = parseMatchingRecords(data.matchingRecords);

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      const acceptedReviewIds: string[] = [];
      const duplicateReviewIds: string[] = [];
      const progressCardIds: string[] = [];
      const matchingRecordDeckIds: string[] = [];

      for (const review of reviews) {
        await requireReviewTarget(client, userId, review);
        const result = await client.query<{ client_event_id: string }>(
          `
          INSERT INTO study_reviews (
            user_id, client_event_id, deck_id, deck_version_id, card_id,
            mode, outcome, reviewed_at, duration_ms, was_new, previous_state, new_state
          ) VALUES (
            $1, $2, $3, $4, $5,
            $6, $7, $8::timestamptz, $9, $10, $11, $12
          )
          ON CONFLICT (user_id, client_event_id) DO NOTHING
          RETURNING client_event_id
          `,
          [
            userId,
            review.clientEventId,
            review.deckId,
            review.deckVersionId,
            review.cardId,
            review.mode,
            review.outcome,
            review.reviewedAt,
            review.durationMs,
            review.wasNew,
            review.previousState,
            review.newState,
          ],
        );
        if (result.rowCount) {
          acceptedReviewIds.push(review.clientEventId);
        } else {
          duplicateReviewIds.push(review.clientEventId);
        }
      }

      for (const progress of progressItems) {
        await requireProgressTarget(client, userId, progress);
        const result = await client.query<{ card_id: string }>(
          `
          INSERT INTO card_progress (
            user_id, card_id, deck_id, fsrs_data, due_at, state, updated_at
          ) VALUES (
            $1, $2, $3, $4::jsonb, $5::timestamptz, $6, COALESCE($7::timestamptz, now())
          )
          ON CONFLICT (user_id, card_id) DO UPDATE SET
            deck_id = excluded.deck_id,
            fsrs_data = excluded.fsrs_data,
            due_at = excluded.due_at,
            state = excluded.state,
            updated_at = excluded.updated_at,
            server_revision = nextval('server_revision_seq')
          WHERE card_progress.deck_id IS DISTINCT FROM excluded.deck_id
             OR card_progress.fsrs_data IS DISTINCT FROM excluded.fsrs_data
             OR card_progress.due_at IS DISTINCT FROM excluded.due_at
             OR card_progress.state IS DISTINCT FROM excluded.state
             OR card_progress.updated_at IS DISTINCT FROM excluded.updated_at
          RETURNING card_id
          `,
          [
            userId,
            progress.cardId,
            progress.deckId,
            JSON.stringify(progress.fsrsData),
            progress.dueAt,
            progress.state,
            progress.updatedAt,
          ],
        );
        if (result.rowCount) {
          progressCardIds.push(progress.cardId);
        }
      }

      for (const record of matchingRecords) {
        await requireMatchingTarget(client, userId, record);
        const result = await client.query<{ deck_id: string }>(
          `
          INSERT INTO deck_matching_records (
            user_id, deck_id, deck_version_id, best_duration_seconds, pair_count, achieved_at
          ) VALUES (
            $1, $2, $3, $4, $5, $6::timestamptz
          )
          ON CONFLICT (user_id, deck_id) DO UPDATE SET
            deck_version_id = excluded.deck_version_id,
            best_duration_seconds = excluded.best_duration_seconds,
            pair_count = excluded.pair_count,
            achieved_at = excluded.achieved_at,
            server_revision = nextval('server_revision_seq')
          WHERE deck_matching_records.pair_count IS DISTINCT FROM excluded.pair_count
             OR excluded.best_duration_seconds < deck_matching_records.best_duration_seconds
          RETURNING deck_id
          `,
          [
            userId,
            record.deckId,
            record.deckVersionId,
            record.bestDurationSeconds,
            record.pairCount,
            record.achievedAt,
          ],
        );
        if (result.rowCount) {
          matchingRecordDeckIds.push(record.deckId);
        }
      }

      await client.query("COMMIT");

      return {
        acceptedReviewIds,
        duplicateReviewIds,
        progressCardIds,
        matchingRecordDeckIds,
        serverRevision: await latestRevision(pool),
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  });
}
