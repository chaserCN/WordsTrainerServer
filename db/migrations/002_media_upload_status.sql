CREATE TYPE media_upload_status AS ENUM ('pending', 'ready', 'failed');

ALTER TABLE media_objects
    ADD COLUMN upload_status media_upload_status NOT NULL DEFAULT 'ready';

CREATE INDEX idx_media_objects_upload_status ON media_objects(upload_status);
