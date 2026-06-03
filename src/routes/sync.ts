import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { requireHouseholdSync, selectedUserHeader } from "../auth.js";
import type { AppConfig } from "../config.js";
import {
  badRequest,
  optionalNumber,
  optionalString,
  optionalUUID,
  requiredString,
  requiredUUID,
} from "../http.js";
import { bodyLimits, createRateLimit, endpointRateLimits } from "../limits.js";

type Queryable = Pick<pg.Pool, "query">;

type ChangesQuery = {
  sinceRevision?: string;
};

const cachedDeckVersionIdsHeader = "x-flashgame-cached-deck-version-ids";
const clientTimeZoneHeader = "x-flashgame-time-zone";
const timeZoneAliases = new Map<string, string>([
  ["Europe/Kiev", "Europe/Kyiv"],
]);

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

type DeckPreferenceInput = {
  deckId: string;
  isEnabled: boolean;
  updatedAt: string | null;
};

type SyncTargetValidation = {
  reviews: ReviewEventInput[];
  progressItems: ProgressInput[];
  matchingRecords: MatchingRecordInput[];
  deckPreferences: DeckPreferenceInput[];
  rejectedReviewIds: string[];
  rejectedProgressCardIds: string[];
  rejectedMatchingRecordDeckIds: string[];
  rejectedDeckPreferenceDeckIds: string[];
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
    ? "AND (deck_assignments.server_revision > $2 OR deck_versions.server_revision > $2 OR user_deck_preferences.server_revision > $2)"
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
           deck_versions.published_at,
           COALESCE(user_deck_preferences.is_enabled, true) AS user_enabled,
           user_deck_preferences.updated_at AS preference_updated_at,
           user_deck_preferences.server_revision AS preference_revision
    FROM deck_assignments
    JOIN decks ON decks.id = deck_assignments.deck_id
    LEFT JOIN deck_versions ON deck_versions.id = COALESCE(deck_assignments.deck_version_id, decks.current_version_id)
    LEFT JOIN user_deck_preferences
      ON user_deck_preferences.user_id = deck_assignments.user_id
      AND user_deck_preferences.deck_id = deck_assignments.deck_id
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
      JOIN deck_versions ON deck_versions.id = COALESCE(deck_assignments.deck_version_id, decks.current_version_id)
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

async function dailyUsageRows(pool: pg.Pool, userId: string, timeZone: string): Promise<pg.QueryResult["rows"]> {
  const result = await pool.query(
    `
    SELECT
      study_reviews.deck_id,
      to_char(study_reviews.reviewed_at AT TIME ZONE $2, 'YYYY-MM-DD') AS day_key,
      COUNT(*)::int AS new_cards_studied
    FROM study_reviews
    JOIN deck_assignments ON deck_assignments.user_id = study_reviews.user_id
      AND deck_assignments.deck_id = study_reviews.deck_id
      AND deck_assignments.status = 'active'
    WHERE study_reviews.user_id = $1
      AND study_reviews.was_new = true
      AND study_reviews.outcome IN ('remembered', 'correct')
    GROUP BY study_reviews.deck_id, day_key
    ORDER BY day_key, study_reviews.deck_id
    `,
    [userId, timeZone],
  );
  return result.rows;
}

async function statsSummaryRows(pool: pg.Pool, userId: string, timeZone: string): Promise<{
  activityDays: pg.QueryResult["rows"];
  weakCards: pg.QueryResult["rows"];
}> {
  const [activityDays, weakCards] = await Promise.all([
    pool.query(
      `
      SELECT
        to_char(study_reviews.reviewed_at AT TIME ZONE $2, 'YYYY-MM-DD') AS day_key,
        COUNT(*)::int AS reviewed_count,
        COUNT(*) FILTER (WHERE study_reviews.outcome IN ('remembered', 'correct'))::int AS passed_count
      FROM study_reviews
      WHERE study_reviews.user_id = $1
      GROUP BY day_key
      ORDER BY day_key
      `,
      [userId, timeZone],
    ),
    pool.query(
      `
      SELECT
        study_reviews.card_id,
        study_reviews.deck_id,
        COUNT(*) FILTER (WHERE study_reviews.outcome IN ('forgot', 'incorrect'))::int AS failed_count,
        COUNT(*)::int AS reviewed_count,
        MAX(study_reviews.reviewed_at) FILTER (WHERE study_reviews.outcome IN ('forgot', 'incorrect')) AS last_failed_at
      FROM study_reviews
      JOIN deck_assignments ON deck_assignments.user_id = study_reviews.user_id
        AND deck_assignments.deck_id = study_reviews.deck_id
        AND deck_assignments.status = 'active'
      WHERE study_reviews.user_id = $1
      GROUP BY study_reviews.card_id, study_reviews.deck_id
      HAVING COUNT(*) FILTER (WHERE study_reviews.outcome IN ('forgot', 'incorrect')) > 0
      ORDER BY failed_count DESC,
               (COUNT(*) FILTER (WHERE study_reviews.outcome IN ('forgot', 'incorrect'))::float / COUNT(*)::float) DESC,
               last_failed_at DESC
      LIMIT 100
      `,
      [userId],
    ),
  ]);
  return {
    activityDays: activityDays.rows,
    weakCards: weakCards.rows,
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

function clientTimeZone(request: { headers: Record<string, unknown> }): string {
  const rawValue = request.headers[clientTimeZoneHeader];
  if (rawValue == null || rawValue === "") {
    return "UTC";
  }
  const value = (Array.isArray(rawValue) ? rawValue[0] : String(rawValue)).trim();
  if (!/^[A-Za-z0-9_+\-./]{1,64}$/.test(value)) {
    return "UTC";
  }
  const normalized = timeZoneAliases.get(value) ?? value;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: normalized });
    return normalized;
  } catch {
    return "UTC";
  }
}

