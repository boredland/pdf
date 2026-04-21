/**
 * CCITT Group 4 (T.6) bitonal encoder.
 *
 * Emits a stream that PDF's `/Filter /CCITTFaxDecode` with `/K -1` can
 * consume. Group 4 is the canonical bitonal PDF compression used by fax
 * machines, TIFF B/W, and (historically) most scanned-PDF pipelines. On
 * text-heavy pages it typically produces 4-10× smaller streams than
 * flate-compressed 1-bit PNGs — roughly JBIG2-generic territory without
 * the emscripten vendoring.
 *
 * References:
 *   ITU-T T.6 (1988) — Modified Modified READ (MMR)
 *   ITU-T T.4 (2003) — Modified Huffman run-length tables
 *
 * Convention (matching T.4/T.6 and PDF default): 0 = white (background),
 * 1 = black (foreground). Caller is responsible for inverting if
 * needed.
 */

// -----------------------------------------------------------------------------
// 1-D Modified Huffman run tables (from T.4 Tables 1/2 — the "standard" set).
// Each entry is [code, bits].

type Code = readonly [code: number, bits: number];

/* Terminating codes for white runs 0..63. */
const WHITE_TERM: Code[] = [
  [0x35, 8], [0x07, 6], [0x07, 4], [0x08, 4], [0x0b, 4], [0x0c, 4],
  [0x0e, 4], [0x0f, 4], [0x13, 5], [0x14, 5], [0x07, 5], [0x08, 5],
  [0x08, 6], [0x03, 6], [0x34, 6], [0x35, 6], [0x2a, 6], [0x2b, 6],
  [0x27, 7], [0x0c, 7], [0x08, 7], [0x17, 7], [0x03, 7], [0x04, 7],
  [0x28, 7], [0x2b, 7], [0x13, 7], [0x24, 7], [0x18, 7], [0x02, 8],
  [0x03, 8], [0x1a, 8], [0x1b, 8], [0x12, 8], [0x13, 8], [0x14, 8],
  [0x15, 8], [0x16, 8], [0x17, 8], [0x28, 8], [0x29, 8], [0x2a, 8],
  [0x2b, 8], [0x2c, 8], [0x2d, 8], [0x04, 8], [0x05, 8], [0x0a, 8],
  [0x0b, 8], [0x52, 8], [0x53, 8], [0x54, 8], [0x55, 8], [0x24, 8],
  [0x25, 8], [0x58, 8], [0x59, 8], [0x5a, 8], [0x5b, 8], [0x4a, 8],
  [0x4b, 8], [0x32, 8], [0x33, 8], [0x34, 8],
];

/* Terminating codes for black runs 0..63. */
const BLACK_TERM: Code[] = [
  [0x37, 10], [0x02, 3], [0x03, 2], [0x02, 2], [0x03, 3], [0x03, 4],
  [0x02, 4], [0x03, 5], [0x05, 6], [0x04, 6], [0x04, 7], [0x05, 7],
  [0x07, 7], [0x04, 8], [0x07, 8], [0x18, 9], [0x17, 10], [0x18, 10],
  [0x08, 10], [0x67, 11], [0x68, 11], [0x6c, 11], [0x37, 11], [0x28, 11],
  [0x17, 11], [0x18, 11], [0xca, 12], [0xcb, 12], [0xcc, 12], [0xcd, 12],
  [0x68, 12], [0x69, 12], [0x6a, 12], [0x6b, 12], [0xd2, 12], [0xd3, 12],
  [0xd4, 12], [0xd5, 12], [0xd6, 12], [0xd7, 12], [0x6c, 12], [0x6d, 12],
  [0xda, 12], [0xdb, 12], [0x54, 12], [0x55, 12], [0x56, 12], [0x57, 12],
  [0x64, 12], [0x65, 12], [0x52, 12], [0x53, 12], [0x24, 12], [0x37, 12],
  [0x38, 12], [0x27, 12], [0x28, 12], [0x58, 12], [0x59, 12], [0x2b, 12],
  [0x2c, 12], [0x5a, 12], [0x66, 12], [0x67, 12],
];

