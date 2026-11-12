import { test, after } from "node:test";
import assert from "node:assert/strict";
// This suite must run against a dedicated disposable database.
if (!process.env.PGDATABASE?.endsWith("_test"))
  throw new Error("Use a dedicated PGDATABASE ending in _test.");
process.env.NODE_ENV = "test";
const { start } = await import("../services/server.js");
const { pool } = await import("../services/db.js");
const database = await pool.query("SELECT current_database() AS name");
  assert.equal(database.rows[0].name, process.env.PGDATABASE, "Database di test inatteso");
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
  const section = await request("/sections", "POST", {
    code: "QA",
    name: "Verifiche",
  });
  await request("/sections", "POST", { code: "qa", name: "Duplicata" }, 409);
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
    body: JSON.stringify({ code: "X", name: "X" }),
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
