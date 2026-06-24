-- Add 'translation_typing' to the study_mode enum.
--
-- Keep the same transaction-safe enum recreation pattern as
-- 004_picture_choice_mode.sql because the migration runner wraps every file in
-- a single BEGIN/COMMIT.

ALTER TYPE study_mode RENAME TO study_mode_old;

CREATE TYPE study_mode AS ENUM (
    'flashcards',
    'recall',
    'cloze_multiple_choice',
    'cloze_typing',
    'translation_typing',
    'matching',
    'matching_audio',
    'picture_choice'
);

ALTER TABLE study_reviews
    ALTER COLUMN mode TYPE study_mode USING mode::text::study_mode;
ALTER TABLE practice_reviews
    ALTER COLUMN mode TYPE study_mode USING mode::text::study_mode;
ALTER TABLE matching_attempts
    ALTER COLUMN mode TYPE study_mode USING mode::text::study_mode;

DROP TYPE study_mode_old;
