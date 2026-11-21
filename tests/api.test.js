import { test, after } from "node:test";
import assert from "node:assert/strict";
// This suite must run against a dedicated disposable database.
if (!process.env.PGDATABASE?.endsWith("_test"))
  throw new Error("Use a dedicated PGDATABASE ending in _test.");
process.env.NODE_ENV = "test";
const { start } = await import("../services/server.js");
const { pool } = await import("../services/db.js");
const database = await pool.query("SELECT current_database() AS name");
assert.equal(
  database.rows[0].name,
  process.env.PGDATABASE,
  "Database di test inatteso",
);
await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
let server = await start(0);
let base = "http://127.0.0.1:" + server.address().port + "/api";
after(async () => {
  await new Promise((r) => server.close(r));
  await pool.end();
});
async function request(path, method = "GET", body, expected = 200) {
  const r = await fetch(base + path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json();
  assert.equal(r.status, expected, JSON.stringify(data));
  return data;
}
const input = (section_id) => ({
  section_id,
  title: "Attività di test",
  description: "Descrizione",
  owner: "Team",
  status: "Da fare",
  priority: "P1",
});
test("seed, numbering under concurrency, deletion, conflicts, ordering, persistence and Markdown", async () => {
  let state = await request("/state");
  assert.equal(state.tasks.length, 30);
  assert.equal(state.decisions.length, 15);
  assert.ok(state.document.markdown.includes("OPES"));
  const section = await request("/sections", "POST", { code: "QA" });
  assert.deepEqual(Object.keys(section).sort(), ["code", "id", "revision"]);
  await request("/sections", "POST", { code: "qa" }, 409);
  const tasks = await Promise.all(
    Array.from({ length: 12 }, () =>
      request("/tasks", "POST", input(section.id)),
    ),
  );
  assert.equal(new Set(tasks.map((t) => t.id)).size, 12);
  assert.deepEqual(
    tasks.map((t) => t.id).sort(),
    Array.from(
      { length: 12 },
      (_, i) => "QA-" + String(i + 1).padStart(2, "0"),
    ),
  );
  const last = tasks.find((t) => t.id === "QA-12");
  await request("/tasks/" + last.id, "DELETE", { revision: last.revision });
  const next = await request("/tasks", "POST", input(section.id));
  assert.equal(next.id, "QA-13");
  const first = tasks.find((t) => t.id === "QA-01");
  const updated = await request("/tasks/" + first.id, "PATCH", {
    ...first,
    title: "Aggiornata",
  });
  assert.equal(updated.revision, 2);
  await request(
    "/tasks/" + first.id,
    "PATCH",
    { ...first, title: "Sovrascritta" },
    409,
  );
  await request("/tasks/" + first.id, "DELETE", { revision: 1 }, 409);
  state = await request("/state");
  assert.equal(
    state.tasks.filter((t) => t.section_id === section.id)[0].id,
    "QA-01",
  );
  const a = await request("/decisions", "POST", {
    question: "Domanda A",
    answer: "",
  });
  const b = await request("/decisions", "POST", {
    question: "Domanda B",
    answer: "Prima risposta",
  });
  const aAnswered = await request("/decisions/" + a.id, "PATCH", {
    ...a,
    answer: "Risposta A",
  });
  assert.ok(Number(aAnswered.section_order) > Number(b.section_order));
  const bQuestion = await request("/decisions/" + b.id, "PATCH", {
    ...b,
    question: "Domanda B modificata",
  });
  assert.equal(bQuestion.section_order, b.section_order);
  const bAnswer = await request("/decisions/" + b.id, "PATCH", {
    ...bQuestion,
    answer: "Nuova risposta",
  });
  assert.ok(Number(bAnswer.section_order) > Number(aAnswered.section_order));
  const empty = await request("/decisions/" + a.id, "PATCH", {
    ...aAnswered,
    answer: "   ",
  });
  assert.equal(empty.answer, "");
  assert.ok(Number(empty.section_order) > Number(bAnswer.section_order));
  await request(
    "/decisions/" + a.id,
    "PATCH",
    { ...aAnswered, answer: "Obsoleta" },
    409,
  );
  await request("/decisions", "POST", { question: " ", answer: "" }, 400);
  const markdown =
    "# Documento\n\n**Salvato**\n\n<script>alert(1)</script>\n\n[x](javascript:alert(1))";
  const doc = await request("/document", "PUT", {
    markdown,
    revision: state.document.revision,
  });
  await request(
    "/document",
    "PUT",
    { markdown: "Vecchio", revision: state.document.revision },
    409,
  );
  const preview = await request("/preview", "POST", { markdown });
  assert.match(preview.html, /<h1>Documento<\/h1>/);
  assert.match(preview.html, /<strong>Salvato<\/strong>/);
  assert.doesNotMatch(preview.html, /<script|javascript:/);
  const origin = await fetch(base + "/sections", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: "https://example.com",
    },
    body: JSON.stringify({ code: "X" }),
  });
  assert.equal(origin.status, 403);
  await new Promise((r) => server.close(r));
  server = await start(0);
  base = "http://127.0.0.1:" + server.address().port + "/api";
  state = await request("/state");
  assert.equal(state.document.markdown, markdown);
  assert.equal(state.document.revision, doc.revision);
  assert.ok(state.tasks.some((t) => t.id === "QA-13"));
  assert.equal(state.tasks.filter((t) => t.id === "DISC-01").length, 1);
});

