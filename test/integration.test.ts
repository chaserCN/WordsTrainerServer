import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";

const testDatabaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const adminApiKey = process.env.ADMIN_API_KEY ?? "test-admin-key";
const householdSyncToken = process.env.HOUSEHOLD_SYNC_TOKEN ?? "test-household-sync-token";

type TestApp = {
  app: FastifyInstance;
  pool: pg.Pool;
  adminAuth: Record<string, string>;
  syncToken: string;
};

type PublishedDeck = {
  deckId: string;
  versionId: string;
  cardIds: string[];
  exampleIds: string[];
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const migrationsDir = path.resolve(__dirname, "../db/migrations");

function quotedIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

async function createTestApp(t: TestContext): Promise<TestApp | null> {
  if (!testDatabaseUrl) {
    t.skip("TEST_DATABASE_URL or DATABASE_URL is required for integration tests");
    return null;
  }

  process.env.DATABASE_URL = testDatabaseUrl;
  process.env.ADMIN_API_KEY = adminApiKey;
  process.env.HOUSEHOLD_SYNC_TOKEN = householdSyncToken;

  const schema = `fg_test_${randomUUID().replaceAll("-", "")}`;
  const adminPool = new pg.Pool({ connectionString: testDatabaseUrl });
  await adminPool.query(`CREATE SCHEMA ${quotedIdentifier(schema)}`);
  await adminPool.end();

  const pool = new pg.Pool({
    connectionString: testDatabaseUrl,
    options: `-c search_path=${schema},public`,
  });
  await runMigrations(pool);

  const localMediaRoot = await mkdtemp(path.join(os.tmpdir(), "flashgame-media-"));
  const app = buildApp(pool, {
    databaseUrl: testDatabaseUrl,
    adminApiKey,
    householdSyncToken,
    host: "127.0.0.1",
    port: 0,
    localMediaRoot,
    objectStorage: null,
  });

  t.after(async () => {
    await rm(localMediaRoot, { recursive: true, force: true });
    await app.close();
    await pool.end();
    const cleanupPool = new pg.Pool({ connectionString: testDatabaseUrl });
    await cleanupPool.query(`DROP SCHEMA IF EXISTS ${quotedIdentifier(schema)} CASCADE`);
    await cleanupPool.end();
  });

  return {
    app,
    pool,
    adminAuth: { authorization: `Bearer ${adminApiKey}` },
    syncToken: householdSyncToken,
  };
}

async function runMigrations(pool: pg.Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    const files = (await readdir(migrationsDir))
      .filter((file) => file.endsWith(".sql"))
      .sort();
    for (const file of files) {
      const alreadyApplied = await client.query(
        "SELECT 1 FROM schema_migrations WHERE filename = $1",
        [file],
      );
      if (alreadyApplied.rowCount) {
        continue;
      }
      await client.query(await readFile(path.join(migrationsDir, file), "utf8"));
      await client.query("INSERT INTO schema_migrations (filename) VALUES ($1)", [file]);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function injectJson(
  app: FastifyInstance,
  options: {
    method: "GET" | "POST" | "PUT" | "DELETE";
    url: string;
    headers?: Record<string, string>;
    payload?: unknown;
    expectedStatus?: number;
  },
): Promise<any> {
  const response = await app.inject({
    method: options.method,
    url: options.url,
    headers: options.headers,
    payload: options.payload,
  });
  assert.equal(
    response.statusCode,
    options.expectedStatus ?? 200,
    `${options.method} ${options.url}: ${response.statusCode} ${response.payload}`,
  );
  return response.payload ? JSON.parse(response.payload) : null;
}

async function adminJson(
  ctx: TestApp,
  method: "GET" | "POST" | "PUT" | "DELETE",
  url: string,
  payload?: unknown,
  expectedStatus?: number,
): Promise<any> {
  return injectJson(ctx.app, {
    method,
    url,
    headers: ctx.adminAuth,
    payload,
    expectedStatus,
  });
}

async function syncJson(
  ctx: TestApp,
  method: "GET" | "POST",
  url: string,
  token: string,
  payload?: unknown,
  selectedUserId?: string,
  expectedStatus?: number,
): Promise<any> {
  return injectJson(ctx.app, {
    method,
    url,
    headers: {
      authorization: `Bearer ${token}`,
      ...(selectedUserId ? { "x-flashgame-user-id": selectedUserId } : {}),
    },
    payload,
    expectedStatus,
  });
}

async function createMedia(ctx: TestApp, name: string): Promise<string> {
  const result = await adminJson(ctx, "POST", "/v1/admin/media", {
    storageKey: `media/test/${randomUUID()}-${name}.png`,
    mimeType: "image/png",
    sha256: `${name}-hash`,
    byteSize: 1200,
    width: 256,
    height: 256,
  }, 201);
  return result.media.id;
}

async function createUser(ctx: TestApp, displayName: string): Promise<{ userId: string; token: string }> {
  const user = await adminJson(ctx, "POST", "/v1/admin/users", {
    displayName,
    role: "learner",
  }, 201);
  return {
    userId: user.user.id,
    token: ctx.syncToken,
  };
}

async function createPublishedDeck(ctx: TestApp, userId: string, title = "Spanish cafe basics"): Promise<PublishedDeck> {
  const avatarMediaId = await createMedia(ctx, "deck-avatar");
  const cardImageMediaId = await createMedia(ctx, "card-image");
  const deck = await adminJson(ctx, "POST", "/v1/admin/decks", {
    title,
    languageCode: "es",
    avatarSystemName: "cup.and.saucer.fill",
    avatarMediaId,
  }, 201);
  const deckId = deck.deck.id;
  const version = await adminJson(ctx, "POST", `/v1/admin/decks/${deckId}/versions`, {
    manifest: {
      newCardsPerDay: 12,
      reviewCardsPerDay: 80,
      source: "editor-smoke-test",
    },
  }, 201);
  const versionId = version.version.id;
  const cardIds = [randomUUID(), randomUUID()];
  const exampleIds = [randomUUID(), randomUUID()];

  await adminJson(ctx, "PUT", `/v1/admin/decks/${deckId}/versions/${versionId}/cards/${cardIds[0]}`, {
    status: "active",
    lemma: "pedir",
    displayWord: "pedir",
    partOfSpeech: "verb",
    translation: "to order",
    shortDefinition: "Ask for something in a cafe or restaurant.",
    memoryHint: "Pedir sounds like putting in an order.",
    notes: "Initial draft note",
    imageMediaId: cardImageMediaId,
    sortOrder: 1,
  });
  await adminJson(ctx, "PUT", `/v1/admin/decks/${deckId}/versions/${versionId}/cards/${cardIds[0]}`, {
    status: "active",
    lemma: "pedir",
    displayWord: "pido",
    partOfSpeech: "verb",
    translation: "I order",
    shortDefinition: "First-person cafe ordering phrase.",
    memoryHint: "Pido is the form the learner will say.",
    notes: "Edited before publish",
    imageMediaId: cardImageMediaId,
    sortOrder: 1,
  });
  await adminJson(ctx, "PUT", `/v1/admin/decks/${deckId}/versions/${versionId}/cards/${cardIds[1]}`, {
    status: "active",
    lemma: "la cuenta",
    displayWord: "la cuenta",
    partOfSpeech: "noun",
    translation: "the bill",
    shortDefinition: "What you ask for before paying.",
    sortOrder: 2,
  });

  await adminJson(
    ctx,
    "PUT",
    `/v1/admin/decks/${deckId}/versions/${versionId}/cards/${cardIds[0]}/examples/${exampleIds[0]}`,
    {
      template: "Yo {{blank}} un cafe.",
      answer: "pido",
      answerFormKey: "present_yo",
      translation: "I order a coffee.",
      note: "Everyday cafe sentence",
      sortOrder: 1,
    },
  );
  await adminJson(
    ctx,
    "PUT",
    `/v1/admin/decks/${deckId}/versions/${versionId}/cards/${cardIds[1]}/examples/${exampleIds[1]}`,
    {
      template: "La {{blank}}, por favor.",
      answer: "cuenta",
      translation: "The bill, please.",
      sortOrder: 1,
    },
  );
  await adminJson(ctx, "PUT", `/v1/admin/decks/${deckId}/versions/${versionId}/cards/${cardIds[0]}/forms`, {
    forms: [
      { formKey: "infinitive", text: "pedir", sortOrder: 2 },
      { formKey: "present_yo", text: "pido", sortOrder: 1 },
    ],
  });
  await adminJson(ctx, "PUT", `/v1/admin/decks/${deckId}/versions/${versionId}/examples/${exampleIds[0]}/distractors`, {
    distractors: [
      { text: "pago", priority: 2, sourceCardId: cardIds[1] },
      { text: "quiero", priority: 1 },
    ],
  });

  const published = await adminJson(ctx, "POST", `/v1/admin/decks/${deckId}/publish`, { versionId });
  assert.equal(published.version.status, "published");
  await adminJson(ctx, "POST", `/v1/admin/decks/${deckId}/assignments`, {
    userId,
    status: "active",
  }, 201);

  return { deckId, versionId, cardIds, exampleIds };
}

function reviewEvent(deck: PublishedDeck, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    clientEventId: randomUUID(),
    deckId: deck.deckId,
    deckVersionId: deck.versionId,
    cardId: deck.cardIds[0],
    mode: "flashcards",
    outcome: "remembered",
    reviewedAt: "2026-06-01T09:30:00.000Z",
    durationMs: 1400,
    wasNew: true,
    previousState: "new",
    newState: "review",
    ...overrides,
  };
}

function progressEvent(deck: PublishedDeck, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    cardId: deck.cardIds[0],
    deckId: deck.deckId,
    fsrsData: { state: "review", reps: 1, due: "2026-06-03T09:30:00.000Z" },
    dueAt: "2026-06-03T09:30:00.000Z",
    state: "review",
    updatedAt: "2026-06-01T09:30:01.000Z",
    ...overrides,
  };
}

function matchingRecord(deck: PublishedDeck, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    deckId: deck.deckId,
    deckVersionId: deck.versionId,
    bestDurationSeconds: 18.7,
    pairCount: 4,
    achievedAt: "2026-06-01T09:32:00.000Z",
    ...overrides,
  };
}

