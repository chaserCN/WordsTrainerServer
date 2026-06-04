# FlashGame Server

Canonical backend for users, content authoring, deck publication, sync, and
Telegram reporting.

## Decisions Fixed Now

- Railway + Postgres is the server database.
- R2/S3-compatible object storage holds all media bytes.
- Postgres stores media metadata in `media_objects`; content references media by
  `*_media_id`, not by raw URLs.
- Deck content is immutable after publish through `deck_versions`.
- `card_id` is stable across deck versions when the learning unit is the same.
- User progress is keyed by `(user_id, card_id)`.
- `study_reviews` is append-only and stores `deck_version_id` so statistics can
  be tied to the exact content version the user saw.
- iOS is offline-first: it stores a local cache and sends events to the server.
- macOS editor / web admin are authoring clients to the server, not separate
  sources of truth.

## Database

Initial migration:

```text
server/db/migrations/001_initial.sql
```

Run locally with Node 20+.

On this machine Homebrew installed Node 20 as keg-only, so use:

```bash
export PATH="/usr/local/opt/node@20/bin:$PATH"
```

Then:

```bash
cd server
cp .env.example .env
npm install
npm run migrate
npm run dev
```

Required runtime config:

- `DATABASE_URL`: `postgres://` or `postgresql://` URL.
- `ADMIN_API_KEY`: at least 12 characters.
- `HOUSEHOLD_SYNC_TOKEN`: at least 16 characters.
- `PORT`: optional integer, `1...65535`, default `3000`.
- `UPLOAD_URL_EXPIRES_SECONDS`: optional integer, `1...604800`, default `900`.
- `OBJECT_STORAGE_ENDPOINT` and `OBJECT_STORAGE_PUBLIC_BASE_URL`, when set,
  must be `http://` or `https://` URLs.

Admin routes require:

```http
Authorization: Bearer <ADMIN_API_KEY>
```

Mobile sync routes require the household sync token from server config:

```http
Authorization: Bearer <HOUSEHOLD_SYNC_TOKEN>
```

The app uses `X-FlashGame-User-Id` when it needs content or writes statistics
for a specific child. `GET /v1/bootstrap` may omit that header; the server then
returns all users and selects the first user when one exists.

Request limits:

- Default JSON body limit: 1 MiB.
- `POST /v1/sync/events`: 2 MiB body limit and 120 requests/minute per
  token+selected-user identity.
- Admin routes: 10,000 requests/minute per token identity.
- `POST /v1/admin/media/upload`: 25 MiB body limit and 10,000 requests/minute per
  token identity.

Build:

```bash
npm run build
npm start
```

Run integration tests against an isolated schema in Postgres:

```bash
npm test
```

`npm test` loads `.env` and runs through Node 20 automatically when Homebrew
`node@20` is installed. Set `TEST_DATABASE_URL` only when you want tests to use a
different database than `DATABASE_URL`.

The tests create and drop their own `fg_test_*` schema. They exercise the
admin/editor content flow and the iOS sync flow through Fastify HTTP injection,
not mocked route handlers.

Core tables:

- `users`
- `study_groups`, `group_members`
- `media_objects`
- `decks`, `deck_versions`, `deck_assignments`, `user_deck_preferences`
- `deck_version_cards`, `deck_version_examples`
- `deck_version_word_forms`, `deck_version_distractors`
- `card_progress`, `study_reviews`
- `deck_matching_records`
- `telegram_links`, `telegram_group_chats`

## Implemented Endpoints

Health:

```text
GET /health
GET /v1/health
```

Admin/editor bootstrap endpoints:

```text
GET  /v1/admin/users
POST /v1/admin/users
PUT  /v1/admin/users/:userId
GET  /v1/admin/users/:userId/daily-activity?dayKey=YYYY-MM-DD&timeZone=Europe/Kiev
GET  /v1/admin/groups
POST /v1/admin/groups
GET  /v1/admin/groups/:groupId
PUT  /v1/admin/groups/:groupId
PUT  /v1/admin/groups/:groupId/members/:userId
DELETE /v1/admin/groups/:groupId/members/:userId
POST /v1/admin/media
POST /v1/admin/media/delete-orphans
POST /v1/admin/media/upload-url
POST /v1/admin/media/:mediaId/complete
POST /v1/admin/media/:mediaId/failed

GET  /v1/admin/decks
POST /v1/admin/decks
PUT  /v1/admin/decks/:deckId
POST /v1/admin/decks/:deckId/versions
GET  /v1/admin/decks/:deckId/versions
GET  /v1/admin/decks/:deckId/versions/:versionId
POST /v1/admin/decks/:deckId/prune-versions
DELETE /v1/admin/decks/:deckId/versions/:versionId
PUT  /v1/admin/decks/:deckId/versions/:versionId/cards/:cardId
DELETE /v1/admin/decks/:deckId/versions/:versionId/cards/:cardId
PUT  /v1/admin/decks/:deckId/versions/:versionId/cards/:cardId/examples/:exampleId
DELETE /v1/admin/decks/:deckId/versions/:versionId/examples/:exampleId
PUT  /v1/admin/decks/:deckId/versions/:versionId/cards/:cardId/forms
PUT  /v1/admin/decks/:deckId/versions/:versionId/examples/:exampleId/distractors
POST /v1/admin/decks/:deckId/publish
POST /v1/admin/decks/:deckId/assignments
```

