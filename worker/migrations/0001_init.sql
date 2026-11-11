-- Everything except photos. Lists come back in the order rows were added (rowid),
-- which matches the order the home version keeps them in.
CREATE TABLE restaurants (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  area TEXT NOT NULL DEFAULT '',
  place_id TEXT,
  address TEXT,
  lat REAL,
  lon REAL,
  -- NULL means not looked up yet; '' means OpenStreetMap lists none.
  website TEXT
);

CREATE TABLE ratings (
  id TEXT PRIMARY KEY,
  restaurant_id TEXT NOT NULL,
  dish TEXT NOT NULL,
  rater TEXT NOT NULL,
  score REAL NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  photo TEXT,
  updated_at TEXT NOT NULL
);
CREATE INDEX ratings_by_restaurant ON ratings (restaurant_id);

CREATE TABLE people (name TEXT PRIMARY KEY);

CREATE TABLE wishes (
  id TEXT PRIMARY KEY,
  restaurant_id TEXT NOT NULL,
  person TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  added_at TEXT NOT NULL
);

CREATE TABLE accounts (person TEXT PRIMARY KEY, password TEXT NOT NULL);
CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, person TEXT NOT NULL, expires INTEGER NOT NULL);
CREATE TABLE invites (code_hash TEXT PRIMARY KEY, person TEXT NOT NULL, expires INTEGER NOT NULL);

-- Failed sign-ins, kept here because each request may run in a different place.
CREATE TABLE failures (key TEXT PRIMARY KEY, count INTEGER NOT NULL, until INTEGER NOT NULL);

-- Small switches, such as the freeze message.
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
