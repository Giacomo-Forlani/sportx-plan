import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { pool } from "./db.js";

const key = /^[a-z0-9][a-z0-9-]{0,63}$/;
const threadPath = /^\/conversations\/([a-f0-9-]{36})(?:\/(replies|read|proposal|confirmation))?$/;
const hash = (value) => createHash("sha256").update(value).digest();
let directorySource;
let directory = [];

export function conversationMembers() {
  const source = process.env.SPORTX_CONVERSATION_MEMBERS ?? "";
  if (source === directorySource) return directory;
  directorySource = source;
  try {
    const entries = JSON.parse(source || "{}");
    if (!entries || typeof entries !== "object" || Array.isArray(entries)) throw new Error();
    const tokens = new Set();
    directory = Object.entries(entries).map(([id, member]) => {
      if (!key.test(id) || typeof member?.name !== "string" || !member.name.trim() || member.name.length > 120 ||
        typeof member.token !== "string" || !/^[!-~]{32,256}$/.test(member.token) || tokens.has(member.token) ||
        member.token === process.env.SPORTX_MCP_TOKEN) throw new Error();
      tokens.add(member.token);
      return { id, name: member.name.trim(), tokenHash: hash(member.token) };
    });
  } catch {
    directory = [];
    console.error("Configurazione dei partecipanti alle conversazioni non valida.");
  }
  return directory;
}

export function conversationMember(authorization) {
  if (typeof authorization !== "string" || !authorization.startsWith("Bearer ")) return null;
  const supplied = hash(authorization.slice(7));
  let match = null;
  for (const member of conversationMembers()) {
    if (timingSafeEqual(member.tokenHash, supplied)) match = member;
  }
  return match;
}

const profile = ({ id, name }) => ({ id, name });