test("delete empty sections and decisions with revision checks; preserve numbering", async () => {
  const section = await request("/sections", "POST", { code: "DEL" });
  assert.equal(section.revision, 1);
  await request("/sections/" + section.id, "DELETE", { revision: 0 }, 400);
  await request("/sections/" + section.id, "DELETE", { revision: 99 }, 409);
  const first = await request("/tasks", "POST", input(section.id));
  assert.equal(first.id, "DEL-01");
  await request("/sections/" + section.id, "DELETE", { revision: section.revision }, 409);
  let current = (await request("/state")).sections.find((s) => s.id === section.id);
  assert.equal(current.revision, section.revision + 1);
  const busy = await request("/sections/" + section.id, "DELETE", { revision: current.revision }, 409);
  assert.match(busy.error, /contiene attività/);
  await request("/tasks/" + first.id, "DELETE", { revision: first.revision });
  const gone = await request("/sections/" + section.id, "DELETE", { revision: current.revision });
  assert.equal(gone.code, "DEL");
  await request("/sections/" + section.id, "DELETE", { revision: current.revision }, 409);
  assert.ok(!(await request("/state")).sections.some((s) => s.id === section.id));
  const recreated = await request("/sections", "POST", { code: "DEL" });
  assert.notEqual(recreated.id, section.id);
  const next = await request("/tasks", "POST", input(recreated.id));
  assert.equal(next.id, "DEL-02", "Deleting/recreating a section must not reuse task IDs.");
  await request("/tasks/" + next.id, "DELETE", { revision: next.revision });
  current = (await request("/state")).sections.find((s) => s.id === recreated.id);
  await request("/sections/" + recreated.id, "DELETE", { revision: current.revision });

  const decision = await request("/decisions", "POST", { question: "Eliminare?", answer: "" });
  await request("/decisions/" + decision.id, "DELETE", { revision: 0 }, 400);
  await request("/decisions/" + decision.id, "DELETE", { revision: 99 }, 409);
  const changed = await request("/decisions/" + decision.id, "PATCH", {
    ...decision, answer: "Sì",
  });
  await request("/decisions/" + decision.id, "DELETE", { revision: decision.revision }, 409);
  const removed = await request("/decisions/" + decision.id, "DELETE", { revision: changed.revision });
  assert.equal(removed.id, decision.id);
  await request("/decisions/" + decision.id, "DELETE", { revision: changed.revision }, 409);
  assert.ok(!(await request("/state")).decisions.some((d) => d.id === decision.id));
});

