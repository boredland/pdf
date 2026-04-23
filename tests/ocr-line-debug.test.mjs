import { expect, test } from "bun:test";
import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const baselinePath = join(repoRoot, "tests/fixtures/ocr/skew.tesseract.eng.txt");
const reportPath = join(repoRoot, "test-results/ocr-line-debug.json");
const cropsRoot = join(repoRoot, "test-results/ocr-line-debug");

const providerId = process.env.OCR_LINE_DEBUG_PROVIDER ?? "onnx-paddle";
const language = process.env.OCR_LINE_DEBUG_LANGUAGE ?? "eng";
const exampleId = process.env.OCR_LINE_DEBUG_EXAMPLE ?? "scanned";
const pageIndex = Number.parseInt(process.env.OCR_LINE_DEBUG_PAGE ?? "0", 10);
const port = Number.parseInt(process.env.OCR_LINE_DEBUG_PORT ?? "4175", 10);
const cropLimit = Number.parseInt(process.env.OCR_LINE_DEBUG_LIMIT ?? "20", 10);
const detectCropLimit = Number.parseInt(process.env.OCR_LINE_DEBUG_DETECT_LIMIT ?? "20", 10);

test(
  "captures line-level OCR debug artifacts for the scanned fixture",
  async () => {
    const baselineText = await readFile(baselinePath, "utf8");
    const baselineLines = splitLines(baselineText);
    const server = await startServer(repoRoot, port);
    const browser = await chromium.launch();

    try {
      const context = await browser.newContext();
      const page = await context.newPage();

      await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "networkidle" });
      await waitForHarness(page);

      const actual = await collectLineDebug(page, {
        providerId,
        language,
        exampleId,
        pageIndex,
      });

      expect(actual.detectRegions.length).toBeGreaterThan(0);
      expect(actual.lines.length).toBeGreaterThan(0);

      const overall = compareText(baselineText, actual.text);
      const lineMatches = alignLines(baselineLines, actual.lines);
      const selectedLineIndices = selectRepresentativeLineIndices(actual.lines, lineMatches, cropLimit);
      const selectedDetectIndices = actual.detectRegions
        .slice(0, Math.max(0, detectCropLimit))
        .map((region) => region.index);

      const crops = await collectSelectedCrops(page, {
        projectId: actual.projectId,
        pageIndex,
        lineIndices: selectedLineIndices,
        detectIndices: selectedDetectIndices,
      });

      await context.close();

      await rm(cropsRoot, { recursive: true, force: true });
      await mkdir(cropsRoot, { recursive: true });

      const lineCropByIndex = new Map();
      for (const crop of crops.lineCrops) {
        const fileName = `line-${String(crop.index + 1).padStart(2, "0")}.png`;
        const relativePath = join("test-results/ocr-line-debug", fileName);
        await writePng(join(repoRoot, relativePath), crop.dataUrl);
        lineCropByIndex.set(crop.index, relativePath);
      }

      const detectCropByIndex = new Map();
      for (const crop of crops.detectCrops) {
        const fileName = `detect-${String(crop.index + 1).padStart(2, "0")}.png`;
        const relativePath = join("test-results/ocr-line-debug", fileName);
        await writePng(join(repoRoot, relativePath), crop.dataUrl);
        detectCropByIndex.set(crop.index, relativePath);
      }

      const report = {
        providerId,
        language,
        exampleId,
        pageIndex,
        generatedAt: new Date().toISOString(),
        overall,
        baselineLineCount: baselineLines.length,
        detectRegionCount: actual.detectRegions.length,
        recognizedLineCount: actual.lines.length,
        avgLineConfidence: round(
          actual.lines.reduce((sum, line) => sum + line.confidence, 0) / (actual.lines.length || 1),
          4,
        ),
        representativeLineIndices: selectedLineIndices,
        representativeDetectIndices: selectedDetectIndices,
        lines: lineMatches.map((line) => ({
          ...line,
          cropPath: lineCropByIndex.get(line.index) ?? null,
        })),
        detectRegions: actual.detectRegions.map((region) => ({
          ...region,
          cropPath: detectCropByIndex.get(region.index) ?? null,
        })),
      };

      await writeFile(reportPath, JSON.stringify(report, null, 2));

      printSummary(report);
      console.log(`\nSaved OCR line debug report to ${reportPath}`);

      expect(crops.lineCrops.length).toBeGreaterThan(0);
    } finally {
      await browser.close();
      await stopServer(server);
    }
  },
  12 * 60 * 1000,
);