async function transaction(run, begin = "BEGIN") {
  const client = await pool.connect();
  try {
    await client.query(begin);
    const result = await run(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function threads(client, member, id = null) {
  const { rows } = await client.query(
    `SELECT t.id,t.subject,t.reference,t.kind,t.agreement_version,t.updated_at,
      ARRAY[t.sender_id,t.recipient_id] AS member_ids,
      left(latest.body,280) AS preview,
      (t.kind='question' AND t.recipient_id=$1 AND NOT EXISTS(
        SELECT FROM conversation_messages m WHERE m.thread_id=t.id AND m.author_id=$1
      )) AS owes_reply,
      EXISTS(SELECT FROM conversation_messages m WHERE m.thread_id=t.id
        AND m.author_id<>$1 AND m.id>COALESCE(r.through_id,0)) AS unread,
      ARRAY(SELECT m.author_id FROM conversation_messages m WHERE m.thread_id=t.id
        AND m.kind='confirmation' AND m.agreement_version=t.agreement_version
        ORDER BY m.id) AS confirmed_by
     FROM conversation_threads t
     LEFT JOIN conversation_reads r ON r.thread_id=t.id AND r.member_id=$1
     JOIN LATERAL (SELECT body FROM conversation_messages WHERE thread_id=t.id
       ORDER BY id DESC LIMIT 1) latest ON true
     WHERE (t.sender_id=$1 OR t.recipient_id=$1) AND ($2::uuid IS NULL OR t.id=$2)
     ORDER BY t.updated_at DESC,t.id DESC`,
    [member.id, id],
  );
  const byId = new Map(conversationMembers().map((person) => [person.id, profile(person)]));
  return rows.map(({ member_ids, owes_reply, ...row }) => ({
    ...row,
    participants: member_ids.map((personId) => byId.get(personId) ?? { id: personId, name: personId }),
    waiting_for_you: row.agreement_version && row.confirmed_by.length < member_ids.length
      ? !row.confirmed_by.includes(member.id)
      : owes_reply,
  }));
}

export async function conversationApi(req, path, { body, field, Problem }) {
  const member = conversationMember(req.headers?.authorization);
  if (!conversationMembers().length) throw new Problem(503, "Conversazioni non ancora configurate.");
  if (!member) throw new Problem(401, "Inserisci il tuo token personale SportX.");

  if (req.method === "GET" && path === "/conversations") {
    return { me: profile(member), members: conversationMembers().map(profile), threads: await threads(pool, member) };
  }
  if (req.method === "POST" && path === "/conversations") {
    const data = await body(req);
    const recipient = field(data, "recipient", 64);
    const subject = field(data, "subject", 180);
    const reference = field({ reference: data.reference ?? "" }, "reference", 300, { empty: true });
    const message = field(data, "message", 20000);
    const kind = data.kind ?? "question";
    if (!["question", "notice"].includes(kind)) throw new Problem(400, "Tipo di conversazione non valido.");
    if (recipient === member.id || !conversationMembers().some(({ id }) => id === recipient))
      throw new Problem(400, "Seleziona un altro sviluppatore dall’elenco.");
    const id = randomUUID();
    await transaction(async (client) => {
      await client.query(`INSERT INTO conversation_threads(id,sender_id,recipient_id,subject,reference,kind)
        VALUES($1,$2,$3,$4,$5,$6)`, [id, member.id, recipient, subject, reference, kind]);
      await client.query(`INSERT INTO conversation_messages(thread_id,author_id,body,kind)
        VALUES($1,$2,$3,'message')`, [id, member.id, message]);
    });
    return { id };
  }

  const match = threadPath.exec(path);
  if (!match || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(match[1]))
    throw new Problem(404, "Conversazione non trovata.");
  const [, id, action] = match;
  if (req.method === "GET" && !action) {
    return transaction(async (client) => {
      const [thread] = await threads(client, member, id);
      if (!thread) throw new Problem(404, "Conversazione non trovata.");
      const { rows: messages } = await client.query(
        `SELECT id,author_id,body,kind,agreement_version,created_at FROM conversation_messages
         WHERE thread_id=$1 ORDER BY id`, [id],
      );
      return { ...thread, messages };
    }, "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  }
  if (req.method !== "POST" || !action) throw new Problem(404, "Operazione non trovata.");
  const data = await body(req);
  return transaction(async (client) => {
    const { rows: [thread] } = await client.query(
      `SELECT agreement_version FROM conversation_threads
       WHERE id=$1 AND (sender_id=$2 OR recipient_id=$2) FOR UPDATE`, [id, member.id],
    );
    if (!thread) throw new Problem(404, "Conversazione non trovata.");
    if (action === "read") {
      if (typeof data.through_id !== "string" || !/^[1-9][0-9]{0,18}$/.test(data.through_id) || BigInt(data.through_id) > 9223372036854775807n)
        throw new Problem(400, "ID dell’ultimo messaggio non valido.");
      const { rowCount } = await client.query(
        `INSERT INTO conversation_reads(thread_id,member_id,through_id)
         SELECT thread_id,$2,id FROM conversation_messages WHERE thread_id=$1 AND id=$3
         ON CONFLICT(thread_id,member_id) DO UPDATE
         SET through_id=GREATEST(conversation_reads.through_id,EXCLUDED.through_id)`,
        [id, member.id, data.through_id],
      );
      if (!rowCount) throw new Problem(400, "Il messaggio non appartiene alla conversazione.");
      return { ok: true };
    }

    let version = null;
    let kind = "message";
    let message = "";
    if (action === "confirmation") {
      version = thread.agreement_version;
      if (!version || data.version !== version)
        throw new Problem(409, "La proposta è cambiata. Leggi la versione corrente prima di confermare.");
      kind = "confirmation";
    } else {
      message = field(data, "message", 20000);
      if (action === "proposal") {
        if (data.version !== thread.agreement_version)
          throw new Problem(409, "La proposta è cambiata. Rileggi la conversazione prima di proporre una versione.");
        version = thread.agreement_version + 1;
        kind = "proposal";
      }
    }
    const { rows: [posted] } = await client.query(
      `INSERT INTO conversation_messages(thread_id,author_id,body,kind,agreement_version)
       VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING id`,
      [id, member.id, message, kind, version],
    );
    if (posted) await client.query(
      "UPDATE conversation_threads SET updated_at=clock_timestamp(),agreement_version=COALESCE($2,agreement_version) WHERE id=$1",
      [id, version],
    );
    return { id, version };
  });
}