test("mobile bootstrap and sync are usable when server has no assigned content", async (t) => {
  const ctx = await createTestApp(t);
  if (!ctx) return;

  const learner = await createUser(ctx, "Empty Server Learner");
  const bootstrap = await syncJson(ctx, "GET", "/v1/bootstrap", learner.token);
  assert.equal(bootstrap.user.id, learner.userId);
  assert.equal(bootstrap.users.length, 1);
  assert.deepEqual(bootstrap.assignments, []);
  assert.deepEqual(bootstrap.content.cards, []);
  assert.deepEqual(bootstrap.content.examples, []);
  assert.deepEqual(bootstrap.content.forms, []);
  assert.deepEqual(bootstrap.content.distractors, []);
  assert.deepEqual(bootstrap.media, []);
  assert.deepEqual(bootstrap.progress, []);
  assert.equal(bootstrap.reviewsRevision, "0");
  assert.equal(bootstrap.serverRevision, "0");

  const changes = await syncJson(ctx, "GET", "/v1/sync/changes?sinceRevision=0", learner.token, undefined, learner.userId);
  assert.deepEqual(changes.assignments, []);
  assert.deepEqual(changes.content.cards, []);
  assert.deepEqual(changes.progress, []);
  assert.deepEqual(changes.reviews, []);
  assert.deepEqual(changes.matchingRecords, []);

  const emptySync = await syncJson(ctx, "POST", "/v1/sync/events", learner.token, {}, learner.userId);
  assert.deepEqual(emptySync.acceptedReviewIds, []);
  assert.deepEqual(emptySync.duplicateReviewIds, []);
  assert.deepEqual(emptySync.progressCardIds, []);
  assert.deepEqual(emptySync.matchingRecordDeckIds, []);

  const badSelectedUser = await syncJson(
    ctx,
    "GET",
    "/v1/bootstrap",
    learner.token,
    undefined,
    "not-a-uuid",
    400,
  );
  assert.equal(badSelectedUser.error, "bad_request");

  const staleSelectedUser = await syncJson(
    ctx,
    "GET",
    "/v1/bootstrap",
    learner.token,
    undefined,
    randomUUID(),
  );
  assert.equal(staleSelectedUser.user.id, learner.userId);
  assert.equal(staleSelectedUser.users.length, 1);
});

