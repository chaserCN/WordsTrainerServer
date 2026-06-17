-- Add 'picture_choice' to the study_mode enum.
--
-- `ALTER TYPE ... ADD VALUE` cannot run inside a transaction block, but the
-- migration runner wraps every migration in a single BEGIN/COMMIT. So instead
-- of ADD VALUE we recreate the type: rename the old enum, create a new one with
-- the extra value, convert the columns through text, and drop the old type.
-- This is fully transaction-safe.

ALTER TYPE study_mode RENAME TO study_mode_old;

CREATE TYPE study_mode AS ENUM (
    'flashcards',
    'recall',
    'cloze_multiple_choice',
    'cloze_typing',
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