test("simultaneous task creation and section deletion cannot orphan tasks", async () => {
  const section = await request("/sections", "POST", { code: "RACE" });
  const r = await Promise.all([
    fetch(base + "/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input(section.id)),
    }),
    fetch(base + "/sections/" + section.id, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ revision: section.revision }),
    }),
  ]);
  const statuses = r.map((x) => x.status);
  assert.ok(
    (statuses[0] === 200 && statuses[1] === 409) ||
    (statuses[0] === 400 && statuses[1] === 200),
    "Unexpected concurrent outcomes: " + statuses.join(","),
  );
  const snapshot = await request("/state");
  for (const task of snapshot.tasks) {
    assert.ok(snapshot.sections.some((s) => s.id === task.section_id), task.id + " is orphaned.");
  }
  if (statuses[0] === 200) {
    const task = await r[0].json();
    await request("/tasks/" + task.id, "DELETE", { revision: task.revision });
    const fresh = snapshot.sections.find((s) => s.id === section.id);
    await request("/sections/" + section.id, "DELETE", { revision: fresh.revision });
  }
});

test("migration removes legacy section name without losing existing data", async () => {
  const before = await request("/state");
  const counters = await pool.query(
    "SELECT id,code,next_number FROM sections ORDER BY id",
  );
  await pool.query(
    "ALTER TABLE sections ADD COLUMN name text NOT NULL DEFAULT 'Legacy'",
  );
  await pool.query("UPDATE sections SET name=code");
  const { initialize } = await import("../services/db.js");
  await initialize();
  const columns = await pool.query(
    "SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='sections' AND column_name='name'",
  );
  assert.equal(columns.rowCount, 0);
  assert.deepEqual(await request("/state"), before);
  assert.deepEqual(
    (await pool.query("SELECT id,code,next_number FROM sections ORDER BY id")).rows,
    counters.rows,
  );
  await initialize(); // idempotent on already migrated databases
  assert.deepEqual(await request("/state"), before);
});

test("Docker healthcheck and root/subpath deployment routes", async () => {
  const origin = base.replace(/\/api$/, "");
  for (const prefix of ["", "/sportx-plan"]) {
    const home = await fetch(origin + prefix + "/");
    assert.equal(home.status, 200);
    assert.match(await home.text(), /src="\.\/app\.js"/);
    const asset = await fetch(origin + prefix + "/app.js");
    assert.equal(asset.status, 200);
    assert.match(asset.headers.get("content-type"), /javascript/);
    const health = await fetch(origin + prefix + "/api/health");
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { ok: true });
  }
  const redirect = await fetch(origin + "/sportx-plan?from=dokploy", {
    redirect: "manual",
  });
  assert.equal(redirect.status, 308);
  assert.equal(redirect.headers.get("location"), "/sportx-plan/?from=dokploy");
});


test("MCP endpoint uses the same persistent API state and validation", async () => {
  const old = process.env.SPORTX_MCP_TOKEN;
  const secret = "integration-test-" + "s".repeat(48);
  process.env.SPORTX_MCP_TOKEN = secret;
  const origin = base.slice(0, -4);
  const call = async (method, params = {}) => {
    const response = await fetch(origin + "/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + secret, Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 11, method, params }),
    });
    assert.equal(response.status, 200);
    return (await response.json()).result;
  };
  try {
    const initialized = await call("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "api-test", version: "1" } });
    assert.equal(initialized.protocolVersion, "2025-11-25");
    const tool = await call("tools/call", { name: "sportx_create_section", arguments: { code: "MCP" } });
    assert.equal(tool.structuredContent.code, "MCP");
    const state = await request("/state");
    assert.ok(state.sections.some((x) => x.code === "MCP"));
    const all = await call("tools/call", { name: "sportx_list_sections", arguments: {} });
    assert.ok(JSON.parse(all.content[0].text).some((x) => x.code === "MCP"));
  } finally {
    if (old === undefined) delete process.env.SPORTX_MCP_TOKEN;
    else process.env.SPORTX_MCP_TOKEN = old;
  }
});

