CREATE SEQUENCE IF NOT EXISTS decision_order;
CREATE TABLE IF NOT EXISTS sections (
 id bigserial PRIMARY KEY, code text NOT NULL UNIQUE,
 next_number integer NOT NULL DEFAULT 1 CHECK(next_number > 0)
);
-- Existing installations receive a revision for safe concurrent section deletion.
ALTER TABLE sections ADD COLUMN IF NOT EXISTS revision integer NOT NULL DEFAULT 1;
-- Remove the legacy duplicate label on existing installations.
ALTER TABLE sections DROP COLUMN IF EXISTS name;
-- Keep numbering across deletion and later recreation of the same section code.
CREATE TABLE IF NOT EXISTS deleted_section_counters (
 code text PRIMARY KEY,
 next_number integer NOT NULL CHECK(next_number > 0)
);
CREATE TABLE IF NOT EXISTS tasks (
 position bigserial PRIMARY KEY, id text NOT NULL UNIQUE,
 section_id bigint NOT NULL REFERENCES sections(id), title text NOT NULL,
 description text NOT NULL DEFAULT '', status text NOT NULL DEFAULT 'Da fare',
 owner text NOT NULL DEFAULT '', priority text NOT NULL DEFAULT 'P1',
 revision integer NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS decisions (
 id bigserial PRIMARY KEY, code text UNIQUE, question text NOT NULL, answer text NOT NULL DEFAULT '',
 section_order bigint NOT NULL DEFAULT nextval('decision_order'), revision integer NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS document (
 id integer PRIMARY KEY CHECK(id=1), markdown text NOT NULL, revision integer NOT NULL DEFAULT 1
);
