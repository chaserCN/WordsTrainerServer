CREATE INDEX IF NOT EXISTS idx_deck_assignments_user_revision
    ON deck_assignments(user_id, server_revision);

CREATE INDEX IF NOT EXISTS idx_user_deck_preferences_user_revision
    ON user_deck_preferences(user_id, server_revision);

CREATE INDEX IF NOT EXISTS idx_sense_progress_user_revision
    ON sense_progress(user_id, server_revision);

CREATE INDEX IF NOT EXISTS idx_study_reviews_user_revision
    ON study_reviews(user_id, server_revision);

CREATE INDEX IF NOT EXISTS idx_practice_reviews_user_revision
    ON practice_reviews(user_id, server_revision);

CREATE INDEX IF NOT EXISTS idx_deck_matching_records_user_revision
    ON deck_matching_records(user_id, server_revision);

CREATE INDEX IF NOT EXISTS idx_matching_attempts_user_revision
    ON matching_attempts(user_id, server_revision);