/* Make-up codes for white runs 64..1728 in steps of 64. */
const WHITE_MAKEUP: Code[] = [
  [0x1b, 5], [0x12, 5], [0x17, 6], [0x37, 7], [0x36, 8], [0x37, 8],
  [0x64, 8], [0x65, 8], [0x68, 8], [0x67, 8], [0xcc, 9], [0xcd, 9],
  [0xd2, 9], [0xd3, 9], [0xd4, 9], [0xd5, 9], [0xd6, 9], [0xd7, 9],
  [0xd8, 9], [0xd9, 9], [0xda, 9], [0xdb, 9], [0x98, 9], [0x99, 9],
  [0x9a, 9], [0x18, 6], [0x9b, 9],
];

/* Make-up codes for black runs 64..1728 in steps of 64. */
const BLACK_MAKEUP: Code[] = [
  [0x0f, 10], [0xc8, 12], [0xc9, 12], [0x5b, 12], [0x33, 12], [0x34, 12],
  [0x35, 12], [0x6c, 13], [0x6d, 13], [0x4a, 13], [0x4b, 13], [0x4c, 13],
  [0x4d, 13], [0x72, 13], [0x73, 13], [0x74, 13], [0x75, 13], [0x76, 13],
  [0x77, 13], [0x52, 13], [0x53, 13], [0x54, 13], [0x55, 13], [0x5a, 13],
  [0x5b, 13], [0x64, 13], [0x65, 13],
];

/* Common extended make-up codes (white+black) for runs 1792..2560 step 64. */
const EXT_MAKEUP: Code[] = [
  [0x08, 11], [0x0c, 11], [0x0d, 11], [0x12, 12], [0x13, 12], [0x14, 12],
  [0x15, 12], [0x16, 12], [0x17, 12], [0x1c, 12], [0x1d, 12], [0x1e, 12],
  [0x1f, 12],
];

// -----------------------------------------------------------------------------
// 2-D codes (from T.6 Table 1).
//   Pass                    0001       (4 bits)
//   Horizontal              001        (3 bits, then two 1-D runs)
//   Vertical 0              1          (1 bit)
//   Vertical R/L 1          011 / 010  (3 bits)
//   Vertical R/L 2          000011 / 000010
//   Vertical R/L 3          0000011 / 0000010

const CODE_PASS: Code = [0b0001, 4];
const CODE_HORIZONTAL: Code = [0b001, 3];
const CODE_V0: Code = [0b1, 1];
const CODE_VR1: Code = [0b011, 3];
const CODE_VL1: Code = [0b010, 3];
const CODE_VR2: Code = [0b000011, 6];
const CODE_VL2: Code = [0b000010, 6];
const CODE_VR3: Code = [0b0000011, 7];
const CODE_VL3: Code = [0b0000010, 7];

/** End of facsimile block — two consecutive EOLs (000000000001). */
const EOFB = 0x001001; // 24 bits

// -----------------------------------------------------------------------------

class BitWriter {
  private readonly chunks: number[] = [];
  private buf = 0;
  private bufBits = 0;

  write(code: number, bits: number): void {
    this.buf = (this.buf << bits) | (code & ((1 << bits) - 1));
    this.bufBits += bits;
    while (this.bufBits >= 8) {
      this.bufBits -= 8;
      this.chunks.push((this.buf >> this.bufBits) & 0xff);
    }
  }

  writeCode(c: Code): void {
    this.write(c[0], c[1]);
  }

  flush(): Uint8Array {
    if (this.bufBits > 0) {
      this.chunks.push((this.buf << (8 - this.bufBits)) & 0xff);
      this.bufBits = 0;
      this.buf = 0;
    }
    return new Uint8Array(this.chunks);
  }
}

/** Emit a run length of the given color. T.4 §2.2.1 algorithm. */
function emitRun(bw: BitWriter, length: number, color: 0 | 1): void {
  const term = color === 0 ? WHITE_TERM : BLACK_TERM;
  const makeup = color === 0 ? WHITE_MAKEUP : BLACK_MAKEUP;

  // Extended make-up for runs ≥ 1792.
  while (length >= 2624) {
    bw.writeCode(EXT_MAKEUP[12]!); // 2560 make-up
    length -= 2560;
  }
  if (length >= 1792) {
    // Extended codes cover 1792, 1856, ..., 2560.
    const idx = Math.min(12, Math.floor((length - 1792) / 64));
    bw.writeCode(EXT_MAKEUP[idx]!);
    length -= 1792 + idx * 64;
  } else if (length >= 64) {
    const muIndex = Math.floor(length / 64) - 1;
    bw.writeCode(makeup[muIndex]!);
    length -= (muIndex + 1) * 64;
  }
  bw.writeCode(term[length]!);
}

