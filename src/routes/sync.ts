import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { requireHouseholdSync, selectedUserHeader } from "../auth.js";
import type { AppConfig } from "../config.js";
import {
  badRequest,
  HttpError,
  optionalNumber,
  optionalString,
  optionalUUID,
  requiredString,
  requiredUUID,
} from "../http.js";
import { bodyLimits, createRateLimit, endpointRateLimits } from "../limits.js";
import { consumeForceFullSync } from "../sync-control.js";

type Queryable = Pick<pg.Pool, "query">;

type ChangesQuery = {
  sinceRevision?: string;
};

type BootstrapQuery = Record<string, never>;

const cachedDeckVersionIdsHeader = "x-flashgame-cached-deck-version-ids";
const clientDeviceIdHeader = "x-flashgame-device-id";

type UserRow = {
  id: string;
  display_name: string;
  display_name_localized: string;
  grammatical_gender: string;
  avatar_media_id: string | null;
  role: string;
  created_at: string;
  updated_at: string;
};

type UserSettingsRow = {
  user_id: string;
  random_card_count: number;
  updated_at: string;
  server_revision: string;
};

type ReviewEventInput = {
  clientEventId: string;
  deckId: string;
  deckVersionId: string | null;
  cardId: string;
  mode: string;
  outcome: string;
  source: string;
  reviewedAt: string;
  durationMs: number | null;
  wasNew: boolean;
  previousState: string | null;
  newState: string | null;
};

