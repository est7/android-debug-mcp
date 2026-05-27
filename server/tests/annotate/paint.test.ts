import { PNG } from "pngjs";
import { describe, expect, it } from "vitest";
import { DEFAULT_DIGIT_STYLE } from "../../src/annotate/glyphs.ts";
import {
  AnnotateError,
  IHDR_HEADER_BYTES,
  MAX_PIXELS,
  type RGBA,
  decodePng,
  drawDigit,
  drawNumber,
  encodePng,
  fillRect,
  inspectPngHeader,
  strokeRect,
} from "../../src/annotate/paint.ts";

function blank(w: number, h: number, fill: RGBA = [0, 0, 0, 0xff]) {
  const png = new PNG({ width: w, height: h });
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = fill[0];
    png.data[i + 1] = fill[1];
    png.data[i + 2] = fill[2];
    png.data[i + 3] = fill[3];
  }
  return { width: w, height: h, data: png.data };
}

function pixelAt(img: ReturnType<typeof blank>, x: number, y: number): RGBA {
  const idx = (y * img.width + x) * 4;
  return [
    img.data[idx] ?? 0,
    img.data[idx + 1] ?? 0,
    img.data[idx + 2] ?? 0,
    img.data[idx + 3] ?? 0,
  ];
}

describe("inspectPngHeader", () => {
  function buildPngBuffer(w: number, h: number): Buffer {
    return PNG.sync.write(blankPng(w, h));
  }
  function blankPng(w: number, h: number): PNG {
    const png = new PNG({ width: w, height: h });
    for (let i = 0; i < png.data.length; i += 4) {
      png.data[i + 3] = 0xff;
    }
    return png;
  }

  it("parses width / height / bitDepth / colorType from a valid 1×1 PNG", () => {
    const meta = inspectPngHeader(buildPngBuffer(1, 1));
    expect(meta.width).toBe(1);
    expect(meta.height).toBe(1);
    expect(meta.bitDepth).toBe(8);
    expect(meta.colorType).toBe(6); // RGBA
  });

  it("parses width / height for a non-trivial size", () => {
    const meta = inspectPngHeader(buildPngBuffer(1080, 2400));
    expect(meta.width).toBe(1080);
    expect(meta.height).toBe(2400);
  });

  it("rejects a buffer shorter than IHDR_HEADER_BYTES", () => {
    const tiny = Buffer.alloc(IHDR_HEADER_BYTES - 1);
    expect(() => inspectPngHeader(tiny)).toThrowError(
      expect.objectContaining({ name: "AnnotateError", code: "annotate_decode_failed" }),
    );
  });

  it("rejects a buffer with the wrong magic bytes", () => {
    const buf = Buffer.alloc(64);
    buf.write("not-a-png");
    expect(() => inspectPngHeader(buf)).toThrowError(
      expect.objectContaining({ code: "annotate_decode_failed" }),
    );
  });

  it("rejects PNG whose pixel count exceeds MAX_PIXELS", () => {
    // Craft a header that claims a 5000×5000 image (25 M pixels > 16.78 M cap).
    // We do NOT allocate a real such PNG — just synthesize a valid-looking header.
    const buf = Buffer.alloc(IHDR_HEADER_BYTES);
    // PNG signature
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
    // chunk length (13 BE)
    buf.writeUInt32BE(13, 8);
    // chunk type "IHDR"
    buf.write("IHDR", 12);
    // width / height / bitDepth / colorType
    buf.writeUInt32BE(5000, 16);
    buf.writeUInt32BE(5000, 20);
    buf[24] = 8;
    buf[25] = 6;
    expect(() => inspectPngHeader(buf)).toThrowError(
      expect.objectContaining({ code: "annotate_image_too_large" }),
    );
  });

  it("rejects PNG whose first chunk is not IHDR", () => {
    const buf = Buffer.alloc(IHDR_HEADER_BYTES);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
    buf.writeUInt32BE(13, 8);
    buf.write("OOPS", 12);
    buf.writeUInt32BE(100, 16);
    buf.writeUInt32BE(100, 20);
    buf[24] = 8;
    buf[25] = 6;
    expect(() => inspectPngHeader(buf)).toThrowError(
      expect.objectContaining({ code: "annotate_decode_failed" }),
    );
  });

  it("MAX_PIXELS equals 4096²", () => {
    expect(MAX_PIXELS).toBe(4096 * 4096);
  });
});