test("conversations share REST and MCP profiles and preserve legacy messages", async (t) => {
  const secret = "conversation-application-test-" + "x".repeat(40);
  const previous = process.env.SPORTX_MCP_TOKEN;
  const previousTeam = process.env.SPORTX_CONVERSATION_TEAM;
  process.env.SPORTX_CONVERSATION_TEAM = "Ada,Luca,Marta";
  process.env.SPORTX_MCP_TOKEN = secret;
  t.after(() => {
    if (previous === undefined) delete process.env.SPORTX_MCP_TOKEN;
    else process.env.SPORTX_MCP_TOKEN = previous;
    if (previousTeam === undefined) delete process.env.SPORTX_CONVERSATION_TEAM;
    else process.env.SPORTX_CONVERSATION_TEAM = previousTeam;
  });
  const headers = (user) => ({
    "Content-Type": "application/json",
    ...(user ? { "X-SportX-Developer": user } : {}),
  });
  const inbox = async (user, path = "", data, expected = 200) => {
    const response = await fetch(base + "/conversations" + path, {
      method: data ? "POST" : "GET",
      headers: headers(user),
      body: data ? JSON.stringify(data) : undefined,
    });
    const value = await response.json();
    assert.equal(response.status, expected, JSON.stringify(value));
    return value;
  };
  const mcp = async (user, tool, args) => {
    const response = await fetch(base.slice(0, -4) + "/mcp", {
      method: "POST",
      headers: { ...headers(null), Authorization: "Bearer " + secret },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call",
        params: { name: "sportx_" + tool,
          arguments: ["register_developer", "list_developers"].includes(tool)
            ? args : { ...args, developer: user } } }),
    });
    assert.equal(response.status, 200);
    const { result } = await response.json();
    assert.ok(!result.isError, JSON.stringify(result));
    return result.structuredContent ?? JSON.parse(result.content[0].text);
  };

  const emptyBoard = await inbox(null, "/board");
  assert.deepEqual(emptyBoard.sections.map(({ name, member_ids }) => [name, member_ids]),
    [["Ada", []], ["Luca", []], ["Marta", []]]);
  assert.deepEqual(emptyBoard.threads, []);
  await inbox(null, "", undefined, 400);
  await inbox("ada", "", undefined, 404);
  assert.deepEqual(await inbox("ada", "/developers", { name: "Ada Rossi" }),
    { id: "ada", name: "Ada Rossi" });
  assert.deepEqual(await mcp(null, "register_developer", { name: "Ada Rossi" }),
    { id: "ada", name: "Ada Rossi" });
  assert.deepEqual(await inbox(null, "/developers", { name: "  ada   rossi  " }),
    { id: "ada", name: "Ada Rossi" });
  assert.deepEqual(await inbox(null, "/developers", { name: "Luca Bianchi" }),
    { id: "luca-bianchi", name: "Luca Bianchi" });
  await inbox("luca", "/developers", { name: "Luca Bianchi" }, 409);
  await inbox("marta", "/developers", { name: "Marta Verdi" });
  assert.deepEqual((await mcp(null, "list_developers", {})).map(({ id }) => id),
    ["ada", "luca-bianchi", "marta"]);
  const unauthenticated = await fetch(base.slice(0, -4) + "/mcp", {
    method: "POST",
    headers: headers("ada"),
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
  });
  assert.equal(unauthenticated.status, 401);
  const sent = await mcp("ada", "send_message", {
    recipient: "luca-bianchi", subject: "Contratto pagamenti", message: "Serve l’ID della richiesta.",
    reference: "DEC-02",
  });
  const path = "/" + sent.id;
  assert.deepEqual((await inbox("marta")).threads, []);
  await inbox("marta", path, undefined, 404);
  const board = await inbox(null, "/board");
  assert.deepEqual(board.sections.map(({ name, member_ids }) => [name, member_ids]),
    [["Ada", ["ada"]], ["Luca", ["luca-bianchi"]], ["Marta", ["marta"]]]);
  assert.deepEqual(board.threads.map(({ subject, unread_counts, waiting_by }) => [subject, unread_counts, waiting_by]),
    [["Contratto pagamenti", { ada: 0, "luca-bianchi": 1 }, ["luca-bianchi"]]]);
  const fromBoard = await inbox(null, "/board" + path);
  assert.equal(fromBoard.messages[0].author_id, "ada");
  assert.equal(fromBoard.messages[0].recipient_id, "luca-bianchi");
  assert.ok(fromBoard.messages[0].created_at);
  await inbox("marta", path + "/replies", { message: "Risposta di un estraneo" }, 404);
  await inbox("ada", path + "/replies", { message: "Aggiungo anche un esempio." });
  const first = await inbox("luca-bianchi", path);
  assert.equal(first.unread_count, 2);
  assert.deepEqual((await inbox(null, "/board" + path)).unread_counts, { ada: 0, "luca-bianchi": 2 });
  assert.equal(first.messages[0].author_id, "ada");
  assert.equal(first.unread, true);
  assert.equal(first.waiting_for_you, true);
  assert.equal(first.reference, "DEC-02");
  assert.ok(!(await request("/state")).conversations);
  await mcp("luca-bianchi", "mark_conversation_read", { thread_id: sent.id, through_id: first.messages[0].id });
  const partial = await mcp("luca-bianchi", "list_conversations", { unread_only: true });
  assert.equal(partial.threads[0].unread_count, 1);
  assert.deepEqual((await inbox(null, "/board" + path)).unread_counts, { ada: 0, "luca-bianchi": 1 });
  await mcp("luca-bianchi", "mark_conversation_read", { thread_id: sent.id, through_id: first.messages[1].id });
  assert.deepEqual((await mcp("luca-bianchi", "list_conversations", { unread_only: true })).threads, []);
  assert.equal((await inbox("luca-bianchi", path)).waiting_for_you, true);
  await inbox("luca-bianchi", path + "/replies", { message: "Sì, e anche l’ID pagamento." });
  const afterReply = await inbox("marta", "/board" + path);
  assert.equal(afterReply.subject, "Contratto pagamenti");
  assert.equal(afterReply.messages[2].recipient_id, "ada");
  assert.deepEqual(afterReply.waiting_by, []);
  assert.equal((await inbox("ada", path)).unread, true);
  assert.equal((await inbox("ada", path)).waiting_for_you, false);
  assert.equal((await inbox("luca-bianchi", path)).waiting_for_you, false);
  await inbox("ada", path + "/proposal", { message: "Versione 1", version: 0 }, 404);
  await inbox("luca-bianchi", path + "/confirmation", { version: 1 }, 404);
  await pool.query("UPDATE conversation_threads SET agreement_version=1 WHERE id=$1", [sent.id]);
  await pool.query(
    `INSERT INTO conversation_messages(thread_id,author_id,body,kind,agreement_version)
     VALUES($1,'ada','Proposta storica','proposal',1),($1,'luca-bianchi','','confirmation',1)`, [sent.id],
  );
  await inbox("ada", path + "/read", { through_id: first.messages[0].id });
  const detail = await mcp("ada", "read_conversation", { thread_id: sent.id });
  assert.deepEqual(detail.messages.slice(-2).map(({ kind, body }) => [kind, body]),
    [["proposal", "Proposta storica"], ["confirmation", ""]]);
  assert.deepEqual(detail.waiting_by, []);
  assert.equal(detail.unread, true);
  await inbox("ada", path + "/read", { through_id: detail.messages.at(-1).id });
  await inbox("ada", path + "/read", { through_id: first.messages[0].id });
  assert.equal((await inbox("ada", path)).unread, false);
  assert.deepEqual(await mcp(null, "register_developer", { name: "Paolo Neri" }),
    { id: "paolo-neri", name: "Paolo Neri" });
  assert.equal((await mcp("paolo-neri", "list_conversations", { unread_only: true })).me.id,
    "paolo-neri");
  const roster = await inbox(null, "/board");
  assert.deepEqual(roster.sections.map(({ name }) => name), ["Ada", "Luca", "Marta"]);
  assert.deepEqual(roster.members.map(({ id }) => id), ["ada", "luca-bianchi", "marta"]);
  await mcp(null, "register_developer", { name: "Ilaria Verdi" });
  const archived = await mcp("paolo-neri", "send_message", {
    recipient: "ilaria-verdi", subject: "Storico", message: "Messaggio precedente",
  });
  const archiveBoard = await inbox(null, "/board");
  assert.deepEqual(archiveBoard.sections.map(({ name }) => name), ["Ada", "Luca", "Marta", "Archivio"]);
  assert.deepEqual(archiveBoard.sections.at(-1).thread_ids, [archived.id]);
  assert.equal((await inbox(null, "/board/" + archived.id)).subject, "Storico");
  const missingDeveloper = await fetch(base.slice(0, -4) + "/mcp", {
    method: "POST",
    headers: { ...headers(null), Authorization: "Bearer " + secret },
    body: JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tools/call",
      params: { name: "sportx_list_conversations", arguments: {} } }),
  });
  assert.equal(missingDeveloper.status, 200);
  const { result: missingResult } = await missingDeveloper.json();
  assert.equal(missingResult.isError, true);
  assert.match(missingResult.content[0].text, /developer/);
});

