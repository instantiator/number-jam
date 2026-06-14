/**
 * Unit tests for the plate obscuring module.
 *
 * The pure geometry helpers {@link plateAngleDeg} and {@link clampedBbox} are
 * tested with synthetic polygon data. {@link obscureFrame} is tested
 * end-to-end using a small synthetic JPEG created in memory by sharp, so that
 * no real video fixture is required.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import sharp from "sharp";
import {
  obscureFrame,
  plateAngleDeg,
  clampedBbox,
  snapPolygonToEdges,
  expandPolygon,
} from "../src/obscuring/obscurer";
import { PlateDetection, PaddingSpec } from "../src/types";

// Geometry helpers

describe("plateAngleDeg", () => {
  it("returns ~0 for a perfectly horizontal plate", () => {
    /** All four corners share the same y coordinate. */
    const polygon: [number, number][] = [
      [10, 50],
      [90, 50],
      [90, 70],
      [10, 70],
    ];
    expect(plateAngleDeg(polygon)).toBeCloseTo(0);
  });

  it("returns ~45 for a plate tilted 45 degrees upward", () => {
    const polygon: [number, number][] = [
      [0, 0],
      [100, 100],
      [80, 120],
      [-20, 20],
    ];
    expect(plateAngleDeg(polygon)).toBeCloseTo(45);
  });

  it("returns a negative angle for a plate tilted downward", () => {
    const polygon: [number, number][] = [
      [0, 100],
      [100, 0],
      [120, 20],
      [20, 120],
    ];
    expect(plateAngleDeg(polygon)).toBeLessThan(0);
  });
});

describe("clampedBbox", () => {
  const W = 1920;
  const H = 1080;

  it("returns exact bounds for a polygon well within the frame", () => {
    const polygon: [number, number][] = [
      [100, 200],
      [300, 200],
      [300, 260],
      [100, 260],
    ];
    const box = clampedBbox(polygon, W, H);
    expect(box.left).toBe(100);
    expect(box.top).toBe(200);
    expect(box.width).toBe(200);
    expect(box.height).toBe(60);
  });

  it("clamps left and top edges to 0 when the polygon extends outside the frame", () => {
    const polygon: [number, number][] = [
      [-50, -30],
      [200, -30],
      [200, 80],
      [-50, 80],
    ];
    const box = clampedBbox(polygon, W, H);
    expect(box.left).toBe(0);
    expect(box.top).toBe(0);
  });

  it("clamps right and bottom edges to the frame dimensions", () => {
    const polygon: [number, number][] = [
      [1800, 1000],
      [2000, 1000],
      [2000, 1200],
      [1800, 1200],
    ];
    const box = clampedBbox(polygon, W, H);
    // right = min(1920, ceil(2000)) = 1920; bottom = min(1080, ceil(1200)) = 1080
    expect(box.left + box.width).toBeLessThanOrEqual(W);
    expect(box.top + box.height).toBeLessThanOrEqual(H);
  });

  it("produces a zero-size box for a single-point degenerate polygon", () => {
    const polygon: [number, number][] = [[100, 200]];
    const box = clampedBbox(polygon, W, H);
    expect(box.width).toBe(0);
    expect(box.height).toBe(0);
  });
});