type PracticeReviewInput = {
  clientEventId: string;
  deckId: string;
  deckVersionId: string | null;
  cardId: string;
  mode: string;
  outcome: string;
  source: string;
  practicedAt: string;
  durationMs: number | null;
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

type MatchingAttemptInput = {
  clientEventId: string;
  deckId: string | null;
  deckVersionId: string | null;
  mode: string;
  source: string;
  completedAt: string;
  durationMs: number;
  pairCount: number;
};

type DeckPreferenceInput = {
  deckId: string;
  isEnabled: boolean;
  updatedAt: string | null;
};

type SyncTargetValidation = {
  reviews: ReviewEventInput[];
  practiceReviews: PracticeReviewInput[];
  progressItems: ProgressInput[];
  matchingRecords: MatchingRecordInput[];
  matchingAttempts: MatchingAttemptInput[];
  deckPreferences: DeckPreferenceInput[];
  rejectedReviewIds: string[];
  rejectedPracticeReviewIds: string[];
  rejectedProgressCardIds: string[];
  rejectedMatchingRecordDeckIds: string[];
  rejectedMatchingAttemptIds: string[];
  rejectedDeckPreferenceDeckIds: string[];
};

function studyMode(value: unknown, field: string): string {
  const mode = requiredString(value, field);
  switch (mode) {
  case "flashcards":
  case "recall":
  case "matching":
  case "matching_audio":
  case "cloze_multiple_choice":
  case "cloze_typing":
    return mode;
  case "clozeMultipleChoice":
    return "cloze_multiple_choice";
  case "clozeTyping":
    return "cloze_typing";
  case "matchingAudio":
    return "matching_audio";
  default:
    badRequest(`${field} must be a valid study mode`);
  }
}

function matchingAttemptMode(value: unknown, field: string): string {
  const mode = studyMode(value, field);
  if (!["matching", "matching_audio"].includes(mode)) {
    badRequest(`${field} must be matching or matching_audio`);
  }
  return mode;
}

function practiceReviewMode(value: unknown, field: string): string {
  const mode = studyMode(value, field);
  if (!["flashcards", "cloze_multiple_choice", "cloze_typing"].includes(mode)) {
    badRequest(`${field} must be flashcards, cloze_multiple_choice, or cloze_typing`);
  }
  return mode;
}

function reviewOutcome(value: unknown, field: string): string {
  const outcome = requiredString(value, field);
  if (!["remembered", "forgot", "correct", "incorrect"].includes(outcome)) {
    badRequest(`${field} must be remembered, forgot, correct, or incorrect`);
  }
  return outcome;
}

function reviewSource(value: unknown, field: string): string {
  const source = optionalString(value, field) ?? "deck_session";
  if (!["today_queue", "deck_session", "weak_cards", "today_practice"].includes(source)) {
    badRequest(`${field} must be a valid review source`);
  }
  return source;
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

function requestDeviceId(value: string | string[] | undefined): string | null {
  return optionalUUID(Array.isArray(value) ? value[0] : value, clientDeviceIdHeader);
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
  pool: Queryable,
  userId: string,
  sinceRevision?: string,
  excludingDeviceId?: string | null,
): Promise<pg.QueryResult["rows"]> {
  const revisionFilter = sinceRevision
    ? `AND (
        deck_assignments.server_revision > $2
        OR deck_versions.server_revision > $2
        OR user_deck_groups.server_revision > $2
        OR (
          user_deck_preferences.server_revision > $2
          AND ($3::uuid IS NULL
            OR user_deck_preferences.modified_by_device_id IS NULL
            OR user_deck_preferences.modified_by_device_id <> $3::uuid)
        )
      )`
    : "";
  const params = sinceRevision ? [userId, sinceRevision, excludingDeviceId ?? null] : [userId];
  const result = await pool.query(
    `
    SELECT deck_assignments.user_id,
           deck_assignments.deck_id,
           NULL::uuid AS deck_version_id,
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
           deck_versions.published_at,
           COALESCE(user_deck_preferences.is_enabled, true) AS user_enabled,
           user_deck_preferences.updated_at AS preference_updated_at,
           user_deck_preferences.server_revision AS preference_revision,
           user_deck_groups.id AS deck_group_id,
           user_deck_groups.title AS deck_group_title,
           user_deck_groups.sort_order AS deck_group_sort_order,
           user_deck_groups.server_revision AS deck_group_revision,
           deck_assignments.sort_order AS deck_sort_order
    FROM deck_assignments
    JOIN decks ON decks.id = deck_assignments.deck_id
    LEFT JOIN deck_versions ON deck_versions.id = decks.current_version_id
    LEFT JOIN user_deck_groups
      ON user_deck_groups.user_id = deck_assignments.user_id
      AND user_deck_groups.id = deck_assignments.group_id
    LEFT JOIN user_deck_preferences
      ON user_deck_preferences.user_id = deck_assignments.user_id
      AND user_deck_preferences.deck_id = deck_assignments.deck_id
    WHERE deck_assignments.user_id = $1
      ${revisionFilter}
    ORDER BY user_deck_groups.sort_order NULLS LAST, user_deck_groups.title NULLS LAST, deck_assignments.sort_order, decks.title
    `,
    params,
  );
  return result.rows;
}

async function assignedContentRows(
  pool: Queryable,
  userId: string,
  sinceRevision?: string,
  cachedDeckVersionIds: string[] = [],
): Promise<{
  cards: pg.QueryResult["rows"];
  examples: pg.QueryResult["rows"];
  forms: pg.QueryResult["rows"];
  distractors: pg.QueryResult["rows"];
}> {
  const filters: string[] = [];
  const params: unknown[] = [userId];
  if (sinceRevision) {
    params.push(sinceRevision);
    filters.push(`AND (deck_assignments.server_revision > $${params.length} OR deck_versions.server_revision > $${params.length})`);
  }
  if (cachedDeckVersionIds.length) {
    params.push(cachedDeckVersionIds);
    filters.push(`AND NOT (deck_versions.id = ANY($${params.length}::uuid[]))`);
  }
  const contentFilters = filters.join("\n        ");
  const assignedVersions = `
    WITH assigned_versions AS (
      SELECT deck_versions.id
      FROM deck_assignments
      JOIN decks ON decks.id = deck_assignments.deck_id
      JOIN deck_versions ON deck_versions.id = decks.current_version_id
      WHERE deck_assignments.user_id = $1
        AND deck_assignments.status = 'active'
        AND deck_versions.status = 'published'
        ${contentFilters}
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

function cachedDeckVersionIds(request: { headers: Record<string, unknown> }): string[] {
  const rawValue = request.headers[cachedDeckVersionIdsHeader];
  if (rawValue == null || rawValue === "") {
    return [];
  }
  const text = Array.isArray(rawValue) ? rawValue.join(",") : String(rawValue);
  const ids = text
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  return [...new Set(ids.map((id) => requiredUUID(id, "cachedDeckVersionIds")))];
}

async function latestRevision(pool: Queryable): Promise<string> {
  const result = await pool.query<{ revision: string }>(
    `
    SELECT GREATEST(
      COALESCE((SELECT MAX(server_revision) FROM deck_versions), 0),
      COALESCE((SELECT MAX(server_revision) FROM deck_assignments), 0),
      COALESCE((SELECT MAX(server_revision) FROM user_deck_groups), 0),
      COALESCE((SELECT MAX(server_revision) FROM user_deck_preferences), 0),
      COALESCE((SELECT MAX(server_revision) FROM user_settings), 0),
      COALESCE((SELECT MAX(server_revision) FROM card_progress), 0),
      COALESCE((SELECT MAX(server_revision) FROM study_reviews), 0),
      COALESCE((SELECT MAX(server_revision) FROM practice_reviews), 0),
      COALESCE((SELECT MAX(server_revision) FROM deck_matching_records), 0),
      COALESCE((SELECT MAX(server_revision) FROM matching_attempts), 0),
      COALESCE((SELECT MAX(server_revision) FROM study_data_resets), 0)
    )::text AS revision
    `,
  );
  return result.rows[0]?.revision ?? "0";
}

async function allUserRows(pool: Queryable): Promise<UserRow[]> {
  const result = await pool.query<UserRow>(
    `
    SELECT id, display_name, display_name_localized, grammatical_gender, avatar_media_id, role, created_at, updated_at
    FROM users
    ORDER BY display_name
    `,
  );
  return result.rows;
}

async function assignedMediaRows(
  pool: Queryable,
  userId: string,
  cachedDeckVersionIds: string[] = [],
): Promise<pg.QueryResult["rows"]> {
  const result = await pool.query(
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
      WHERE users.avatar_media_id IS NOT NULL
      UNION
      SELECT deck_version_cards.image_media_id
      FROM deck_assignments
      JOIN decks ON decks.id = deck_assignments.deck_id
      JOIN deck_version_cards ON deck_version_cards.deck_version_id = decks.current_version_id
      WHERE deck_assignments.user_id = $1
        AND NOT (deck_version_cards.deck_version_id = ANY($2::uuid[]))
        AND deck_version_cards.image_media_id IS NOT NULL
      UNION
      SELECT deck_version_cards.audio_word_media_id
      FROM deck_assignments
      JOIN decks ON decks.id = deck_assignments.deck_id
      JOIN deck_version_cards ON deck_version_cards.deck_version_id = decks.current_version_id
      WHERE deck_assignments.user_id = $1
        AND NOT (deck_version_cards.deck_version_id = ANY($2::uuid[]))
        AND deck_version_cards.audio_word_media_id IS NOT NULL
      UNION
      SELECT deck_version_examples.image_media_id
      FROM deck_assignments
      JOIN decks ON decks.id = deck_assignments.deck_id
      JOIN deck_version_examples ON deck_version_examples.deck_version_id = decks.current_version_id
      WHERE deck_assignments.user_id = $1
        AND NOT (deck_version_examples.deck_version_id = ANY($2::uuid[]))
        AND deck_version_examples.image_media_id IS NOT NULL
      UNION
      SELECT deck_version_examples.audio_example_media_id
      FROM deck_assignments
      JOIN decks ON decks.id = deck_assignments.deck_id
      JOIN deck_version_examples ON deck_version_examples.deck_version_id = decks.current_version_id
      WHERE deck_assignments.user_id = $1
        AND NOT (deck_version_examples.deck_version_id = ANY($2::uuid[]))
        AND deck_version_examples.audio_example_media_id IS NOT NULL
    )
    ORDER BY media_objects.storage_key
    `,
    [userId, cachedDeckVersionIds],
  );
  return result.rows;
}

async function userSettingsRows(
  pool: Queryable,
  userId: string,
  sinceRevision?: string,
  excludingDeviceId?: string | null,
): Promise<UserSettingsRow[]> {
  const params: unknown[] = [userId];
  const revisionFilter = sinceRevision
    ? `AND user_settings.server_revision > $2
       AND ($3::uuid IS NULL OR user_settings.modified_by_device_id IS NULL OR user_settings.modified_by_device_id <> $3::uuid)`
    : "";
  if (sinceRevision) {
    params.push(sinceRevision, excludingDeviceId ?? null);
  }
  const result = await pool.query<UserSettingsRow>(
    `
    SELECT users.id AS user_id,
           COALESCE(user_settings.random_card_count, 30)::int AS random_card_count,
           COALESCE(user_settings.updated_at, users.updated_at) AS updated_at,
           COALESCE(user_settings.server_revision, 0)::text AS server_revision
    FROM users
    LEFT JOIN user_settings ON user_settings.user_id = users.id
    WHERE users.id = $1
      ${revisionFilter}
    `,
    params,
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
      source: reviewSource(review.source, `reviews[${index}].source`),
      reviewedAt: requiredTimestamp(review.reviewedAt, `reviews[${index}].reviewedAt`),
      durationMs: optionalNonNegativeInteger(review.durationMs, `reviews[${index}].durationMs`),
      wasNew: review.wasNew,
      previousState: optionalString(review.previousState, `reviews[${index}].previousState`),
      newState: optionalString(review.newState, `reviews[${index}].newState`),
    };
  });
}

