-- Each photo is shrunk in the browser first, well under D1's 2 MB limit per row.
CREATE TABLE photos (id TEXT PRIMARY KEY, bytes BLOB NOT NULL);
