import { expect, test, type Page } from "@playwright/test";

async function waitForHarness(page: Page) {
  await page.waitForFunction(() => typeof window.__pdfApp !== "undefined", null, {
    timeout: 10_000,
  });
}

/**
 * Build a minimal JPEG in-browser, then splice in an APP1/EXIF segment with
 * Orientation = `orientation` (1..8). Returns the finished bytes.
 */
async function buildJpegWithExifOrientation(
  page: Page,
  orientation: number,
): Promise<{ bytes: Uint8Array; width: number; height: number }> {
  return page.evaluate(async (o) => {
    const width = 200;
    const height = 120;
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "white";
    ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = "black";
    ctx.font = "48px sans-serif";
    ctx.fillText("UP", 20, 80);
    const base = new Uint8Array(
      await (
        await canvas.convertToBlob({ type: "image/jpeg", quality: 0.9 })
      ).arrayBuffer(),
    );

    // APP1/EXIF: one IFD entry for Orientation (tag 0x0112, SHORT, count=1).
    const exif = new Uint8Array([
      0xff, 0xe1,
      0x00, 0x22, // segment length (34, includes these two bytes)
      0x45, 0x78, 0x69, 0x66, 0x00, 0x00, // "Exif\0\0"
      0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00, // TIFF little-endian
      0x01, 0x00, // 1 IFD entry
      0x12, 0x01, 0x03, 0x00, 0x01, 0x00, 0x00, 0x00,
      o & 0xff, 0x00, 0x00, 0x00, // value = orientation
      0x00, 0x00, 0x00, 0x00, // next IFD offset = 0
    ]);

    const out = new Uint8Array(2 + exif.length + (base.length - 2));
    out.set(base.subarray(0, 2), 0);
    out.set(exif, 2);
    out.set(base.subarray(2), 2 + exif.length);
    // Return transferable-friendly array (plain JS).
    return {
      bytes: Array.from(out),
      width,
      height,
    } as unknown as { bytes: Uint8Array; width: number; height: number };
  }, orientation) as unknown as Promise<{
    bytes: Uint8Array;
    width: number;
    height: number;
  }>;
}

test.describe("step 11 — image upload with EXIF rotation", () => {
  test.setTimeout(60_000);
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await waitForHarness(page);
  });

  test("getExifOrientation round-trips through the spliced EXIF segment", async ({
    page,
  }) => {
    const { bytes } = await buildJpegWithExifOrientation(page, 3);
    const parsed = await page.evaluate((arr) => {
      const u8 = new Uint8Array(arr);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (window as any).__pdfApp!.testing.exif.getOrientation(u8);
    }, bytes as unknown as number[]);
    expect(parsed).toBe(3);
  });

  test("uploading a JPEG with EXIF Orientation=3 produces a PDF page mupdf can read", async ({
    page,
  }) => {
    const { bytes, width, height } = await buildJpegWithExifOrientation(page, 3);
    const result = await page.evaluate(
      async ({ arr, srcW, srcH }) => {
        const u8 = new Uint8Array(arr);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const app = (window as any).__pdfApp!;
        const project = await app.projects.createProjectFromBytes(
          "rotated.jpg",
          u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength),
          "image/jpeg",
        );
        const pdfBlob = await app.opfs.readBlob(project.sourcePdfPath);
        const pdfBytes = await pdfBlob!.arrayBuffer();
        const pageCount = await app.render.getPageCount(pdfBytes);
        const texts = await app.pdfInspect.extractText(pdfBytes);
        return {
          sizeBytes: pdfBlob!.size,
          pageCount,
          textPages: texts.length,
          srcW,
          srcH,
        };
      },
      {
        arr: bytes as unknown as number[],
        srcW: width,
        srcH: height,
      },
    );

    expect(result.sizeBytes).toBeGreaterThan(500);
    expect(result.pageCount).toBe(1);
    expect(result.textPages).toBe(1);
  });

  test("EXIF Orientation=6 swaps width/height on the embedded image", async ({
    page,
  }) => {
    const { bytes } = await buildJpegWithExifOrientation(page, 6);
    const result = await page.evaluate(async (arr) => {
      const u8 = new Uint8Array(arr);
      // Sanity-check: does the bundled EXIF parser see orientation=6?
      const firstMarker = [u8[0], u8[1], u8[2], u8[3]].map((b) =>
        b!.toString(16).padStart(2, "0"),
      );
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const app = (window as any).__pdfApp!;
      const project = await app.projects.createProjectFromBytes(
        "landscape.jpg",
        u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength),
        "image/jpeg",
      );
      const pdfBlob = await app.opfs.readBlob(project.sourcePdfPath);
      const pdfBytes = await pdfBlob!.arrayBuffer();
      const pdfPageCount = await app.render.getPageCount(pdfBytes);
      await app.render.ensurePageRows(project);
      const fresh = await app.projects.getProject(project.id);
      await app.render.runRenderPipeline(fresh);
      const row = await app.db.pages.get(`${project.id}:0`);
      const blob = row?.status?.render
        ? await app.opfs.readBlob(row.status.render.artifactPath)
        : null;
      const dims = blob
        ? (await createImageBitmap(blob))
        : null;
      return {
        width: dims?.width ?? -1,
        height: dims?.height ?? -1,
        hasRender: !!blob,
        pdfPageCount,
        pdfSize: pdfBlob!.size,
        firstMarker,
      };
    }, bytes as unknown as number[]);

    // Source image was 200×120 (landscape). Orientation 6 says "rotate 90°
    // CW to display", so the baked PDF should be portrait: height > width.
    expect(result).toMatchObject({ hasRender: true, pdfPageCount: 1 });
    expect(result.height).toBeGreaterThan(result.width);
  });
});
