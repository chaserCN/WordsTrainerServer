ALTER TABLE deck_version_sentence_questions
    ADD COLUMN IF NOT EXISTS translation text;

UPDATE deck_version_sentence_questions
SET translation = ''
WHERE translation IS NULL;

ALTER TABLE deck_version_sentence_questions
    ALTER COLUMN translation SET NOT NULL;
