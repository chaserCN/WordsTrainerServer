CREATE TABLE user_deck_groups (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title text NOT NULL CHECK (length(trim(title)) > 0),
    sort_order integer NOT NULL DEFAULT 0,
    server_revision bigint NOT NULL DEFAULT nextval('server_revision_seq'),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (user_id, id),
    UNIQUE (user_id, title)
);

CREATE INDEX idx_user_deck_groups_user_order
    ON user_deck_groups(user_id, sort_order, title);

CREATE INDEX idx_user_deck_groups_revision
    ON user_deck_groups(server_revision);

ALTER TABLE deck_assignments
    ADD COLUMN group_id uuid,
    ADD COLUMN sort_order integer NOT NULL DEFAULT 0,
    ADD CONSTRAINT fk_deck_assignments_user_group
        FOREIGN KEY (user_id, group_id)
        REFERENCES user_deck_groups(user_id, id)
        ON DELETE SET NULL (group_id);

CREATE INDEX idx_deck_assignments_user_group_order
    ON deck_assignments(user_id, group_id, sort_order, deck_id);