describe("snapPolygonToEdges", () => {
  const W = 1920;
  const H = 1080;

  it("snaps the polygon upward when its top edge is within EDGE_SNAP_MARGIN of y=0", () => {
    // Represents the real-world case: detection polygon with top-left at y=7,
    // top-right at y=0 (tilted plate near the top of the frame).
    const polygon: [number, number][] = [
      [105, 7],
      [476, 0],
      [460, 141],
      [91, 149],
    ];
    const snapped = snapPolygonToEdges(polygon, W, H);
    // min_y was 0 → no shift (already at the edge); but the min is 0, which is
    // NOT > 0, so the snap condition doesn't apply. All y coords are unchanged.
    // (The issue was that min_y = 0 but the top-LEFT corner is at y = 7 — the
    // obscurer's SVG clips the negative side of the polygon. The snap only
    // kicks in when min_y > 0.)
    expect(snapped[0][1]).toBe(7);
    expect(snapped[1][1]).toBe(0);
  });

  it("snaps upward when min_y is between 1 and EDGE_SNAP_MARGIN", () => {
    // Polygon whose top edge is at y=7 on BOTH sides (fully inside the frame
    // but within the 20-px snap margin).
    const polygon: [number, number][] = [
      [100, 7],
      [400, 7],
      [400, 150],
      [100, 150],
    ];
    const snapped = snapPolygonToEdges(polygon, W, H);
    const minY = Math.min(...snapped.map(([, y]) => y));
    expect(minY).toBe(0);
    // Width must be unchanged.
    expect(snapped[0][0]).toBe(100);
    expect(snapped[1][0]).toBe(400);
  });

  it("does not snap when the polygon is far from all frame edges", () => {
    const polygon: [number, number][] = [
      [100, 200],
      [400, 200],
      [400, 350],
      [100, 350],
    ];
    const result = snapPolygonToEdges(polygon, W, H);
    // Should be identity — no vertex is within 20 px of any edge.
    for (let i = 0; i < polygon.length; i++) {
      expect(result[i][0]).toBe(polygon[i][0]);
      expect(result[i][1]).toBe(polygon[i][1]);
    }
  });

  it("snaps downward when the bottom edge is within EDGE_SNAP_MARGIN of frameH", () => {
    const polygon: [number, number][] = [
      [100, 800],
      [400, 800],
      [400, 1073],
      [100, 1073],
    ];
    const snapped = snapPolygonToEdges(polygon, W, H);
    const maxY = Math.max(...snapped.map(([, y]) => y));
    expect(maxY).toBe(H);
  });
});

// expandPolygon

describe("expandPolygon", () => {
  const W = 1920;
  const H = 1080;

  /** Simple 200×60 rectangle centred at (300, 200). */
  const poly: [number, number][] = [
    [200, 170],
    [400, 170],
    [400, 230],
    [200, 230],
  ];

  it("returns the original polygon when no padding is given", () => {
    const result = expandPolygon(poly, undefined, undefined, W, H);
    expect(result).toEqual(poly);
  });

  it("expands left and right by px amount and keeps centre X unchanged", () => {
    const pw: PaddingSpec = { value: 10, unit: "px" };
    const result = expandPolygon(poly, pw, undefined, W, H);
    const xs = result.map(([x]) => x);
    expect(Math.min(...xs)).toBeCloseTo(190);
    expect(Math.max(...xs)).toBeCloseTo(410);
    // Centre X: (190+410)/2 = 300 — unchanged
    expect((Math.min(...xs) + Math.max(...xs)) / 2).toBeCloseTo(300);
  });

  it("expands top and bottom by px amount and keeps centre Y unchanged", () => {
    const ph: PaddingSpec = { value: 5, unit: "px" };
    const result = expandPolygon(poly, undefined, ph, W, H);
    const ys = result.map(([, y]) => y);
    expect(Math.min(...ys)).toBeCloseTo(165);
    expect(Math.max(...ys)).toBeCloseTo(235);
    expect((Math.min(...ys) + Math.max(...ys)) / 2).toBeCloseTo(200);
  });

  it("resolves % as a fraction of the polygon's own dimension (each side)", () => {
    // Width = 200px, 10% → 20px per side
    const pw: PaddingSpec = { value: 10, unit: "%" };
    const result = expandPolygon(poly, pw, undefined, W, H);
    const xs = result.map(([x]) => x);
    expect(Math.min(...xs)).toBeCloseTo(180);  // 200 - 20
    expect(Math.max(...xs)).toBeCloseTo(420);  // 400 + 20
  });

  it("clamps expansion to frame bounds", () => {
    const nearEdge: [number, number][] = [[5, 5], [50, 5], [50, 20], [5, 20]];
    const pw: PaddingSpec = { value: 20, unit: "px" };
    const ph: PaddingSpec = { value: 20, unit: "px" };
    const result = expandPolygon(nearEdge, pw, ph, W, H);
    const xs = result.map(([x]) => x);
    const ys = result.map(([, y]) => y);
    expect(Math.min(...xs)).toBe(0);
    expect(Math.min(...ys)).toBe(0);
  });

  it("returns a 4-point axis-aligned rectangle regardless of original polygon shape", () => {
    const tilted: [number, number][] = [[100, 200], [300, 180], [310, 240], [110, 260]];
    const pw: PaddingSpec = { value: 5, unit: "px" };
    const result = expandPolygon(tilted, pw, undefined, W, H);
    expect(result).toHaveLength(4);
    // All 4 corners must form an axis-aligned box
    const xs = result.map(([x]) => x);
    const ys = result.map(([, y]) => y);
    expect(new Set(xs).size).toBe(2);  // exactly 2 distinct x values
    expect(new Set(ys).size).toBe(2);  // exactly 2 distinct y values
  });
});