test("admin can upload local media and mobile can download it by media id", async (t) => {
  const ctx = await createTestApp(t);
  if (!ctx) return;

  const body = Buffer.from("fake mp3 bytes");
  const uploadResponse = await ctx.app.inject({
    method: "POST",
    url: "/v1/admin/media/upload",
    headers: {
      ...ctx.adminAuth,
      "content-type": "audio/mpeg",
      "x-file-name": "word.mp3",
    },
    payload: body,
  });
  assert.equal(uploadResponse.statusCode, 201, uploadResponse.payload);
  const upload = JSON.parse(uploadResponse.payload);

  assert.equal(upload.media.mime_type, "audio/mpeg");
  assert.equal(Number(upload.media.byte_size), body.length);
  assert.match(upload.media.storage_key, /^media\/\d{4}\/\d{2}\/.+-word\.mp3$/);

  const download = await ctx.app.inject({
    method: "GET",
    url: `/v1/media/${upload.media.id}`,
  });
  assert.equal(download.statusCode, 200);
  assert.equal(download.headers["content-type"], "audio/mpeg");
  assert.deepEqual(download.rawPayload, body);
});

test("admin/editor can create, edit, publish, and assign usable deck content", async (t) => {
  const ctx = await createTestApp(t);
  if (!ctx) return;

  const learner = await createUser(ctx, "Mia Learner");
  const deck = await createPublishedDeck(ctx, learner.userId);

  const versionDetail = await adminJson(ctx, "GET", `/v1/admin/decks/${deck.deckId}/versions/${deck.versionId}`);
  assert.equal(versionDetail.cards.length, 2);
  assert.equal(versionDetail.examples.length, 2);
  assert.equal(versionDetail.forms.length, 2);
  assert.equal(versionDetail.distractors.length, 2);
  assert.equal(versionDetail.cards[0].display_word, "pido");
  assert.equal(versionDetail.forms[0].form_key, "present_yo");

  await adminJson(
    ctx,
    "PUT",
    `/v1/admin/decks/${deck.deckId}/versions/${deck.versionId}/cards/${deck.cardIds[0]}`,
    {
      lemma: "pedir",
      displayWord: "blocked edit",
      translation: "blocked",
    },
    400,
  );

  const bootstrap = await syncJson(ctx, "GET", "/v1/bootstrap", learner.token);
  assert.equal(bootstrap.user.id, learner.userId);
  assert.equal(bootstrap.users.length, 1);
  assert.equal(bootstrap.assignments.length, 1);
  assert.equal(bootstrap.assignments[0].title, "Spanish cafe basics");
  assert.equal(bootstrap.assignments[0].version_status, "published");
  assert.equal(bootstrap.content.cards.length, 2);
  assert.equal(bootstrap.content.examples.length, 2);
  assert.equal(bootstrap.content.forms.length, 2);
  assert.equal(bootstrap.content.distractors.length, 2);
  assert.equal(bootstrap.content.cards[0].deck_version_id, deck.versionId);
  assert.ok(bootstrap.media.length >= 2);
  assert.ok(bootstrap.media.every((media: any) => typeof media.byte_size === "number"));
});

test("admin can manage study groups and member roles", async (t) => {
  const ctx = await createTestApp(t);
  if (!ctx) return;

  const parent = await createUser(ctx, "Group Parent");
  const child = await createUser(ctx, "Group Child");
  const group = await adminJson(ctx, "POST", "/v1/admin/groups", {
    title: "Morning family practice",
  }, 201);
  assert.equal(group.group.title, "Morning family practice");

  const renamed = await adminJson(ctx, "PUT", `/v1/admin/groups/${group.group.id}`, {
    title: "Evening family practice",
  });
  assert.equal(renamed.group.title, "Evening family practice");

  const parentMember = await adminJson(ctx, "PUT", `/v1/admin/groups/${group.group.id}/members/${parent.userId}`, {
    role: "owner",
  });
  const childMember = await adminJson(ctx, "PUT", `/v1/admin/groups/${group.group.id}/members/${child.userId}`, {
    role: "learner",
  });
  assert.equal(parentMember.member.role, "owner");
  assert.equal(childMember.member.role, "learner");

  const changedChild = await adminJson(ctx, "PUT", `/v1/admin/groups/${group.group.id}/members/${child.userId}`, {
    role: "editor",
  });
  assert.equal(changedChild.member.role, "editor");

  await adminJson(ctx, "PUT", `/v1/admin/groups/${group.group.id}/members/${child.userId}`, {
    role: "manager",
  }, 400);
  await adminJson(ctx, "PUT", `/v1/admin/groups/${group.group.id}/members/${randomUUID()}`, {
    role: "learner",
  }, 404);

  const listed = await adminJson(ctx, "GET", "/v1/admin/groups");
  assert.equal(listed.groups.length, 1);
  assert.equal(listed.groups[0].member_count, 2);

  const detail = await adminJson(ctx, "GET", `/v1/admin/groups/${group.group.id}`);
  assert.equal(detail.members.length, 2);
  assert.deepEqual(
    detail.members.map((member: any) => ({ userId: member.user_id, role: member.role })).sort(
      (left: any, right: any) => left.userId.localeCompare(right.userId),
    ),
    [
      { userId: parent.userId, role: "owner" },
      { userId: child.userId, role: "editor" },
    ].sort((left, right) => left.userId.localeCompare(right.userId)),
  );

  const deleted = await adminJson(ctx, "DELETE", `/v1/admin/groups/${group.group.id}/members/${child.userId}`);
  assert.equal(deleted.deletedMember.user_id, child.userId);
  await adminJson(ctx, "DELETE", `/v1/admin/groups/${group.group.id}/members/${child.userId}`, undefined, 404);
});

