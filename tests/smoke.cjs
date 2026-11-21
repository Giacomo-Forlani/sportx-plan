const assert = require("node:assert/strict");
const puppeteer = require(
  process.env.PUPPETEER_MODULE ||
    "/usr/local/lib/node_modules/@wonderwhy-er/desktop-commander/node_modules/puppeteer",
);
(async () => {
  if (!process.env.PGDATABASE?.endsWith("_test"))
    throw new Error("Use PGDATABASE ending in _test.");
  process.env.NODE_ENV = "test";
  const { pool } = await import("../services/db.js");
  const { start } = await import("../services/server.js");
  const database = await pool.query("SELECT current_database() AS name");
  assert.equal(database.rows[0].name, process.env.PGDATABASE, "Database di test inatteso");
  await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
  const server = await start(0);
  const browser = await puppeteer.launch({
    executablePath:
      process.env.CHROME_BIN ||
      "/workspace/.chatgpt-state/dc-settings/puppeteer-cache/chrome/linux-156.0.8078.73/chrome-linux64/chrome",
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const errors = [];
  try {
    const a = await browser.newPage(),
      context = await browser.createBrowserContext(),
      b = await context.newPage();
    for (const page of [a, b]) {
      page.on("pageerror", (e) => errors.push(e.message));
      await page.setViewport({ width: 1440, height: 1000 });
      await page.goto(
        "http://127.0.0.1:" + server.address().port + "/sportx-plan/",
        { waitUntil: "networkidle0" },
      );
      await page.waitForFunction(
        () => document.querySelector("#stat-total").textContent === "30",
      );
    }
    // The OS preference controls the dashboard. Chromium maps no-preference to light.
    const colors = async (preference) => {
      await a.emulateMediaFeatures([
        { name: "prefers-color-scheme", value: preference },
      ]);
      return a.evaluate(() => {
        const style = (selector) => getComputedStyle(document.querySelector(selector));
        return {
          scheme: style("html").colorScheme,
          background: style("body").backgroundColor,
          sidebar: style(".sidebar").backgroundColor,
          panel: style(".panel").backgroundColor,
          field: style("#task-search").backgroundColor,
          text: style("body").color,
        };
      });
    };
    const dark = await colors("dark");
    assert.equal(dark.scheme, "dark");
    assert.equal(dark.background, "rgb(12, 20, 34)");
    assert.equal(dark.sidebar, dark.panel);
    assert.equal(dark.panel, dark.field);
    const light = await colors("light");
    assert.equal(light.scheme, "light");
    assert.equal(light.background, "rgb(246, 247, 249)");
    assert.notEqual(light.sidebar, dark.sidebar);
    assert.notEqual(light.text, dark.text);
    const noPreference = await colors("no-preference");
    assert.equal(noPreference.scheme, "light");
    assert.equal(noPreference.background, light.background);
    await a.emulateMediaFeatures([
      { name: "prefers-color-scheme", value: "dark" },
    ]);
    await a.click('[data-view="backlog"]');
    await a.click("#add-section");
    await a.type("#section-code", "TEST");
    await a.click("#section-form button[type=submit]");
    await a.waitForSelector("#section-dialog:not([open])");
    await a.waitForFunction(
      () => document.querySelector("#task-sections .backlog-section:last-child h2")?.textContent === "TEST",
    );
    assert.equal(
      await a.$eval("#task-sections .backlog-section:last-child h2", (e) => e.textContent),
      "TEST",
    );
    a.on("dialog", (d) => d.accept());
    assert.equal(
      await a.$eval('[aria-label="Elimina sezione TEST"]', (e) => e.disabled),
      false,
    );
    await a.click('[aria-label="Elimina sezione TEST"]');
    await a.waitForFunction(
      () => ![...document.querySelectorAll(".backlog-section h2")].some((e) => e.textContent === "TEST"),
    );
    await a.click("#add-section");
    await a.type("#section-code", "TEST");
    await a.click("#section-form button[type=submit]");
    await a.waitForSelector("#section-dialog:not([open])");
    await a.waitForFunction(
      () => [...document.querySelectorAll(".backlog-section h2")].some((e) => e.textContent === "TEST"),
    );
    await a.click("#add-task");
    assert.equal(
      await a.$eval("#editor-section option:last-child", (e) => e.textContent),
      "TEST",
    );
    await a.select(
      "#editor-section",
      await a.$eval("#editor-section option:last-child", (e) => e.value),
    );
    await a.type("#editor-title", "Attività condivisa");
    await a.type(
      "#editor-description",
      "Una descrizione che non appare nella card",
    );
    await a.click("#task-form button[type=submit]");
    await a.waitForSelector('[data-id="TEST-01"]');
    assert.equal(await a.$eval('[aria-label="Elimina sezione TEST"]', (e) => e.disabled), true);
    assert.doesNotMatch(
      await a.$eval('[data-id="TEST-01"]', (e) => e.textContent),
      /descrizione/,
    );
    await b.click('[data-view="backlog"]');
    await b.waitForSelector('[data-id="TEST-01"]', { timeout: 12000 });
    await a.click('[data-id="TEST-01"] .task-open');
    await a.select("#editor-status", "In corso");
    await a.click("#task-form button[type=submit]");
    await a.waitForFunction(
      () =>
        document.querySelector('[data-id="TEST-01"] .status-badge')
          .textContent === "In corso",
    );
    await b.waitForFunction(
      () =>
        document.querySelector('[data-id="TEST-01"] .status-badge')
          .textContent === "In corso",
      { timeout: 12000 },
    );
    await a.click('[data-id="TEST-01"] .danger');
    await a.waitForFunction(
      () => !document.querySelector('[data-id="TEST-01"]'),
    );
    await a.click("#add-task");
    await a.select(
      "#editor-section",
      await a.$eval("#editor-section option:last-child", (e) => e.value),
    );
    await a.type("#editor-title", "Seconda attività");
    await a.click("#task-form button[type=submit]");
    await a.waitForSelector('[data-id="TEST-02"]');
    await a.click('[data-view="decisioni"]');
    await a.click("#add-decision");
    await a.type("#new-question", "Domanda condivisa?");
    await a.click("#new-decision button[type=submit]");
    await a.waitForFunction(
      () =>
        document.querySelector('[data-answered="false"] .decision textarea')
          ?.value === "Domanda condivisa?",
    );
    const decisionId = await a.$eval(
      '[data-answered="false"] .decision',
      (e) => e.dataset.id,
    );
    await a.type(
      '[data-answered="false"] .decision label:nth-of-type(2) textarea',
      "Risposta del team",
    );
    await a.click('[data-answered="false"] .decision button[type=submit]');
    await a.waitForSelector(
      '[data-answered="true"] .decision[data-id="' + decisionId + '"]',
    );
    await a.click('[data-answered="true"] .decision[data-id="' + decisionId + '"] .decision-remove');
    await a.waitForFunction(
      (id) => !document.querySelector('.decision[data-id="' + id + '"]'),
      {},
      decisionId,
    );
    await a.click('[data-view="backlog"]');
    assert.equal(await a.$eval('[aria-label="Elimina sezione TEST"]', (e) => e.disabled), true);
    await a.click('[data-id="TEST-02"] .danger');
    await a.waitForFunction(() => !document.querySelector('[data-id="TEST-02"]'));
    await a.waitForFunction(
      () => !document.querySelector('[aria-label="Elimina sezione TEST"]').disabled,
    );
    await a.click('[aria-label="Elimina sezione TEST"]');
    await a.waitForFunction(
      () => ![...document.querySelectorAll(".backlog-section h2")].some((e) => e.textContent === "TEST"),
    );
    await a.click('[data-view="documento"]');
    await a.waitForSelector("#document-preview:not(.hidden) h1");
    assert.equal(await a.$eval("#preview-document", (e) => e.textContent.trim()), "Modifica testo");
    assert.equal(await a.$eval("#document-text", (e) => e.classList.contains("hidden")), true);
    assert.equal(await a.$("#save-document"), null);
    await a.click("#preview-document");
    await a.waitForSelector("#document-text:not(.hidden)");
    assert.equal(await a.$eval("#preview-document", (e) => e.textContent.trim()), "Anteprima");
    await a.$eval("#document-text", (e) => {
      e.value = "# Test condiviso\n\n**Testo Markdown**";
      e.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await a.waitForFunction(
      () => document.querySelector("#document-status").textContent === "Salvato",
      { timeout: 12000 },
    );
    await a.click("#preview-document");
    await a.waitForSelector("#document-preview:not(.hidden) strong");
    assert.equal(
      await a.$eval("#document-preview strong", (e) => e.textContent),
      "Testo Markdown",
    );
    await b.click('[data-view="documento"]');
    await b.waitForFunction(
      () => document.querySelector("#document-preview:not(.hidden) strong")?.textContent === "Testo Markdown",
      { timeout: 12000 },
    );
    assert.equal(await b.$eval("#document-text", (e) => e.classList.contains("hidden")), true);
    await a.click('[data-view="backlog"]');
    await a.click('[data-view="documento"]');
    await a.waitForSelector("#document-preview:not(.hidden) strong");
    assert.equal(await a.$eval("#preview-document", (e) => e.textContent.trim()), "Modifica testo");

    // A second edit made while the first autosave is in flight must not be lost.
    await a.click("#preview-document");
    await a.evaluate(() => {
      const original = window.fetch.bind(window);
      let delayNextDocumentWrite = true;
      window.fetch = async (...args) => {
        if (
          delayNextDocumentWrite &&
          String(args[0]).endsWith("/api/document") &&
          args[1]?.method === "PUT"
        ) {
          delayNextDocumentWrite = false;
          await new Promise((resolve) => setTimeout(resolve, 900));
        }
        return original(...args);
      };
    });
    await a.$eval("#document-text", (e) => {
      e.value = "# Documento aggiornato\n\n**Prima versione**";
      e.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await a.waitForFunction(
      () => document.querySelector("#document-status").textContent === "Salvataggio…",
      { timeout: 12000 },
    );
    await a.$eval("#document-text", (e) => {
      e.value = "# Documento aggiornato\n\n**Da un collega**";
      e.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await a.waitForFunction(
      () => document.querySelector("#document-status").textContent === "Salvato",
      { timeout: 12000 },
    );
    await b.waitForFunction(
      () => document.querySelector("#document-preview strong")?.textContent === "Da un collega",
      { timeout: 12000 },
    );
    const savedDocument = await a.evaluate(async () => {
      const r = await fetch("./api/state");
      return (await r.json()).document;
    });
    assert.equal(savedDocument.markdown, "# Documento aggiornato\n\n**Da un collega**");

    // A revision conflict never silently overwrites the shared document or the local draft.
    await a.evaluate(() => {
      const original = window.fetch.bind(window);
      window.fetch = (...args) => {
        if (String(args[0]).endsWith("/api/document") && args[1]?.method === "PUT") {
          return Promise.resolve(
            new Response(JSON.stringify({ error: "Revisione non valida." }), {
              status: 409,
              headers: { "Content-Type": "application/json" },
            }),
          );
        }
        return original(...args);
      };
    });
    await a.$eval("#document-text", (e) => {
      e.value = "# Bozza in conflitto";
      e.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await a.waitForFunction(
      () => document.querySelector("#document-status").textContent.includes("Conflitto:"),
      { timeout: 12000 },
    );
    assert.equal(await a.$eval("#document-text", (e) => e.value), "# Bozza in conflitto");
    assert.equal(
      (await a.evaluate(async () => (await (await fetch("./api/state")).json()).document.markdown)),
      savedDocument.markdown,
    );
    await a.setViewport({ width: 375, height: 812 });
    for (const view of ["panoramica", "backlog", "decisioni", "documento"]) {
      await a.evaluate((v) => (location.hash = v), view);
      await a.waitForFunction(
        (v) =>
          !document.querySelector("#view-" + v).classList.contains("hidden"),
        {},
        view,
      );
      assert.ok(
        await a.evaluate(() => document.body.scrollWidth <= innerWidth + 2),
        "Mobile overflow " + view,
      );
    }
    assert.equal(await a.$$eval('[data-view="rilasci"]', (e) => e.length), 0);
    assert.deepEqual(errors, []);
    await a.screenshot({ path: "/tmp/sportx-plan-mobile.png", fullPage: true });
    console.log(
      "OK: two browsers, shared edits, deletion and numbering, inline decisions, Markdown, mobile, no JavaScript errors.",
    );
  } finally {
    await browser.close();
    await new Promise((r) => server.close(r));
    await pool.end();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