describe("decodePng + encodePng round-trip", () => {
  it("decodes then re-encodes preserving dimensions", () => {
    const orig = new PNG({ width: 32, height: 24 });
    for (let i = 0; i < orig.data.length; i += 4) {
      orig.data[i] = 0xff;
      orig.data[i + 1] = 0x80;
      orig.data[i + 2] = 0x40;
      orig.data[i + 3] = 0xff;
    }
    const buf = PNG.sync.write(orig);
    const img = decodePng(buf);
    expect(img.width).toBe(32);
    expect(img.height).toBe(24);
    expect(img.data[0]).toBe(0xff);
    expect(img.data[1]).toBe(0x80);
    expect(img.data[2]).toBe(0x40);

    const reencoded = encodePng(img);
    const round = decodePng(reencoded);
    expect(round.width).toBe(32);
    expect(round.height).toBe(24);
  });

  it("decodePng routes through inspectPngHeader (rejects too-large early)", () => {
    const buf = Buffer.alloc(IHDR_HEADER_BYTES);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
    buf.writeUInt32BE(13, 8);
    buf.write("IHDR", 12);
    buf.writeUInt32BE(5000, 16);
    buf.writeUInt32BE(5000, 20);
    buf[24] = 8;
    buf[25] = 6;
    expect(() => decodePng(buf)).toThrowError(
      expect.objectContaining({ code: "annotate_image_too_large" }),
    );
  });
});

describe("fillRect", () => {
  it("paints the requested half-open rect", () => {
    const img = blank(10, 10);
    fillRect(img, 2, 3, 5, 6, [0xff, 0x00, 0x00, 0xff]);
    expect(pixelAt(img, 2, 3)).toEqual([0xff, 0, 0, 0xff]);
    expect(pixelAt(img, 4, 5)).toEqual([0xff, 0, 0, 0xff]);
    expect(pixelAt(img, 5, 6)).toEqual([0, 0, 0, 0xff]); // half-open: r/b excluded
    expect(pixelAt(img, 1, 3)).toEqual([0, 0, 0, 0xff]); // outside left
  });

  it("clips out-of-bounds coords", () => {
    const img = blank(4, 4);
    fillRect(img, -2, -2, 100, 100, [0xff, 0xff, 0xff, 0xff]);
    expect(pixelAt(img, 0, 0)).toEqual([0xff, 0xff, 0xff, 0xff]);
    expect(pixelAt(img, 3, 3)).toEqual([0xff, 0xff, 0xff, 0xff]);
  });

  it("no-op on degenerate rect (r <= l)", () => {
    const img = blank(4, 4);
    fillRect(img, 2, 2, 1, 3, [0xff, 0, 0, 0xff]);
    expect(pixelAt(img, 1, 2)).toEqual([0, 0, 0, 0xff]);
    expect(pixelAt(img, 2, 2)).toEqual([0, 0, 0, 0xff]);
  });
});

describe("strokeRect", () => {
  it("draws a hollow border at the requested thickness", () => {
    const img = blank(20, 20);
    const RED: RGBA = [0xff, 0, 0, 0xff];
    strokeRect(img, 4, 4, 16, 16, RED, 2);
    expect(pixelAt(img, 4, 4)).toEqual(RED); // corner
    expect(pixelAt(img, 5, 5)).toEqual(RED); // inside stroke
    expect(pixelAt(img, 6, 6)).toEqual([0, 0, 0, 0xff]); // empty interior
    expect(pixelAt(img, 15, 15)).toEqual(RED); // bottom-right inside stroke
  });
});

describe("drawDigit + drawNumber", () => {
  it("draws something for every digit 0-9 (no exception, some pixel changes)", () => {
    const RED: RGBA = [0xff, 0, 0, 0xff];
    for (const d of ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"]) {
      const img = blank(40, 50);
      drawDigit(img, 5, 5, d, DEFAULT_DIGIT_STYLE, RED);
      // count painted pixels
      let painted = 0;
      for (let i = 0; i < img.data.length; i += 4) {
        if (img.data[i] === 0xff) painted++;
      }
      expect(painted).toBeGreaterThan(0);
    }
  });

  it("ignores non-digit chars", () => {
    const img = blank(40, 50);
    drawDigit(img, 5, 5, "x", DEFAULT_DIGIT_STYLE, [0xff, 0, 0, 0xff]);
    for (let i = 0; i < img.data.length; i += 4) {
      expect(img.data[i]).toBe(0); // nothing painted
    }
  });

  it("drawNumber advances cursor by width + gap per digit", () => {
    const img = blank(200, 50);
    drawNumber(img, 0, 5, 123, DEFAULT_DIGIT_STYLE, 4, [0xff, 0, 0, 0xff]);
    // digit '1' lives in cols [0, 24); '2' in [28, 52); '3' in [56, 80).
    // segment 'a' of '2' must paint y=5 row at x≈28..52. sample one pixel.
    expect(pixelAt(img, 30, 5)).toEqual([0xff, 0, 0, 0xff]);
    // gap between digits at x=25..27 should be clean
    expect(pixelAt(img, 25, 5)).toEqual([0, 0, 0, 0xff]);
  });
});

describe("AnnotateError", () => {
  it("carries name and a public-union code for downstream tool-error mapping", () => {
    const err = new AnnotateError("annotate_decode_failed", "some message");
    expect(err.name).toBe("AnnotateError");
    expect(err.code).toBe("annotate_decode_failed");
    expect(err.message).toBe("some message");
    expect(err instanceof Error).toBe(true);
  });
});