test("configured teammates can exchange messages before registration and keep their thread", async (t) => {
  const old = process.env.SPORTX_CONVERSATION_TEAM;
  process.env.SPORTX_CONVERSATION_TEAM = "Ada,Luca,Lea";
  t.after(() => {
    if (old === undefined) delete process.env.SPORTX_CONVERSATION_TEAM;
    else process.env.SPORTX_CONVERSATION_TEAM = old;
  });
  const { initializeConversationTeam } = await import("../services/conversations.js");
  await Promise.all([initializeConversationTeam(), initializeConversationTeam()]);
  const board = await request("/conversations/board");
  assert.deepEqual(board.members.map(({ id }) => id), ["ada", "luca-bianchi", "lea"]);
  const replyAs = (developer, path, data) => fetch(base + "/conversations" + path, {
    method: data ? "POST" : "GET",
    headers: { "Content-Type": "application/json", "X-SportX-Developer": developer },
    body: data ? JSON.stringify(data) : undefined,
  });
  const sent = await replyAs("ada", "", { recipient: "lea", subject: "Interfaccia", message: "Puoi controllare il campo?" });
  assert.equal(sent.status, 200);
  const { id } = await sent.json();
  const answer = await replyAs("lea", "/" + id + "/replies", { message: "Sì, possiamo usarlo." });
  assert.equal(answer.status, 200);
  const profile = await request("/conversations/developers", "POST", { name: "Lea Rossi" });
  assert.deepEqual(profile, { id: "lea", name: "Lea Rossi" });
  assert.deepEqual(await request("/conversations/developers", "POST", { name: "Lea" }), profile);
  const refreshed = await request("/conversations/board");
  assert.deepEqual(refreshed.members.at(-1), { id: "lea", name: "Lea" });
  const thread = await replyAs("lea", "/" + id);
  assert.equal(thread.status, 200);
  assert.deepEqual((await thread.json()).messages.map(({ author_id }) => author_id), ["ada", "lea"]);
});
