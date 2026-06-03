ALTER TABLE study_reviews
    ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'deck_session'
    CHECK (source IN ('today_queue', 'deck_session', 'weak_cards', 'today_practice'));

