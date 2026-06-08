-- Allow pruning old deck versions without deleting study history.
--
-- study_reviews / practice_reviews / matching_attempts / deck_matching_records
-- carry deck_version_id only as provenance (the column is nullable and is never
-- used in any aggregate/progress query). The original FKs were RESTRICT, so once
-- a version had any event it could never be deleted, which broke prune-versions.
-- Switch them to ON DELETE SET NULL: deleting a deck_version keeps the history
-- rows and just clears the version pointer.

ALTER TABLE study_reviews
  DROP CONSTRAINT IF EXISTS study_reviews_deck_version_id_fkey,
  ADD CONSTRAINT study_reviews_deck_version_id_fkey
    FOREIGN KEY (deck_version_id) REFERENCES deck_versions(id) ON DELETE SET NULL;

ALTER TABLE practice_reviews
  DROP CONSTRAINT IF EXISTS practice_reviews_deck_version_id_fkey,
  ADD CONSTRAINT practice_reviews_deck_version_id_fkey
    FOREIGN KEY (deck_version_id) REFERENCES deck_versions(id) ON DELETE SET NULL;

ALTER TABLE matching_attempts
  DROP CONSTRAINT IF EXISTS matching_attempts_deck_version_id_fkey,
  ADD CONSTRAINT matching_attempts_deck_version_id_fkey
    FOREIGN KEY (deck_version_id) REFERENCES deck_versions(id) ON DELETE SET NULL;

ALTER TABLE deck_matching_records
  DROP CONSTRAINT IF EXISTS deck_matching_records_deck_version_id_fkey,
  ADD CONSTRAINT deck_matching_records_deck_version_id_fkey
    FOREIGN KEY (deck_version_id) REFERENCES deck_versions(id) ON DELETE SET NULL;