async function latestRevision(pool: pg.Pool): Promise<string> {
  const result = await pool.query<{ revision: string }>(
    `
    SELECT GREATEST(
      COALESCE((SELECT MAX(server_revision) FROM deck_versions), 0),
      COALESCE((SELECT MAX(server_revision) FROM deck_assignments), 0),
      COALESCE((SELECT MAX(server_revision) FROM user_deck_preferences), 0),
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
  return `${target.deckId}:${nullableKey(target.deckVersionId)}`;
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

function matchingTargetRows(targets: MatchingTarget[]): Array<{ deck_id: string; deck_version_id: string | null }> {
  return targets.map((target) => ({
    deck_id: target.deckId,
    deck_version_id: target.deckVersionId,
  }));
}

async function validateSyncTargets(
  client: Queryable,
  userId: string,
  reviews: ReviewEventInput[],
  progressItems: ProgressInput[],
  matchingRecords: MatchingRecordInput[],
  deckPreferences: DeckPreferenceInput[],
): Promise<SyncTargetValidation> {
  const [
    allowedReviewTargets,
    allowedProgressTargets,
    allowedMatchingTargets,
    allowedDeckPreferenceTargets,
  ] = await Promise.all([
    allowedReviewTargetKeys(client, userId, reviews),
    allowedProgressTargetKeys(client, userId, progressItems),
    allowedMatchingTargetKeys(client, userId, matchingRecords),
    allowedDeckPreferenceTargetKeys(client, userId, deckPreferences),
  ]);

  const acceptedReviews: ReviewEventInput[] = [];
  const acceptedProgressItems: ProgressInput[] = [];
  const acceptedMatchingRecords: MatchingRecordInput[] = [];
  const acceptedDeckPreferences: DeckPreferenceInput[] = [];
  const rejectedReviewIds: string[] = [];
  const rejectedProgressCardIds: string[] = [];
  const rejectedMatchingRecordDeckIds: string[] = [];
  const rejectedDeckPreferenceDeckIds: string[] = [];

  for (const review of reviews) {
    const key = reviewTargetKey(review);
    if (allowedReviewTargets.has(key)) {
      acceptedReviews.push(review);
    } else {
      rejectedReviewIds.push(review.clientEventId);
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
  for (const preference of deckPreferences) {
    if (allowedDeckPreferenceTargets.has(preference.deckId)) {
      acceptedDeckPreferences.push(preference);
    } else {
      rejectedDeckPreferenceDeckIds.push(preference.deckId);
    }
  }

  return {
    reviews: acceptedReviews,
    progressItems: acceptedProgressItems,
    matchingRecords: acceptedMatchingRecords,
    deckPreferences: acceptedDeckPreferences,
    rejectedReviewIds,
    rejectedProgressCardIds,
    rejectedMatchingRecordDeckIds,
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
      ON deck_versions.deck_id = decks.id
      AND deck_versions.status = 'published'
      AND (
        (input_targets.deck_version_id IS NOT NULL AND deck_versions.id = input_targets.deck_version_id)
        OR (
          input_targets.deck_version_id IS NULL
          AND deck_versions.id = COALESCE(deck_assignments.deck_version_id, decks.current_version_id)
        )
      )
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
      ON deck_versions.id = COALESCE(deck_assignments.deck_version_id, decks.current_version_id)
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
    })),
    matchingTargetKey,
  );
  if (!targets.length) {
    return new Set();
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
      ON deck_versions.deck_id = decks.id
      AND deck_versions.status = 'published'
      AND (
        (input_targets.deck_version_id IS NOT NULL AND deck_versions.id = input_targets.deck_version_id)
        OR (
          input_targets.deck_version_id IS NULL
          AND deck_versions.id = COALESCE(deck_assignments.deck_version_id, decks.current_version_id)
        )
      )
    `,
    [userId, JSON.stringify(matchingTargetRows(targets))],
  );
  return new Set(result.rows.map((row) => matchingTargetKey({
    deckId: row.deck_id,
    deckVersionId: row.deck_version_id,
  })));
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

  app.get("/v1/bootstrap", async (request) => {
    requireHouseholdSync(request, config);

    const users = await allUserRows(pool);
    const requestedUserId = selectedUserHeader(request);
    const requestedUserExists = requestedUserId && users.some((user) => user.id === requestedUserId);
    const userId = requestedUserExists ? requestedUserId : users[0]?.id ?? null;
    const cachedVersions = cachedDeckVersionIds(request);
    const timeZone = clientTimeZone(request);

    const [assignments, content, media, progress, matchingRecords, dailyUsage, statsSummary, reviewsRevision] = userId
      ? await Promise.all([
          assignedDeckRows(pool, userId),
          assignedContentRows(pool, userId, undefined, cachedVersions),
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
              WHERE users.avatar_media_id IS NOT NULL
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
            FROM deck_matching_records
            WHERE user_id = $1
            ORDER BY server_revision
            `,
            [userId],
          ),
          dailyUsageRows(pool, userId, timeZone),
          statsSummaryRows(pool, userId, timeZone),
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
          [],
          { activityDays: [], weakCards: [] },
          { rows: [{ revision: "0" }] },
        ];

    return {
      user: users.find((user) => user.id === userId) ?? null,
      users,
      assignments,
      content,
      media: media.rows,
      progress: progress.rows,
      reviews: [],
      matchingRecords: matchingRecords.rows,
      dailyUsage,
      statsSummary,
      reviewsRevision: reviewsRevision.rows[0]?.revision ?? "0",
      serverRevision: await latestRevision(pool),
    };
  });

  app.get<{ Querystring: ChangesQuery }>("/v1/sync/changes", async (request) => {
    requireHouseholdSync(request, config);
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

  app.post("/v1/sync/events", {
    bodyLimit: bodyLimits.syncEvents,
    preHandler: syncEventsRateLimit,
  }, async (request) => {
    requireHouseholdSync(request, config);
    const userId = await selectedSyncUserId(request, pool);
    const startedAt = Date.now();
    const data = body(request.body);
    const reviews = parseReviews(data.reviews);
    const progressItems = parseProgress(data.progress);
    const matchingRecords = parseMatchingRecords(data.matchingRecords);
    const deckPreferences = parseDeckPreferences(data.deckPreferences);

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      const acceptedReviewIds: string[] = [];
      const duplicateReviewIds: string[] = [];
      const progressCardIds: string[] = [];
      const matchingRecordDeckIds: string[] = [];
      const deckPreferenceDeckIds: string[] = [];

      const validated = await validateSyncTargets(client, userId, reviews, progressItems, matchingRecords, deckPreferences);

      for (const review of validated.reviews) {
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

      for (const progress of validated.progressItems) {
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

      for (const preference of validated.deckPreferences) {
        await client.query(
          `
          INSERT INTO user_deck_preferences (
            user_id, deck_id, is_enabled, updated_at
          ) VALUES (
            $1, $2, $3, COALESCE($4::timestamptz, now())
          )
          ON CONFLICT (user_id, deck_id) DO UPDATE SET
            is_enabled = excluded.is_enabled,
            updated_at = excluded.updated_at,
            server_revision = nextval('server_revision_seq')
          WHERE user_deck_preferences.is_enabled IS DISTINCT FROM excluded.is_enabled
            AND excluded.updated_at >= user_deck_preferences.updated_at
          `,
          [userId, preference.deckId, preference.isEnabled, preference.updatedAt],
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
        progressCount: progressItems.length,
        acceptedProgressCount: progressCardIds.length,
        matchingRecordCount: matchingRecords.length,
        acceptedMatchingRecordCount: matchingRecordDeckIds.length,
        deckPreferenceCount: deckPreferences.length,
        acceptedDeckPreferenceCount: deckPreferenceDeckIds.length,
        rejectedReviewCount: validated.rejectedReviewIds.length,
        rejectedProgressCount: validated.rejectedProgressCardIds.length,
        rejectedMatchingRecordCount: validated.rejectedMatchingRecordDeckIds.length,
        rejectedDeckPreferenceCount: validated.rejectedDeckPreferenceDeckIds.length,
      }, "sync events accepted");

      return {
        acceptedReviewIds,
        duplicateReviewIds,
        progressCardIds,
        matchingRecordDeckIds,
        deckPreferenceDeckIds,
        rejectedReviewIds: validated.rejectedReviewIds,
        rejectedProgressCardIds: validated.rejectedProgressCardIds,
        rejectedMatchingRecordDeckIds: validated.rejectedMatchingRecordDeckIds,
        rejectedDeckPreferenceDeckIds: validated.rejectedDeckPreferenceDeckIds,
        serverRevision: await latestRevision(pool),
      };
    } catch (error) {
      await client.query("ROLLBACK");
      request.log.warn({
        err: error,
        userId,
        durationMs: Date.now() - startedAt,
        reviewCount: reviews.length,
        progressCount: progressItems.length,
        matchingRecordCount: matchingRecords.length,
        deckPreferenceCount: deckPreferences.length,
      }, "sync events rejected");
      throw error;
    } finally {
      client.release();
    }
  });
}