test("admin endpoints reject invalid roles, ids, and missing parent records", async (t) => {
  const ctx = await createTestApp(t);
  if (!ctx) return;

  const invalidUserRole = await adminJson(ctx, "POST", "/v1/admin/users", {
    displayName: "Invalid Role",
    role: "coach",
  }, 400);
  assert.equal(invalidUserRole.error, "bad_request");

  await adminJson(ctx, "POST", "/v1/admin/decks", {
    title: "Broken avatar deck",
    languageCode: "en",
    avatarMediaId: "not-a-uuid",
  }, 400);
  await adminJson(ctx, "POST", `/v1/admin/decks/${randomUUID()}/versions`, {
    manifest: {},
  }, 404);

  const learner = await createUser(ctx, "Admin Validation Learner");
  const deck = await adminJson(ctx, "POST", "/v1/admin/decks", {
    title: "Admin validation deck",
    languageCode: "en",
  }, 201);
  const version = await adminJson(ctx, "POST", `/v1/admin/decks/${deck.deck.id}/versions`, {
    manifest: {},
  }, 201);

  await adminJson(ctx, "POST", `/v1/admin/decks/${deck.deck.id}/assignments`, {
    userId: learner.userId,
    status: "paused",
  }, 400);
  await adminJson(ctx, "POST", `/v1/admin/decks/${deck.deck.id}/assignments`, {
    userId: randomUUID(),
  }, 404);
  await adminJson(ctx, "POST", `/v1/admin/decks/${deck.deck.id}/assignments`, {
    userId: learner.userId,
    deckVersionId: randomUUID(),
  }, 404);

  const assignment = await adminJson(ctx, "POST", `/v1/admin/decks/${deck.deck.id}/assignments`, {
    userId: learner.userId,
    deckVersionId: version.version.id,
    status: "active",
  }, 201);
  assert.equal(assignment.assignment.user_id, learner.userId);
  assert.equal(assignment.assignment.deck_version_id, version.version.id);

  await adminJson(ctx, "GET", "/v1/admin/groups/not-a-uuid", undefined, 400);
});

test("mobile sync supports user switching, idempotent reviews, progress updates, and revision changes", async (t) => {
  const ctx = await createTestApp(t);
  if (!ctx) return;

  const child = await createUser(ctx, "Child Learner");
  const sibling = await createUser(ctx, "Sibling Learner");
  const deck = await createPublishedDeck(ctx, child.userId, "Child daily words");
  await createPublishedDeck(ctx, sibling.userId, "Sibling daily words");

  const childBootstrap = await syncJson(ctx, "GET", "/v1/bootstrap", child.token, undefined, child.userId);
  const baselineRevision = childBootstrap.serverRevision;
  assert.equal(childBootstrap.user.id, child.userId);
  assert.deepEqual(
    childBootstrap.users.map((user: any) => user.id).sort(),
    [child.userId, sibling.userId].sort(),
  );
  assert.equal(childBootstrap.assignments.length, 1);
  assert.equal(childBootstrap.content.cards.length, 2);

  await injectJson(ctx.app, {
    method: "GET",
    url: "/v1/bootstrap",
    headers: {
      authorization: "Bearer wrong-household-token",
      "x-flashgame-user-id": child.userId,
    },
    expectedStatus: 401,
  });

  const clientEventId = randomUUID();
  const reviewedAt = "2026-06-01T09:30:00.000Z";
  const dueAt = "2026-06-03T09:30:00.000Z";
  const eventsPayload = {
    reviews: [
      {
        clientEventId,
        deckId: deck.deckId,
        deckVersionId: deck.versionId,
        cardId: deck.cardIds[0],
        mode: "flashcards",
        outcome: "remembered",
        reviewedAt,
        durationMs: 1400,
        wasNew: true,
        previousState: "new",
        newState: "review",
      },
    ],
    progress: [
      {
        cardId: deck.cardIds[0],
        deckId: deck.deckId,
        fsrsData: { state: "review", reps: 1, due: dueAt },
        dueAt,
        state: "review",
        updatedAt: "2026-06-01T09:30:01.000Z",
      },
    ],
    matchingRecords: [
      {
        deckId: deck.deckId,
        deckVersionId: deck.versionId,
        bestDurationSeconds: 18.7,
        pairCount: 4,
        achievedAt: "2026-06-01T09:32:00.000Z",
      },
    ],
  };

  const firstSync = await syncJson(
    ctx,
    "POST",
    "/v1/sync/events",
    child.token,
    eventsPayload,
    child.userId,
  );
  assert.deepEqual(firstSync.acceptedReviewIds, [clientEventId]);
  assert.deepEqual(firstSync.duplicateReviewIds, []);
  assert.deepEqual(firstSync.progressCardIds, [deck.cardIds[0]]);
  assert.deepEqual(firstSync.matchingRecordDeckIds, [deck.deckId]);

  const duplicateSync = await syncJson(
    ctx,
    "POST",
    "/v1/sync/events",
    child.token,
    eventsPayload,
    child.userId,
  );
  assert.deepEqual(duplicateSync.acceptedReviewIds, []);
  assert.deepEqual(duplicateSync.duplicateReviewIds, [clientEventId]);
  assert.deepEqual(duplicateSync.progressCardIds, []);
  assert.deepEqual(duplicateSync.matchingRecordDeckIds, []);

  const persistedStats = await ctx.pool.query(
    `
    SELECT
      (SELECT COUNT(*) FROM study_reviews WHERE user_id = $1) AS review_count,
      (SELECT COUNT(*) FROM card_progress WHERE user_id = $1) AS progress_count,
      (SELECT COUNT(*) FROM deck_matching_records WHERE user_id = $1) AS matching_count
    `,
    [child.userId],
  );
  assert.equal(Number(persistedStats.rows[0].review_count), 1);
  assert.equal(Number(persistedStats.rows[0].progress_count), 1);
  assert.equal(Number(persistedStats.rows[0].matching_count), 1);

  const bootstrapAfterSync = await syncJson(ctx, "GET", "/v1/bootstrap", child.token, undefined, child.userId);
  assert.equal(bootstrapAfterSync.progress.length, 1);
  assert.equal(bootstrapAfterSync.progress[0].card_id, deck.cardIds[0]);
  assert.equal(bootstrapAfterSync.reviews.length, 1);
  assert.equal(bootstrapAfterSync.reviews[0].client_event_id, clientEventId);
  assert.equal(bootstrapAfterSync.matchingRecords.length, 1);
  assert.equal(bootstrapAfterSync.matchingRecords[0].deck_id, deck.deckId);

  const changes = await syncJson(
    ctx,
    "GET",
    `/v1/sync/changes?sinceRevision=${baselineRevision}`,
    child.token,
    undefined,
    child.userId,
  );
  assert.equal(changes.reviews.length, 1);
  assert.equal(changes.reviews[0].client_event_id, clientEventId);
  assert.equal(changes.progress.length, 1);
  assert.equal(changes.progress[0].card_id, deck.cardIds[0]);
  assert.equal(changes.matchingRecords.length, 1);
  assert.equal(changes.matchingRecords[0].deck_id, deck.deckId);

  const updatedProgress = await syncJson(
    ctx,
    "POST",
    "/v1/sync/events",
    child.token,
    {
      reviews: [],
      progress: [
        {
          cardId: deck.cardIds[0],
          deckId: deck.deckId,
          fsrsData: { state: "review", reps: 2, due: "2026-06-07T09:30:00.000Z" },
          dueAt: "2026-06-07T09:30:00.000Z",
          state: "review",
          updatedAt: "2026-06-02T09:30:01.000Z",
        },
      ],
    },
    child.userId,
  );
  assert.deepEqual(updatedProgress.progressCardIds, [deck.cardIds[0]]);
  assert.ok(BigInt(updatedProgress.serverRevision) > BigInt(firstSync.serverRevision));

  const worseMatchingRecord = await syncJson(
    ctx,
    "POST",
    "/v1/sync/events",
    child.token,
    {
      reviews: [],
      progress: [],
      matchingRecords: [
        {
          deckId: deck.deckId,
          deckVersionId: deck.versionId,
          bestDurationSeconds: 25.2,
          pairCount: 4,
          achievedAt: "2026-06-02T09:34:00.000Z",
        },
      ],
    },
    child.userId,
  );
  assert.deepEqual(worseMatchingRecord.matchingRecordDeckIds, []);

  const betterMatchingRecord = await syncJson(
    ctx,
    "POST",
    "/v1/sync/events",
    child.token,
    {
      reviews: [],
      progress: [],
      matchingRecords: [
        {
          deckId: deck.deckId,
          deckVersionId: deck.versionId,
          bestDurationSeconds: 14.1,
          pairCount: 4,
          achievedAt: "2026-06-02T09:35:00.000Z",
        },
      ],
    },
    child.userId,
  );
  assert.deepEqual(betterMatchingRecord.matchingRecordDeckIds, [deck.deckId]);
});

