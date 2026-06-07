CREATE TABLE user_settings (
    user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    random_card_count integer NOT NULL DEFAULT 30 CHECK (random_card_count BETWEEN 1 AND 200),
    modified_by_device_id uuid,
    server_revision bigint NOT NULL DEFAULT nextval('server_revision_seq'),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_user_settings_revision ON user_settings(server_revision);
