const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const puppeteer = require(
  process.env.PUPPETEER_MODULE ||
    "/usr/local/lib/node_modules/@wonderwhy-er/desktop-commander/node_modules/puppeteer",
);

(async () => {
  const css = fs.readFileSync(path.join(__dirname, "../src/style.css"), "utf8");
  const browser = await puppeteer.launch({
    executablePath:
      process.env.CHROME_BIN ||
      "/workspace/.chatgpt-state/dc-settings/puppeteer-cache/chrome/linux-156.0.8078.73/chrome-linux64/chrome",
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });

  try {
    const page = await browser.newPage();
    await page.setContent(`
      <style>${css}</style>
      <div class="app">
        <aside class="sidebar"></aside>
        <main class="main">
          <div class="content">
            <article class="markdown panel" id="document-preview">
              <h1>Documento SportX</h1>
              <div class="markdown-table-scroll" role="region" tabindex="0">
              <table>
                <thead><tr>
                  <th>Codice</th><th>Argomento</th><th>Release</th>
                  <th>Domanda</th><th>Risposta</th><th>Priorità</th>
                </tr></thead>
                <tbody><tr>
                  <td>DEC-29</td><td>Collegamento account-persona</td><td>R1</td>
                  <td>Chi avvia e approva il collegamento? Come verificare l'identità?</td>
                  <td>Per verificare il profilo possiamo usare il codice fiscale. Approvazione automatica tramite mail e codice fiscale.</td>
                  <td>P0</td>
                </tr></tbody>
              </table>
              </div>
            </article>
          </div>
        </main>
      </div>
    `);

    for (const width of [1320, 375]) {
      await page.setViewport({ width, height: 800 });
      const metrics = await page.evaluate(() => {
        const preview = document.querySelector("#document-preview");
        const scroll = preview.querySelector(".markdown-table-scroll");
        const table = scroll.querySelector("table");
        const id = table.querySelector("tbody td");
        const range = document.createRange();
        range.selectNodeContents(id);
        return {
          display: getComputedStyle(table).display,
          idWidth: id.getBoundingClientRect().width,
          idLineCount: range.getClientRects().length,
          tableWidth: table.getBoundingClientRect().width,
          previewWidth: preview.clientWidth,
          scrollWidth: scroll.scrollWidth,
          scrollClientWidth: scroll.clientWidth,
          previewScrollWidth: preview.scrollWidth,
          bodyWidth: document.body.scrollWidth,
          viewport: innerWidth,
        };
      });
      assert.equal(metrics.display, "table");
      assert.ok(metrics.idWidth >= 105, `ID troppo stretto: ${JSON.stringify(metrics)}`);
      assert.equal(metrics.idLineCount, 1, `Codice a capo: ${JSON.stringify(metrics)}`);
      assert.ok(metrics.tableWidth < 2300, `Tabella eccessivamente larga: ${JSON.stringify(metrics)}`);
      assert.ok(metrics.bodyWidth <= metrics.viewport + 2, `Overflow pagina: ${JSON.stringify(metrics)}`);
      assert.ok(metrics.previewScrollWidth <= metrics.previewWidth + 2, "Overflow anteprima");
      assert.ok(metrics.scrollWidth > metrics.scrollClientWidth, "Scroll tabella non disponibile");
      console.log(`OK layout Markdown ${width}px:`, metrics);
    }
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
