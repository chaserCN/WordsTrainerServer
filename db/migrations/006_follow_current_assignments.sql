UPDATE deck_assignments
SET deck_version_id = NULL,
    server_revision = nextval('server_revision_seq'),
    updated_at = now()
WHERE deck_version_id IS NOT NULL;
