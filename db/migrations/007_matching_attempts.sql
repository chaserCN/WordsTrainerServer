ALTER TYPE study_mode ADD VALUE IF NOT EXISTS 'matching_audio';

CREATE TABLE IF NOT EXISTS practice_reviews (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    client_event_id uuid NOT NULL,
    deck_id uuid NOT NULL REFERENCES decks(id) ON DELETE CASCADE,
    deck_version_id uuid REFERENCES deck_versions(id),
    card_id uuid NOT NULL,
    sense_id uuid NOT NULL,
    mode study_mode NOT NULL,
    outcome review_outcome NOT NULL,
    source text NOT NULL DEFAULT 'today_practice'
        CHECK (source IN ('today_queue', 'deck_session', 'weak_cards', 'today_practice')),
    practiced_at timestamptz NOT NULL,
    duration_ms integer CHECK (duration_ms IS NULL OR duration_ms >= 0),
    modified_by_device_id uuid,
    server_revision bigint NOT NULL DEFAULT nextval('server_revision_seq'),
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (user_id, client_event_id)
);

CREATE INDEX IF NOT EXISTS idx_practice_reviews_user_practiced ON practice_reviews(user_id, practiced_at);
CREATE INDEX IF NOT EXISTS idx_practice_reviews_deck_practiced ON practice_reviews(deck_id, practiced_at);
CREATE INDEX IF NOT EXISTS idx_practice_reviews_card ON practice_reviews(user_id, card_id);
CREATE INDEX IF NOT EXISTS idx_practice_reviews_sense ON practice_reviews(user_id, sense_id);
CREATE INDEX IF NOT EXISTS idx_practice_reviews_revision ON practice_reviews(server_revision);

CREATE TABLE IF NOT EXISTS matching_attempts (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    client_event_id uuid NOT NULL,
    deck_id uuid REFERENCES decks(id) ON DELETE CASCADE,
    deck_version_id uuid REFERENCES deck_versions(id),
    mode study_mode NOT NULL,
    source text NOT NULL DEFAULT 'deck_session'
        CHECK (source IN ('today_queue', 'deck_session', 'weak_cards', 'today_practice')),
    completed_at timestamptz NOT NULL,
    duration_ms integer NOT NULL CHECK (duration_ms >= 0),
    pair_count integer NOT NULL CHECK (pair_count > 0),
    modified_by_device_id uuid,
    server_revision bigint NOT NULL DEFAULT nextval('server_revision_seq'),
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (user_id, client_event_id)
);

CREATE INDEX IF NOT EXISTS idx_matching_attempts_user_completed ON matching_attempts(user_id, completed_at);
CREATE INDEX IF NOT EXISTS idx_matching_attempts_deck_completed ON matching_attempts(deck_id, completed_at);
CREATE INDEX IF NOT EXISTS idx_matching_attempts_revision ON matching_attempts(server_revision);
