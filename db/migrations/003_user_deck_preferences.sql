CREATE TABLE user_deck_preferences (
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    deck_id uuid NOT NULL REFERENCES decks(id) ON DELETE CASCADE,
    is_enabled boolean NOT NULL DEFAULT true,
    modified_by_device_id uuid,
    server_revision bigint NOT NULL DEFAULT nextval('server_revision_seq'),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, deck_id),
    FOREIGN KEY (user_id, deck_id)
        REFERENCES deck_assignments(user_id, deck_id)
        ON DELETE CASCADE
);

CREATE INDEX idx_user_deck_preferences_revision ON user_deck_preferences(server_revision);