// -----------------------------------------------------------------------------

interface Scan {
  /** Pixel buffer with 1 byte per pixel, values 0 (white) or 1 (black). */
  pixels: Uint8Array;
  width: number;
  height: number;
}

/**
 * Find the next changing element on `line` strictly after position `from`.
 * Returns `line.length` if there are no more transitions.
 *
 * A "changing element" is the leftmost pixel of a run — i.e. the first
 * pixel whose colour differs from its left neighbour (or position 0 when
 * the leading colour differs from the imaginary-white start).
 */
function nextChange(
  line: Uint8Array,
  width: number,
  from: number,
  startColor: 0 | 1,
): number {
  let i = from;
  // If we're at the imaginary-start position (-1), figure out what the
  // first real pixel is and skip past any run that shares startColor.
  if (i < 0) {
    if ((line[0] ?? 0) !== startColor) return 0;
    i = 0;
  }
  const cur = line[i];
  i++;
  while (i < width && line[i] === cur) i++;
  return i;
}

/** Colour of the pixel *before* position `i` (imaginary white for i <= 0). */
function colorBefore(line: Uint8Array, i: number): 0 | 1 {
  if (i <= 0) return 0;
  return (line[i - 1] as 0 | 1 | undefined) ?? 0;
}

/** One MMR-encoded row. */
function encodeRow(
  bw: BitWriter,
  reference: Uint8Array,
  coding: Uint8Array,
  width: number,
): void {
  let a0 = -1; // imaginary element just before the line
  while (a0 < width) {
    const a0Color = colorBefore(coding, a0 + 1);

    // a1: next changing element on coding line, starts with opposite colour.
    const a1 = nextChange(coding, width, a0, a0Color);

    // b1: first changing element on reference line strictly right of a0
    // whose colour is opposite to a0's. "Opposite to a0's" here means
    // opposite to `a0Color` (the colour of a0 itself).
    let b1 = nextChange(reference, width, a0, colorBefore(reference, a0 + 1));
    // If that b1's colour doesn't match "not a0Color", skip one more run.
    if (b1 < width && colorBefore(reference, b1 + 1) === a0Color) {
      b1 = nextChange(reference, width, b1, a0Color);
    }
    const b2 = nextChange(reference, width, b1, 1 - a0Color as 0 | 1);

    if (b2 < a1) {
      // Pass mode.
      bw.writeCode(CODE_PASS);
      a0 = b2;
      continue;
    }

    const delta = a1 - b1;
    if (delta >= -3 && delta <= 3) {
      // Vertical mode.
      switch (delta) {
        case 0:
          bw.writeCode(CODE_V0);
          break;
        case 1:
          bw.writeCode(CODE_VR1);
          break;
        case -1:
          bw.writeCode(CODE_VL1);
          break;
        case 2:
          bw.writeCode(CODE_VR2);
          break;
        case -2:
          bw.writeCode(CODE_VL2);
          break;
        case 3:
          bw.writeCode(CODE_VR3);
          break;
        case -3:
          bw.writeCode(CODE_VL3);
          break;
      }
      a0 = a1;
    } else {
      // Horizontal mode: a0a1 run + a1a2 run.
      bw.writeCode(CODE_HORIZONTAL);
      const a2 = nextChange(coding, width, a1, 1 - a0Color as 0 | 1);
      emitRun(bw, a1 - Math.max(a0, 0), a0Color);
      emitRun(bw, a2 - a1, (1 - a0Color) as 0 | 1);
      a0 = a2;
    }
  }
}

/** Encode a bitonal raster as a Group 4 stream. */
export function encodeCcittG4(scan: Scan): Uint8Array {
  const { pixels, width, height } = scan;
  if (pixels.length !== width * height) {
    throw new Error(
      `ccitt-g4: pixels length ${pixels.length} doesn't match ${width}×${height}`,
    );
  }
  const bw = new BitWriter();
  let reference = new Uint8Array(width); // imaginary reference: all white.
  for (let y = 0; y < height; y++) {
    const coding = pixels.subarray(y * width, (y + 1) * width);
    encodeRow(bw, reference, coding, width);
    reference = coding.slice();
  }
  // EOFB (two EOLs concatenated).
  bw.write(EOFB, 24);
  return bw.flush();
}
