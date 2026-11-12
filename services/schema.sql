CREATE SEQUENCE IF NOT EXISTS decision_order;
CREATE TABLE IF NOT EXISTS sections (
 id bigserial PRIMARY KEY, code text NOT NULL UNIQUE, name text NOT NULL,
 next_number integer NOT NULL DEFAULT 1 CHECK(next_number > 0)
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
