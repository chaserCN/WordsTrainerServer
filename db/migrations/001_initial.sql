-- FlashGame canonical server schema.
-- Postgres 16+ on Railway.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE SEQUENCE IF NOT EXISTS server_revision_seq AS bigint;

CREATE TYPE app_role AS ENUM ('admin', 'editor', 'learner');
CREATE TYPE group_role AS ENUM ('owner', 'editor', 'learner');
CREATE TYPE content_status AS ENUM ('active', 'inactive', 'archived');
CREATE TYPE deck_version_status AS ENUM ('draft', 'published', 'archived');
CREATE TYPE study_mode AS ENUM ('flashcards', 'recall', 'cloze_multiple_choice', 'cloze_typing', 'matching');
CREATE TYPE review_outcome AS ENUM ('remembered', 'forgot', 'correct', 'incorrect');

CREATE TABLE media_objects (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    storage_key text NOT NULL UNIQUE,
    sha256 text,
    mime_type text NOT NULL,
    byte_size bigint,
    width integer,
    height integer,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    display_name text NOT NULL,
    avatar_media_id uuid REFERENCES media_objects(id),
    role app_role NOT NULL DEFAULT 'learner',
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE study_groups (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    title text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE group_members (
    group_id uuid NOT NULL REFERENCES study_groups(id) ON DELETE CASCADE,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role group_role NOT NULL DEFAULT 'learner',
    joined_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (group_id, user_id)
);

CREATE INDEX idx_group_members_user_id ON group_members(user_id);

CREATE TABLE decks (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    title text NOT NULL,
    avatar_system_name text,
    avatar_media_id uuid REFERENCES media_objects(id),
    language_code text NOT NULL,
    current_version_id uuid,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE deck_versions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    deck_id uuid NOT NULL REFERENCES decks(id) ON DELETE CASCADE,
    version_number integer NOT NULL,
    status deck_version_status NOT NULL DEFAULT 'draft',
    manifest jsonb NOT NULL DEFAULT '{}'::jsonb,
    server_revision bigint NOT NULL DEFAULT nextval('server_revision_seq'),
    created_at timestamptz NOT NULL DEFAULT now(),
    published_at timestamptz,
    UNIQUE (deck_id, version_number)
);

ALTER TABLE decks
    ADD CONSTRAINT fk_decks_current_version
    FOREIGN KEY (current_version_id) REFERENCES deck_versions(id) ON DELETE SET NULL;

CREATE INDEX idx_deck_versions_deck_status ON deck_versions(deck_id, status);
CREATE INDEX idx_deck_versions_revision ON deck_versions(server_revision);

CREATE TABLE deck_assignments (
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    deck_id uuid NOT NULL REFERENCES decks(id) ON DELETE CASCADE,
    deck_version_id uuid REFERENCES deck_versions(id),
    status content_status NOT NULL DEFAULT 'active',
    server_revision bigint NOT NULL DEFAULT nextval('server_revision_seq'),
    assigned_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, deck_id)
);

CREATE INDEX idx_deck_assignments_revision ON deck_assignments(server_revision);

CREATE TABLE deck_version_cards (
    deck_version_id uuid NOT NULL REFERENCES deck_versions(id) ON DELETE CASCADE,
    card_id uuid NOT NULL,
    status content_status NOT NULL DEFAULT 'active',
    lemma text NOT NULL,
    display_word text NOT NULL,
    part_of_speech text,
    translation text NOT NULL,
    short_definition text,
    memory_hint text,
    etymology text,
    usage_note text,
    synonym_note text,
    grammar_note text,
    notes text,
    image_media_id uuid REFERENCES media_objects(id),
    audio_word_media_id uuid REFERENCES media_objects(id),
    sort_order integer NOT NULL DEFAULT 0,
    PRIMARY KEY (deck_version_id, card_id)
);

CREATE INDEX idx_deck_version_cards_card_id ON deck_version_cards(card_id);

CREATE TABLE deck_version_examples (
    deck_version_id uuid NOT NULL REFERENCES deck_versions(id) ON DELETE CASCADE,
    example_id uuid NOT NULL,
    card_id uuid NOT NULL,
    template text NOT NULL,
    answer text NOT NULL,
    answer_form_key text,
    translation text,
    note text,
    image_media_id uuid REFERENCES media_objects(id),
    audio_example_media_id uuid REFERENCES media_objects(id),
    sort_order integer NOT NULL DEFAULT 0,
    PRIMARY KEY (deck_version_id, example_id),
    FOREIGN KEY (deck_version_id, card_id)
        REFERENCES deck_version_cards(deck_version_id, card_id)
        ON DELETE CASCADE
);

CREATE INDEX idx_deck_version_examples_card ON deck_version_examples(deck_version_id, card_id);

CREATE TABLE deck_version_word_forms (
    deck_version_id uuid NOT NULL REFERENCES deck_versions(id) ON DELETE CASCADE,
    card_id uuid NOT NULL,
    form_key text NOT NULL,
    text text NOT NULL,
    sort_order integer NOT NULL DEFAULT 0,
    PRIMARY KEY (deck_version_id, card_id, form_key, text),
    FOREIGN KEY (deck_version_id, card_id)
        REFERENCES deck_version_cards(deck_version_id, card_id)
        ON DELETE CASCADE
);

CREATE TABLE deck_version_distractors (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    deck_version_id uuid NOT NULL REFERENCES deck_versions(id) ON DELETE CASCADE,
    example_id uuid NOT NULL,
    text text NOT NULL,
    source_card_id uuid,
    priority integer NOT NULL DEFAULT 0,
    FOREIGN KEY (deck_version_id, example_id)
        REFERENCES deck_version_examples(deck_version_id, example_id)
        ON DELETE CASCADE
);

CREATE INDEX idx_deck_version_distractors_example
    ON deck_version_distractors(deck_version_id, example_id);

CREATE TABLE card_progress (
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    card_id uuid NOT NULL,
    deck_id uuid NOT NULL REFERENCES decks(id) ON DELETE CASCADE,
    fsrs_data jsonb NOT NULL,
    due_at timestamptz,
    state text,
    updated_at timestamptz NOT NULL DEFAULT now(),
    server_revision bigint NOT NULL DEFAULT nextval('server_revision_seq'),
    PRIMARY KEY (user_id, card_id)
);

CREATE INDEX idx_card_progress_user_due ON card_progress(user_id, due_at);
CREATE INDEX idx_card_progress_revision ON card_progress(server_revision);

CREATE TABLE study_reviews (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    client_event_id uuid NOT NULL,
    deck_id uuid NOT NULL REFERENCES decks(id) ON DELETE CASCADE,
    deck_version_id uuid REFERENCES deck_versions(id),
    card_id uuid NOT NULL,
    mode study_mode NOT NULL,
    outcome review_outcome NOT NULL,
    reviewed_at timestamptz NOT NULL,
    duration_ms integer,
    was_new boolean NOT NULL,
    previous_state text,
    new_state text,
    server_revision bigint NOT NULL DEFAULT nextval('server_revision_seq'),
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (user_id, client_event_id)
);

CREATE INDEX idx_study_reviews_user_reviewed ON study_reviews(user_id, reviewed_at);
CREATE INDEX idx_study_reviews_deck_reviewed ON study_reviews(deck_id, reviewed_at);
CREATE INDEX idx_study_reviews_card ON study_reviews(user_id, card_id);
CREATE INDEX idx_study_reviews_revision ON study_reviews(server_revision);

CREATE TABLE deck_matching_records (
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    deck_id uuid NOT NULL REFERENCES decks(id) ON DELETE CASCADE,
    deck_version_id uuid REFERENCES deck_versions(id),
    best_duration_seconds real NOT NULL,
    pair_count integer NOT NULL,
    achieved_at timestamptz NOT NULL,
    server_revision bigint NOT NULL DEFAULT nextval('server_revision_seq'),
    PRIMARY KEY (user_id, deck_id)
);

CREATE INDEX idx_deck_matching_records_revision ON deck_matching_records(server_revision);

CREATE TABLE telegram_links (
    user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    telegram_user_id bigint,
    telegram_chat_id bigint,
    enabled boolean NOT NULL DEFAULT true,
    linked_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE telegram_group_chats (
    group_id uuid PRIMARY KEY REFERENCES study_groups(id) ON DELETE CASCADE,
    telegram_chat_id bigint NOT NULL,
    enabled boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
