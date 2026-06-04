ALTER TABLE users
    ADD COLUMN display_name_localized text,
    ADD COLUMN grammatical_gender text NOT NULL DEFAULT 'neutral';

UPDATE users
SET display_name_localized = display_name
WHERE display_name_localized IS NULL;

UPDATE users
SET display_name_localized = 'Коля',
    grammatical_gender = 'male'
WHERE lower(display_name) IN ('nikolay', 'nikolai', 'nicolay', 'nicolai', 'kolya');

UPDATE users
SET display_name_localized = 'Даша',
    grammatical_gender = 'female'
WHERE lower(display_name) IN ('dasha', 'daria', 'darina');

ALTER TABLE users
    ALTER COLUMN display_name_localized SET NOT NULL,
    ADD CONSTRAINT users_grammatical_gender_check
        CHECK (grammatical_gender IN ('male', 'female', 'neutral'));
