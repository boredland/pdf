import { expect, test } from "bun:test";
import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const baselinePath = join(repoRoot, "tests/fixtures/ocr/skew.tesseract.eng.txt");
const reportPath = join(repoRoot, "test-results/ocr-provider-quality.json");

const language = process.env.OCR_QUALITY_LANGUAGE ?? "eng";
const exampleId = process.env.OCR_QUALITY_EXAMPLE ?? "scanned";
const pageIndex = Number.parseInt(process.env.OCR_QUALITY_PAGE ?? "0", 10);
const port = Number.parseInt(process.env.OCR_QUALITY_PORT ?? "4173", 10);

test(
  "plots OCR quality for each provider",
  async () => {
    const baselineText = await readFile(baselinePath, "utf8");
    const server = await startServer(repoRoot, port);
    const browser = await chromium.launch();

    try {
      const providers = await resolveProviders(browser, port);
      expect(providers.length).toBeGreaterThan(0);

      const results = [];
      for (const provider of providers) {
        results.push(await benchmarkProvider({
          browser,
          port,
          provider,
          baselineText,
        }));
      }

      results.sort((a, b) => scoreValue(b) - scoreValue(a));
      await mkdir(dirname(reportPath), { recursive: true });
      await writeFile(
        reportPath,
        JSON.stringify(
          {
            language,
            exampleId,
            pageIndex,
            generatedAt: new Date().toISOString(),
            results,
          },
          null,
          2,
        ),
      );

      printResults(results);
      console.log(`\nSaved OCR provider report to ${reportPath}`);

      const measured = results.filter((result) => !result.error);
      expect(measured.length).toBeGreaterThan(0);
    } finally {
      await browser.close();
      await stopServer(server);
    }
  },
  10 * 60 * 1000,
);

async function resolveProviders(browser, port) {
  const configured = process.env.OCR_QUALITY_PROVIDERS?.split(",")
    .map((providerId) => providerId.trim())
    .filter(Boolean);
  if (configured?.length) {
    return configured.map((id) => ({ id, label: id, kind: "unknown" }));
  }

  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "networkidle" });
    await waitForHarness(page);
    return await page.evaluate(async () => {
      const app = window.__pdfApp;
      if (!app) throw new Error("test harness not available");

      const providers = app.ocr.listProviders().map((provider) => ({
        id: provider.id,
        label: provider.label,
        kind: provider.kind,
      }));

      const out = [];
      for (const provider of providers) {
        if (provider.kind === "hosted") {
          const hasKey = await app.apiKeys.has(provider.id);
          if (!hasKey) continue;
        }
        out.push(provider);
      }
      return out;
    });
  } finally {
    await context.close();
  }
}

async function benchmarkProvider({ browser, port, provider, baselineText }) {
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "networkidle" });
    await waitForHarness(page);

    const actual = await page.evaluate(
      async ({ providerId, language, exampleId, pageIndex }) => {
        const app = window.__pdfApp;
        if (!app) throw new Error("test harness not available");

        const bytes = app.example.loadById
          ? await app.example.loadById(exampleId)
          : await app.example.load();
        const project = await app.projects.createProjectFromBytes(
          `ocr-quality-${providerId}-${Date.now()}`,
          bytes,
        );

        let fresh = await app.projects.getProject(project.id);
        if (!fresh) throw new Error("project missing after create");

        await app.db.projects.update(project.id, {
          settings: {
            ...fresh.settings,
            ocr: {
              ...fresh.settings.ocr,
              providerId,
              language,
            },
          },
        });

        fresh = await app.projects.getProject(project.id);
        if (!fresh) throw new Error("project missing after settings update");

        await app.render.ensurePageRows(fresh);
        fresh = await app.projects.getProject(project.id);
        if (!fresh) throw new Error("project missing after ensurePageRows");

        await app.render.runRenderPipeline(fresh, { pageIndices: [pageIndex] });
        fresh = await app.projects.getProject(project.id);
        if (!fresh) throw new Error("project missing after render");

        await app.preprocess.runPreprocessPipeline(fresh, { pageIndices: [pageIndex] });
        fresh = await app.projects.getProject(project.id);
        if (!fresh) throw new Error("project missing after preprocess");

        await app.detect.runDetectPipeline(fresh, { pageIndices: [pageIndex] });
        fresh = await app.projects.getProject(project.id);
        if (!fresh) throw new Error("project missing after detect");

        const startedAt = performance.now();
        await app.ocr.runOcrPipeline(fresh, { pageIndices: [pageIndex] });
        const elapsedMs = performance.now() - startedAt;
        const result = await app.ocr.readOcrResult(project.id, pageIndex);
        if (!result) throw new Error("missing OCR result");

        return {
          providerId: result.providerId,
          text: result.text,
          wordCount: result.words.length,
          lineCount: result.lines.length,
          avgConfidence:
            result.words.reduce((sum, word) => sum + word.confidence, 0) /
            (result.words.length || 1),
          elapsedMs,
        };
      },
      { providerId: provider.id, language, exampleId, pageIndex },
    );

    const metrics = compareText(baselineText, actual.text);
    return {
      providerId: provider.id,
      label: provider.label,
      kind: provider.kind,
      elapsedMs: round(actual.elapsedMs, 1),
      wordCount: actual.wordCount,
      lineCount: actual.lineCount,
      avgConfidence: round(actual.avgConfidence, 4),
      textSample: actual.text.slice(0, 240),
      ...metrics,
    };
  } catch (error) {
    return {
      providerId: provider.id,
      label: provider.label,
      kind: provider.kind,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    await context.close();
  }
}