async function collectLineDebug(page, { providerId, language, exampleId, pageIndex }) {
  return await page.evaluate(
    async ({ providerId, language, exampleId, pageIndex }) => {
      const app = window.__pdfApp;
      if (!app) throw new Error("test harness not available");

      const bytes = app.example.loadById ? await app.example.loadById(exampleId) : await app.example.load();
      const project = await app.projects.createProjectFromBytes(
        `ocr-line-debug-${providerId}-${Date.now()}`,
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

      await app.ocr.runOcrPipeline(fresh, { pageIndices: [pageIndex] });

      const [detect, ocr] = await Promise.all([
        app.detect.readDetectRegions(project.id, pageIndex),
        app.ocr.readOcrResult(project.id, pageIndex),
      ]);
      if (!ocr) throw new Error("missing OCR result");

      const sortedDetectRegions = sortByReadingOrder(detect?.regions ?? []).map((bbox, index) => ({
        index,
        bbox,
      }));
      const sortedLines = sortByReadingOrder(ocr.lines ?? []).map((line, index) => ({
        index,
        text: line.text,
        confidence: averageConfidence(line.words),
        bbox: line.bbox,
      }));

      return {
        projectId: project.id,
        text: ocr.text,
        lines: sortedLines,
        detectRegions: sortedDetectRegions,
      };

      function sortByReadingOrder(items) {
        return [...items].sort((a, b) => {
          const ay = a.bbox ? a.bbox.y : a.y;
          const by = b.bbox ? b.bbox.y : b.y;
          if (Math.abs(ay - by) < 8) {
            const ax = a.bbox ? a.bbox.x : a.x;
            const bx = b.bbox ? b.bbox.x : b.x;
            return ax - bx;
          }
          return ay - by;
        });
      }

      function averageConfidence(words = []) {
        if (!words.length) return 0;
        return words.reduce((sum, word) => sum + (word.confidence ?? 0), 0) / words.length;
      }
    },
    { providerId, language, exampleId, pageIndex },
  );
}

async function collectSelectedCrops(page, { projectId, pageIndex, lineIndices, detectIndices }) {
  return await page.evaluate(
    async ({ projectId, pageIndex, lineIndices, detectIndices }) => {
      const app = window.__pdfApp;
      if (!app) throw new Error("test harness not available");

      const pageRow = await app.db.pages.get(`${projectId}:${pageIndex}`);
      const preprocessPath = pageRow?.status?.preprocess?.artifactPath;
      if (!preprocessPath) throw new Error("missing preprocess artifact");

      const [blob, detect, ocr] = await Promise.all([
        app.opfs.readBlob(preprocessPath),
        app.detect.readDetectRegions(projectId, pageIndex),
        app.ocr.readOcrResult(projectId, pageIndex),
      ]);
      if (!blob) throw new Error("failed to read preprocess artifact");
      if (!ocr) throw new Error("missing OCR result");

      const bitmap = await createImageBitmap(blob);
      const canvas = document.createElement("canvas");
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("2d context unavailable");
      ctx.drawImage(bitmap, 0, 0);
      bitmap.close?.();

      const sortedLines = sortByReadingOrder(ocr.lines ?? []).map((line, index) => ({
        index,
        bbox: line.bbox,
      }));
      const sortedDetectRegions = sortByReadingOrder(detect?.regions ?? []).map((bbox, index) => ({
        index,
        bbox,
      }));

      return {
        lineCrops: lineIndices
          .map((index) => {
            const line = sortedLines[index];
            return line ? { index, dataUrl: cropToDataUrl(canvas, line.bbox) } : null;
          })
          .filter(Boolean),
        detectCrops: detectIndices
          .map((index) => {
            const region = sortedDetectRegions[index];
            return region ? { index, dataUrl: cropToDataUrl(canvas, region.bbox) } : null;
          })
          .filter(Boolean),
      };

      function sortByReadingOrder(items) {
        return [...items].sort((a, b) => {
          const ay = a.bbox ? a.bbox.y : a.y;
          const by = b.bbox ? b.bbox.y : b.y;
          if (Math.abs(ay - by) < 8) {
            const ax = a.bbox ? a.bbox.x : a.x;
            const bx = b.bbox ? b.bbox.x : b.x;
            return ax - bx;
          }
          return ay - by;
        });
      }

      function cropToDataUrl(sourceCanvas, bbox) {
        const pad = Math.max(2, Math.round(Math.min(bbox.width, bbox.height) * 0.08));
        const x = Math.max(0, bbox.x - pad);
        const y = Math.max(0, bbox.y - pad);
        const width = Math.min(sourceCanvas.width - x, bbox.width + pad * 2);
        const height = Math.min(sourceCanvas.height - y, bbox.height + pad * 2);
        const cropCanvas = document.createElement("canvas");
        cropCanvas.width = Math.max(1, width);
        cropCanvas.height = Math.max(1, height);
        const cropCtx = cropCanvas.getContext("2d");
        if (!cropCtx) throw new Error("2d context unavailable");
        cropCtx.drawImage(sourceCanvas, x, y, width, height, 0, 0, width, height);
        return cropCanvas.toDataURL("image/png");
      }
    },
    { projectId, pageIndex, lineIndices, detectIndices },
  );
}

async function writePng(path, dataUrl) {
  const base64 = dataUrl.replace(/^data:image\/png;base64,/, "");
  await writeFile(path, Buffer.from(base64, "base64"));
}

function alignLines(expectedLines, actualLines) {
  let cursor = 0;
  return actualLines.map((line) => {
    const windowEnd = Math.min(expectedLines.length, cursor + 8);
    let bestIndex = cursor < expectedLines.length ? cursor : expectedLines.length - 1;
    let bestExpected = bestIndex >= 0 ? expectedLines[bestIndex] : "";
    let bestMetrics = compareText(bestExpected ?? "", line.text);

    for (let index = Math.max(0, cursor); index < windowEnd; index++) {
      const candidate = expectedLines[index] ?? "";
      const metrics = compareText(candidate, line.text);
      if (metrics.charAccuracy > bestMetrics.charAccuracy) {
        bestIndex = index;
        bestExpected = candidate;
        bestMetrics = metrics;
      }
    }

    if (bestIndex >= 0) cursor = bestIndex + 1;

    return {
      index: line.index,
      baselineIndex: bestIndex,
      bbox: line.bbox,
      confidence: round(line.confidence, 4),
      actualText: line.text,
      expectedText: bestExpected ?? "",
      ...bestMetrics,
    };
  });
}

function selectRepresentativeLineIndices(actualLines, lineMatches, limit) {
  const first = actualLines.slice(0, Math.min(5, actualLines.length)).map((line) => line.index);
  const worstAccuracy = [...lineMatches]
    .sort((a, b) => a.charAccuracy - b.charAccuracy)
    .slice(0, Math.min(8, lineMatches.length))
    .map((line) => line.index);
  const lowestConfidence = [...actualLines]
    .sort((a, b) => a.confidence - b.confidence)
    .slice(0, Math.min(8, actualLines.length))
    .map((line) => line.index);

  const selected = [];
  const seen = new Set();
  for (const index of [...first, ...worstAccuracy, ...lowestConfidence]) {
    if (seen.has(index)) continue;
    seen.add(index);
    selected.push(index);
    if (selected.length >= limit) break;
  }
  return selected.sort((a, b) => a - b);
}

function splitLines(text) {
  return text
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .filter(Boolean);
}

function compareText(expectedText, actualText) {
  const expected = normalizeText(expectedText);
  const actual = normalizeText(actualText);
  const distance = levenshtein(expected, actual);
  const cer = expected.length ? distance / expected.length : actual.length ? 1 : 0;
  const charAccuracy = expected.length ? 1 - cer : actual.length ? 0 : 1;

  const expectedTokens = tokenize(expected);
  const actualTokens = tokenize(actual);
  const { matched, precision, recall, f1 } = overlapMetrics(expectedTokens, actualTokens);

  return {
    charErrorRate: round(cer, 4),
    charAccuracy: round(charAccuracy, 4),
    matchedWords: matched,
    expectedWords: expectedTokens.length,
    actualWords: actualTokens.length,
    precision: round(precision, 4),
    recall: round(recall, 4),
    f1: round(f1, 4),
  };
}

function normalizeText(text) {
  return text
    .toLowerCase()
    .replace(/\r\n/g, "\n")
    .replace(/[^\p{L}\p{N}\n ]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenize(text) {
  return text ? text.split(" ").filter(Boolean) : [];
}

function overlapMetrics(expectedTokens, actualTokens) {
  const remaining = new Map();
  for (const token of expectedTokens) {
    remaining.set(token, (remaining.get(token) ?? 0) + 1);
  }

  let matched = 0;
  for (const token of actualTokens) {
    const count = remaining.get(token) ?? 0;
    if (count > 0) {
      matched += 1;
      remaining.set(token, count - 1);
    }
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
  const curr = new Array(b.length + 1);

  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= b.length; j++) prev[j] = curr[j];
  }

  return prev[b.length];
}

function round(value, digits) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function printSummary(report) {
  const worst = [...report.lines]
    .sort((a, b) => a.charAccuracy - b.charAccuracy)
    .slice(0, Math.min(8, report.lines.length));

  console.log(`\nOCR line debug for ${report.providerId}`);
  console.log(
    `whole-page char accuracy ${(report.overall.charAccuracy * 100).toFixed(1)}% | ` +
      `detect regions ${report.detectRegionCount} | recognized lines ${report.recognizedLineCount} | ` +
      `avg line confidence ${report.avgLineConfidence.toFixed(3)}`,
  );
  console.log("\nWorst aligned lines:");
  for (const line of worst) {
    console.log(
      `- line ${String(line.index + 1).padStart(2, "0")}: ` +
        `${(line.charAccuracy * 100).toFixed(1)}% | conf ${line.confidence.toFixed(3)} | ` +
        `actual="${truncate(line.actualText)}" | expected="${truncate(line.expectedText)}"`,
    );
  }
}

function truncate(text, max = 72) {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

async function waitForHarness(page) {
  await page.waitForFunction(() => typeof window.__pdfApp !== "undefined", null, {
    timeout: 20_000,
  });
}

async function startServer(cwd, port) {
  await runCommand("npm", ["run", "build"], cwd);
  const child = spawn(
    "npm",
    ["run", "preview", "--", "--host", "127.0.0.1", "--port", String(port), "--strictPort"],
    { cwd, stdio: ["ignore", "pipe", "pipe"] },
  );
  const logs = [];
  child.stdout.on("data", (chunk) => logs.push(chunk.toString("utf8")));
  child.stderr.on("data", (chunk) => logs.push(chunk.toString("utf8")));

  const url = `http://127.0.0.1:${port}/`;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`preview server exited early for ${cwd}\n${logs.join("")}`);
    }
    try {
      const response = await fetch(url);
      if (response.ok) return { child, logs };
    } catch {
      // keep polling
    }
    await sleep(500);
  }
  throw new Error(`timed out waiting for preview server at ${url}\n${logs.join("")}`);
}

async function stopServer(server) {
  if (!server?.child || server.child.exitCode !== null) return;
  const pid = server.child.pid;
  if (typeof pid === "number") process.kill(pid, "SIGTERM");
  await new Promise((resolve) => server.child.once("close", resolve));
}

async function runCommand(command, args, cwd) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });

    const logs = [];
    child.stdout.on("data", (chunk) => logs.push(chunk.toString("utf8")));
    child.stderr.on("data", (chunk) => logs.push(chunk.toString("utf8")));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(" ")} failed\n${logs.join("")}`));
    });
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
