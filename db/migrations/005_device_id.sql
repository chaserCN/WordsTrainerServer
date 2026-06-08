ALTER TABLE sense_progress
    ADD COLUMN IF NOT EXISTS modified_by_device_id uuid;

ALTER TABLE study_reviews
    ADD COLUMN IF NOT EXISTS modified_by_device_id uuid;

ALTER TABLE deck_matching_records
    ADD COLUMN IF NOT EXISTS modified_by_device_id uuid;

ALTER TABLE user_deck_preferences
    ADD COLUMN IF NOT EXISTS modified_by_device_id uuid;