test("sync validation rejects malformed payloads without partial writes", async (t) => {
  const ctx = await createTestApp(t);
  if (!ctx) return;

  const learner = await createUser(ctx, "Malformed Sync Learner");
  const deck = await createPublishedDeck(ctx, learner.userId, "Malformed payload deck");

  const badRequests = [
    { payload: undefined, message: "missing JSON body" },
    { payload: { reviews: "nope" }, message: "reviews is not an array" },
    { payload: { reviews: [reviewEvent(deck, { clientEventId: "not-a-uuid" })] }, message: "bad review uuid" },
    { payload: { reviews: [reviewEvent(deck, { mode: "quiz" })] }, message: "bad review mode" },
    { payload: { reviews: [reviewEvent(deck, { outcome: "maybe" })] }, message: "bad review outcome" },
    { payload: { reviews: [reviewEvent(deck, { reviewedAt: "not-a-date" })] }, message: "bad review date" },
    { payload: { reviews: [reviewEvent(deck, { durationMs: 1.5 })] }, message: "bad review duration" },
    { payload: { reviews: [reviewEvent(deck, { wasNew: "yes" })] }, message: "bad review boolean" },
    { payload: { progress: "nope" }, message: "progress is not an array" },
    { payload: { progress: [progressEvent(deck, { fsrsData: "review" })] }, message: "bad fsrs data" },
    { payload: { progress: [progressEvent(deck, { dueAt: "tomorrow-ish" })] }, message: "bad due date" },
    { payload: { matchingRecords: "nope" }, message: "matching records is not an array" },
    {
      payload: { matchingRecords: [matchingRecord(deck, { bestDurationSeconds: -1 })] },
      message: "bad matching duration",
    },
    { payload: { matchingRecords: [matchingRecord(deck, { pairCount: 2.5 })] }, message: "bad pair count" },
    {
      payload: { matchingRecords: [matchingRecord(deck, { achievedAt: "later" })] },
      message: "bad achieved date",
    },
  ];

  for (const badRequestCase of badRequests) {
    await injectJson(ctx.app, {
      method: "POST",
      url: "/v1/sync/events",
      headers: {
        authorization: `Bearer ${learner.token}`,
        "x-flashgame-user-id": learner.userId,
      },
      payload: badRequestCase.payload,
      expectedStatus: 400,
    });
  }

  await syncJson(ctx, "GET", "/v1/sync/changes?sinceRevision=abc", learner.token, undefined, learner.userId, 400);
  await syncJson(ctx, "GET", "/v1/sync/changes?sinceRevision=-1", learner.token, undefined, learner.userId, 400);

  const persistedStats = await ctx.pool.query(
    `
    SELECT
      (SELECT COUNT(*) FROM study_reviews) AS review_count,
      (SELECT COUNT(*) FROM card_progress) AS progress_count,
      (SELECT COUNT(*) FROM deck_matching_records) AS matching_count
    `,
  );
  assert.equal(Number(persistedStats.rows[0].review_count), 0);
  assert.equal(Number(persistedStats.rows[0].progress_count), 0);
  assert.equal(Number(persistedStats.rows[0].matching_count), 0);
});

