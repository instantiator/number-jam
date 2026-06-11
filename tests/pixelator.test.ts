/**
 * Unit tests for the plate pixelation module.
 *
 * The pure geometry helpers {@link plateAngleDeg} and {@link clampedBbox} are
 * tested with synthetic polygon data.  {@link pixelateFrame} is tested
 * end-to-end using a small synthetic JPEG created in memory by sharp, so that
 * no real video fixture is required.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import sharp from "sharp";
import {
  pixelateFrame,
  plateAngleDeg,
  clampedBbox,
} from "../src/pixelation/pixelator";
import { PlateDetection } from "../src/types";

// ── Geometry helpers ─────────────────────────────────────────────────────────

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

// ── pixelateFrame end-to-end ──────────────────────────────────────────────────

describe("pixelateFrame", () => {
  let tmpDir: string;
  let srcPath: string;
  let outPath: string;

  /** Create a 200×100 grey JPEG in a temp directory before all tests. */
  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nj-pix-test-"));
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
    await pixelateFrame(srcPath, [], outPath);
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
    await pixelateFrame(srcPath, [det], outPath);
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
      polygon: [[10, 10]], // degenerate — skipped by pixelateFrame
      frameIndex: 0,
    };
    await expect(pixelateFrame(srcPath, [det], outPath)).resolves.not.toThrow();
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
    await expect(pixelateFrame(srcPath, [det], outPath)).resolves.not.toThrow();
  });
});
