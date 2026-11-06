-- Anonymous usage counts, only from people who said yes in the app.
--
-- `aid` is a random number the device made up; it is not derived from
-- anything about the person or the device and is not linked to a sync space.
-- No names, addresses, coordinates or schedules: a day, what kind of thing
-- was done, how many times, and the saving the app itself measured.
CREATE TABLE IF NOT EXISTS pings (
  aid        TEXT NOT NULL,          -- 32 hex characters, random
  day        TEXT NOT NULL,          -- YYYY-MM-DD, UTC
  kind       TEXT NOT NULL,          -- 'open' | 'week' | 'day'
  n          INTEGER NOT NULL DEFAULT 1,
  km_saved   REAL NOT NULL DEFAULT 0,
  min_saved  REAL NOT NULL DEFAULT 0,
  lang       TEXT,
  prof       TEXT,
  ver        TEXT,
  PRIMARY KEY (aid, day, kind)
);
CREATE INDEX IF NOT EXISTS pings_day ON pings(day);