test("sync data is isolated for different users sharing the same deck", async (t) => {
  const ctx = await createTestApp(t);
  if (!ctx) return;

  const alice = await createUser(ctx, "Alice Daily");
  const bob = await createUser(ctx, "Bob Daily");
  const sharedDeck = await createPublishedDeck(ctx, alice.userId, "Shared travel deck");
  await adminJson(ctx, "POST", `/v1/admin/decks/${sharedDeck.deckId}/assignments`, {
    userId: bob.userId,
    status: "active",
  }, 201);

  await injectJson(ctx.app, {
    method: "GET",
    url: "/v1/bootstrap",
    headers: {
      authorization: "Bearer wrong-household-token",
      "x-flashgame-user-id": bob.userId,
    },
    expectedStatus: 401,
  });

  const aliceBaseline = await syncJson(ctx, "GET", "/v1/bootstrap", alice.token, undefined, alice.userId);
  const bobBaseline = await syncJson(ctx, "GET", "/v1/bootstrap", bob.token, undefined, bob.userId);
  assert.equal(aliceBaseline.content.cards.length, 2);
  assert.equal(bobBaseline.content.cards.length, 2);

  const sameClientEventId = randomUUID();
  const aliceSync = await syncJson(ctx, "POST", "/v1/sync/events", alice.token, {
    reviews: [
      {
        clientEventId: sameClientEventId,
        deckId: sharedDeck.deckId,
        deckVersionId: sharedDeck.versionId,
        cardId: sharedDeck.cardIds[0],
        mode: "recall",
        outcome: "forgot",
        reviewedAt: "2026-06-01T10:00:00.000Z",
        durationMs: 2200,
        wasNew: true,
        previousState: "new",
        newState: "learning",
      },
    ],
    progress: [
      {
        cardId: sharedDeck.cardIds[0],
        deckId: sharedDeck.deckId,
        fsrsData: { state: "learning", reps: 1, due: "2026-06-01T10:10:00.000Z" },
        dueAt: "2026-06-01T10:10:00.000Z",
        state: "learning",
        updatedAt: "2026-06-01T10:00:03.000Z",
      },
    ],
    matchingRecords: [
      {
        deckId: sharedDeck.deckId,
        deckVersionId: sharedDeck.versionId,
        bestDurationSeconds: 31.4,
        pairCount: 4,
        achievedAt: "2026-06-01T10:04:00.000Z",
      },
    ],
  }, alice.userId);
  const bobSync = await syncJson(ctx, "POST", "/v1/sync/events", bob.token, {
    reviews: [
      {
        clientEventId: sameClientEventId,
        deckId: sharedDeck.deckId,
        deckVersionId: sharedDeck.versionId,
        cardId: sharedDeck.cardIds[1],
        mode: "cloze_multiple_choice",
        outcome: "correct",
        reviewedAt: "2026-06-01T11:00:00.000Z",
        durationMs: 1600,
        wasNew: true,
        previousState: "new",
        newState: "review",
      },
    ],
    progress: [
      {
        cardId: sharedDeck.cardIds[1],
        deckId: sharedDeck.deckId,
        fsrsData: { state: "review", reps: 1, due: "2026-06-04T11:00:00.000Z" },
        dueAt: "2026-06-04T11:00:00.000Z",
        state: "review",
        updatedAt: "2026-06-01T11:00:02.000Z",
      },
    ],
    matchingRecords: [
      {
        deckId: sharedDeck.deckId,
        deckVersionId: sharedDeck.versionId,
        bestDurationSeconds: 19.8,
        pairCount: 4,
        achievedAt: "2026-06-01T11:05:00.000Z",
      },
    ],
  }, bob.userId);
  assert.deepEqual(aliceSync.acceptedReviewIds, [sameClientEventId]);
  assert.deepEqual(bobSync.acceptedReviewIds, [sameClientEventId]);

  const counts = await ctx.pool.query(
    `
    SELECT user_id, COUNT(*)::int AS review_count
    FROM study_reviews
    GROUP BY user_id
    ORDER BY user_id
    `,
  );
  assert.deepEqual(
    counts.rows.map((row) => ({ userId: row.user_id, count: row.review_count })),
    [
      { userId: alice.userId, count: 1 },
      { userId: bob.userId, count: 1 },
    ].sort((left, right) => left.userId.localeCompare(right.userId)),
  );

  const aliceChanges = await syncJson(
    ctx,
    "GET",
    `/v1/sync/changes?sinceRevision=${aliceBaseline.serverRevision}`,
    alice.token,
    undefined,
    alice.userId,
  );
  const bobChanges = await syncJson(
    ctx,
    "GET",
    `/v1/sync/changes?sinceRevision=${bobBaseline.serverRevision}`,
    bob.token,
    undefined,
    bob.userId,
  );
  assert.deepEqual(aliceChanges.reviews.map((review: any) => review.card_id), [sharedDeck.cardIds[0]]);
  assert.deepEqual(bobChanges.reviews.map((review: any) => review.card_id), [sharedDeck.cardIds[1]]);
  assert.deepEqual(aliceChanges.progress.map((progress: any) => progress.card_id), [sharedDeck.cardIds[0]]);
  assert.deepEqual(bobChanges.progress.map((progress: any) => progress.card_id), [sharedDeck.cardIds[1]]);
  assert.equal(aliceChanges.matchingRecords[0].best_duration_seconds, 31.4);
  assert.equal(bobChanges.matchingRecords[0].best_duration_seconds, 19.8);

  const aliceAfterSync = await syncJson(ctx, "GET", "/v1/bootstrap", alice.token, undefined, alice.userId);
  const bobAfterSync = await syncJson(ctx, "GET", "/v1/bootstrap", bob.token, undefined, bob.userId);
  assert.deepEqual(aliceAfterSync.progress.map((progress: any) => progress.card_id), [sharedDeck.cardIds[0]]);
  assert.deepEqual(bobAfterSync.progress.map((progress: any) => progress.card_id), [sharedDeck.cardIds[1]]);

  await adminJson(ctx, "POST", `/v1/admin/decks/${sharedDeck.deckId}/assignments`, {
    userId: bob.userId,
    status: "inactive",
  }, 201);
  const inactiveBob = await syncJson(ctx, "GET", "/v1/bootstrap", bob.token, undefined, bob.userId);
  const activeAlice = await syncJson(ctx, "GET", "/v1/bootstrap", alice.token, undefined, alice.userId);
  assert.equal(inactiveBob.assignments[0].assignment_status, "inactive");
  assert.equal(inactiveBob.content.cards.length, 0);
  assert.equal(activeAlice.content.cards.length, 2);

  await injectJson(ctx.app, {
    method: "POST",
    url: "/v1/sync/events",
    headers: {
      authorization: `Bearer ${bob.token}`,
      "x-flashgame-user-id": bob.userId,
    },
    payload: {
      reviews: [
        {
          clientEventId: randomUUID(),
          deckId: sharedDeck.deckId,
          deckVersionId: sharedDeck.versionId,
          cardId: sharedDeck.cardIds[0],
          mode: "flashcards",
          outcome: "remembered",
          reviewedAt: "2026-06-02T08:00:00.000Z",
          durationMs: 1000,
          wasNew: false,
          previousState: "review",
          newState: "review",
        },
      ],
      progress: [
        {
          cardId: sharedDeck.cardIds[0],
          deckId: sharedDeck.deckId,
          fsrsData: { state: "review", reps: 2 },
          dueAt: "2026-06-06T08:00:00.000Z",
          state: "review",
          updatedAt: "2026-06-02T08:00:00.000Z",
        },
      ],
      matchingRecords: [
        {
          deckId: sharedDeck.deckId,
          deckVersionId: sharedDeck.versionId,
          bestDurationSeconds: 12.4,
          pairCount: 4,
          achievedAt: "2026-06-02T08:02:00.000Z",
        },
      ],
    },
    expectedStatus: 400,
  });
});