function parsePracticeReviews(value: unknown): PracticeReviewInput[] {
  if (value == null) {
    return [];
  }
  if (!Array.isArray(value)) {
    badRequest("practiceReviews must be an array");
  }
  return value.map((item, index) => {
    if (item == null || typeof item !== "object" || Array.isArray(item)) {
      badRequest(`practiceReviews[${index}] must be an object`);
    }
    const review = item as Record<string, unknown>;
    return {
      clientEventId: requiredUUID(review.clientEventId, `practiceReviews[${index}].clientEventId`),
      deckId: requiredUUID(review.deckId, `practiceReviews[${index}].deckId`),
      deckVersionId: optionalUUID(review.deckVersionId, `practiceReviews[${index}].deckVersionId`),
      cardId: requiredUUID(review.cardId, `practiceReviews[${index}].cardId`),
      mode: practiceReviewMode(review.mode, `practiceReviews[${index}].mode`),
      outcome: reviewOutcome(review.outcome, `practiceReviews[${index}].outcome`),
      source: reviewSource(review.source, `practiceReviews[${index}].source`),
      practicedAt: requiredTimestamp(review.practicedAt, `practiceReviews[${index}].practicedAt`),
      durationMs: optionalNonNegativeInteger(review.durationMs, `practiceReviews[${index}].durationMs`),
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

function parseMatchingAttempts(value: unknown): MatchingAttemptInput[] {
  if (value == null) {
    return [];
  }
  if (!Array.isArray(value)) {
    badRequest("matchingAttempts must be an array");
  }
  return value.map((item, index) => {
    if (item == null || typeof item !== "object" || Array.isArray(item)) {
      badRequest(`matchingAttempts[${index}] must be an object`);
    }
    const attempt = item as Record<string, unknown>;
    const pairCount = optionalNumber(attempt.pairCount, `matchingAttempts[${index}].pairCount`);
    if (pairCount == null || !Number.isInteger(pairCount) || pairCount <= 0) {
      badRequest(`matchingAttempts[${index}].pairCount must be a positive integer`);
    }
    return {
      clientEventId: requiredUUID(attempt.clientEventId, `matchingAttempts[${index}].clientEventId`),
      deckId: optionalUUID(attempt.deckId, `matchingAttempts[${index}].deckId`),
      deckVersionId: optionalUUID(attempt.deckVersionId, `matchingAttempts[${index}].deckVersionId`),
      mode: matchingAttemptMode(attempt.mode, `matchingAttempts[${index}].mode`),
      source: reviewSource(attempt.source, `matchingAttempts[${index}].source`),
      completedAt: requiredTimestamp(attempt.completedAt, `matchingAttempts[${index}].completedAt`),
      durationMs: optionalNonNegativeInteger(attempt.durationMs, `matchingAttempts[${index}].durationMs`) ?? 0,
      pairCount,
    };
  });
}

function parseDeckPreferences(value: unknown): DeckPreferenceInput[] {
  if (value == null) {
    return [];
  }
  if (!Array.isArray(value)) {
    badRequest("deckPreferences must be an array");
  }
  return value.map((item, index) => {
    const preference = body(item);
    const isEnabled = preference.isEnabled;
    if (typeof isEnabled !== "boolean") {
      badRequest(`deckPreferences[${index}].isEnabled must be a boolean`);
    }
    return {
      deckId: requiredUUID(preference.deckId, `deckPreferences[${index}].deckId`),
      isEnabled,
      updatedAt: optionalTimestamp(preference.updatedAt, `deckPreferences[${index}].updatedAt`),
    };
  });
}

type ReviewTarget = {
  deckId: string;
  deckVersionId: string | null;
  cardId: string;
};

type ProgressTarget = {
  deckId: string;
  cardId: string;
};

type MatchingTarget = {
  deckId: string;
  deckVersionId: string | null;
  pairCount: number;
};

type MatchingAttemptTarget = {
  deckId: string | null;
  deckVersionId: string | null;
};

function nullableKey(value: string | null): string {
  return value ?? "<effective>";
}

function reviewTargetKey(target: ReviewTarget): string {
  return `${target.deckId}:${nullableKey(target.deckVersionId)}:${target.cardId}`;
}

function progressTargetKey(target: ProgressTarget): string {
  return `${target.deckId}:${target.cardId}`;
}

function matchingTargetKey(target: MatchingTarget): string {
  return `${target.deckId}:${nullableKey(target.deckVersionId)}:${target.pairCount}`;
}

function matchingAttemptTargetKey(target: MatchingAttemptTarget): string {
  return `${nullableKey(target.deckId)}:${nullableKey(target.deckVersionId)}`;
}

function uniqueByKey<T>(items: T[], key: (item: T) => string): T[] {
  return [...new Map(items.map((item) => [key(item), item])).values()];
}

function reviewTargetRows(targets: ReviewTarget[]): Array<{ deck_id: string; deck_version_id: string | null; card_id: string }> {
  return targets.map((target) => ({
    deck_id: target.deckId,
    deck_version_id: target.deckVersionId,
    card_id: target.cardId,
  }));
}

function progressTargetRows(targets: ProgressTarget[]): Array<{ deck_id: string; card_id: string }> {
  return targets.map((target) => ({
    deck_id: target.deckId,
    card_id: target.cardId,
  }));
}

function matchingTargetRows(targets: MatchingTarget[]): Array<{ deck_id: string; deck_version_id: string | null; pair_count: number }> {
  return targets.map((target) => ({
    deck_id: target.deckId,
    deck_version_id: target.deckVersionId,
    pair_count: target.pairCount,
  }));
}

function matchingAttemptTargetRows(targets: MatchingAttemptTarget[]): Array<{ deck_id: string | null; deck_version_id: string | null }> {
  return targets.map((target) => ({
    deck_id: target.deckId,
    deck_version_id: target.deckVersionId,
  }));
}

async function validateSyncTargets(
  client: Queryable,
  userId: string,
  reviews: ReviewEventInput[],
  practiceReviews: PracticeReviewInput[],
  progressItems: ProgressInput[],
  matchingRecords: MatchingRecordInput[],
  matchingAttempts: MatchingAttemptInput[],
  deckPreferences: DeckPreferenceInput[],
): Promise<SyncTargetValidation> {
  const [
    allowedReviewTargets,
    allowedPracticeReviewTargets,
    allowedProgressTargets,
    allowedMatchingTargets,
    allowedMatchingAttemptTargets,
    allowedDeckPreferenceTargets,
  ] = await Promise.all([
    allowedReviewTargetKeys(client, userId, reviews),
    allowedPracticeReviewTargetKeys(client, userId, practiceReviews),
    allowedProgressTargetKeys(client, userId, progressItems),
    allowedMatchingTargetKeys(client, userId, matchingRecords),
    allowedMatchingAttemptTargetKeys(client, userId, matchingAttempts),
    allowedDeckPreferenceTargetKeys(client, userId, deckPreferences),
  ]);

  const acceptedReviews: ReviewEventInput[] = [];
  const acceptedPracticeReviews: PracticeReviewInput[] = [];
  const acceptedProgressItems: ProgressInput[] = [];
  const acceptedMatchingRecords: MatchingRecordInput[] = [];
  const acceptedMatchingAttempts: MatchingAttemptInput[] = [];
  const acceptedDeckPreferences: DeckPreferenceInput[] = [];
  const rejectedReviewIds: string[] = [];
  const rejectedPracticeReviewIds: string[] = [];
  const rejectedProgressCardIds: string[] = [];
  const rejectedMatchingRecordDeckIds: string[] = [];
  const rejectedMatchingAttemptIds: string[] = [];
  const rejectedDeckPreferenceDeckIds: string[] = [];

  for (const review of reviews) {
    const key = reviewTargetKey(review);
    if (allowedReviewTargets.has(key)) {
      acceptedReviews.push(review);
    } else {
      rejectedReviewIds.push(review.clientEventId);
    }
  }
  for (const review of practiceReviews) {
    const key = reviewTargetKey(review);
    if (allowedPracticeReviewTargets.has(key)) {
      acceptedPracticeReviews.push(review);
    } else {
      rejectedPracticeReviewIds.push(review.clientEventId);
    }
  }
  for (const progress of progressItems) {
    const key = progressTargetKey(progress);
    if (allowedProgressTargets.has(key)) {
      acceptedProgressItems.push(progress);
    } else {
      rejectedProgressCardIds.push(progress.cardId);
    }
  }
  for (const record of matchingRecords) {
    const key = matchingTargetKey(record);
    if (allowedMatchingTargets.has(key)) {
      acceptedMatchingRecords.push(record);
    } else {
      rejectedMatchingRecordDeckIds.push(record.deckId);
    }
  }
  for (const attempt of matchingAttempts) {
    const key = matchingAttemptTargetKey(attempt);
    if (allowedMatchingAttemptTargets.has(key)) {
      acceptedMatchingAttempts.push(attempt);
    } else {
      rejectedMatchingAttemptIds.push(attempt.clientEventId);
    }
  }
  for (const preference of deckPreferences) {
    if (allowedDeckPreferenceTargets.has(preference.deckId)) {
      acceptedDeckPreferences.push(preference);
    } else {
      rejectedDeckPreferenceDeckIds.push(preference.deckId);
    }
  }

  return {
    reviews: acceptedReviews,
    practiceReviews: acceptedPracticeReviews,
    progressItems: acceptedProgressItems,
    matchingRecords: acceptedMatchingRecords,
    matchingAttempts: acceptedMatchingAttempts,
    deckPreferences: acceptedDeckPreferences,
    rejectedReviewIds,
    rejectedPracticeReviewIds,
    rejectedProgressCardIds,
    rejectedMatchingRecordDeckIds,
    rejectedMatchingAttemptIds,
    rejectedDeckPreferenceDeckIds,
  };
}

async function allowedReviewTargetKeys(
  client: Queryable,
  userId: string,
  reviews: ReviewEventInput[],
): Promise<Set<string>> {
  const targets = uniqueByKey(
    reviews.map((review) => ({
      deckId: review.deckId,
      deckVersionId: review.deckVersionId,
      cardId: review.cardId,
    })),
    reviewTargetKey,
  );
  if (!targets.length) {
    return new Set();
  }

  const result = await client.query<{
    deck_id: string;
    deck_version_id: string | null;
    card_id: string;
  }>(
    `
    WITH input_targets AS (
      SELECT DISTINCT
        deck_id::uuid AS deck_id,
        deck_version_id::uuid AS deck_version_id,
        card_id::uuid AS card_id
      FROM jsonb_to_recordset($2::jsonb)
        AS target(deck_id text, deck_version_id text, card_id text)
    )
    SELECT input_targets.deck_id::text,
           input_targets.deck_version_id::text,
           input_targets.card_id::text
    FROM input_targets
    JOIN deck_assignments
      ON deck_assignments.user_id = $1
      AND deck_assignments.deck_id = input_targets.deck_id
      AND deck_assignments.status = 'active'
    JOIN decks ON decks.id = deck_assignments.deck_id
    JOIN deck_versions
      ON deck_versions.id = decks.current_version_id
      AND deck_versions.status = 'published'
      AND (input_targets.deck_version_id IS NULL OR input_targets.deck_version_id = decks.current_version_id)
    JOIN deck_version_cards
      ON deck_version_cards.deck_version_id = deck_versions.id
      AND deck_version_cards.card_id = input_targets.card_id
    `,
    [userId, JSON.stringify(reviewTargetRows(targets))],
  );
  return new Set(result.rows.map((row) => reviewTargetKey({
    deckId: row.deck_id,
    deckVersionId: row.deck_version_id,
    cardId: row.card_id,
  })));
}

async function allowedPracticeReviewTargetKeys(
  client: Queryable,
  userId: string,
  reviews: PracticeReviewInput[],
): Promise<Set<string>> {
  const targets = uniqueByKey(
    reviews.map((review) => ({
      deckId: review.deckId,
      deckVersionId: review.deckVersionId,
      cardId: review.cardId,
    })),
    reviewTargetKey,
  );
  if (!targets.length) {
    return new Set();
  }

  const result = await client.query<{
    deck_id: string;
    deck_version_id: string | null;
    card_id: string;
  }>(
    `
    WITH input_targets AS (
      SELECT DISTINCT
        deck_id::uuid AS deck_id,
        deck_version_id::uuid AS deck_version_id,
        card_id::uuid AS card_id
      FROM jsonb_to_recordset($2::jsonb)
        AS target(deck_id text, deck_version_id text, card_id text)
    )
    SELECT input_targets.deck_id::text,
           input_targets.deck_version_id::text,
           input_targets.card_id::text
    FROM input_targets
    JOIN deck_assignments
      ON deck_assignments.user_id = $1
      AND deck_assignments.deck_id = input_targets.deck_id
      AND deck_assignments.status = 'active'
    JOIN decks ON decks.id = deck_assignments.deck_id
    JOIN deck_versions
      ON deck_versions.id = decks.current_version_id
      AND deck_versions.status = 'published'
      AND (input_targets.deck_version_id IS NULL OR input_targets.deck_version_id = decks.current_version_id)
    JOIN deck_version_cards
      ON deck_version_cards.deck_version_id = deck_versions.id
      AND deck_version_cards.card_id = input_targets.card_id
    `,
    [userId, JSON.stringify(reviewTargetRows(targets))],
  );
  return new Set(result.rows.map((row) => reviewTargetKey({
    deckId: row.deck_id,
    deckVersionId: row.deck_version_id,
    cardId: row.card_id,
  })));
}

async function allowedProgressTargetKeys(
  client: Queryable,
  userId: string,
  progressItems: ProgressInput[],
): Promise<Set<string>> {
  const targets = uniqueByKey(
    progressItems.map((progress) => ({
      deckId: progress.deckId,
      cardId: progress.cardId,
    })),
    progressTargetKey,
  );
  if (!targets.length) {
    return new Set();
  }

  const result = await client.query<{
    deck_id: string;
    card_id: string;
  }>(
    `
    WITH input_targets AS (
      SELECT DISTINCT
        deck_id::uuid AS deck_id,
        card_id::uuid AS card_id
      FROM jsonb_to_recordset($2::jsonb)
        AS target(deck_id text, card_id text)
    )
    SELECT input_targets.deck_id::text,
           input_targets.card_id::text
    FROM input_targets
    JOIN deck_assignments
      ON deck_assignments.user_id = $1
      AND deck_assignments.deck_id = input_targets.deck_id
      AND deck_assignments.status = 'active'
    JOIN decks ON decks.id = deck_assignments.deck_id
    JOIN deck_versions
      ON deck_versions.id = decks.current_version_id
      AND deck_versions.status = 'published'
    JOIN deck_version_cards
      ON deck_version_cards.deck_version_id = deck_versions.id
      AND deck_version_cards.card_id = input_targets.card_id
    `,
    [userId, JSON.stringify(progressTargetRows(targets))],
  );
  return new Set(result.rows.map((row) => progressTargetKey({
    deckId: row.deck_id,
    cardId: row.card_id,
  })));
}

async function allowedMatchingTargetKeys(
  client: Queryable,
  userId: string,
  matchingRecords: MatchingRecordInput[],
): Promise<Set<string>> {
  const targets = uniqueByKey(
    matchingRecords.map((record) => ({
      deckId: record.deckId,
      deckVersionId: record.deckVersionId,
      pairCount: record.pairCount,
    })),
    matchingTargetKey,
  );
  if (!targets.length) {
    return new Set();
  }

  const result = await client.query<{
    deck_id: string;
    deck_version_id: string | null;
    pair_count: number;
  }>(
    `
    WITH input_targets AS (
      SELECT DISTINCT
        deck_id::uuid AS deck_id,
        deck_version_id::uuid AS deck_version_id,
        pair_count::int AS pair_count
      FROM jsonb_to_recordset($2::jsonb)
        AS target(deck_id text, deck_version_id text, pair_count int)
    )
    SELECT input_targets.deck_id::text,
           input_targets.deck_version_id::text,
           input_targets.pair_count
    FROM input_targets
    JOIN deck_assignments
      ON deck_assignments.user_id = $1
      AND deck_assignments.deck_id = input_targets.deck_id
      AND deck_assignments.status = 'active'
    JOIN decks ON decks.id = deck_assignments.deck_id
    JOIN deck_versions
      ON deck_versions.id = decks.current_version_id
      AND deck_versions.status = 'published'
      AND (input_targets.deck_version_id IS NULL OR input_targets.deck_version_id = decks.current_version_id)
    JOIN deck_version_cards
      ON deck_version_cards.deck_version_id = deck_versions.id
      AND deck_version_cards.status = 'active'
    JOIN LATERAL (
      SELECT GREATEST(1, COUNT(*) FILTER (WHERE btrim(part) <> ''))::int AS pair_count
      FROM regexp_split_to_table(deck_version_cards.translation, ';') AS part
    ) card_pairs ON true
    GROUP BY input_targets.deck_id, input_targets.deck_version_id, input_targets.pair_count
    HAVING SUM(card_pairs.pair_count)::int = input_targets.pair_count
    `,
    [userId, JSON.stringify(matchingTargetRows(targets))],
  );
  return new Set(result.rows.map((row) => matchingTargetKey({
    deckId: row.deck_id,
    deckVersionId: row.deck_version_id,
    pairCount: row.pair_count,
  })));
}

async function allowedMatchingAttemptTargetKeys(
  client: Queryable,
  userId: string,
  matchingAttempts: MatchingAttemptInput[],
): Promise<Set<string>> {
  const targets = uniqueByKey(
    matchingAttempts.map((attempt) => ({
      deckId: attempt.deckId,
      deckVersionId: attempt.deckVersionId,
    })),
    matchingAttemptTargetKey,
  );
  if (!targets.length) {
    return new Set();
  }

  const keys = new Set<string>();
  for (const target of targets) {
    if (target.deckId == null && target.deckVersionId == null) {
      keys.add(matchingAttemptTargetKey(target));
    }
  }

  const deckTargets = targets.filter((target): target is MatchingTarget => target.deckId != null);
  if (!deckTargets.length) {
    return keys;
  }

  const result = await client.query<{
    deck_id: string;
    deck_version_id: string | null;
  }>(
    `
    WITH input_targets AS (
      SELECT DISTINCT
        deck_id::uuid AS deck_id,
        deck_version_id::uuid AS deck_version_id
      FROM jsonb_to_recordset($2::jsonb)
        AS target(deck_id text, deck_version_id text)
    )
    SELECT input_targets.deck_id::text,
           input_targets.deck_version_id::text
    FROM input_targets
    JOIN deck_assignments
      ON deck_assignments.user_id = $1
      AND deck_assignments.deck_id = input_targets.deck_id
      AND deck_assignments.status = 'active'
    JOIN decks ON decks.id = deck_assignments.deck_id
    JOIN deck_versions
      ON deck_versions.id = decks.current_version_id
      AND deck_versions.status = 'published'
      AND (input_targets.deck_version_id IS NULL OR input_targets.deck_version_id = decks.current_version_id)
    `,
    [userId, JSON.stringify(matchingAttemptTargetRows(deckTargets))],
  );
  for (const row of result.rows) {
    keys.add(matchingAttemptTargetKey({
      deckId: row.deck_id,
      deckVersionId: row.deck_version_id,
    }));
  }
  return keys;
}

async function allowedDeckPreferenceTargetKeys(
  client: Queryable,
  userId: string,
  deckPreferences: DeckPreferenceInput[],
): Promise<Set<string>> {
  const deckIds = [...new Set(deckPreferences.map((preference) => preference.deckId))];
  if (!deckIds.length) {
    return new Set();
  }

  const result = await client.query<{ deck_id: string }>(
    `
    SELECT deck_id::text
    FROM deck_assignments
    WHERE user_id = $1
      AND deck_id = ANY($2::uuid[])
    `,
    [userId, deckIds],
  );
  return new Set(result.rows.map((row) => row.deck_id));
}

export async function registerSyncRoutes(app: FastifyInstance, pool: pg.Pool, config: AppConfig): Promise<void> {
  const syncEventsRateLimit = createRateLimit(endpointRateLimits.syncEvents);
  const syncReadRateLimit = createRateLimit(endpointRateLimits.syncReads);

  app.get<{ Querystring: BootstrapQuery }>("/v1/bootstrap", {
    preHandler: syncReadRateLimit,
  }, async (request) => {
    requireHouseholdSync(request, config);

    const client = await pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");

      const users = await allUserRows(client);
      const requestedUserId = selectedUserHeader(request);
      const requestedUserExists = requestedUserId && users.some((user) => user.id === requestedUserId);
      const userId = requestedUserExists ? requestedUserId : users[0]?.id ?? null;
      const cachedVersions = cachedDeckVersionIds(request);

      const [
        assignments,
        content,
        media,
        progress,
        matchingRecords,
        matchingAttempts,
        reviews,
        practiceReviews,
        studyDataResets,
        userSettings,
      ] = userId
        ? [
            await assignedDeckRows(client, userId),
            await assignedContentRows(client, userId, undefined, cachedVersions),
            { rows: await assignedMediaRows(client, userId, cachedVersions) },
            await client.query(
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
            await client.query(
              `
              SELECT *
              FROM deck_matching_records
              WHERE user_id = $1
              ORDER BY server_revision
              `,
              [userId],
            ),
            await client.query(
              `
              SELECT *
              FROM matching_attempts
              WHERE user_id = $1
              ORDER BY server_revision
              `,
              [userId],
            ),
            await client.query(
              `
              SELECT *
              FROM study_reviews
              WHERE user_id = $1
              ORDER BY server_revision
              `,
              [userId],
            ),
            await client.query(
              `
              SELECT *
              FROM practice_reviews
              WHERE user_id = $1
              ORDER BY server_revision
              `,
              [userId],
            ),
            await client.query(
              `
              SELECT user_id, deck_id, reset_at, server_revision
              FROM study_data_resets
              WHERE user_id = $1
              ORDER BY server_revision
              `,
              [userId],
            ),
            await userSettingsRows(client, userId),
          ]
        : [
            [],
            emptyContent(),
            { rows: [] },
            { rows: [] },
            { rows: [] },
            { rows: [] },
            { rows: [] },
            { rows: [] },
            { rows: [] },
            [],
          ];

      const serverRevision = await latestRevision(client);
      await client.query("COMMIT");

      return {
        mode: "snapshot",
        revision: serverRevision,
        user: users.find((user) => user.id === userId) ?? null,
        users,
        snapshot: {
          assignments,
          content,
          media: media.rows,
          progress: progress.rows,
          reviews: reviews.rows,
          practiceReviews: practiceReviews.rows,
          matchingRecords: matchingRecords.rows,
          matchingAttempts: matchingAttempts.rows,
          studyDataResets: studyDataResets.rows,
          userSettings,
        },
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  });

  app.get<{ Querystring: ChangesQuery }>("/v1/sync/changes", {
    preHandler: syncReadRateLimit,
  }, async (request) => {
    requireHouseholdSync(request, config);
    const userId = await selectedSyncUserId(request, pool);
    if (consumeForceFullSync(userId)) {
      throw new HttpError(409, "full_sync_required", "Full sync is required for this user");
    }
    const sinceRevision = parseRevision(request.query.sinceRevision).toString();
    const deviceId = requestDeviceId(request.headers[clientDeviceIdHeader]);
    const cachedVersions = cachedDeckVersionIds(request);

    const [
      users,
      assignments,
      content,
      media,
      progress,
      reviews,
      practiceReviews,
      matchingRecords,
      matchingAttempts,
      studyDataResets,
      userSettings,
    ] = await Promise.all([
      allUserRows(pool),
      assignedDeckRows(pool, userId, sinceRevision, deviceId),
      assignedContentRows(pool, userId, sinceRevision),
      assignedMediaRows(pool, userId, cachedVersions),
      pool.query(
        `
        SELECT *
        FROM card_progress
        WHERE user_id = $1
          AND server_revision > $2
          AND ($3::uuid IS NULL OR modified_by_device_id IS NULL OR modified_by_device_id <> $3::uuid)
        ORDER BY server_revision
        `,
        [userId, sinceRevision, deviceId],
      ),
      pool.query(
        `
        SELECT *
        FROM study_reviews
        WHERE user_id = $1
          AND server_revision > $2
          AND ($3::uuid IS NULL OR modified_by_device_id IS NULL OR modified_by_device_id <> $3::uuid)
        ORDER BY server_revision
        `,
        [userId, sinceRevision, deviceId],
      ),
      pool.query(
        `
        SELECT *
        FROM practice_reviews
        WHERE user_id = $1
          AND server_revision > $2
          AND ($3::uuid IS NULL OR modified_by_device_id IS NULL OR modified_by_device_id <> $3::uuid)
        ORDER BY server_revision
        `,
        [userId, sinceRevision, deviceId],
      ),
      pool.query(
        `
        SELECT *
        FROM deck_matching_records
        WHERE user_id = $1
          AND server_revision > $2
          AND ($3::uuid IS NULL OR modified_by_device_id IS NULL OR modified_by_device_id <> $3::uuid)
        ORDER BY server_revision
        `,
        [userId, sinceRevision, deviceId],
      ),
      pool.query(
        `
        SELECT *
        FROM matching_attempts
        WHERE user_id = $1
          AND server_revision > $2
          AND ($3::uuid IS NULL OR modified_by_device_id IS NULL OR modified_by_device_id <> $3::uuid)
        ORDER BY server_revision
        `,
        [userId, sinceRevision, deviceId],
      ),
      pool.query(
        `
        SELECT user_id, deck_id, reset_at, server_revision
        FROM study_data_resets
        WHERE user_id = $1
          AND server_revision > $2
        ORDER BY server_revision
        `,
        [userId, sinceRevision],
      ),
      userSettingsRows(pool, userId, sinceRevision, deviceId),
    ]);

    return {
      mode: "delta",
      fromRevision: sinceRevision,
      toRevision: await latestRevision(pool),
      changes: {
        users,
        assignments,
        content,
        media,
        progress: progress.rows,
        reviews: reviews.rows,
        practiceReviews: practiceReviews.rows,
        matchingRecords: matchingRecords.rows,
        matchingAttempts: matchingAttempts.rows,
        studyDataResets: studyDataResets.rows,
        userSettings,
      },
    };
  });

  app.post("/v1/sync/events", {
    bodyLimit: bodyLimits.syncEvents,
    preHandler: syncEventsRateLimit,
  }, async (request) => {
    requireHouseholdSync(request, config);
    const userId = await selectedSyncUserId(request, pool);
    const deviceId = requestDeviceId(request.headers[clientDeviceIdHeader]);
    const startedAt = Date.now();
    const data = body(request.body);
    const reviews = parseReviews(data.reviews);
    const practiceReviews = parsePracticeReviews(data.practiceReviews);
    const progressItems = parseProgress(data.progress);
    const matchingRecords = parseMatchingRecords(data.matchingRecords);
    const matchingAttempts = parseMatchingAttempts(data.matchingAttempts);
    const deckPreferences = parseDeckPreferences(data.deckPreferences);

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      const acceptedReviewIds: string[] = [];
      const duplicateReviewIds: string[] = [];
      const acceptedPracticeReviewIds: string[] = [];
      const duplicatePracticeReviewIds: string[] = [];
      const progressCardIds: string[] = [];
      const matchingRecordDeckIds: string[] = [];
      const acceptedMatchingAttemptIds: string[] = [];
      const duplicateMatchingAttemptIds: string[] = [];
      const deckPreferenceDeckIds: string[] = [];

      const validated = await validateSyncTargets(
        client,
        userId,
        reviews,
        practiceReviews,
        progressItems,
        matchingRecords,
        matchingAttempts,
        deckPreferences,
      );

      for (const review of validated.reviews) {
        const result = await client.query<{ client_event_id: string }>(
          `
          INSERT INTO study_reviews (
            user_id, client_event_id, deck_id, deck_version_id, card_id,
            mode, outcome, source, reviewed_at, duration_ms, was_new, previous_state, new_state,
            modified_by_device_id
          ) VALUES (
            $1, $2, $3, $4, $5,
            $6, $7, $8, $9::timestamptz, $10, $11, $12, $13, $14::uuid
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
            review.source,
            review.reviewedAt,
            review.durationMs,
            review.wasNew,
            review.previousState,
            review.newState,
            deviceId,
          ],
        );
        if (result.rowCount) {
          acceptedReviewIds.push(review.clientEventId);
        } else {
          duplicateReviewIds.push(review.clientEventId);
        }
      }

      for (const review of validated.practiceReviews) {
        const result = await client.query<{ client_event_id: string }>(
          `
          INSERT INTO practice_reviews (
            user_id, client_event_id, deck_id, deck_version_id, card_id,
            mode, outcome, source, practiced_at, duration_ms, modified_by_device_id
          ) VALUES (
            $1, $2, $3, $4, $5,
            $6, $7, $8, $9::timestamptz, $10, $11::uuid
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
            review.source,
            review.practicedAt,
            review.durationMs,
            deviceId,
          ],
        );
        if (result.rowCount) {
          acceptedPracticeReviewIds.push(review.clientEventId);
        } else {
          duplicatePracticeReviewIds.push(review.clientEventId);
        }
      }

      for (const progress of validated.progressItems) {
        const result = await client.query<{ card_id: string }>(
          `
          INSERT INTO card_progress (
            user_id, card_id, deck_id, fsrs_data, due_at, state, updated_at, modified_by_device_id
          ) VALUES (
            $1, $2, $3, $4::jsonb, $5::timestamptz, $6, COALESCE($7::timestamptz, now()), $8::uuid
          )
          ON CONFLICT (user_id, card_id) DO UPDATE SET
            deck_id = excluded.deck_id,
            fsrs_data = excluded.fsrs_data,
            due_at = excluded.due_at,
            state = excluded.state,
            updated_at = excluded.updated_at,
            modified_by_device_id = excluded.modified_by_device_id,
            server_revision = nextval('server_revision_seq')
          WHERE (
              card_progress.deck_id IS DISTINCT FROM excluded.deck_id
              OR card_progress.fsrs_data IS DISTINCT FROM excluded.fsrs_data
              OR card_progress.due_at IS DISTINCT FROM excluded.due_at
              OR card_progress.state IS DISTINCT FROM excluded.state
              OR card_progress.updated_at IS DISTINCT FROM excluded.updated_at
            )
            AND excluded.updated_at >= card_progress.updated_at
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
            deviceId,
          ],
        );
        if (result.rowCount) {
          progressCardIds.push(progress.cardId);
        }
      }

      for (const record of validated.matchingRecords) {
        const result = await client.query<{ deck_id: string }>(
          `
          INSERT INTO deck_matching_records (
            user_id, deck_id, deck_version_id, best_duration_seconds, pair_count, achieved_at,
            modified_by_device_id
          ) VALUES (
            $1, $2, $3, $4, $5, $6::timestamptz, $7::uuid
          )
          ON CONFLICT (user_id, deck_id) DO UPDATE SET
            deck_version_id = excluded.deck_version_id,
            best_duration_seconds = excluded.best_duration_seconds,
            pair_count = excluded.pair_count,
            achieved_at = excluded.achieved_at,
            modified_by_device_id = excluded.modified_by_device_id,
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
            deviceId,
          ],
        );
        if (result.rowCount) {
          matchingRecordDeckIds.push(record.deckId);
        }
      }

      for (const attempt of validated.matchingAttempts) {
        const result = await client.query<{ client_event_id: string }>(
          `
          INSERT INTO matching_attempts (
            user_id, client_event_id, deck_id, deck_version_id, mode, source,
            completed_at, duration_ms, pair_count, modified_by_device_id
          ) VALUES (
            $1, $2, $3::uuid, $4::uuid, $5, $6,
            $7::timestamptz, $8, $9, $10::uuid
          )
          ON CONFLICT (user_id, client_event_id) DO NOTHING
          RETURNING client_event_id
          `,
          [
            userId,
            attempt.clientEventId,
            attempt.deckId,
            attempt.deckVersionId,
            attempt.mode,
            attempt.source,
            attempt.completedAt,
            attempt.durationMs,
            attempt.pairCount,
            deviceId,
          ],
        );
        if (result.rowCount) {
          acceptedMatchingAttemptIds.push(attempt.clientEventId);
        } else {
          duplicateMatchingAttemptIds.push(attempt.clientEventId);
        }
      }

      for (const preference of validated.deckPreferences) {
        await client.query(
          `
          INSERT INTO user_deck_preferences (
            user_id, deck_id, is_enabled, updated_at, modified_by_device_id
          ) VALUES (
            $1, $2, $3, COALESCE($4::timestamptz, now()), $5::uuid
          )
          ON CONFLICT (user_id, deck_id) DO UPDATE SET
            is_enabled = excluded.is_enabled,
            updated_at = excluded.updated_at,
            modified_by_device_id = excluded.modified_by_device_id,
            server_revision = nextval('server_revision_seq')
          WHERE user_deck_preferences.is_enabled IS DISTINCT FROM excluded.is_enabled
            AND excluded.updated_at >= user_deck_preferences.updated_at
          `,
          [userId, preference.deckId, preference.isEnabled, preference.updatedAt, deviceId],
        );
        deckPreferenceDeckIds.push(preference.deckId);
      }

      await client.query("COMMIT");

      const durationMs = Date.now() - startedAt;
      request.log.info({
        userId,
        durationMs,
        reviewCount: reviews.length,
        acceptedReviewCount: acceptedReviewIds.length,
        duplicateReviewCount: duplicateReviewIds.length,
        practiceReviewCount: practiceReviews.length,
        acceptedPracticeReviewCount: acceptedPracticeReviewIds.length,
        duplicatePracticeReviewCount: duplicatePracticeReviewIds.length,
        progressCount: progressItems.length,
        acceptedProgressCount: progressCardIds.length,
        matchingRecordCount: matchingRecords.length,
        acceptedMatchingRecordCount: matchingRecordDeckIds.length,
        matchingAttemptCount: matchingAttempts.length,
        acceptedMatchingAttemptCount: acceptedMatchingAttemptIds.length,
        duplicateMatchingAttemptCount: duplicateMatchingAttemptIds.length,
        deckPreferenceCount: deckPreferences.length,
        acceptedDeckPreferenceCount: deckPreferenceDeckIds.length,
        rejectedReviewCount: validated.rejectedReviewIds.length,
        rejectedPracticeReviewCount: validated.rejectedPracticeReviewIds.length,
        rejectedProgressCount: validated.rejectedProgressCardIds.length,
        rejectedMatchingRecordCount: validated.rejectedMatchingRecordDeckIds.length,
        rejectedMatchingAttemptCount: validated.rejectedMatchingAttemptIds.length,
        rejectedDeckPreferenceCount: validated.rejectedDeckPreferenceDeckIds.length,
      }, "sync events accepted");

      return {
        mode: "events",
        accepted: {
          reviewIds: acceptedReviewIds,
          practiceReviewIds: acceptedPracticeReviewIds,
          progressCardIds,
          matchingRecordDeckIds,
          matchingAttemptIds: acceptedMatchingAttemptIds,
          deckPreferenceDeckIds,
        },
        duplicates: {
          reviewIds: duplicateReviewIds,
          practiceReviewIds: duplicatePracticeReviewIds,
          matchingAttemptIds: duplicateMatchingAttemptIds,
        },
        rejected: {
          reviewIds: validated.rejectedReviewIds,
          practiceReviewIds: validated.rejectedPracticeReviewIds,
          progressCardIds: validated.rejectedProgressCardIds,
          matchingRecordDeckIds: validated.rejectedMatchingRecordDeckIds,
          matchingAttemptIds: validated.rejectedMatchingAttemptIds,
          deckPreferenceDeckIds: validated.rejectedDeckPreferenceDeckIds,
        },
        toRevision: await latestRevision(pool),
      };
    } catch (error) {
      await client.query("ROLLBACK");
      request.log.warn({
        err: error,
        userId,
        durationMs: Date.now() - startedAt,
        reviewCount: reviews.length,
        practiceReviewCount: practiceReviews.length,
        progressCount: progressItems.length,
        matchingRecordCount: matchingRecords.length,
        matchingAttemptCount: matchingAttempts.length,
        deckPreferenceCount: deckPreferences.length,
      }, "sync events rejected");
      throw error;
    } finally {
      client.release();
    }
  });
}
