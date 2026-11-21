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
CREATE TABLE IF NOT EXISTS conversation_threads (
 id uuid PRIMARY KEY,
 sender_id text NOT NULL,
 recipient_id text NOT NULL CHECK(recipient_id <> sender_id),
 subject text NOT NULL,
 reference text NOT NULL DEFAULT '',
 kind text NOT NULL CHECK(kind IN ('question','notice')),
 agreement_version integer NOT NULL DEFAULT 0,
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS conversation_threads_sender ON conversation_threads(sender_id);
CREATE INDEX IF NOT EXISTS conversation_threads_recipient ON conversation_threads(recipient_id);
CREATE TABLE IF NOT EXISTS conversation_messages (
 id bigserial PRIMARY KEY,
 thread_id uuid NOT NULL REFERENCES conversation_threads(id),
 author_id text NOT NULL,
 body text NOT NULL,
 kind text NOT NULL CHECK(kind IN ('message','proposal','confirmation')),
 agreement_version integer,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK ((kind = 'message') = (agreement_version IS NULL))
);
CREATE INDEX IF NOT EXISTS conversation_messages_by_thread ON conversation_messages(thread_id,id);
CREATE UNIQUE INDEX IF NOT EXISTS conversation_confirmations_once
 ON conversation_messages(thread_id,agreement_version,author_id) WHERE kind='confirmation';
CREATE TABLE IF NOT EXISTS conversation_reads (
 thread_id uuid NOT NULL REFERENCES conversation_threads(id),
 member_id text NOT NULL,
 through_id bigint NOT NULL,
 PRIMARY KEY(thread_id,member_id)
);
