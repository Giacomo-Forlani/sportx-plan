import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

const { handleMcp } = await import(process.env.SPORTX_MCP_MODULE || "../services/mcp.js");
const token = "mcp-isolated-test-secret-" + "x".repeat(40);
process.env.SPORTX_MCP_TOKEN = token;
const calls = [];
const state = {
  sections: [{ id: 1, code: "ARCH", revision: 2 }],
  tasks: [{ id: "ARCH-01", section_id: 1, title: "Schema", description: "", owner: "", status: "Da fare", priority: "P1", revision: 2 }],
  decisions: [{ id: 3, question: "Conferma?", answer: "", revision: 1 }],
  document: { markdown: "# Piano", revision: 4 },
};
async function api(req, path) {
  let input;
  if (req.method !== "GET") {
    let text = "";
    for await (const chunk of req) text += chunk;
    input = JSON.parse(text);
  }
  calls.push({ method: req.method, path, input });
  if (req.method === "GET" && path === "/state") return state;
  if (req.method === "GET" && path === "/conversations/developers")
    return [{ id: "ada", name: "Ada Rossi" }];
  if (req.method === "GET" && path === "/conversations") {
    assert.equal(req.headers["x-sportx-developer"], "ada");
    return { me: { id: "ada", name: "Ada Rossi" }, members: [], threads: [] };
  }
  if (path === "/sections" && req.method === "POST") return { id: 2, code: input.code, revision: 1 };
  if (path === "/sections/1" && req.method === "DELETE") return { id: 1, code: "ARCH" };
  if (path === "/tasks" && req.method === "POST") return { id: "ARCH-02", ...input };
  if (path === "/tasks/ARCH-01" && req.method === "PATCH") {
    const e = new Error("Revisione non più valida."); e.status = 409; throw e;
  }
  if (path === "/tasks/ARCH-01" && req.method === "DELETE") return { id: "ARCH-01" };
  if (path === "/decisions" && req.method === "POST") return { id: 4, ...input };
  if (path === "/decisions/3" && req.method === "PATCH") return { id: 3, ...input };
  if (path === "/decisions/3" && req.method === "DELETE") return { id: 3, code: "DEC-03" };
  if (path === "/document" && req.method === "PUT") return input;
  throw new Error("Unexpected mocked API path: " + path);
}
const server = http.createServer((req, res) => handleMcp(req, res, api));
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const url = "http://127.0.0.1:" + server.address().port + "/mcp";
after(async () => {
  await new Promise((resolve) => server.close(resolve));
  delete process.env.SPORTX_MCP_TOKEN;
});
async function send(method, params = {}, options = {}) {
  const modern = options.modern ?? false;
  const meta = modern ? {
    _meta: {
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientCapabilities": {},
    },
  } : {};
  const request = { jsonrpc: "2.0", id: options.id ?? 1, method, params: { ...params, ...meta } };
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    Authorization: "Bearer " + token,
    ...(modern ? { "MCP-Protocol-Version": "2026-07-28", "Mcp-Method": method, ...(method === "tools/call" ? { "Mcp-Name": params.name } : {}) } : {}),
    ...options.headers,
  };
  const response = await fetch(url, { method: "POST", headers, body: JSON.stringify(request) });
  return { status: response.status, data: await response.json() };
}
test("MCP remains disabled without a configured token and rejects unauthorized access", async () => {
  const before = process.env.SPORTX_MCP_TOKEN;
  delete process.env.SPORTX_MCP_TOKEN;
  const disabled = await send("tools/list");
  assert.equal(disabled.status, 503);
  process.env.SPORTX_MCP_TOKEN = before;
  const without = await fetch(url, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
  });
  assert.equal(without.status, 401);
  const origin = await send("tools/list", {}, { headers: { Origin: "https://evil.example" } });
  assert.equal(origin.status, 403);
  const get = await fetch(url, { headers: { Authorization: "Bearer " + token } });
  assert.equal(get.status, 405);
});
test("legacy initialize and complete tools catalogue", async () => {
  const hello = await send("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "1" } });
  assert.equal(hello.status, 200);
  assert.equal(hello.data.result.protocolVersion, "2025-11-25");
  const list = await send("tools/list");
  assert.equal(list.data.result.tools.length, 23);
  const names = list.data.result.tools.map((x) => x.name);
  assert.ok(names.includes("sportx_update_document"));
  assert.ok(names.includes("sportx_register_developer"));
  assert.ok(names.includes("sportx_list_developers"));
  assert.ok(names.includes("sportx_list_conversations"));
  assert.ok(names.includes("sportx_delete_task"));
  assert.ok(names.includes("sportx_delete_section"));
  assert.ok(names.includes("sportx_delete_decision"));
});
test("conversation identity is selected per tool call, never taken from client headers", async () => {
  const directory = await send("tools/call", { name: "sportx_list_developers", arguments: {} });
  assert.equal(directory.data.result.content[0].text.includes("Ada Rossi"), true);
  const missing = await send("tools/call", { name: "sportx_list_conversations", arguments: {} },
    { headers: { "X-SportX-Developer": "ada" } });
  assert.equal(missing.data.result.isError, true);
  assert.match(missing.data.result.content[0].text, /developer/);
  const inbox = await send("tools/call", {
    name: "sportx_list_conversations", arguments: { developer: "ada", unread_only: true },
  }, { headers: { "X-SportX-Developer": "someone-else" } });
  assert.equal(inbox.data.result.structuredContent.me.id, "ada");
  assert.deepEqual(inbox.data.result.structuredContent.threads, []);
});

test("modern discovery and list use required protocol metadata", async () => {
  const discover = await send("server/discover", {}, { modern: true });
  assert.equal(discover.status, 200);
  assert.deepEqual(discover.data.result.supportedVersions, ["2026-07-28", "2025-11-25"]);
  assert.equal(discover.data.result.resultType, "complete");
  assert.equal(discover.data.result._meta["io.modelcontextprotocol/serverInfo"].name, "sportx-plan");
  const list = await send("tools/list", {}, { modern: true });
  assert.equal(list.data.result.tools.length, 23);
  const invalid = await send("tools/list", {}, { modern: true, headers: { "Mcp-Method": "tools/call" } });
  assert.equal(invalid.status, 400);
});
test("read filters, writes, revisions and explicit confirmation", async () => {
  const stateResult = await send("tools/call", { name: "sportx_get_state", arguments: {} }, { modern: true });
  assert.equal(stateResult.data.result.structuredContent.document.markdown, "# Piano");
  const tasks = await send("tools/call", { name: "sportx_list_tasks", arguments: { section_id: 1 } });
  assert.equal(JSON.parse(tasks.data.result.content[0].text)[0].id, "ARCH-01");
  const sections = await send("tools/call", { name: "sportx_create_section", arguments: { code: "DISC" } });
  assert.equal(sections.data.result.structuredContent.code, "DISC");
  const created = await send("tools/call", { name: "sportx_create_task", arguments: { section_id: 1, title: "MCP" } });
  assert.equal(created.data.result.structuredContent.status, "Da fare");
  assert.equal(created.data.result.structuredContent.priority, "P1");
  const missing = await send("tools/call", { name: "sportx_delete_task", arguments: { id: "ARCH-01", revision: 2 } });
  assert.equal(missing.data.result.isError, true);
  assert.equal(calls.filter((x) => x.method === "DELETE").length, 0);
  const removed = await send("tools/call", { name: "sportx_delete_task", arguments: { id: "ARCH-01", revision: 2, confirm: true } });
  assert.equal(removed.data.result.structuredContent.id, "ARCH-01");
  const sectionsBefore = calls.filter((x) => x.method === "DELETE" && x.path.startsWith("/sections/")).length;
  const refuseSection = await send("tools/call", { name: "sportx_delete_section", arguments: { section_id: 1, revision: 2 } });
  assert.equal(refuseSection.data.result.isError, true);
  assert.equal(calls.filter((x) => x.method === "DELETE" && x.path.startsWith("/sections/")).length, sectionsBefore);
  const deletedSection = await send("tools/call", { name: "sportx_delete_section", arguments: { section_id: 1, revision: 2, confirm: true } });
  assert.equal(deletedSection.data.result.structuredContent.code, "ARCH");
  assert.deepEqual(calls.at(-1), { method: "DELETE", path: "/sections/1", input: { revision: 2 } });
  const refuseDecision = await send("tools/call", { name: "sportx_delete_decision", arguments: { decision_id: 3, revision: 1, confirm: false } });
  assert.equal(refuseDecision.data.result.isError, true);
  const deletedDecision = await send("tools/call", { name: "sportx_delete_decision", arguments: { decision_id: 3, revision: 1, confirm: true } });
  assert.equal(deletedDecision.data.result.structuredContent.id, 3);
  assert.deepEqual(calls.at(-1), { method: "DELETE", path: "/decisions/3", input: { revision: 1 } });
  const conflicted = await send("tools/call", {
    name: "sportx_update_task",
    arguments: { id: "ARCH-01", revision: 2, title: "Schema", description: "", owner: "", status: "Da fare", priority: "P1" },
  });
  assert.equal(conflicted.data.result.isError, true);
  assert.match(conflicted.data.result.content[0].text, /Revisione/);
  const doc = await send("tools/call", { name: "sportx_update_document", arguments: { markdown: "Nuovo", revision: 4 } });
  assert.equal(doc.data.result.structuredContent.markdown, "Nuovo");
  const invalid = await send("tools/call", { name: "sportx_read_document", arguments: { unknown: 1 } });
  assert.equal(invalid.data.result.isError, true);
});