test("sync rejects reviews, progress, and matching records for unassigned targets", async (t) => {
  const ctx = await createTestApp(t);
  if (!ctx) return;

  const assignedLearner = await createUser(ctx, "Assigned Learner");
  const unassignedLearner = await createUser(ctx, "Unassigned Learner");
  const deck = await createPublishedDeck(ctx, assignedLearner.userId, "Target validation deck");

  const unassignedBootstrap = await syncJson(
    ctx,
    "GET",
    "/v1/bootstrap",
    unassignedLearner.token,
    undefined,
    unassignedLearner.userId,
  );
  assert.deepEqual(unassignedBootstrap.assignments, []);
  assert.deepEqual(unassignedBootstrap.content.cards, []);

  await syncJson(ctx, "POST", "/v1/sync/events", unassignedLearner.token, {
    reviews: [reviewEvent(deck)],
  }, unassignedLearner.userId, 400);
  await syncJson(ctx, "POST", "/v1/sync/events", unassignedLearner.token, {
    progress: [progressEvent(deck)],
  }, unassignedLearner.userId, 400);
  await syncJson(ctx, "POST", "/v1/sync/events", unassignedLearner.token, {
    matchingRecords: [matchingRecord(deck)],
  }, unassignedLearner.userId, 400);

  await syncJson(ctx, "POST", "/v1/sync/events", assignedLearner.token, {
    reviews: [reviewEvent(deck, { cardId: randomUUID() })],
  }, assignedLearner.userId, 400);
  await syncJson(ctx, "POST", "/v1/sync/events", assignedLearner.token, {
    reviews: [reviewEvent(deck, { deckVersionId: randomUUID() })],
  }, assignedLearner.userId, 400);
  await syncJson(ctx, "POST", "/v1/sync/events", assignedLearner.token, {
    matchingRecords: [matchingRecord(deck, { deckVersionId: randomUUID() })],
  }, assignedLearner.userId, 400);

  const persistedStats = await ctx.pool.query(
    `
    SELECT
      (SELECT COUNT(*) FROM study_reviews) AS review_count,
      (SELECT COUNT(*) FROM card_progress) AS progress_count,
      (SELECT COUNT(*) FROM deck_matching_records) AS matching_count
    `,
  );
  assert.equal(Number(persistedStats.rows[0].review_count), 0);
  assert.equal(Number(persistedStats.rows[0].progress_count), 0);
  assert.equal(Number(persistedStats.rows[0].matching_count), 0);
});

test("sync accepts iOS study mode names and stores canonical review modes", async (t) => {
  const ctx = await createTestApp(t);
  if (!ctx) return;

  const learner = await createUser(ctx, "Mode Compatibility Learner");
  const deck = await createPublishedDeck(ctx, learner.userId, "Mode compatibility deck");
  const firstEventId = randomUUID();
  const secondEventId = randomUUID();

  const result = await syncJson(ctx, "POST", "/v1/sync/events", learner.token, {
    reviews: [
      reviewEvent(deck, {
        clientEventId: firstEventId,
        mode: "clozeMultipleChoice",
        outcome: "correct",
      }),
      reviewEvent(deck, {
        clientEventId: secondEventId,
        cardId: deck.cardIds[1],
        mode: "clozeTyping",
        outcome: "incorrect",
      }),
    ],
  }, learner.userId);
  assert.deepEqual(result.acceptedReviewIds.sort(), [firstEventId, secondEventId].sort());

  const stored = await ctx.pool.query(
    `
    SELECT client_event_id, mode, outcome
    FROM study_reviews
    WHERE user_id = $1
    ORDER BY client_event_id
    `,
    [learner.userId],
  );
  assert.deepEqual(
    stored.rows.map((row) => ({ id: row.client_event_id, mode: row.mode, outcome: row.outcome })).sort(
      (left, right) => left.id.localeCompare(right.id),
    ),
    [
      { id: firstEventId, mode: "cloze_multiple_choice", outcome: "correct" },
      { id: secondEventId, mode: "cloze_typing", outcome: "incorrect" },
    ].sort((left, right) => left.id.localeCompare(right.id)),
  );
});