Content editing endpoints and publish both accept only `draft` deck versions.
After a version is published, the macOS editor must create a new draft version,
edit that draft, and publish it when ready. This keeps iOS sync deterministic
because statistics and reviews always point to the exact content version the
user studied.

User and deck metadata can be edited independently from deck versions:

```text
PUT /v1/admin/users/:userId
```

```json
{
  "displayName": "Mia",
  "avatarMediaId": "media-uuid-or-null",
  "role": "learner"
}
```

```text
PUT /v1/admin/decks/:deckId
```

```json
{
  "title": "English basics",
  "languageCode": "en",
  "avatarSystemName": "books.vertical.fill",
  "avatarMediaId": "media-uuid-or-null"
}
```

Both endpoints accept partial bodies. Pass `null` for `avatarMediaId` or
`avatarSystemName` to clear it.

Media upload flow:

```text
POST /v1/admin/media/upload-url
```

Request:

```json
{
  "fileName": "deck-avatar.png",
  "mimeType": "image/png",
  "sha256": "optional-file-hash",
  "byteSize": 12345,
  "width": 512,
  "height": 512
}
```

Response contains `media.id` with `upload_status = "pending"` plus a presigned
`PUT` URL. The editor uploads the file bytes directly to R2/S3 with the returned
headers, then calls:

```text
POST /v1/admin/media/:mediaId/complete
```

That marks `upload_status = "ready"`. If upload fails, the editor can call
`POST /v1/admin/media/:mediaId/failed`. Content should store `media.id` only
after the upload is complete.

iOS sync read endpoints:

```text
GET /v1/bootstrap
GET /v1/sync/changes?sinceRevision=...
```

`GET /v1/sync/changes` and `POST /v1/sync/events` require
`X-FlashGame-User-Id` so progress is always written to an explicit user.

`GET /v1/bootstrap` accepts optional client-state headers:

- `X-FlashGame-User-Id`: selected learner. If omitted, the server returns the
  first user alphabetically.
- `X-FlashGame-Cached-Deck-Version-Ids`: comma-separated published deck version
  ids already stored locally; content rows for these versions are omitted.
- `X-FlashGame-Time-Zone`: IANA time zone used to build `dailyUsage.day_key`.
  If omitted, the server uses `UTC`.

Bootstrap includes `dailyUsage` rows:

```json
[
  {
    "deck_id": "deck-uuid",
    "day_key": "2026-06-01",
    "new_cards_studied": 1
  }
]
```

Assignment rows include user-level deck preferences:

```json
{
  "deck_id": "deck-uuid",
  "assignment_status": "active",
  "user_enabled": false,
  "preference_updated_at": "2026-06-01T12:00:00.000Z"
}
```

Effective deck activity on the client is:

```text
assignment_status == "active" && user_enabled != false
```

Bootstrap also includes `statsSummary` for dashboard statistics so clients do
not need raw review history for activity and weak-card views:

```json
{
  "activityDays": [
    {
      "day_key": "2026-06-01",
      "reviewed_count": 3,
      "passed_count": 2
    }
  ],
  "weakCards": [
    {
      "card_id": "card-uuid",
      "deck_id": "deck-uuid",
      "failed_count": 2,
      "reviewed_count": 5,
      "last_failed_at": "2026-06-01T12:00:00.000Z"
    }
  ]
}
```

`GET /v1/bootstrap` keeps `reviews: []` for response-shape compatibility.
Raw review history is not part of full bootstrap; use `/v1/sync/changes` for
revision-based review deltas if needed.

`POST /v1/sync/events` accepts idempotent study events:

```json
{
  "reviews": [
    {
      "clientEventId": "client-generated-uuid",
      "deckId": "deck-uuid",
      "deckVersionId": "version-uuid",
      "cardId": "stable-card-uuid",
      "mode": "flashcards",
      "outcome": "remembered",
      "reviewedAt": "2026-06-01T12:00:00Z",
      "durationMs": 1200,
      "wasNew": true,
      "previousState": null,
      "newState": "review"
    }
  ],
  "progress": [
    {
      "cardId": "stable-card-uuid",
      "deckId": "deck-uuid",
      "fsrsData": { "state": "review" },
      "dueAt": "2026-06-02T12:00:00Z",
      "state": "review",
      "updatedAt": "2026-06-01T12:00:01Z"
    }
  ],
  "deckPreferences": [
    {
      "deckId": "deck-uuid",
      "isEnabled": false,
      "updatedAt": "2026-06-01T12:00:02Z"
    }
  ]
}
```

Repeated `clientEventId` values are reported as duplicates and do not create
new review rows. Invalid/stale targets are reported per element via
`rejectedReviewIds`, `rejectedProgressCardIds`,
`rejectedMatchingRecordDeckIds`, and `rejectedDeckPreferenceDeckIds`; valid
elements in the same request are still written. Malformed payloads still return
`400` without partial writes.

Identical progress snapshots do not advance `serverRevision`.
The server logs sync event batches with selected user id, input counts,
accepted/duplicate counts, rejected element counts, and duration.
Deck preferences are upserted per user/deck and returned in
`deckPreferenceDeckIds` when accepted.

## Next Implementation Steps

1. Add object-storage upload integration for media.
2. Add Telegram reporting jobs.
3. Add iOS client sync integration.
