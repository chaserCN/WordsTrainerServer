CREATE TABLE IF NOT EXISTS study_data_resets (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    deck_id uuid REFERENCES decks(id) ON DELETE CASCADE,
    reset_at timestamptz NOT NULL DEFAULT now(),
    server_revision bigint NOT NULL DEFAULT nextval('server_revision_seq')
);

CREATE INDEX IF NOT EXISTS idx_study_data_resets_user_revision ON study_data_resets(user_id, server_revision);
