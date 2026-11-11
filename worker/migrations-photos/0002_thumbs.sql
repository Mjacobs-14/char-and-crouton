-- Small copies of photos for the board, made in the browser. Kept apart from the full photos
-- so listing or reading them never drags the big pictures along.
CREATE TABLE thumbs (id TEXT PRIMARY KEY, bytes BLOB NOT NULL);
-- When each recent photo arrived, so one that never got attached to a rating can be removed later.
CREATE TABLE uploads (id TEXT PRIMARY KEY, created INTEGER NOT NULL);