async function waitForHarness(page) {
  await page.waitForFunction(() => typeof window.__pdfApp !== "undefined", null, {
    timeout: 20_000,
  });
}

async function startServer(cwd, port) {
  const child = spawn(
    "bun",
    ["run", "dev", "--", "--host", "127.0.0.1", "--port", String(port), "--strictPort"],
    { cwd, stdio: ["ignore", "pipe", "pipe"] },
  );
  const logs = [];
  child.stdout.on("data", (chunk) => logs.push(chunk.toString("utf8")));
  child.stderr.on("data", (chunk) => logs.push(chunk.toString("utf8")));

  const url = `http://127.0.0.1:${port}/`;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`dev server exited early for ${cwd}\n${logs.join("")}`);
    }
    try {
      const response = await fetch(url);
      if (response.ok) return { child, logs };
    } catch {
      // keep polling
    }
    await sleep(500);
  }
  throw new Error(`timed out waiting for dev server at ${url}\n${logs.join("")}`);
}

async function stopServer(server) {
  if (!server?.child || server.child.exitCode !== null) return;
  const pid = server.child.pid;
  if (typeof pid === "number") process.kill(pid, "SIGTERM");
  await new Promise((resolve) => server.child.once("close", resolve));
}

function compareText(expectedText, actualText) {
  const expected = normalizeText(expectedText);
  const actual = normalizeText(actualText);
  const distance = levenshtein(expected, actual);
  const cer = expected.length ? distance / expected.length : 0;
  const charAccuracy = 1 - cer;

  const expectedTokens = tokenize(expected);
  const actualTokens = tokenize(actual);
  const { matched, precision, recall, f1 } = overlapMetrics(expectedTokens, actualTokens);

  return {
    charErrorRate: round(cer, 4),
    charAccuracy: round(charAccuracy, 4),
    matchedWords: matched,
    expectedWords: expectedTokens.length,
    actualWords: actualTokens.length,
    wordPrecision: round(precision, 4),
    wordRecall: round(recall, 4),
    wordF1: round(f1, 4),
  };
}

function normalizeText(text) {
  return text
    .normalize("NFKC")
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[—–]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function tokenize(text) {
  return text.match(/[a-z0-9']+/g) ?? [];
}

function overlapMetrics(expectedTokens, actualTokens) {
  const expectedCounts = new Map();
  const actualCounts = new Map();

  for (const token of expectedTokens) {
    expectedCounts.set(token, (expectedCounts.get(token) ?? 0) + 1);
  }
  for (const token of actualTokens) {
    actualCounts.set(token, (actualCounts.get(token) ?? 0) + 1);
  }

  let matched = 0;
  for (const [token, count] of expectedCounts) {
    matched += Math.min(count, actualCounts.get(token) ?? 0);
  }

  const precision = actualTokens.length ? matched / actualTokens.length : 0;
  const recall = expectedTokens.length ? matched / expectedTokens.length : 0;
  const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
  return { matched, precision, recall, f1 };
}

function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;

  const prev = Array.from({ length: b.length + 1 }, (_, index) => index);
  const cur = new Array(b.length + 1);

  for (let i = 0; i < a.length; i++) {
    cur[0] = i + 1;
    for (let j = 0; j < b.length; j++) {
      const cost = a[i] === b[j] ? 0 : 1;
      cur[j + 1] = Math.min(prev[j + 1] + 1, cur[j] + 1, prev[j] + cost);
    }
    for (let j = 0; j < cur.length; j++) prev[j] = cur[j];
  }

  return prev[b.length];
}

function printResults(results) {
  console.log(`\nOCR provider quality (${language}, ${exampleId}, page ${pageIndex})`);
  console.log(
    "provider".padEnd(24) +
      "accuracy  ".padEnd(12) +
      "cer      ".padEnd(9) +
      "f1       ".padEnd(9) +
      "conf     ".padEnd(9) +
      "time      ".padEnd(10) +
      "plot",
  );

  for (const result of results) {
    if (result.error) {
      console.log(`${result.providerId.padEnd(24)}error    ${result.error}`);
      continue;
    }

    console.log(
      result.providerId.padEnd(24) +
        `${pct(result.charAccuracy).padEnd(12)}` +
        `${pct(result.charErrorRate).padEnd(9)}` +
        `${pct(result.wordF1).padEnd(9)}` +
        `${pct(result.avgConfidence).padEnd(9)}` +
        `${`${result.elapsedMs}ms`.padEnd(10)}` +
        qualityBar(result.charAccuracy),
    );
  }
}

function qualityBar(score) {
  const width = 24;
  const filled = Math.max(0, Math.min(width, Math.round(score * width)));
  return `${"█".repeat(filled)}${"░".repeat(width - filled)}`;
}

function pct(value) {
  return `${(value * 100).toFixed(1)}%`;
}

function scoreValue(result) {
  if (result.error) return Number.NEGATIVE_INFINITY;
  return result.charAccuracy;
}

function round(value, places) {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
