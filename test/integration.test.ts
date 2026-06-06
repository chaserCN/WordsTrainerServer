import "dotenv/config";
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
import { loadConfig, type AppConfig } from "../src/config.js";
import { bodyLimits, endpointRateLimits } from "../src/limits.js";

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
const configEnvKeys = [
  "DATABASE_URL",
  "HOST",
  "PORT",
  "ADMIN_API_KEY",
  "HOUSEHOLD_SYNC_TOKEN",
  "LOCAL_MEDIA_ROOT",
  "OBJECT_STORAGE_BUCKET",
  "OBJECT_STORAGE_REGION",
  "OBJECT_STORAGE_ENDPOINT",
  "OBJECT_STORAGE_ACCESS_KEY_ID",
  "OBJECT_STORAGE_SECRET_ACCESS_KEY",
  "OBJECT_STORAGE_PUBLIC_BASE_URL",
  "OBJECT_STORAGE_FORCE_PATH_STYLE",
  "UPLOAD_URL_EXPIRES_SECONDS",
] as const;

function withConfigEnv<T>(values: Partial<Record<(typeof configEnvKeys)[number], string>>, action: () => T): T {
  const previous = new Map(configEnvKeys.map((key) => [key, process.env[key]]));
  for (const key of configEnvKeys) {
    delete process.env[key];
  }
  for (const [key, value] of Object.entries(values)) {
    if (value != null) {
      process.env[key] = value;
    }
  }
  try {
    return action();
  } finally {
    for (const key of configEnvKeys) {
      const value = previous.get(key);
      if (value == null) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

function quotedIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

async function createTestApp(
  t: TestContext,
  options: { objectStorage?: AppConfig["objectStorage"] } = {},
): Promise<TestApp | null> {
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
    objectStorage: options.objectStorage ?? null,
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

test("loadConfig validates production-critical environment", () => {
  const config = withConfigEnv({
    DATABASE_URL: "postgres://user:pass@localhost:5432/flashgame",
    ADMIN_API_KEY: "admin-key-with-length",
    HOUSEHOLD_SYNC_TOKEN: "household-token-with-length",
    PORT: "4321",
    OBJECT_STORAGE_BUCKET: "flashgame-media",
    OBJECT_STORAGE_REGION: "auto",
    OBJECT_STORAGE_ENDPOINT: "https://object-storage.example.test",
    OBJECT_STORAGE_ACCESS_KEY_ID: "access-key",
    OBJECT_STORAGE_SECRET_ACCESS_KEY: "secret-key",
    OBJECT_STORAGE_PUBLIC_BASE_URL: "https://cdn.example.test/assets",
    UPLOAD_URL_EXPIRES_SECONDS: "120",
  }, () => loadConfig());

  assert.equal(config.databaseUrl, "postgres://user:pass@localhost:5432/flashgame");
  assert.equal(config.port, 4321);
  assert.equal(config.objectStorage?.endpoint, "https://object-storage.example.test");
  assert.equal(config.objectStorage?.publicBaseUrl, "https://cdn.example.test/assets");
  assert.equal(config.objectStorage?.uploadUrlExpiresSeconds, 120);

  assert.throws(
    () => withConfigEnv({
      DATABASE_URL: "not-a-postgres-url",
      ADMIN_API_KEY: "admin-key-with-length",
      HOUSEHOLD_SYNC_TOKEN: "household-token-with-length",
    }, () => loadConfig()),
    /DATABASE_URL must be a valid URL/,
  );
  assert.throws(
    () => withConfigEnv({
      DATABASE_URL: "postgres://user:pass@localhost:5432/flashgame",
      ADMIN_API_KEY: "short",
      HOUSEHOLD_SYNC_TOKEN: "household-token-with-length",
    }, () => loadConfig()),
    /ADMIN_API_KEY must be at least 12 characters long/,
  );
  assert.throws(
    () => withConfigEnv({
      DATABASE_URL: "postgres://user:pass@localhost:5432/flashgame",
      ADMIN_API_KEY: "admin-key-with-length",
      HOUSEHOLD_SYNC_TOKEN: "household-token-with-length",
      OBJECT_STORAGE_BUCKET: "flashgame-media",
      OBJECT_STORAGE_ACCESS_KEY_ID: "access-key",
      OBJECT_STORAGE_SECRET_ACCESS_KEY: "secret-key",
      UPLOAD_URL_EXPIRES_SECONDS: "999999999",
    }, () => loadConfig()),
    /UPLOAD_URL_EXPIRES_SECONDS must be an integer >= 1 and <= 604800/,
  );
});

test("health endpoints report database readiness", async (t) => {
  const ctx = await createTestApp(t);
  if (!ctx) return;

  assert.deepEqual(await injectJson(ctx.app, { method: "GET", url: "/health" }), {
    ok: true,
    database: "ok",
  });
  assert.deepEqual(await injectJson(ctx.app, { method: "GET", url: "/v1/health" }), {
    ok: true,
    database: "ok",
  });
});

test("auth uses build-time config instead of rereading mutable env", async (t) => {
  const ctx = await createTestApp(t);
  if (!ctx) return;

  const previousAdminKey = process.env.ADMIN_API_KEY;
  const previousSyncToken = process.env.HOUSEHOLD_SYNC_TOKEN;
  try {
    process.env.ADMIN_API_KEY = "changed-admin-key";
    process.env.HOUSEHOLD_SYNC_TOKEN = "changed-household-sync-token";

    await injectJson(ctx.app, {
      method: "GET",
      url: "/v1/admin/users",
      headers: ctx.adminAuth,
    });
    await injectJson(ctx.app, {
      method: "GET",
      url: "/v1/admin/users",
      headers: { authorization: `Bearer ${process.env.ADMIN_API_KEY}` },
      expectedStatus: 401,
    });
    await injectJson(ctx.app, {
      method: "GET",
      url: "/v1/bootstrap",
      headers: { authorization: `Bearer ${ctx.syncToken}` },
    });
    await injectJson(ctx.app, {
      method: "GET",
      url: "/v1/bootstrap",
      headers: { authorization: `Bearer ${process.env.HOUSEHOLD_SYNC_TOKEN}` },
      expectedStatus: 401,
    });
  } finally {
    if (previousAdminKey == null) {
      delete process.env.ADMIN_API_KEY;
    } else {
      process.env.ADMIN_API_KEY = previousAdminKey;
    }
    if (previousSyncToken == null) {
      delete process.env.HOUSEHOLD_SYNC_TOKEN;
    } else {
      process.env.HOUSEHOLD_SYNC_TOKEN = previousSyncToken;
    }
  }
});

test("endpoint body limits protect sync JSON while allowing bounded media uploads", async (t) => {
  const ctx = await createTestApp(t);
  if (!ctx) return;

  const oversizedSyncPayload = JSON.stringify({
    reviews: [],
    padding: "x".repeat(bodyLimits.syncEvents),
  });
  const syncResponse = await ctx.app.inject({
    method: "POST",
    url: "/v1/sync/events",
    headers: {
      authorization: `Bearer ${ctx.syncToken}`,
      "content-type": "application/json",
    },
    payload: oversizedSyncPayload,
  });
  assert.equal(syncResponse.statusCode, 413, syncResponse.payload);
  assert.equal(JSON.parse(syncResponse.payload).error, "payload_too_large");

  const mediaBytes = Buffer.alloc(bodyLimits.defaultJson + 1, 7);
  const mediaResponse = await ctx.app.inject({
    method: "POST",
    url: "/v1/admin/media/upload",
    headers: {
      ...ctx.adminAuth,
      "content-type": "application/octet-stream",
      "x-file-name": "body-limit.bin",
    },
    payload: mediaBytes,
  });
  assert.equal(mediaResponse.statusCode, 201, mediaResponse.payload);
  const media = JSON.parse(mediaResponse.payload);
  assert.equal(Number(media.media.byte_size), mediaBytes.length);
});

test("sync events are rate limited per selected user", async (t) => {
  const ctx = await createTestApp(t);
  if (!ctx) return;

  const learner = await createUser(ctx, "Rate Limited Learner");
  for (let index = 0; index < endpointRateLimits.syncEvents.max; index += 1) {
    await syncJson(ctx, "POST", "/v1/sync/events", learner.token, {}, learner.userId);
  }

  const limited = await ctx.app.inject({
    method: "POST",
    url: "/v1/sync/events",
    headers: {
      authorization: `Bearer ${learner.token}`,
      "x-flashgame-user-id": learner.userId,
    },
    payload: {},
  });
  assert.equal(limited.statusCode, 429, limited.payload);
  assert.equal(JSON.parse(limited.payload).error, "rate_limited");
});

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

function flattenSyncResponse(url: string, payload: any): any {
  if (!payload || typeof payload !== "object") {
    return payload;
  }
  if (url.startsWith("/v1/bootstrap") && payload.mode === "snapshot") {
    return {
      user: payload.user,
      users: payload.users,
      ...payload.snapshot,
      serverRevision: payload.revision,
    };
  }
  if (url.startsWith("/v1/sync/changes") && payload.mode === "delta") {
    return {
      ...payload.changes,
      serverRevision: payload.toRevision,
    };
  }
  if (url.startsWith("/v1/sync/events") && payload.mode === "events") {
    return {
      acceptedReviewIds: payload.accepted?.reviewIds ?? [],
      duplicateReviewIds: payload.duplicates?.reviewIds ?? [],
      acceptedPracticeReviewIds: payload.accepted?.practiceReviewIds ?? [],
      duplicatePracticeReviewIds: payload.duplicates?.practiceReviewIds ?? [],
      progressCardIds: payload.accepted?.progressCardIds ?? [],
      matchingRecordDeckIds: payload.accepted?.matchingRecordDeckIds ?? [],
      acceptedMatchingAttemptIds: payload.accepted?.matchingAttemptIds ?? [],
      duplicateMatchingAttemptIds: payload.duplicates?.matchingAttemptIds ?? [],
      deckPreferenceDeckIds: payload.accepted?.deckPreferenceDeckIds ?? [],
      rejectedReviewIds: payload.rejected?.reviewIds ?? [],
      rejectedPracticeReviewIds: payload.rejected?.practiceReviewIds ?? [],
      rejectedProgressCardIds: payload.rejected?.progressCardIds ?? [],
      rejectedMatchingRecordDeckIds: payload.rejected?.matchingRecordDeckIds ?? [],
      rejectedMatchingAttemptIds: payload.rejected?.matchingAttemptIds ?? [],
      rejectedDeckPreferenceDeckIds: payload.rejected?.deckPreferenceDeckIds ?? [],
      serverRevision: payload.toRevision,
    };
  }
  return payload;
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
  const responsePayload = await injectJson(ctx.app, {
    method,
    url,
    headers: {
      authorization: `Bearer ${token}`,
      ...(selectedUserId ? { "x-flashgame-user-id": selectedUserId } : {}),
    },
    payload,
    expectedStatus,
  });
  return flattenSyncResponse(url, responsePayload);
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

async function uploadLocalMedia(ctx: TestApp, fileName: string, mimeType: string, bytes: Buffer): Promise<any> {
  const response = await ctx.app.inject({
    method: "POST",
    url: "/v1/admin/media/upload",
    headers: {
      ...ctx.adminAuth,
      "content-type": mimeType,
      "x-file-name": fileName,
    },
    payload: bytes,
  });
  assert.equal(response.statusCode, 201, response.payload);
  return JSON.parse(response.payload).media;
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

function practiceReviewEvent(deck: PublishedDeck, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    clientEventId: randomUUID(),
    deckId: deck.deckId,
    deckVersionId: deck.versionId,
    cardId: deck.cardIds[0],
    mode: "clozeTyping",
    outcome: "correct",
    source: "today_practice",
    practicedAt: "2026-06-01T09:31:00.000Z",
    durationMs: 900,
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
    pairCount: 2,
    achievedAt: "2026-06-01T09:32:00.000Z",
    ...overrides,
  };
}

function matchingAttempt(deck: PublishedDeck, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    clientEventId: randomUUID(),
    deckId: deck.deckId,
    deckVersionId: deck.versionId,
    mode: "matching",
    source: "deck_session",
    completedAt: "2026-06-01T09:34:00.000Z",
    durationMs: 18700,
    pairCount: 2,
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
    headers: {
      authorization: `Bearer ${ctx.syncToken}`,
    },
  });
  assert.equal(download.statusCode, 200);
  assert.equal(download.headers["content-type"], "audio/mpeg");
  assert.deepEqual(download.rawPayload, body);

  const anonymousDownload = await ctx.app.inject({
    method: "GET",
    url: `/v1/media/${upload.media.id}`,
  });
  assert.equal(anonymousDownload.statusCode, 401);

  const wrongTokenDownload = await ctx.app.inject({
    method: "GET",
    url: `/v1/media/${upload.media.id}`,
    headers: {
      authorization: "Bearer wrong-household-token",
    },
  });
  assert.equal(wrongTokenDownload.statusCode, 401);
});

test("mobile bootstrap skips content for cached deck versions", async (t) => {
  const ctx = await createTestApp(t);
  if (!ctx) return;

  const learner = await createUser(ctx, "Cached Content Learner");
  const deck = await createPublishedDeck(ctx, learner.userId, "Cached content deck");

  const fullBootstrap = await syncJson(ctx, "GET", "/v1/bootstrap", learner.token, undefined, learner.userId);
  assert.equal(fullBootstrap.assignments.length, 1);
  assert.equal(fullBootstrap.assignments[0].current_version_id, deck.versionId);
  assert.equal(fullBootstrap.content.cards.length, 2);
  assert.equal(fullBootstrap.content.examples.length, 2);
  assert.equal(fullBootstrap.media.length, 2);

  const cachedBootstrapResponse = await ctx.app.inject({
    method: "GET",
    url: "/v1/bootstrap",
    headers: {
      authorization: `Bearer ${ctx.syncToken}`,
      "x-flashgame-user-id": learner.userId,
      "x-flashgame-cached-deck-version-ids": deck.versionId,
    },
  });
  assert.equal(cachedBootstrapResponse.statusCode, 200, cachedBootstrapResponse.payload);
  const cachedBootstrap = flattenSyncResponse("/v1/bootstrap", JSON.parse(cachedBootstrapResponse.payload));
  assert.equal(cachedBootstrap.assignments.length, 1);
  assert.equal(cachedBootstrap.assignments[0].current_version_id, deck.versionId);
  assert.deepEqual(cachedBootstrap.content.cards, []);
  assert.deepEqual(cachedBootstrap.content.examples, []);
  assert.deepEqual(cachedBootstrap.content.forms, []);
  assert.deepEqual(cachedBootstrap.content.distractors, []);
  assert.equal(cachedBootstrap.media.length, 1);
});

test("admin can create object storage upload urls and mobile downloads ready media through storage redirect", async (t) => {
  const objectStorage: AppConfig["objectStorage"] = {
    bucket: "flashgame-test",
    region: "auto",
    endpoint: "https://object-storage.test",
    accessKeyId: "test-access-key",
    secretAccessKey: "test-secret-key",
    publicBaseUrl: "https://cdn.example.test/assets",
    forcePathStyle: true,
    uploadUrlExpiresSeconds: 600,
  };
  const ctx = await createTestApp(t, { objectStorage });
  if (!ctx) return;

  const uploadResponse = await adminJson(ctx, "POST", "/v1/admin/media/upload-url", {
    fileName: "avatar.png",
    mimeType: "image/png",
    sha256: "a".repeat(64),
    byteSize: 123,
    width: 80,
    height: 60,
  }, 201);

  assert.equal(uploadResponse.media.mime_type, "image/png");
  assert.equal(uploadResponse.media.upload_status, "pending");
  assert.equal(Number(uploadResponse.media.byte_size), 123);
  assert.match(uploadResponse.media.storage_key, /^media\/\d{4}\/\d{2}\/.+-avatar\.png$/);
  assert.equal(uploadResponse.upload.method, "PUT");
  assert.equal(uploadResponse.upload.headers["Content-Type"], "image/png");
  assert.equal(uploadResponse.upload.expiresInSeconds, 600);
  assert.match(uploadResponse.upload.url, /^https:\/\/object-storage\.test\/flashgame-test\/media\//);
  assert.equal(
    uploadResponse.upload.publicUrl,
    `https://cdn.example.test/assets/${uploadResponse.media.storage_key}`,
  );

  const pendingDownload = await ctx.app.inject({
    method: "GET",
    url: `/v1/media/${uploadResponse.media.id}`,
    headers: {
      authorization: `Bearer ${ctx.syncToken}`,
    },
  });
  assert.equal(pendingDownload.statusCode, 404);

  const complete = await adminJson(ctx, "POST", `/v1/admin/media/${uploadResponse.media.id}/complete`, {
    byteSize: 456,
    width: 120,
    height: 90,
  });
  assert.equal(complete.media.upload_status, "ready");
  assert.equal(Number(complete.media.byte_size), 456);
  assert.equal(Number(complete.media.width), 120);
  assert.equal(Number(complete.media.height), 90);

  const redirectDownload = await ctx.app.inject({
    method: "GET",
    url: `/v1/media/${uploadResponse.media.id}`,
    headers: {
      authorization: `Bearer ${ctx.syncToken}`,
    },
  });
  assert.equal(redirectDownload.statusCode, 302);
  assert.equal(
    redirectDownload.headers.location,
    `https://cdn.example.test/assets/${uploadResponse.media.storage_key}`,
  );

  const failedUpload = await adminJson(ctx, "POST", "/v1/admin/media/upload-url", {
    fileName: "broken.mp3",
    mimeType: "audio/mpeg",
  }, 201);
  const failed = await adminJson(ctx, "POST", `/v1/admin/media/${failedUpload.media.id}/failed`);
  assert.equal(failed.media.upload_status, "failed");

  const failedDownload = await ctx.app.inject({
    method: "GET",
    url: `/v1/media/${failedUpload.media.id}`,
    headers: {
      authorization: `Bearer ${ctx.syncToken}`,
    },
  });
  assert.equal(failedDownload.statusCode, 404);
});

test("admin/editor can create, edit, publish, and assign usable deck content", async (t) => {
  const ctx = await createTestApp(t);
  if (!ctx) return;

  const learner = await createUser(ctx, "Mia Learner");
  const deck = await createPublishedDeck(ctx, learner.userId);
  const userAvatarMediaId = await createMedia(ctx, "user-avatar");

  const updatedUser = await adminJson(ctx, "PUT", `/v1/admin/users/${learner.userId}`, {
    displayName: "Mia Updated",
    displayNameLocalized: "Мия",
    grammaticalGender: "female",
    avatarMediaId: userAvatarMediaId,
  });
  assert.equal(updatedUser.user.display_name, "Mia Updated");
  assert.equal(updatedUser.user.display_name_localized, "Мия");
  assert.equal(updatedUser.user.grammatical_gender, "female");
  assert.equal(updatedUser.user.avatar_media_id, userAvatarMediaId);

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
  assert.equal(bootstrap.user.display_name, "Mia Updated");
  assert.equal(bootstrap.user.display_name_localized, "Мия");
  assert.equal(bootstrap.user.grammatical_gender, "female");
  assert.equal(bootstrap.user.avatar_media_id, userAvatarMediaId);
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

  const deckAvatarMediaId = await createMedia(ctx, "renamed-deck-avatar");
  const updatedDeck = await adminJson(ctx, "PUT", `/v1/admin/decks/${deck.deckId}`, {
    title: "Spanish cafe essentials",
    avatarSystemName: "sparkles",
    avatarMediaId: deckAvatarMediaId,
  });
  assert.equal(updatedDeck.deck.title, "Spanish cafe essentials");
  assert.equal(updatedDeck.deck.avatar_system_name, "sparkles");
  assert.equal(updatedDeck.deck.avatar_media_id, deckAvatarMediaId);

  const metadataChanges = await syncJson(
    ctx,
    "GET",
    `/v1/sync/changes?sinceRevision=${bootstrap.serverRevision}`,
    learner.token,
    undefined,
    learner.userId,
  );
  assert.equal(metadataChanges.assignments.length, 1);
  assert.equal(metadataChanges.assignments[0].title, "Spanish cafe essentials");
  assert.equal(metadataChanges.assignments[0].avatar_system_name, "sparkles");
  assert.equal(metadataChanges.assignments[0].avatar_media_id, deckAvatarMediaId);
});

test("admin can edit user and deck metadata with partial updates and clears", async (t) => {
  const ctx = await createTestApp(t);
  if (!ctx) return;

  const firstUserAvatarId = await createMedia(ctx, "first-user-avatar");
  const secondUserAvatarId = await createMedia(ctx, "second-user-avatar");
  const user = await adminJson(ctx, "POST", "/v1/admin/users", {
    displayName: "Metadata Learner",
    displayNameLocalized: "Метадата",
    grammaticalGender: "female",
    role: "learner",
    avatarMediaId: firstUserAvatarId,
  }, 201);
  assert.equal(user.user.display_name_localized, "Метадата");
  assert.equal(user.user.grammatical_gender, "female");
  const userId = user.user.id;

  const renamedUser = await adminJson(ctx, "PUT", `/v1/admin/users/${userId}`, {
    displayName: "Renamed Learner",
    displayNameLocalized: "Переименованная",
  });
  assert.equal(renamedUser.user.display_name, "Renamed Learner");
  assert.equal(renamedUser.user.display_name_localized, "Переименованная");
  assert.equal(renamedUser.user.role, "learner");
  assert.equal(renamedUser.user.avatar_media_id, firstUserAvatarId);

  const reavatarUser = await adminJson(ctx, "PUT", `/v1/admin/users/${userId}`, {
    grammaticalGender: "neutral",
    role: "editor",
    avatarMediaId: secondUserAvatarId,
  });
  assert.equal(reavatarUser.user.display_name, "Renamed Learner");
  assert.equal(reavatarUser.user.grammatical_gender, "neutral");
  assert.equal(reavatarUser.user.role, "editor");
  assert.equal(reavatarUser.user.avatar_media_id, secondUserAvatarId);

  const clearedUserAvatar = await adminJson(ctx, "PUT", `/v1/admin/users/${userId}`, {
    avatarMediaId: null,
  });
  assert.equal(clearedUserAvatar.user.avatar_media_id, null);

  await adminJson(ctx, "PUT", `/v1/admin/users/${userId}`, {}, 400);
  await adminJson(ctx, "PUT", `/v1/admin/users/${userId}`, { role: "coach" }, 400);
  await adminJson(ctx, "PUT", `/v1/admin/users/${userId}`, { grammaticalGender: "plural" }, 400);
  await adminJson(ctx, "PUT", `/v1/admin/users/${randomUUID()}`, { displayName: "Missing" }, 404);

  const deckAvatarId = await createMedia(ctx, "metadata-deck-avatar");
  const newDeckAvatarId = await createMedia(ctx, "metadata-new-deck-avatar");
  const deck = await adminJson(ctx, "POST", "/v1/admin/decks", {
    title: "Metadata deck",
    languageCode: "en",
    avatarSystemName: "books.vertical.fill",
    avatarMediaId: deckAvatarId,
  }, 201);
  const version = await adminJson(ctx, "POST", `/v1/admin/decks/${deck.deck.id}/versions`, {
    manifest: {},
  }, 201);
  await adminJson(ctx, "POST", `/v1/admin/decks/${deck.deck.id}/publish`, {
    versionId: version.version.id,
  });
  await adminJson(ctx, "POST", `/v1/admin/decks/${deck.deck.id}/assignments`, {
    userId,
  }, 201);

  const baseline = await syncJson(ctx, "GET", "/v1/bootstrap", ctx.syncToken, undefined, userId);
  assert.equal(baseline.assignments[0].title, "Metadata deck");
  assert.equal(baseline.assignments[0].language_code, "en");
  assert.equal(baseline.assignments[0].avatar_system_name, "books.vertical.fill");
  assert.equal(baseline.assignments[0].avatar_media_id, deckAvatarId);

  const relanguagedDeck = await adminJson(ctx, "PUT", `/v1/admin/decks/${deck.deck.id}`, {
    languageCode: "es",
  });
  assert.equal(relanguagedDeck.deck.title, "Metadata deck");
  assert.equal(relanguagedDeck.deck.language_code, "es");
  assert.equal(relanguagedDeck.deck.avatar_system_name, "books.vertical.fill");
  assert.equal(relanguagedDeck.deck.avatar_media_id, deckAvatarId);

  const clearedDeckMedia = await adminJson(ctx, "PUT", `/v1/admin/decks/${deck.deck.id}`, {
    title: "Renamed metadata deck",
    avatarSystemName: null,
    avatarMediaId: null,
  });
  assert.equal(clearedDeckMedia.deck.title, "Renamed metadata deck");
  assert.equal(clearedDeckMedia.deck.language_code, "es");
  assert.equal(clearedDeckMedia.deck.avatar_system_name, null);
  assert.equal(clearedDeckMedia.deck.avatar_media_id, null);

  const reavatarDeck = await adminJson(ctx, "PUT", `/v1/admin/decks/${deck.deck.id}`, {
    avatarSystemName: "sparkles",
    avatarMediaId: newDeckAvatarId,
  });
  assert.equal(reavatarDeck.deck.title, "Renamed metadata deck");
  assert.equal(reavatarDeck.deck.avatar_system_name, "sparkles");
  assert.equal(reavatarDeck.deck.avatar_media_id, newDeckAvatarId);

  const metadataChanges = await syncJson(
    ctx,
    "GET",
    `/v1/sync/changes?sinceRevision=${baseline.serverRevision}`,
    ctx.syncToken,
    undefined,
    userId,
  );
  assert.equal(metadataChanges.assignments.length, 1);
  assert.equal(metadataChanges.assignments[0].title, "Renamed metadata deck");
  assert.equal(metadataChanges.assignments[0].language_code, "es");
  assert.equal(metadataChanges.assignments[0].avatar_system_name, "sparkles");
  assert.equal(metadataChanges.assignments[0].avatar_media_id, newDeckAvatarId);

  await adminJson(ctx, "PUT", `/v1/admin/decks/${deck.deck.id}`, {}, 400);
  await adminJson(ctx, "PUT", `/v1/admin/decks/${deck.deck.id}`, { avatarMediaId: "not-a-uuid" }, 400);
  await adminJson(ctx, "PUT", `/v1/admin/decks/${randomUUID()}`, { title: "Missing deck" }, 404);
});

test("admin can delete draft cards and examples with dependent content", async (t) => {
  const ctx = await createTestApp(t);
  if (!ctx) return;

  const learner = await createUser(ctx, "Delete Learner");
  const deck = await adminJson(ctx, "POST", "/v1/admin/decks", {
    title: "Delete editing deck",
    languageCode: "en",
  }, 201);
  const version = await adminJson(ctx, "POST", `/v1/admin/decks/${deck.deck.id}/versions`, {
    manifest: {},
  }, 201);
  const keptCardId = randomUUID();
  const deletedCardId = randomUUID();
  const deletedExampleId = randomUUID();
  const cascadingExampleId = randomUUID();

  await adminJson(ctx, "PUT", `/v1/admin/decks/${deck.deck.id}/versions/${version.version.id}/cards/${keptCardId}`, {
    lemma: "keep",
    displayWord: "keep",
    translation: "оставить",
    sortOrder: 1,
  });
  await adminJson(ctx, "PUT", `/v1/admin/decks/${deck.deck.id}/versions/${version.version.id}/cards/${deletedCardId}`, {
    lemma: "remove",
    displayWord: "remove",
    translation: "удалить",
    sortOrder: 2,
  });
  await adminJson(
    ctx,
    "PUT",
    `/v1/admin/decks/${deck.deck.id}/versions/${version.version.id}/cards/${keptCardId}/examples/${deletedExampleId}`,
    {
      template: "I will {{blank}} this example.",
      answer: "keep",
      translation: "Я оставлю этот пример.",
    },
  );
  await adminJson(
    ctx,
    "PUT",
    `/v1/admin/decks/${deck.deck.id}/versions/${version.version.id}/cards/${deletedCardId}/examples/${cascadingExampleId}`,
    {
      template: "Please {{blank}} this card.",
      answer: "remove",
      translation: "Пожалуйста, удали эту карточку.",
    },
  );
  await adminJson(ctx, "PUT", `/v1/admin/decks/${deck.deck.id}/versions/${version.version.id}/cards/${deletedCardId}/forms`, {
    forms: [{ formKey: "base", text: "remove" }],
  });
  await adminJson(
    ctx,
    "PUT",
    `/v1/admin/decks/${deck.deck.id}/versions/${version.version.id}/examples/${deletedExampleId}/distractors`,
    {
      distractors: [{ text: "discard", priority: 1 }],
    },
  );
  await adminJson(
    ctx,
    "PUT",
    `/v1/admin/decks/${deck.deck.id}/versions/${version.version.id}/examples/${cascadingExampleId}/distractors`,
    {
      distractors: [{ text: "retain", priority: 1 }],
    },
  );

  const deletedExample = await adminJson(
    ctx,
    "DELETE",
    `/v1/admin/decks/${deck.deck.id}/versions/${version.version.id}/examples/${deletedExampleId}`,
  );
  assert.equal(deletedExample.deletedExampleId, deletedExampleId);

  const afterExampleDelete = await adminJson(ctx, "GET", `/v1/admin/decks/${deck.deck.id}/versions/${version.version.id}`);
  assert.equal(afterExampleDelete.cards.length, 2);
  assert.equal(afterExampleDelete.examples.length, 1);
  assert.equal(afterExampleDelete.examples[0].example_id, cascadingExampleId);
  assert.equal(afterExampleDelete.distractors.length, 1);
  assert.equal(afterExampleDelete.distractors[0].example_id, cascadingExampleId);

  const deletedCard = await adminJson(
    ctx,
    "DELETE",
    `/v1/admin/decks/${deck.deck.id}/versions/${version.version.id}/cards/${deletedCardId}`,
  );
  assert.equal(deletedCard.deletedCardId, deletedCardId);

  const afterCardDelete = await adminJson(ctx, "GET", `/v1/admin/decks/${deck.deck.id}/versions/${version.version.id}`);
  assert.deepEqual(afterCardDelete.cards.map((card: any) => card.card_id), [keptCardId]);
  assert.deepEqual(afterCardDelete.examples, []);
  assert.deepEqual(afterCardDelete.forms, []);
  assert.deepEqual(afterCardDelete.distractors, []);

  await adminJson(ctx, "DELETE", `/v1/admin/decks/${deck.deck.id}/versions/${version.version.id}/cards/${deletedCardId}`, undefined, 404);
  await adminJson(ctx, "DELETE", `/v1/admin/decks/${deck.deck.id}/versions/${version.version.id}/examples/${deletedExampleId}`, undefined, 404);

  await adminJson(ctx, "POST", `/v1/admin/decks/${deck.deck.id}/publish`, {
    versionId: version.version.id,
  });
  await adminJson(ctx, "POST", `/v1/admin/decks/${deck.deck.id}/assignments`, {
    userId: learner.userId,
  }, 201);

  await adminJson(ctx, "DELETE", `/v1/admin/decks/${deck.deck.id}/versions/${version.version.id}/cards/${keptCardId}`, undefined, 400);
  const bootstrap = await syncJson(ctx, "GET", "/v1/bootstrap", learner.token, undefined, learner.userId);
  assert.equal(bootstrap.content.cards.length, 1);
  assert.equal(bootstrap.content.cards[0].card_id, keptCardId);
  assert.deepEqual(bootstrap.content.examples, []);
});

test("admin can delete draft deck versions and orphan local media", async (t) => {
  const ctx = await createTestApp(t);
  if (!ctx) return;

  const learner = await createUser(ctx, "Draft Cleanup Learner");
  const deck = await createPublishedDeck(ctx, learner.userId, "Draft cleanup deck");

  await adminJson(ctx, "DELETE", `/v1/admin/decks/${deck.deckId}/versions/${deck.versionId}`, {
    deleteOrphanMedia: true,
    orphanMediaOlderThanMinutes: 0,
  }, 400);

  const draft = await adminJson(ctx, "POST", `/v1/admin/decks/${deck.deckId}/versions`, {
    manifest: { source: "interrupted-upload-test" },
  }, 201);
  const draftVersionId = draft.version.id;
  const draftCardId = randomUUID();
  const draftAudio = await uploadLocalMedia(ctx, "draft-word.mp3", "audio/mpeg", Buffer.from("draft audio"));
  const orphanAudio = await uploadLocalMedia(ctx, "orphan-word.mp3", "audio/mpeg", Buffer.from("orphan audio"));
  const retainedAvatar = await uploadLocalMedia(ctx, "retained-avatar.jpg", "image/jpeg", Buffer.from("avatar"));

  await adminJson(ctx, "PUT", `/v1/admin/users/${learner.userId}`, {
    avatarMediaId: retainedAvatar.id,
  });
  await adminJson(ctx, "PUT", `/v1/admin/decks/${deck.deckId}/versions/${draftVersionId}/cards/${draftCardId}`, {
    lemma: "draft",
    displayWord: "draft",
    translation: "черновик",
    audioWordMediaId: draftAudio.id,
    sortOrder: 1,
  });

  const versionsBefore = await adminJson(ctx, "GET", `/v1/admin/decks/${deck.deckId}/versions`);
  assert.deepEqual(
    versionsBefore.versions.map((version: any) => version.status).sort(),
    ["draft", "published"],
  );

  const deleted = await adminJson(ctx, "DELETE", `/v1/admin/decks/${deck.deckId}/versions/${draftVersionId}`, {
    deleteOrphanMedia: true,
    orphanMediaOlderThanMinutes: 0,
  });
  assert.equal(deleted.version.id, draftVersionId);
  assert.equal(deleted.deletedMediaCount, 2);
  assert.equal(deleted.deletedFileCount, 2);
  assert.deepEqual(deleted.failedFiles, []);
  assert.deepEqual(
    deleted.deletedMedia.map((media: any) => media.id).sort(),
    [draftAudio.id, orphanAudio.id].sort(),
  );

  await adminJson(ctx, "GET", `/v1/admin/decks/${deck.deckId}/versions/${draftVersionId}`, undefined, 404);
  const versionsAfter = await adminJson(ctx, "GET", `/v1/admin/decks/${deck.deckId}/versions`);
  assert.deepEqual(versionsAfter.versions.map((version: any) => version.status), ["published"]);

  const missingDraftAudio = await ctx.app.inject({
    method: "GET",
    url: `/v1/media/${draftAudio.id}`,
    headers: { authorization: `Bearer ${ctx.syncToken}` },
  });
  assert.equal(missingDraftAudio.statusCode, 404, missingDraftAudio.payload);

  const missingOrphanAudio = await ctx.app.inject({
    method: "GET",
    url: `/v1/media/${orphanAudio.id}`,
    headers: { authorization: `Bearer ${ctx.syncToken}` },
  });
  assert.equal(missingOrphanAudio.statusCode, 404, missingOrphanAudio.payload);

  const retainedDownload = await ctx.app.inject({
    method: "GET",
    url: `/v1/media/${retainedAvatar.id}`,
    headers: { authorization: `Bearer ${ctx.syncToken}` },
  });
  assert.equal(retainedDownload.statusCode, 200, retainedDownload.payload);
  assert.deepEqual(retainedDownload.rawPayload, Buffer.from("avatar"));

  const bootstrap = await syncJson(ctx, "GET", "/v1/bootstrap", learner.token, undefined, learner.userId);
  assert.equal(bootstrap.assignments.length, 1);
  assert.equal(bootstrap.assignments[0].current_version_id, deck.versionId);
});

test("admin can dry-run and delete orphan media", async (t) => {
  const ctx = await createTestApp(t);
  if (!ctx) return;

  const learner = await createUser(ctx, "Orphan Media Learner");
  const deck = await createPublishedDeck(ctx, learner.userId, "Orphan media deck");
  const retainedAvatar = await uploadLocalMedia(ctx, "retained-avatar.jpg", "image/jpeg", Buffer.from("avatar"));
  const orphanAudio = await uploadLocalMedia(ctx, "orphan-audio.mp3", "audio/mpeg", Buffer.from("orphan audio"));

  await adminJson(ctx, "PUT", `/v1/admin/users/${learner.userId}`, {
    avatarMediaId: retainedAvatar.id,
  });

  await adminJson(ctx, "POST", "/v1/admin/media/delete-orphans", {
    olderThanMinutes: -1,
  }, 400);

  const dryRun = await adminJson(ctx, "POST", "/v1/admin/media/delete-orphans", {
    dryRun: true,
    olderThanMinutes: 0,
  });
  assert.equal(dryRun.dryRun, true);
  assert.equal(dryRun.mediaCount, 1);
  assert.equal(dryRun.deletedFileCount, 0);
  assert.deepEqual(dryRun.failedFiles, []);
  assert.deepEqual(dryRun.media.map((media: any) => media.id), [orphanAudio.id]);
  assert.equal(dryRun.media[0].byte_size, Buffer.from("orphan audio").length);

  const orphanBeforeDelete = await ctx.app.inject({
    method: "GET",
    url: `/v1/media/${orphanAudio.id}`,
    headers: { authorization: `Bearer ${ctx.syncToken}` },
  });
  assert.equal(orphanBeforeDelete.statusCode, 200, orphanBeforeDelete.payload);

  const deleted = await adminJson(ctx, "POST", "/v1/admin/media/delete-orphans", {
    dryRun: false,
    olderThanMinutes: 0,
  });
  assert.equal(deleted.dryRun, false);
  assert.equal(deleted.mediaCount, 1);
  assert.equal(deleted.deletedFileCount, 1);
  assert.deepEqual(deleted.failedFiles, []);
  assert.deepEqual(deleted.media.map((media: any) => media.id), [orphanAudio.id]);

  const orphanAfterDelete = await ctx.app.inject({
    method: "GET",
    url: `/v1/media/${orphanAudio.id}`,
    headers: { authorization: `Bearer ${ctx.syncToken}` },
  });
  assert.equal(orphanAfterDelete.statusCode, 404, orphanAfterDelete.payload);

  const retainedDownload = await ctx.app.inject({
    method: "GET",
    url: `/v1/media/${retainedAvatar.id}`,
    headers: { authorization: `Bearer ${ctx.syncToken}` },
  });
  assert.equal(retainedDownload.statusCode, 200, retainedDownload.payload);
  assert.deepEqual(retainedDownload.rawPayload, Buffer.from("avatar"));

  const versionDetail = await adminJson(ctx, "GET", `/v1/admin/decks/${deck.deckId}/versions/${deck.versionId}`);
  assert.equal(versionDetail.mediaObjects.length, 2);
});

test("admin can prune old deck versions and only their orphaned media", async (t) => {
  const ctx = await createTestApp(t);
  if (!ctx) return;

  const learner = await createUser(ctx, "Prune Versions Learner");
  const deck = await createPublishedDeck(ctx, learner.userId, "Prune versions deck");
  const unrelatedOrphan = await uploadLocalMedia(ctx, "unrelated-orphan.mp3", "audio/mpeg", Buffer.from("unrelated"));

  const secondVersion = await adminJson(ctx, "POST", `/v1/admin/decks/${deck.deckId}/versions`, {
    manifest: { reason: "replace first version" },
  }, 201);
  await adminJson(
    ctx,
    "PUT",
    `/v1/admin/decks/${deck.deckId}/versions/${secondVersion.version.id}/cards/${deck.cardIds[0]}`,
    {
      lemma: "pedir",
      displayWord: "pido v2",
      translation: "I order, refreshed",
      sortOrder: 1,
    },
  );
  await adminJson(ctx, "POST", `/v1/admin/decks/${deck.deckId}/publish`, {
    versionId: secondVersion.version.id,
  });

  const dryRun = await adminJson(ctx, "POST", `/v1/admin/decks/${deck.deckId}/prune-versions`, {
    dryRun: true,
    keepPublishedVersions: 1,
    orphanMediaOlderThanMinutes: 0,
  });
  assert.equal(dryRun.dryRun, true);
  assert.equal(dryRun.versionCount, 1);
  assert.deepEqual(dryRun.versions.map((version: any) => version.id), [deck.versionId]);
  assert.equal(dryRun.mediaCount, 1);
  assert.deepEqual(dryRun.media.map((media: any) => media.id).includes(unrelatedOrphan.id), false);
  assert.equal(dryRun.deletedFileCount, 0);

  const versionsAfterDryRun = await adminJson(ctx, "GET", `/v1/admin/decks/${deck.deckId}/versions`);
  assert.equal(versionsAfterDryRun.versions.length, 2);

  const pruned = await adminJson(ctx, "POST", `/v1/admin/decks/${deck.deckId}/prune-versions`, {
    dryRun: false,
    keepPublishedVersions: 1,
    orphanMediaOlderThanMinutes: 0,
  });
  assert.equal(pruned.dryRun, false);
  assert.equal(pruned.versionCount, 1);
  assert.deepEqual(pruned.versions.map((version: any) => version.id), [deck.versionId]);
  assert.equal(pruned.mediaCount, 1);
  assert.deepEqual(pruned.media.map((media: any) => media.id).includes(unrelatedOrphan.id), false);
  assert.equal(pruned.deletedFileCount, 1);
  assert.deepEqual(pruned.failedFiles, []);

  const versionsAfterPrune = await adminJson(ctx, "GET", `/v1/admin/decks/${deck.deckId}/versions`);
  assert.deepEqual(versionsAfterPrune.versions.map((version: any) => version.id), [secondVersion.version.id]);

  const retainedUnrelated = await ctx.app.inject({
    method: "GET",
    url: `/v1/media/${unrelatedOrphan.id}`,
    headers: { authorization: `Bearer ${ctx.syncToken}` },
  });
  assert.equal(retainedUnrelated.statusCode, 200, retainedUnrelated.payload);
  assert.deepEqual(retainedUnrelated.rawPayload, Buffer.from("unrelated"));

  const bootstrap = await syncJson(ctx, "GET", "/v1/bootstrap", learner.token, undefined, learner.userId);
  assert.equal(bootstrap.assignments[0].deck_version_id, null);
  assert.equal(bootstrap.assignments[0].version_number, 2);
  assert.equal(bootstrap.content.cards.length, 1);
  assert.equal(bootstrap.content.cards[0].deck_version_id, secondVersion.version.id);
});

test("admin can remove a published card by publishing a new draft version without it", async (t) => {
  const ctx = await createTestApp(t);
  if (!ctx) return;

  const learner = await createUser(ctx, "Version Delete Learner");
  const deck = await createPublishedDeck(ctx, learner.userId, "Versioned delete deck");
  const keptCardId = deck.cardIds[0];
  const removedCardId = deck.cardIds[1];

  const baseline = await syncJson(ctx, "GET", "/v1/bootstrap", learner.token, undefined, learner.userId);
  assert.equal(baseline.assignments[0].version_number, 1);
  assert.deepEqual(
    baseline.content.cards.map((card: any) => card.card_id).sort(),
    [keptCardId, removedCardId].sort(),
  );

  await adminJson(
    ctx,
    "DELETE",
    `/v1/admin/decks/${deck.deckId}/versions/${deck.versionId}/cards/${removedCardId}`,
    undefined,
    400,
  );

  const nextVersion = await adminJson(ctx, "POST", `/v1/admin/decks/${deck.deckId}/versions`, {
    manifest: { source: "delete-card-refresh" },
  }, 201);
  const nextVersionId = nextVersion.version.id;
  await adminJson(ctx, "PUT", `/v1/admin/decks/${deck.deckId}/versions/${nextVersionId}/cards/${keptCardId}`, {
    status: "active",
    lemma: "pedir",
    displayWord: "pido",
    partOfSpeech: "verb",
    translation: "I order",
    shortDefinition: "First-person cafe ordering phrase.",
    sortOrder: 1,
  });
  await adminJson(
    ctx,
    "PUT",
    `/v1/admin/decks/${deck.deckId}/versions/${nextVersionId}/cards/${keptCardId}/examples/${randomUUID()}`,
    {
      template: "Yo {{blank}} agua.",
      answer: "pido",
      translation: "I order water.",
      sortOrder: 1,
    },
  );
  const published = await adminJson(ctx, "POST", `/v1/admin/decks/${deck.deckId}/publish`, {
    versionId: nextVersionId,
  });
  assert.equal(published.version.version_number, 2);
  assert.equal(published.deck.current_version_id, nextVersionId);

  const changes = await syncJson(
    ctx,
    "GET",
    `/v1/sync/changes?sinceRevision=${baseline.serverRevision}`,
    learner.token,
    undefined,
    learner.userId,
  );
  assert.equal(changes.assignments.length, 1);
  assert.equal(changes.assignments[0].version_number, 2);
  assert.equal(changes.content.cards.length, 1);
  assert.equal(changes.content.cards[0].deck_version_id, nextVersionId);
  assert.equal(changes.content.cards[0].card_id, keptCardId);
  assert.notEqual(changes.content.cards[0].card_id, removedCardId);
  assert.equal(changes.content.examples.length, 1);
  assert.equal(changes.content.examples[0].card_id, keptCardId);

  const refreshed = await syncJson(ctx, "GET", "/v1/bootstrap", learner.token, undefined, learner.userId);
  assert.equal(refreshed.assignments[0].version_number, 2);
  assert.deepEqual(refreshed.content.cards.map((card: any) => card.card_id), [keptCardId]);
});

test("admin can edit published card content through a new version while preserving card progress", async (t) => {
  const ctx = await createTestApp(t);
  if (!ctx) return;

  const learner = await createUser(ctx, "Version Edit Learner");
  const deck = await createPublishedDeck(ctx, learner.userId, "Versioned edit deck");
  const editedCardId = deck.cardIds[0];
  const staleExampleId = deck.exampleIds[0];

  await syncJson(ctx, "POST", "/v1/sync/events", learner.token, {
    progress: [
      progressEvent(deck, {
        cardId: editedCardId,
        fsrsData: { state: "review", reps: 4, due: "2026-06-05T09:30:00.000Z" },
        dueAt: "2026-06-05T09:30:00.000Z",
        state: "review",
      }),
    ],
  }, learner.userId);

  const baseline = await syncJson(ctx, "GET", "/v1/bootstrap", learner.token, undefined, learner.userId);
  assert.equal(baseline.content.cards.find((card: any) => card.card_id === editedCardId).display_word, "pido");
  assert.equal(baseline.progress.find((progress: any) => progress.card_id === editedCardId).state, "review");

  await adminJson(
    ctx,
    "PUT",
    `/v1/admin/decks/${deck.deckId}/versions/${deck.versionId}/cards/${editedCardId}`,
    {
      lemma: "pedir",
      displayWord: "direct edit blocked",
      translation: "blocked",
    },
    400,
  );
  await adminJson(
    ctx,
    "DELETE",
    `/v1/admin/decks/${deck.deckId}/versions/${deck.versionId}/examples/${staleExampleId}`,
    undefined,
    400,
  );

  const nextVersion = await adminJson(ctx, "POST", `/v1/admin/decks/${deck.deckId}/versions`, {
    manifest: { source: "edit-card-refresh" },
  }, 201);
  const nextVersionId = nextVersion.version.id;
  const newExampleId = randomUUID();
  await adminJson(ctx, "PUT", `/v1/admin/decks/${deck.deckId}/versions/${nextVersionId}/cards/${editedCardId}`, {
    status: "active",
    lemma: "pedir",
    displayWord: "pido actualizado",
    partOfSpeech: "verb",
    translation: "I order, updated",
    shortDefinition: "Updated first-person ordering phrase.",
    sortOrder: 1,
  });
  await adminJson(
    ctx,
    "PUT",
    `/v1/admin/decks/${deck.deckId}/versions/${nextVersionId}/cards/${editedCardId}/examples/${newExampleId}`,
    {
      template: "Yo {{blank}} una limonada.",
      answer: "pido",
      translation: "I order a lemonade.",
      sortOrder: 1,
    },
  );
  await adminJson(ctx, "POST", `/v1/admin/decks/${deck.deckId}/publish`, {
    versionId: nextVersionId,
  });

  const changes = await syncJson(
    ctx,
    "GET",
    `/v1/sync/changes?sinceRevision=${baseline.serverRevision}`,
    learner.token,
    undefined,
    learner.userId,
  );
  assert.equal(changes.assignments[0].version_number, 2);
  assert.equal(changes.content.cards.length, 1);
  assert.equal(changes.content.cards[0].card_id, editedCardId);
  assert.equal(changes.content.cards[0].display_word, "pido actualizado");
  assert.deepEqual(changes.content.examples.map((example: any) => example.example_id), [newExampleId]);
  assert.ok(!changes.content.examples.some((example: any) => example.example_id === staleExampleId));
  assert.deepEqual(changes.content.forms, []);
  assert.deepEqual(changes.content.distractors, []);

  const refreshed = await syncJson(ctx, "GET", "/v1/bootstrap", learner.token, undefined, learner.userId);
  assert.equal(refreshed.content.cards[0].card_id, editedCardId);
  assert.equal(refreshed.content.cards[0].display_word, "pido actualizado");
  assert.equal(refreshed.progress.find((progress: any) => progress.card_id === editedCardId).state, "review");

  const progressUpdate = await syncJson(ctx, "POST", "/v1/sync/events", learner.token, {
    progress: [
      progressEvent(deck, {
        cardId: editedCardId,
        fsrsData: { state: "review", reps: 5, due: "2026-06-06T09:30:00.000Z" },
        dueAt: "2026-06-06T09:30:00.000Z",
        state: "review",
      }),
    ],
  }, learner.userId);
  assert.deepEqual(progressUpdate.progressCardIds, [editedCardId]);
});

test("admin can hide and restore a deck through assignment status without deleting history", async (t) => {
  const ctx = await createTestApp(t);
  if (!ctx) return;

  const learner = await createUser(ctx, "Archive Assignment Learner");
  const deck = await createPublishedDeck(ctx, learner.userId, "Assignment archive deck");
  await syncJson(ctx, "POST", "/v1/sync/events", learner.token, {
    reviews: [reviewEvent(deck)],
    progress: [progressEvent(deck)],
  }, learner.userId);

  const activeBootstrap = await syncJson(ctx, "GET", "/v1/bootstrap", learner.token, undefined, learner.userId);
  assert.equal(activeBootstrap.assignments[0].assignment_status, "active");
  assert.equal(activeBootstrap.content.cards.length, 2);
  assert.equal(activeBootstrap.reviews.length, 1);
  assert.equal(activeBootstrap.progress.length, 1);

  const archived = await adminJson(ctx, "POST", `/v1/admin/decks/${deck.deckId}/assignments`, {
    userId: learner.userId,
    status: "archived",
  }, 201);
  assert.equal(archived.assignment.status, "archived");

  const archivedChanges = await syncJson(
    ctx,
    "GET",
    `/v1/sync/changes?sinceRevision=${activeBootstrap.serverRevision}`,
    learner.token,
    undefined,
    learner.userId,
  );
  assert.equal(archivedChanges.assignments.length, 1);
  assert.equal(archivedChanges.assignments[0].assignment_status, "archived");
  assert.deepEqual(archivedChanges.content.cards, []);

  const archivedBootstrap = await syncJson(ctx, "GET", "/v1/bootstrap", learner.token, undefined, learner.userId);
  assert.equal(archivedBootstrap.assignments[0].assignment_status, "archived");
  assert.deepEqual(archivedBootstrap.content.cards, []);
  assert.equal(archivedBootstrap.reviews.length, 1);
  assert.equal(archivedBootstrap.progress.length, 1);

  const archivedSync = await syncJson(ctx, "POST", "/v1/sync/events", learner.token, {
    progress: [progressEvent(deck)],
  }, learner.userId);
  assert.deepEqual(archivedSync.progressCardIds, []);
  assert.deepEqual(archivedSync.rejectedProgressCardIds, [deck.cardIds[0]]);

  const restored = await adminJson(ctx, "POST", `/v1/admin/decks/${deck.deckId}/assignments`, {
    userId: learner.userId,
    status: "active",
  }, 201);
  assert.equal(restored.assignment.status, "active");

  const restoredBootstrap = await syncJson(ctx, "GET", "/v1/bootstrap", learner.token, undefined, learner.userId);
  assert.equal(restoredBootstrap.assignments[0].assignment_status, "active");
  assert.equal(restoredBootstrap.content.cards.length, 2);
  assert.equal(restoredBootstrap.reviews.length, 1);
  assert.equal(restoredBootstrap.progress.length, 1);
});

test("learner deck preference syncs across devices without changing assignment", async (t) => {
  const ctx = await createTestApp(t);
  if (!ctx) return;

  const learner = await createUser(ctx, "Deck Preference Learner");
  const deck = await createPublishedDeck(ctx, learner.userId, "Preference deck");

  const firstDeviceBootstrap = await syncJson(ctx, "GET", "/v1/bootstrap", learner.token, undefined, learner.userId);
  assert.equal(firstDeviceBootstrap.assignments[0].assignment_status, "active");
  assert.equal(firstDeviceBootstrap.assignments[0].user_enabled, true);
  assert.equal(firstDeviceBootstrap.content.cards.length, 2);

  const disabled = await syncJson(ctx, "POST", "/v1/sync/events", learner.token, {
    deckPreferences: [
      {
        deckId: deck.deckId,
        isEnabled: false,
        updatedAt: "2026-06-02T12:00:00.000Z",
      },
    ],
  }, learner.userId);
  assert.deepEqual(disabled.deckPreferenceDeckIds, [deck.deckId]);

  const secondDeviceBootstrap = await syncJson(ctx, "GET", "/v1/bootstrap", learner.token, undefined, learner.userId);
  assert.equal(secondDeviceBootstrap.assignments[0].assignment_status, "active");
  assert.equal(secondDeviceBootstrap.assignments[0].user_enabled, false);
  assert.equal(secondDeviceBootstrap.content.cards.length, 2);

  const changes = await syncJson(
    ctx,
    "GET",
    `/v1/sync/changes?sinceRevision=${firstDeviceBootstrap.serverRevision}`,
    learner.token,
    undefined,
    learner.userId,
  );
  assert.equal(changes.assignments.length, 1);
  assert.equal(changes.assignments[0].assignment_status, "active");
  assert.equal(changes.assignments[0].user_enabled, false);
  assert.deepEqual(changes.content.cards, []);

  const enabled = await syncJson(ctx, "POST", "/v1/sync/events", learner.token, {
    deckPreferences: [
      {
        deckId: deck.deckId,
        isEnabled: true,
        updatedAt: "2026-06-02T13:00:00.000Z",
      },
    ],
  }, learner.userId);
  assert.deepEqual(enabled.deckPreferenceDeckIds, [deck.deckId]);

  const restored = await syncJson(ctx, "GET", "/v1/bootstrap", learner.token, undefined, learner.userId);
  assert.equal(restored.assignments[0].assignment_status, "active");
  assert.equal(restored.assignments[0].user_enabled, true);
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

test("admin can clone assignments, create a test learner, inspect state, and reset study data", async (t) => {
  const ctx = await createTestApp(t);
  if (!ctx) return;

  const child = await createUser(ctx, "Child Workflow Learner");
  await adminJson(ctx, "PUT", `/v1/admin/users/${child.userId}`, {
    displayNameLocalized: "Ребёнок",
    grammaticalGender: "female",
  });
  const deck = await createPublishedDeck(ctx, child.userId, "Workflow deck");
  const manualTarget = await createUser(ctx, "Manual Sandbox");

  const cloned = await adminJson(ctx, "POST", `/v1/admin/users/${manualTarget.userId}/clone-assignments`, {
    sourceUserId: child.userId,
  }, 201);
  assert.equal(cloned.assignments.length, 1);
  assert.equal(cloned.assignments[0].user_id, manualTarget.userId);
  assert.equal(cloned.assignments[0].deck_id, deck.deckId);
  assert.equal(cloned.assignments[0].status, "active");

  const manualBootstrap = await syncJson(ctx, "GET", "/v1/bootstrap", manualTarget.token, undefined, manualTarget.userId);
  assert.equal(manualBootstrap.assignments.length, 1);
  assert.equal(manualBootstrap.assignments[0].deck_id, deck.deckId);
  assert.deepEqual(manualBootstrap.progress, []);
  assert.deepEqual(manualBootstrap.reviews, []);
  assert.deepEqual(manualBootstrap.matchingRecords, []);

  const testLearner = await adminJson(ctx, "POST", `/v1/admin/users/${child.userId}/test-learner`, {
    displayName: "Child Workflow Sandbox",
  }, 201);
  assert.equal(testLearner.user.display_name, "Child Workflow Sandbox");
  assert.equal(testLearner.user.display_name_localized, "Child Workflow Sandbox");
  assert.equal(testLearner.user.grammatical_gender, "female");
  assert.equal(testLearner.user.role, "learner");
  assert.notEqual(testLearner.user.id, child.userId);
  assert.equal(testLearner.assignments.length, 1);
  assert.equal(testLearner.assignments[0].deck_id, deck.deckId);

  const eventsPayload = {
    reviews: [reviewEvent(deck)],
    progress: [progressEvent(deck)],
    matchingRecords: [matchingRecord(deck)],
  };
  const syncResult = await syncJson(
    ctx,
    "POST",
    "/v1/sync/events",
    ctx.syncToken,
    eventsPayload,
    testLearner.user.id,
  );
  assert.equal(syncResult.acceptedReviewIds.length, 1);
  assert.deepEqual(syncResult.progressCardIds, [deck.cardIds[0]]);
  assert.deepEqual(syncResult.matchingRecordDeckIds, [deck.deckId]);

  const detail = await adminJson(ctx, "GET", `/v1/admin/users/${testLearner.user.id}`);
  assert.equal(detail.assignments.length, 1);
  assert.equal(Number(detail.stats.assignment_count), 1);
  assert.equal(Number(detail.stats.active_assignment_count), 1);
  assert.equal(Number(detail.stats.review_count), 1);
  assert.equal(Number(detail.stats.progress_count), 1);
  assert.equal(Number(detail.stats.matching_record_count), 1);

  const dryRun = await adminJson(ctx, "POST", `/v1/admin/users/${testLearner.user.id}/reset-study-data`, {
    deckId: deck.deckId,
    dryRun: true,
  });
  assert.equal(dryRun.dryRun, true);
  assert.deepEqual(dryRun.deleted, {
    reviews: 1,
    practiceReviews: 0,
    progress: 1,
    matchingRecords: 1,
    matchingAttempts: 0,
  });

  const detailAfterDryRun = await adminJson(ctx, "GET", `/v1/admin/users/${testLearner.user.id}`);
  assert.equal(Number(detailAfterDryRun.stats.review_count), 1);
  assert.equal(Number(detailAfterDryRun.stats.progress_count), 1);
  assert.equal(Number(detailAfterDryRun.stats.matching_record_count), 1);

  const reset = await adminJson(ctx, "POST", `/v1/admin/users/${testLearner.user.id}/reset-study-data`, {
    deckId: deck.deckId,
  });
  assert.equal(reset.dryRun, false);
  assert.deepEqual(reset.deleted, {
    reviews: 1,
    practiceReviews: 0,
    progress: 1,
    matchingRecords: 1,
    matchingAttempts: 0,
  });

  const detailAfterReset = await adminJson(ctx, "GET", `/v1/admin/users/${testLearner.user.id}`);
  assert.equal(Number(detailAfterReset.stats.review_count), 0);
  assert.equal(Number(detailAfterReset.stats.progress_count), 0);
  assert.equal(Number(detailAfterReset.stats.matching_record_count), 0);
  assert.equal(detailAfterReset.assignments.length, 1);

  const incrementalAfterReset = await syncJson(
    ctx,
    "GET",
    `/v1/bootstrap?sinceRevision=${syncResult.serverRevision}`,
    ctx.syncToken,
    undefined,
    testLearner.user.id,
  );
  assert.equal(incrementalAfterReset.studyDataResets.length, 1);
  assert.equal(incrementalAfterReset.studyDataResets[0].deck_id, deck.deckId);
  assert.equal(incrementalAfterReset.studyDataResets[0].user_id, testLearner.user.id);
  assert.ok(BigInt(incrementalAfterReset.serverRevision) > BigInt(syncResult.serverRevision));

  const bootstrapAfterReset = await syncJson(ctx, "GET", "/v1/bootstrap", ctx.syncToken, undefined, testLearner.user.id);
  assert.equal(bootstrapAfterReset.assignments.length, 1);
  assert.deepEqual(bootstrapAfterReset.progress, []);
  assert.deepEqual(bootstrapAfterReset.reviews, []);
  assert.deepEqual(bootstrapAfterReset.matchingRecords, []);

  const childDetail = await adminJson(ctx, "GET", `/v1/admin/users/${child.userId}`);
  assert.equal(Number(childDetail.stats.assignment_count), 1);
  assert.equal(Number(childDetail.stats.review_count), 0);
  assert.equal(Number(childDetail.stats.progress_count), 0);
  assert.equal(Number(childDetail.stats.matching_record_count), 0);
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
  }, 400);

  const assignment = await adminJson(ctx, "POST", `/v1/admin/decks/${deck.deck.id}/assignments`, {
    userId: learner.userId,
    status: "active",
  }, 201);
  assert.equal(assignment.assignment.user_id, learner.userId);
  assert.equal(assignment.assignment.deck_version_id, null);

  await adminJson(ctx, "POST", `/v1/admin/decks/${deck.deck.id}/assignments`, {
    userId: learner.userId,
    deckVersionId: version.version.id,
    status: "active",
  }, 400);

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
  const practiceReviewId = randomUUID();
  const matchingAttemptId = randomUUID();
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
        source: "today_queue",
        reviewedAt,
        durationMs: 1400,
        wasNew: true,
        previousState: "new",
        newState: "review",
      },
    ],
    practiceReviews: [
      practiceReviewEvent(deck, { clientEventId: practiceReviewId }),
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
        pairCount: 2,
        achievedAt: "2026-06-01T09:32:00.000Z",
      },
    ],
    matchingAttempts: [
      matchingAttempt(deck, { clientEventId: matchingAttemptId }),
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
  assert.deepEqual(firstSync.acceptedPracticeReviewIds, [practiceReviewId]);
  assert.deepEqual(firstSync.duplicatePracticeReviewIds, []);
  assert.deepEqual(firstSync.progressCardIds, [deck.cardIds[0]]);
  assert.deepEqual(firstSync.matchingRecordDeckIds, [deck.deckId]);
  assert.deepEqual(firstSync.acceptedMatchingAttemptIds, [matchingAttemptId]);

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
  assert.deepEqual(duplicateSync.acceptedPracticeReviewIds, []);
  assert.deepEqual(duplicateSync.duplicatePracticeReviewIds, [practiceReviewId]);
  assert.deepEqual(duplicateSync.progressCardIds, []);
  assert.deepEqual(duplicateSync.matchingRecordDeckIds, []);
  assert.deepEqual(duplicateSync.acceptedMatchingAttemptIds, []);
  assert.deepEqual(duplicateSync.duplicateMatchingAttemptIds, [matchingAttemptId]);

  const persistedStats = await ctx.pool.query(
    `
    SELECT
      (SELECT COUNT(*) FROM study_reviews WHERE user_id = $1) AS review_count,
      (SELECT source FROM study_reviews WHERE user_id = $1 LIMIT 1) AS review_source,
      (SELECT COUNT(*) FROM practice_reviews WHERE user_id = $1) AS practice_review_count,
      (SELECT COUNT(*) FROM card_progress WHERE user_id = $1) AS progress_count,
      (SELECT COUNT(*) FROM deck_matching_records WHERE user_id = $1) AS matching_count,
      (SELECT COUNT(*) FROM matching_attempts WHERE user_id = $1) AS matching_attempt_count
    `,
    [child.userId],
  );
  assert.equal(Number(persistedStats.rows[0].review_count), 1);
  assert.equal(persistedStats.rows[0].review_source, "today_queue");
  assert.equal(Number(persistedStats.rows[0].practice_review_count), 1);
  assert.equal(Number(persistedStats.rows[0].progress_count), 1);
  assert.equal(Number(persistedStats.rows[0].matching_count), 1);
  assert.equal(Number(persistedStats.rows[0].matching_attempt_count), 1);

  const bootstrapAfterSync = await syncJson(
    ctx,
    "GET",
    `/v1/bootstrap?sinceRevision=${baselineRevision}`,
    child.token,
    undefined,
    child.userId,
  );
  assert.equal(bootstrapAfterSync.progress.length, 1);
  assert.equal(bootstrapAfterSync.progress[0].card_id, deck.cardIds[0]);
  assert.equal(bootstrapAfterSync.reviews.length, 1);
  assert.equal(bootstrapAfterSync.reviews[0].client_event_id, clientEventId);
  assert.equal(bootstrapAfterSync.reviews[0].source, "today_queue");
  assert.equal(bootstrapAfterSync.practiceReviews.length, 1);
  assert.equal(bootstrapAfterSync.practiceReviews[0].client_event_id, practiceReviewId);
  assert.equal(bootstrapAfterSync.practiceReviews[0].duration_ms, 900);
  assert.equal(bootstrapAfterSync.matchingRecords.length, 1);
  assert.equal(bootstrapAfterSync.matchingRecords[0].deck_id, deck.deckId);
  assert.equal(bootstrapAfterSync.matchingAttempts.length, 1);
  assert.equal(bootstrapAfterSync.matchingAttempts[0].client_event_id, matchingAttemptId);
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
  assert.equal(changes.reviews[0].source, "today_queue");
  assert.equal(changes.practiceReviews.length, 1);
  assert.equal(changes.practiceReviews[0].client_event_id, practiceReviewId);
  assert.equal(changes.practiceReviews[0].duration_ms, 900);
  assert.equal(changes.progress.length, 1);
  assert.equal(changes.progress[0].card_id, deck.cardIds[0]);
  assert.equal(changes.matchingRecords.length, 1);
  assert.equal(changes.matchingRecords[0].deck_id, deck.deckId);
  assert.equal(changes.matchingAttempts.length, 1);
  assert.equal(changes.matchingAttempts[0].client_event_id, matchingAttemptId);

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
          pairCount: 2,
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
          pairCount: 2,
          achievedAt: "2026-06-02T09:35:00.000Z",
        },
      ],
    },
    child.userId,
  );
  assert.deepEqual(betterMatchingRecord.matchingRecordDeckIds, [deck.deckId]);

  const partialMatchingRecord = await syncJson(
    ctx,
    "POST",
    "/v1/sync/events",
    child.token,
    {
      matchingRecords: [
        {
          deckId: deck.deckId,
          deckVersionId: deck.versionId,
          bestDurationSeconds: 3.5,
          pairCount: 1,
          achievedAt: "2026-06-02T09:36:00.000Z",
        },
      ],
    },
    child.userId,
  );
  assert.deepEqual(partialMatchingRecord.matchingRecordDeckIds, []);
  assert.deepEqual(partialMatchingRecord.rejectedMatchingRecordDeckIds, [deck.deckId]);
});

