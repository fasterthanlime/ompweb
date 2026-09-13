import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const toolingRoot = process.env.VISUAL_SANITIZE_PLAYWRIGHT_DIR;

if (!toolingRoot) {
  test("sanitizes hostile visual boundaries in a real browser", { skip: "Set VISUAL_SANITIZE_PLAYWRIGHT_DIR to an existing Playwright/esbuild checkout" }, () => {});
} else {
  const { chromium } = await import(pathToFileURL(join(toolingRoot, "node_modules/playwright/index.mjs")).href);
  const { build } = await import(pathToFileURL(join(toolingRoot, "node_modules/esbuild/lib/main.js")).href);
  const workDir = await mkdtemp(join(tmpdir(), "ompweb-visual-sanitize-"));
  const bundlePath = join(workDir, "visual-sanitize.js");
  await build({
    stdin: {
      contents: `import { sanitizeVisual } from ${JSON.stringify(join(process.cwd(), "lib/visual-sanitize.ts"))}; window.sanitizeVisual = sanitizeVisual;`,
      resolveDir: process.cwd(),
      loader: "ts",
    },
    bundle: true,
    platform: "browser",
    outfile: bundlePath,
  });

  test("sanitizes hostile visual boundaries in a real browser", async () => {
    const browser = await chromium.launch({ args: ["--no-sandbox"] });
    try {
      const page = await browser.newPage();
      await page.setContent("<!doctype html><html><body></body></html>");
      await page.addScriptTag({ path: bundlePath });
      const result = await page.evaluate(() => {
        const safe = window.sanitizeVisual(
          '<header>Title</header><main><svg><defs><linearGradient id="paint"><stop offset="0" /></linearGradient></defs><path fill="url(#paint)" d="M0 0" /></svg><button>Mock</button></main>',
          ".card{display:grid;color:light-dark(#111,#eee);background:linear-gradient(red,blue);overflow:hidden}",
        );
        const hostile = window.sanitizeVisual(
          '<script>alert(1)</script><form action="https://evil.invalid"><input onerror="alert(1)"><img src="https://evil.invalid/a"><button onmouseover="alert(1)">Mock</button>',
          '.card{background:url(https://evil.invalid/a);position:fixed;animation:spin 1s;color:red}.card:hover{color:blue}.card{& .child{color:green}}@import url(https://evil.invalid);@supports(display:grid){.card{color:purple}}@media (max-width:999999999999999999999px){.card{color:pink}}',
        );
        const escaped = window.sanitizeVisual(
          '<svg><path fill="url(https://evil.invalid/a)" d="M0 0" /></svg>',
          ".card{background:u\\72 l(https://evil.invalid);p\\6f sition:fixed}",
        );
        return { safe, hostile, escaped };
      });

      assert.match(result.safe.html, /<header>Title<\/header>/);
      assert.match(result.safe.html, /<button type="button" disabled="" tabindex="-1">Mock<\/button>/);
      assert.match(result.safe.html, /fill="url\(#paint\)"/);
      assert.match(result.safe.css, /linear-gradient/);
      assert.equal(result.safe.warnings.length, 0);

      assert.doesNotMatch(result.hostile.html, /script|form|input|img|onmouseover|onerror|action=/i);
      assert.match(result.hostile.html, /<button type="button" disabled="" tabindex="-1">Mock<\/button>/);
      assert.doesNotMatch(result.hostile.css, /url|position|animation|@import|@supports|:hover|pink|green|purple/i);
      assert.match(result.hostile.css, /color:red/);
      assert.ok(result.hostile.warnings.length > 0);

      assert.doesNotMatch(result.escaped.html, /https:\/\/evil\.invalid/i);
      assert.doesNotMatch(result.escaped.css, /url|position/i);
      assert.ok(result.escaped.warnings.length > 0);
    } finally {
      await browser.close();
    }
  });

  test.after(async () => {
    await rm(workDir, { recursive: true, force: true });
  });
}