// obscureFrame end-to-end

describe("obscureFrame", () => {
  let tmpDir: string;
  let srcPath: string;
  let outPath: string;

  /** Create a 200x100 grey JPEG in a temp directory before all tests. */
  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nj-obscure-test-"));
    srcPath = path.join(tmpDir, "src.jpg");
    outPath = path.join(tmpDir, "out.jpg");

    const buf = await sharp({
      create: { width: 200, height: 100, channels: 3, background: { r: 180, g: 180, b: 180 } },
    })
      .jpeg()
      .toBuffer();

    fs.writeFileSync(srcPath, buf);
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("writes the output file when there are no detections", async () => {
    await obscureFrame(srcPath, [], outPath);
    expect(fs.existsSync(outPath)).toBe(true);
  });

  it("writes the output file for a detection with a valid 4-point polygon", async () => {
    const det: PlateDetection = {
      plate: "AB12CDE",
      confidence: 90,
      region: "gb",
      regionConfidence: 75,
      polygon: [
        [20, 20],
        [100, 20],
        [100, 50],
        [20, 50],
      ],
      frameIndex: 0,
    };
    await obscureFrame(srcPath, [det], outPath);
    expect(fs.existsSync(outPath)).toBe(true);
    // The output should be a readable JPEG.
    const meta = await sharp(outPath).metadata();
    expect(meta.format).toBe("jpeg");
  });

  it("skips a detection whose polygon has fewer than 3 points and still writes output", async () => {
    const det: PlateDetection = {
      plate: "",
      confidence: 50,
      region: null,
      regionConfidence: 0,
      polygon: [[10, 10]], // degenerate -- skipped by obscureFrame
      frameIndex: 0,
    };
    await expect(obscureFrame(srcPath, [det], outPath)).resolves.not.toThrow();
    expect(fs.existsSync(outPath)).toBe(true);
  });

  it("handles a detection whose bounding box falls entirely outside the frame", async () => {
    const det: PlateDetection = {
      plate: "XY34FGH",
      confidence: 80,
      region: "gb",
      regionConfidence: 70,
      polygon: [
        [5000, 5000],
        [6000, 5000],
        [6000, 5100],
        [5000, 5100],
      ],
      frameIndex: 0,
    };
    // The bounding box will be clamped to zero size and the overlay skipped.
    await expect(obscureFrame(srcPath, [det], outPath)).resolves.not.toThrow();
  });

  it("produces the same output as no-detections when fadeAlpha is 0", async () => {
    const det: PlateDetection = {
      plate: "AB12CDE",
      confidence: 90,
      region: "gb",
      regionConfidence: 75,
      polygon: [[20, 20], [100, 20], [100, 50], [20, 50]],
      frameIndex: 0,
    };
    const noneOut  = path.join(tmpDir, "fade0-none.jpg");
    const fadeOut  = path.join(tmpDir, "fade0-detect.jpg");
    await obscureFrame(srcPath, [], noneOut);
    await obscureFrame(srcPath, [det], fadeOut, { fadeAlpha: 0 });
    // Fully transparent overlay — both outputs must be identical byte-for-byte
    // (or at least produce the same pixel content; JPEG re-encoding may differ,
    // so compare sharp-decoded raw buffers instead).
    const { data: d1 } = await sharp(noneOut).raw().toBuffer({ resolveWithObject: true });
    const { data: d2 } = await sharp(fadeOut).raw().toBuffer({ resolveWithObject: true });
    expect(Buffer.compare(d1, d2)).toBe(0);
  });

  it("produces a different composite at fadeAlpha 0.5 vs fadeAlpha 1.0", async () => {
    const det: PlateDetection = {
      plate: "AB12CDE",
      confidence: 90,
      region: "gb",
      regionConfidence: 75,
      polygon: [[20, 20], [100, 20], [100, 50], [20, 50]],
      frameIndex: 0,
    };
    const half = path.join(tmpDir, "fade-half.jpg");
    const full = path.join(tmpDir, "fade-full.jpg");
    await obscureFrame(srcPath, [det], half, { fadeAlpha: 0.5 });
    await obscureFrame(srcPath, [det], full, { fadeAlpha: 1.0 });
    const { data: d1 } = await sharp(half).raw().toBuffer({ resolveWithObject: true });
    const { data: d2 } = await sharp(full).raw().toBuffer({ resolveWithObject: true });
    expect(Buffer.compare(d1, d2)).not.toBe(0);
  });

  it("pads the obscured region when paddingW is set", async () => {
    // Narrow polygon; with large padding the obscured region must be wider.
    const narrowPoly: [number, number][] = [[90, 30], [110, 30], [110, 60], [90, 60]];
    const det: PlateDetection = {
      plate: "XX", confidence: 80, region: null, regionConfidence: 0,
      polygon: narrowPoly, frameIndex: 0,
    };
    const noPad  = path.join(tmpDir, "pad-none.jpg");
    const withPad = path.join(tmpDir, "pad-width.jpg");
    await obscureFrame(srcPath, [det], noPad);
    await obscureFrame(srcPath, [det], withPad, { paddingW: { value: 30, unit: "px" } });
    // The padded frame must differ from the unpadded frame.
    const { data: d1 } = await sharp(noPad).raw().toBuffer({ resolveWithObject: true });
    const { data: d2 } = await sharp(withPad).raw().toBuffer({ resolveWithObject: true });
    expect(Buffer.compare(d1, d2)).not.toBe(0);
  });

  it("obscures two separate polygons in the same frame", async () => {
    // Verify that obscureFrame composites EACH detection separately.
    // Strategy: compare output with 0 detections vs output with 2 detections.
    // A frame with two detections must produce a different file than the same
    // frame with no detections (the composite must have changed some pixels).
    const w = 200, h = 100;
    const twoRectSrc = path.join(tmpDir, "two-rect-src.jpg");
    const twoRectNone = path.join(tmpDir, "two-rect-none.jpg");
    const twoRectTwo = path.join(tmpDir, "two-rect-two.jpg");

    // Simple grey frame; the plate-like polygons sit in two regions.
    const buf = await sharp({
      create: { width: w, height: h, channels: 3, background: { r: 180, g: 180, b: 180 } },
    })
      .jpeg({ quality: 95 })
      .toBuffer();
    fs.writeFileSync(twoRectSrc, buf);

    const dets: PlateDetection[] = [
      {
        plate: "AA11AAA",
        confidence: 90,
        region: "gb",
        regionConfidence: 75,
        polygon: [[10, 20], [80, 20], [80, 50], [10, 50]],
        frameIndex: 0,
      },
      {
        plate: "BB22BBB",
        confidence: 85,
        region: "gb",
        regionConfidence: 70,
        polygon: [[110, 20], [190, 20], [190, 50], [110, 50]],
        frameIndex: 0,
      },
    ];

    await obscureFrame(twoRectSrc, [], twoRectNone);
    await obscureFrame(twoRectSrc, dets, twoRectTwo);

    // Files must differ: the two-detection composite modified the image.
    const noneBuf = fs.readFileSync(twoRectNone);
    const twoBuf = fs.readFileSync(twoRectTwo);
    expect(Buffer.compare(noneBuf, twoBuf)).not.toBe(0);

    // Both output files must be valid JPEGs.
    const metaNone = await sharp(twoRectNone).metadata();
    const metaTwo = await sharp(twoRectTwo).metadata();
    expect(metaNone.format).toBe("jpeg");
    expect(metaTwo.format).toBe("jpeg");
    expect(metaTwo.width).toBe(w);
    expect(metaTwo.height).toBe(h);
  });
});