test("deck assignments can pin a user to an old published version and later follow current", async (t) => {
  const ctx = await createTestApp(t);
  if (!ctx) return;

  const learner = await createUser(ctx, "Pinned Version Learner");
  const deck = await createPublishedDeck(ctx, learner.userId, "Pinned version deck");
  await adminJson(ctx, "POST", `/v1/admin/decks/${deck.deckId}/assignments`, {
    userId: learner.userId,
    deckVersionId: deck.versionId,
    status: "active",
  }, 201);

  const secondVersion = await adminJson(ctx, "POST", `/v1/admin/decks/${deck.deckId}/versions`, {
    manifest: { newCardsPerDay: 20, reviewCardsPerDay: 90, reason: "new lesson added" },
  }, 201);
  await adminJson(
    ctx,
    "PUT",
    `/v1/admin/decks/${deck.deckId}/versions/${secondVersion.version.id}/cards/${deck.cardIds[0]}`,
    {
      status: "active",
      lemma: "pedir",
      displayWord: "pido v2",
      translation: "I order, refreshed",
      sortOrder: 1,
    },
  );
  await adminJson(ctx, "POST", `/v1/admin/decks/${deck.deckId}/publish`, {
    versionId: secondVersion.version.id,
  });

  const pinnedBootstrap = await syncJson(ctx, "GET", "/v1/bootstrap", learner.token);
  assert.equal(pinnedBootstrap.assignments[0].deck_version_id, deck.versionId);
  assert.equal(pinnedBootstrap.assignments[0].current_version_id, secondVersion.version.id);
  assert.equal(pinnedBootstrap.content.cards.length, 2);
  assert.equal(pinnedBootstrap.content.cards[0].deck_version_id, deck.versionId);
  assert.equal(pinnedBootstrap.content.cards[0].display_word, "pido");

  await adminJson(ctx, "POST", `/v1/admin/decks/${deck.deckId}/assignments`, {
    userId: learner.userId,
    status: "active",
  }, 201);
  const currentBootstrap = await syncJson(ctx, "GET", "/v1/bootstrap", learner.token);
  assert.equal(currentBootstrap.assignments[0].deck_version_id, null);
  assert.equal(currentBootstrap.assignments[0].version_number, 2);
  assert.equal(currentBootstrap.content.cards.length, 1);
  assert.equal(currentBootstrap.content.cards[0].deck_version_id, secondVersion.version.id);
  assert.equal(currentBootstrap.content.cards[0].display_word, "pido v2");
});

test("client-facing edge cases stay explicit and recoverable", async (t) => {
  const ctx = await createTestApp(t);
  if (!ctx) return;

  await injectJson(ctx.app, {
    method: "GET",
    url: "/v1/admin/users",
    headers: { authorization: "Bearer wrong-token" },
    expectedStatus: 401,
  });

  const emptyUsers = await adminJson(ctx, "GET", "/v1/admin/users");
  assert.deepEqual(emptyUsers.users, []);

  await injectJson(ctx.app, {
    method: "GET",
    url: "/v1/bootstrap",
    headers: { authorization: "Bearer wrong-household-token" },
    expectedStatus: 401,
  });

  const learner = await createUser(ctx, "Validation Learner");
  const deck = await adminJson(ctx, "POST", "/v1/admin/decks", {
    title: "Validation deck",
    languageCode: "en",
  }, 201);
  const version = await adminJson(ctx, "POST", `/v1/admin/decks/${deck.deck.id}/versions`, {
    manifest: { newCardsPerDay: 5, reviewCardsPerDay: 40 },
  }, 201);
  const cardId = randomUUID();
  const exampleId = randomUUID();

  await adminJson(ctx, "PUT", `/v1/admin/decks/${deck.deck.id}/versions/${version.version.id}/cards/${cardId}`, {
    lemma: "reliable",
    displayWord: "reliable",
    translation: "надежный",
  });

  await adminJson(
    ctx,
    "PUT",
    `/v1/admin/decks/${deck.deck.id}/versions/${version.version.id}/cards/${cardId}/examples/${exampleId}`,
    {
      template: "This sentence has no blank.",
      answer: "reliable",
    },
    400,
  );

  await adminJson(
    ctx,
    "PUT",
    `/v1/admin/decks/${deck.deck.id}/versions/${version.version.id}/cards/${randomUUID()}/forms`,
    {
      forms: [{ formKey: "base", text: "missing" }],
    },
    404,
  );

  await adminJson(ctx, "POST", "/v1/admin/media/upload-url", {
    fileName: "avatar.png",
    mimeType: "image/png",
  }, 503);
  const pendingMedia = await ctx.pool.query("SELECT COUNT(*) FROM media_objects WHERE upload_status = 'pending'");
  assert.equal(Number(pendingMedia.rows[0].count), 0);

  const firstPublish = await adminJson(ctx, "POST", `/v1/admin/decks/${deck.deck.id}/publish`, {
    versionId: version.version.id,
  });
  await adminJson(ctx, "POST", `/v1/admin/decks/${deck.deck.id}/assignments`, {
    userId: learner.userId,
  }, 201);
  const firstBootstrap = await syncJson(ctx, "GET", "/v1/bootstrap", learner.token);
  assert.equal(firstBootstrap.content.cards.length, 1);
  assert.equal(firstBootstrap.content.cards[0].display_word, "reliable");

  const secondVersion = await adminJson(ctx, "POST", `/v1/admin/decks/${deck.deck.id}/versions`, {
    manifest: { newCardsPerDay: 8, reviewCardsPerDay: 60, reason: "weekly refresh" },
  }, 201);
  await adminJson(
    ctx,
    "PUT",
    `/v1/admin/decks/${deck.deck.id}/versions/${secondVersion.version.id}/cards/${cardId}`,
    {
      lemma: "reliable",
      displayWord: "dependable",
      translation: "надежный",
      sortOrder: 1,
    },
  );
  await adminJson(
    ctx,
    "PUT",
    `/v1/admin/decks/${deck.deck.id}/versions/${secondVersion.version.id}/cards/${cardId}/examples/${randomUUID()}`,
    {
      template: "The app feels {{blank}}.",
      answer: "dependable",
      translation: "Приложение ощущается надежным.",
    },
  );
  await adminJson(ctx, "POST", `/v1/admin/decks/${deck.deck.id}/publish`, {
    versionId: secondVersion.version.id,
  });

  const changedContent = await syncJson(
    ctx,
    "GET",
    `/v1/sync/changes?sinceRevision=${firstPublish.version.server_revision}`,
    learner.token,
    undefined,
    learner.userId,
  );
  assert.equal(changedContent.assignments.length, 1);
  assert.equal(changedContent.assignments[0].version_number, 2);
  assert.equal(changedContent.content.cards.length, 1);
  assert.equal(changedContent.content.cards[0].display_word, "dependable");
});
