import { createHash, randomUUID } from "node:crypto";
import { pool } from "./db.js";

const developerId = /^[a-z0-9][a-z0-9-]{0,63}$/;
const uuid = "[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}";
const threadPath = new RegExp("^/conversations/(" + uuid + ")(?:/(replies|read))?$");
const boardThreadPath = new RegExp("^/conversations/board/(" + uuid + ")$");

function slug(name) {
  return name.normalize("NFKD").replace(/\p{M}/gu, "")
    .replace(/[^a-z0-9]+/g, "-").slice(0, 64).replace(/^-|-$/g, "") ||
    "dev-" + createHash("sha256").update(name).digest("hex").slice(0, 20);
}

const teamKey = (name) => slug(name.trim().toLowerCase().split(/\s+/u)[0]);

function configuredTeam() {
  const names = (process.env.SPORTX_CONVERSATION_TEAM ?? "").split(",").map((name) => name.trim()).filter(Boolean);
  return new Map(names.map((name) => [teamKey(name), name]));
}

function memberTeamKey({ id, name }, team) {
  const key = teamKey(name);
  return team.has(key) ? key : id.split("-")[0];
}

async function changeDevelopers(run) {
  return transaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(731093)");
    return run(client);
  });
}

export async function initializeConversationTeam() {
  const team = configuredTeam();
  if (!team.size) return;
  await changeDevelopers(async (client) => {
    const directory = await developers(client);
    const assigned = new Set(directory.map((member) => memberTeamKey(member, team)));
    for (const [id, name] of team) {
      if (assigned.has(id)) continue;
      await client.query(
        `INSERT INTO conversation_developers(id,name,name_key) VALUES($1,$2,$3)
         ON CONFLICT DO NOTHING`, [id, name, name.toLowerCase()],
      );
    }
  });
}

async function registerDeveloper(data, claimedId, { field, Problem }) {
  const name = field(data, "name", 120).normalize("NFKC").replace(/\s+/gu, " ").trim();
  if (!name || name.length > 120 || /\p{C}/u.test(name))
    throw new Problem(400, "Nome sviluppatore non valido.");
  const nameKey = name.toLowerCase();
  const id = claimedId ?? slug(nameKey);
  if (typeof id !== "string" || !developerId.test(id))
    throw new Problem(400, "Identificativo sviluppatore non valido.");

  return changeDevelopers(async (client) => {
    const { rows: [existing] } = await client.query(
      "SELECT id,name FROM conversation_developers WHERE name_key=$1", [nameKey],
    );
    if (existing && (!claimedId || existing.id === claimedId)) return existing;
    if (existing) throw new Problem(409, "Questo nome è già registrato con ID " + existing.id + ". Seleziona il profilo esistente.");

    const team = configuredTeam();
    const shortId = teamKey(name);
    const shortName = team.get(shortId);
    if (shortName) {
      const directory = await developers(client);
      const profile = directory.find((member) => member.id === shortId) ??
        directory.find((member) => memberTeamKey(member, team) === shortId);
      if (profile) {
        if (claimedId && claimedId !== profile.id)
          throw new Problem(409, "Questo sviluppatore ha già l’ID " + profile.id + ". Seleziona il profilo esistente.");
        if (profile.name === shortName) {
          const { rows: [updated] } = await client.query(
            "UPDATE conversation_developers SET name=$1,name_key=$2 WHERE id=$3 RETURNING id,name",
            [name, nameKey, profile.id],
          );
          return updated;
        }
        return profile;
      }
    }

    const { rows: [inserted] } = await client.query(
      `INSERT INTO conversation_developers(id,name,name_key) VALUES($1,$2,$3)
       ON CONFLICT DO NOTHING RETURNING id,name`, [id, name, nameKey],
    );
    if (inserted) return inserted;
    throw new Problem(409, "Identificativo già assegnato. Usa un nome più specifico o un identificativo diverso.");
  });
}

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

async function developers(client = pool) {
  const { rows } = await client.query("SELECT id,name FROM conversation_developers ORDER BY name,id");
  return rows;
}

async function threads(client, directory, memberId = null, id = null) {
  const { rows } = await client.query(
    `SELECT t.id,t.subject,t.reference,t.kind,t.updated_at,
      ARRAY[t.sender_id,t.recipient_id] AS member_ids,
      left(latest.body,280) AS preview,
      (t.kind='question' AND NOT EXISTS(
        SELECT FROM conversation_messages m WHERE m.thread_id=t.id AND m.author_id=t.recipient_id
      )) AS owes_reply,
      (SELECT jsonb_object_agg(p.id, (
        SELECT count(*) FROM conversation_messages m WHERE m.thread_id=t.id
          AND m.author_id<>p.id AND m.id>COALESCE(r.through_id,0)))
        FROM unnest(ARRAY[t.sender_id,t.recipient_id]) AS p(id)
        LEFT JOIN conversation_reads r ON r.thread_id=t.id AND r.member_id=p.id) AS unread_counts
     FROM conversation_threads t
     JOIN LATERAL (SELECT body FROM conversation_messages WHERE thread_id=t.id
       ORDER BY id DESC LIMIT 1) latest ON true
     WHERE ($1::text IS NULL OR t.sender_id=$1 OR t.recipient_id=$1)
       AND ($2::uuid IS NULL OR t.id=$2)
     ORDER BY t.updated_at DESC,t.id DESC`,
    [memberId, id],
  );
  const byId = new Map(directory.map((person) => [person.id, person]));
  return rows.map(({ member_ids, owes_reply, ...row }) => {
    const waitingBy = owes_reply ? [member_ids[1]] : [];
    const thread = {
      ...row,
      participants: member_ids.map((personId) => byId.get(personId) ?? { id: personId, name: personId }),
      unread_by: member_ids.filter((personId) => row.unread_counts[personId] > 0),
      waiting_by: waitingBy,
      waiting_for: owes_reply ? "reply" : null,
    };
    if (memberId) {
      thread.unread_count = row.unread_counts[memberId];
      thread.unread = thread.unread_count > 0;
      thread.waiting_for_you = waitingBy.includes(memberId);
    }
    return thread;
  });
}