test("admin daily activity separates study, practice, and matching attempts", async (t) => {
  const ctx = await createTestApp(t);
  if (!ctx) return;

  const learner = await createUser(ctx, "Daily Activity Learner");
  await adminJson(ctx, "PUT", `/v1/admin/users/${learner.userId}`, {
    displayNameLocalized: "Даша",
    grammaticalGender: "female",
  });
  const deck = await createPublishedDeck(ctx, learner.userId, "Daily activity deck");
  const practiceReviewId = randomUUID();
  const matchingAttemptId = randomUUID();

  await syncJson(ctx, "POST", "/v1/sync/events", learner.token, {
    reviews: [
      reviewEvent(deck, {
        clientEventId: randomUUID(),
        source: "today_queue",
        reviewedAt: "2026-06-01T09:30:00.000Z",
      }),
      reviewEvent(deck, {
        clientEventId: randomUUID(),
        outcome: "forgot",
        source: "today_queue",
        reviewedAt: "2026-06-01T09:35:00.000Z",
        wasNew: false,
        previousState: "review",
        newState: "review",
      }),
    ],
    practiceReviews: [
      {
        clientEventId: practiceReviewId,
        deckId: deck.deckId,
        deckVersionId: deck.versionId,
        cardId: deck.cardIds[0],
        mode: "clozeMultipleChoice",
        outcome: "correct",
        source: "today_practice",
        practicedAt: "2026-06-01T10:00:00.000Z",
        durationMs: 900,
      },
    ],
    matchingAttempts: [
      {
        clientEventId: matchingAttemptId,
        deckId: deck.deckId,
        deckVersionId: null,
        mode: "matchingAudio",
        source: "today_practice",
        completedAt: "2026-06-01T10:05:00.000Z",
        durationMs: 24000,
        pairCount: 2,
      },
    ],
  }, learner.userId);

  const activity = await adminJson(
    ctx,
    "GET",
    `/v1/admin/users/${learner.userId}/daily-activity?dayKey=2026-06-01&timeZone=Europe%2FKiev`,
  );
  assert.equal(activity.active, true);
  assert.equal(activity.user.display_name_localized, "Даша");
  assert.equal(activity.user.grammatical_gender, "female");
  assert.deepEqual(activity.uniqueCards, { total: 1, passed: 1 });
  assert.deepEqual(activity.cardReviews, { total: 3, passed: 2 });
  assert.equal(activity.studyReviews, undefined);
  assert.equal(activity.practiceReviews, undefined);
  assert.deepEqual(activity.matchingAttempts, { total: 1, columns: 0, audioColumns: 1, pairsMatched: 2 });
  assert.deepEqual(activity.studyTime, { totalSeconds: 28, text: "28 сек" });
  assert.equal(activity.firstActivityAt, "2026-06-01T09:30:00.000Z");
  assert.equal(activity.lastActivityAt, "2026-06-01T10:05:00.000Z");

  const emptyActivity = await adminJson(
    ctx,
    "GET",
    `/v1/admin/users/${learner.userId}/daily-activity?dayKey=2026-06-02&timeZone=Europe%2FKiev`,
  );
  assert.equal(emptyActivity.active, false);
  assert.deepEqual(emptyActivity.uniqueCards, { total: 0, passed: 0 });
  assert.deepEqual(emptyActivity.cardReviews, { total: 0, passed: 0 });
  assert.equal(emptyActivity.studyReviews, undefined);
  assert.equal(emptyActivity.practiceReviews, undefined);
  assert.deepEqual(emptyActivity.matchingAttempts, { total: 0, columns: 0, audioColumns: 0, pairsMatched: 0 });
  assert.deepEqual(emptyActivity.studyTime, { totalSeconds: 0, text: "0 сек" });
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
    { payload: { reviews: [reviewEvent(deck, { source: "random" })] }, message: "bad review source" },
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
        pairCount: 2,
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
        pairCount: 2,
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

  const inactiveReviewId = randomUUID();
  const inactiveSync = await syncJson(ctx, "POST", "/v1/sync/events", bob.token, {
    reviews: [
      {
        clientEventId: inactiveReviewId,
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
        pairCount: 2,
        achievedAt: "2026-06-02T08:02:00.000Z",
      },
    ],
  }, bob.userId);
  assert.deepEqual(inactiveSync.rejectedReviewIds, [inactiveReviewId]);
  assert.deepEqual(inactiveSync.rejectedProgressCardIds, [sharedDeck.cardIds[0]]);
  assert.deepEqual(inactiveSync.rejectedMatchingRecordDeckIds, [sharedDeck.deckId]);
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

  const unassignedReview = reviewEvent(deck);
  const rejectedUnassignedReview = await syncJson(ctx, "POST", "/v1/sync/events", unassignedLearner.token, {
    reviews: [unassignedReview],
  }, unassignedLearner.userId);
  assert.deepEqual(rejectedUnassignedReview.rejectedReviewIds, [unassignedReview.clientEventId]);

  const rejectedUnassignedProgress = await syncJson(ctx, "POST", "/v1/sync/events", unassignedLearner.token, {
    progress: [progressEvent(deck)],
  }, unassignedLearner.userId);
  assert.deepEqual(rejectedUnassignedProgress.rejectedProgressCardIds, [deck.cardIds[0]]);

  const rejectedUnassignedMatching = await syncJson(ctx, "POST", "/v1/sync/events", unassignedLearner.token, {
    matchingRecords: [matchingRecord(deck)],
  }, unassignedLearner.userId);
  assert.deepEqual(rejectedUnassignedMatching.rejectedMatchingRecordDeckIds, [deck.deckId]);

  const invalidCardReview = reviewEvent(deck, { cardId: randomUUID() });
  const rejectedInvalidCardReview = await syncJson(ctx, "POST", "/v1/sync/events", assignedLearner.token, {
    reviews: [invalidCardReview],
  }, assignedLearner.userId);
  assert.deepEqual(rejectedInvalidCardReview.rejectedReviewIds, [invalidCardReview.clientEventId]);

  const invalidVersionReview = reviewEvent(deck, { deckVersionId: randomUUID() });
  const rejectedInvalidVersionReview = await syncJson(ctx, "POST", "/v1/sync/events", assignedLearner.token, {
    reviews: [invalidVersionReview],
  }, assignedLearner.userId);
  assert.deepEqual(rejectedInvalidVersionReview.rejectedReviewIds, [invalidVersionReview.clientEventId]);

  const rejectedInvalidMatchingVersion = await syncJson(ctx, "POST", "/v1/sync/events", assignedLearner.token, {
    matchingRecords: [matchingRecord(deck, { deckVersionId: randomUUID() })],
  }, assignedLearner.userId);
  assert.deepEqual(rejectedInvalidMatchingVersion.rejectedMatchingRecordDeckIds, [deck.deckId]);

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

test("sync target validation partially accepts a mixed batch with explicit rejected ids", async (t) => {
  const ctx = await createTestApp(t);
  if (!ctx) return;

  const learner = await createUser(ctx, "Atomic Validation Learner");
  const deck = await createPublishedDeck(ctx, learner.userId, "Atomic validation deck");
  const invalidCardId = randomUUID();
  const firstReviewId = randomUUID();
  const secondReviewId = randomUUID();

  const result = await syncJson(ctx, "POST", "/v1/sync/events", learner.token, {
    reviews: [
      reviewEvent(deck, {
        clientEventId: firstReviewId,
        cardId: deck.cardIds[0],
      }),
      reviewEvent(deck, {
        clientEventId: secondReviewId,
        cardId: deck.cardIds[1],
      }),
    ],
    progress: [
      progressEvent(deck, {
        cardId: deck.cardIds[0],
        updatedAt: "2026-06-02T10:00:00.000Z",
      }),
      progressEvent(deck, {
        cardId: invalidCardId,
        updatedAt: "2026-06-02T10:01:00.000Z",
      }),
    ],
    matchingRecords: [matchingRecord(deck)],
    deckPreferences: [
      {
        deckId: deck.deckId,
        isEnabled: false,
        updatedAt: "2026-06-02T10:02:00.000Z",
      },
    ],
  }, learner.userId);

  assert.deepEqual(result.acceptedReviewIds.sort(), [firstReviewId, secondReviewId].sort());
  assert.deepEqual(result.rejectedReviewIds, []);
  assert.deepEqual(result.progressCardIds, [deck.cardIds[0]]);
  assert.deepEqual(result.rejectedProgressCardIds, [invalidCardId]);
  assert.deepEqual(result.matchingRecordDeckIds, [deck.deckId]);
  assert.deepEqual(result.rejectedMatchingRecordDeckIds, []);
  assert.deepEqual(result.deckPreferenceDeckIds, [deck.deckId]);
  assert.deepEqual(result.rejectedDeckPreferenceDeckIds, []);

  const persistedStats = await ctx.pool.query(
    `
    SELECT
      (SELECT COUNT(*) FROM study_reviews WHERE user_id = $1) AS review_count,
      (SELECT COUNT(*) FROM card_progress WHERE user_id = $1) AS progress_count,
      (SELECT COUNT(*) FROM deck_matching_records WHERE user_id = $1) AS matching_count,
      (SELECT COUNT(*) FROM user_deck_preferences WHERE user_id = $1) AS preference_count
    `,
    [learner.userId],
  );
  assert.equal(Number(persistedStats.rows[0].review_count), 2);
  assert.equal(Number(persistedStats.rows[0].progress_count), 1);
  assert.equal(Number(persistedStats.rows[0].matching_count), 1);
  assert.equal(Number(persistedStats.rows[0].preference_count), 1);
});

test("sync changes excludes records written by the same device", async (t) => {
  const ctx = await createTestApp(t);
  if (!ctx) return;

  const learner = await createUser(ctx, "Device Filter Learner");
  const deck = await createPublishedDeck(ctx, learner.userId, "Device filter words");
  const baseline = await syncJson(ctx, "GET", "/v1/bootstrap", learner.token, undefined, learner.userId);
  const deviceId = randomUUID();
  const otherDeviceId = randomUUID();
  const clientEventId = randomUUID();
  const practiceReviewId = randomUUID();
  const matchingAttemptId = randomUUID();

  await injectJson(ctx.app, {
    method: "POST",
    url: "/v1/sync/events",
    headers: {
      authorization: `Bearer ${learner.token}`,
      "x-flashgame-user-id": learner.userId,
      "x-flashgame-device-id": deviceId,
    },
    payload: {
      reviews: [
        reviewEvent(deck, { clientEventId, source: "today_queue" }),
      ],
      practiceReviews: [
        practiceReviewEvent(deck, { clientEventId: practiceReviewId }),
      ],
      progress: [
        progressEvent(deck),
      ],
      matchingRecords: [
        matchingRecord(deck),
      ],
      matchingAttempts: [
        matchingAttempt(deck, { clientEventId: matchingAttemptId }),
      ],
      deckPreferences: [
        {
          deckId: deck.deckId,
          isEnabled: false,
          updatedAt: "2026-06-02T10:02:00.000Z",
        },
      ],
    },
  });

  const fullBootstrapWithDevice = flattenSyncResponse("/v1/bootstrap", await injectJson(ctx.app, {
    method: "GET",
    url: "/v1/bootstrap",
    headers: {
      authorization: `Bearer ${learner.token}`,
      "x-flashgame-user-id": learner.userId,
      "x-flashgame-device-id": deviceId,
    },
  }));
  assert.equal(fullBootstrapWithDevice.progress.length, 1);
  assert.equal(fullBootstrapWithDevice.progress[0].card_id, deck.cardIds[0]);

  const sameDeviceChanges = flattenSyncResponse(`/v1/sync/changes?sinceRevision=${baseline.serverRevision}`, await injectJson(ctx.app, {
    method: "GET",
    url: `/v1/sync/changes?sinceRevision=${baseline.serverRevision}`,
    headers: {
      authorization: `Bearer ${learner.token}`,
      "x-flashgame-user-id": learner.userId,
      "x-flashgame-device-id": deviceId,
    },
  }));
  assert.deepEqual(sameDeviceChanges.assignments, []);
  assert.deepEqual(sameDeviceChanges.progress, []);
  assert.deepEqual(sameDeviceChanges.reviews, []);
  assert.deepEqual(sameDeviceChanges.practiceReviews, []);
  assert.deepEqual(sameDeviceChanges.matchingRecords, []);
  assert.deepEqual(sameDeviceChanges.matchingAttempts, []);
  assert.ok(BigInt(sameDeviceChanges.serverRevision) > BigInt(baseline.serverRevision));

  const otherDeviceChanges = flattenSyncResponse(`/v1/sync/changes?sinceRevision=${baseline.serverRevision}`, await injectJson(ctx.app, {
    method: "GET",
    url: `/v1/sync/changes?sinceRevision=${baseline.serverRevision}`,
    headers: {
      authorization: `Bearer ${learner.token}`,
      "x-flashgame-user-id": learner.userId,
      "x-flashgame-device-id": otherDeviceId,
    },
  }));
  assert.equal(otherDeviceChanges.assignments.length, 1);
  assert.equal(otherDeviceChanges.assignments[0].user_enabled, false);
  assert.equal(otherDeviceChanges.reviews.length, 1);
  assert.equal(otherDeviceChanges.reviews[0].client_event_id, clientEventId);
  assert.equal(otherDeviceChanges.reviews[0].source, "today_queue");
  assert.equal(otherDeviceChanges.practiceReviews.length, 1);
  assert.equal(otherDeviceChanges.practiceReviews[0].client_event_id, practiceReviewId);
  assert.equal(otherDeviceChanges.progress.length, 1);
  assert.equal(otherDeviceChanges.progress[0].card_id, deck.cardIds[0]);
  assert.equal(otherDeviceChanges.matchingRecords.length, 1);
  assert.equal(otherDeviceChanges.matchingRecords[0].deck_id, deck.deckId);
  assert.equal(otherDeviceChanges.matchingAttempts.length, 1);
  assert.equal(otherDeviceChanges.matchingAttempts[0].client_event_id, matchingAttemptId);

  const bootstrapWithoutDevice = flattenSyncResponse("/v1/bootstrap", await injectJson(ctx.app, {
    method: "GET",
    url: "/v1/bootstrap",
    headers: {
      authorization: `Bearer ${learner.token}`,
      "x-flashgame-user-id": learner.userId,
    },
  }));
  assert.equal(bootstrapWithoutDevice.progress.length, 1);
  assert.equal(bootstrapWithoutDevice.progress[0].card_id, deck.cardIds[0]);
});

test("sync ignores stale progress updates for the same user and card", async (t) => {
  const ctx = await createTestApp(t);
  if (!ctx) return;

  const learner = await createUser(ctx, "Stale Progress Learner");
  const deck = await createPublishedDeck(ctx, learner.userId, "Stale progress deck");

  const first = await syncJson(ctx, "POST", "/v1/sync/events", learner.token, {
    progress: [
      progressEvent(deck, {
        fsrsData: { state: "review", reps: 2, due: "2026-06-07T09:30:00.000Z" },
        dueAt: "2026-06-07T09:30:00.000Z",
        state: "review",
        updatedAt: "2026-06-02T09:30:01.000Z",
      }),
    ],
  }, learner.userId);
  assert.deepEqual(first.progressCardIds, [deck.cardIds[0]]);

  const stale = await syncJson(ctx, "POST", "/v1/sync/events", learner.token, {
    progress: [
      progressEvent(deck, {
        fsrsData: { state: "review", reps: 1, due: "2026-06-03T09:30:00.000Z" },
        dueAt: "2026-06-03T09:30:00.000Z",
        state: "review",
        updatedAt: "2026-06-01T09:30:01.000Z",
      }),
    ],
  }, learner.userId);
  assert.deepEqual(stale.progressCardIds, []);
  assert.equal(stale.serverRevision, first.serverRevision);

  const progress = await ctx.pool.query(
    `
    SELECT fsrs_data, due_at, updated_at
    FROM card_progress
    WHERE user_id = $1 AND card_id = $2
    `,
    [learner.userId, deck.cardIds[0]],
  );
  assert.equal(progress.rowCount, 1);
  assert.equal(progress.rows[0].fsrs_data.reps, 2);
  assert.equal(progress.rows[0].due_at.toISOString(), "2026-06-07T09:30:00.000Z");
  assert.equal(progress.rows[0].updated_at.toISOString(), "2026-06-02T09:30:01.000Z");

  const bootstrap = await syncJson(ctx, "GET", "/v1/bootstrap", learner.token, undefined, learner.userId);
  assert.equal(bootstrap.progress.length, 1);
  assert.equal(bootstrap.progress[0].fsrs_data.reps, 2);
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

test("deck assignments always follow the current published version", async (t) => {
  const ctx = await createTestApp(t);
  if (!ctx) return;

  const learner = await createUser(ctx, "Current Version Learner");
  const deck = await createPublishedDeck(ctx, learner.userId, "Current version deck");
  await adminJson(ctx, "POST", `/v1/admin/decks/${deck.deckId}/assignments`, {
    userId: learner.userId,
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