function boardSections(directory, conversations) {
  const team = configuredTeam();
  const groups = new Map([...team].map(([id, name]) => ["team:" + id, { name, member_ids: [] }]));
  const configured = groups.size > 0;
  const known = new Map(directory.map((member) => [member.id, member]));
  for (const { participants } of conversations) {
    for (const participant of participants) {
      if (!known.has(participant.id)) known.set(participant.id, participant);
    }
  }
  const assigned = new Set();
  for (const { id, name } of known.values()) {
    const group = groups.get("team:" + memberTeamKey({ id, name }, team));
    if (group) {
      group.member_ids.push(id);
      assigned.add(id);
    } else if (!configured) groups.set("developer:" + id, { name, member_ids: [id] });
  }
  if (configured) {
    const archived = conversations.filter(({ participants }) => participants.every(({ id }) => !assigned.has(id)));
    if (archived.length) groups.set("archive", {
      name: "Archivio",
      member_ids: [...new Set(archived.flatMap(({ participants }) => participants.map(({ id }) => id)))],
      thread_ids: archived.map(({ id }) => id),
    });
  }
  return [...groups].map(([id, group]) => ({ id, ...group }));
}

async function threadDetail(directory, id, Problem, memberId = null) {
  return transaction(async (client) => {
    const [thread] = await threads(client, directory, memberId, id);
    if (!thread) throw new Problem(404, "Conversazione non trovata.");
    const [sender, recipient] = thread.participants;
    const { rows } = await client.query(
      `SELECT id,author_id,body,kind,agreement_version,created_at FROM conversation_messages
       WHERE thread_id=$1 ORDER BY id`, [id],
    );
    const messages = rows.map((message) => ({
      ...message,
      recipient_id: message.author_id === sender.id ? recipient.id : sender.id,
    }));
    return { ...thread, messages };
  }, "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
}

export async function conversationApi(req, path, { body, field, Problem }) {
  const claimedId = req.headers?.["x-sportx-developer"];
  if (req.method === "GET" && path === "/conversations/developers")
    return developers();
  if (req.method === "POST" && path === "/conversations/developers")
    return registerDeveloper(await body(req), claimedId, { field, Problem });

  if (req.method === "GET" && path === "/conversations/board") {
    const directory = await developers();
    const conversations = await threads(pool, directory);
    const sections = boardSections(directory, conversations);
    const registered = new Set(directory.map(({ id }) => id));
    const members = sections.filter(({ id }) => id !== "archive").flatMap(({ id, name, member_ids }) => {
      const candidates = member_ids.filter((memberId) => registered.has(memberId));
      const primary = candidates.find((memberId) => id === "team:" + memberId) ?? candidates[0];
      return primary ? [{ id: primary, name }] : [];
    });
    return { members, sections, threads: conversations };
  }
  const boardThread = boardThreadPath.exec(path);
  if (req.method === "GET" && boardThread)
    return threadDetail(await developers(), boardThread[1], Problem);

  if (typeof claimedId !== "string" || !developerId.test(claimedId))
    throw new Problem(400, "Seleziona lo sviluppatore; nei tool MCP passa il suo ID nel parametro developer.");
  const directory = await developers();
  const member = directory.find(({ id }) => id === claimedId);
  if (!member)
    throw new Problem(404, "Registra prima il tuo nome con sportx_register_developer.");

  if (req.method === "GET" && path === "/conversations") {
    return { me: member, members: directory, threads: await threads(pool, directory, member.id) };
  }
  if (req.method === "POST" && path === "/conversations") {
    const data = await body(req);
    const recipient = field(data, "recipient", 64);
    const subject = field(data, "subject", 180);
    const reference = field({ reference: data.reference ?? "" }, "reference", 300, { empty: true });
    const message = field(data, "message", 20000);
    if (recipient === member.id || !directory.some(({ id }) => id === recipient))
      throw new Problem(400, "Seleziona un altro sviluppatore dall’elenco.");
    const id = randomUUID();
    await transaction(async (client) => {
      await client.query(`INSERT INTO conversation_threads(id,sender_id,recipient_id,subject,reference,kind)
        VALUES($1,$2,$3,$4,$5,'question')`, [id, member.id, recipient, subject, reference]);
      await client.query(`INSERT INTO conversation_messages(thread_id,author_id,body,kind)
        VALUES($1,$2,$3,'message')`, [id, member.id, message]);
    });
    return { id };
  }

  const match = threadPath.exec(path);
  if (!match) throw new Problem(404, "Conversazione non trovata.");
  const [, id, action] = match;
  if (req.method === "GET" && !action)
    return threadDetail(directory, id, Problem, member.id);
  if (req.method !== "POST" || !action) throw new Problem(404, "Operazione non trovata.");
  const data = await body(req);
  return transaction(async (client) => {
    const { rows: [thread] } = await client.query(
      `SELECT id FROM conversation_threads
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

    const message = field(data, "message", 20000);
    await client.query(
      `INSERT INTO conversation_messages(thread_id,author_id,body,kind)
       VALUES($1,$2,$3,'message')`,
      [id, member.id, message],
    );
    await client.query(
      "UPDATE conversation_threads SET updated_at=clock_timestamp() WHERE id=$1", [id],
    );
    return { id };
  });
}
