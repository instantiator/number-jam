/**
 * Unit tests for helper functions exported from {@link src/cli/phases.ts}.
 */

import { describe, it, expect } from "vitest";
import { velocityFromBackCoverage, computeFadeExtensions } from "../src/cli/phases";
import { Point } from "../src/types";

function rect(cx: number, cy: number, w = 40, h = 20): Point[] {
  return [
    [cx - w / 2, cy - h / 2],
    [cx + w / 2, cy - h / 2],
    [cx + w / 2, cy + h / 2],
    [cx - w / 2, cy + h / 2],
  ];
}

/** Minimal polygon for use in fade tests. */
const POLY: Point[] = [[0, 0], [10, 0], [10, 5], [0, 5]];

function polygonMap(frameIndices: number[]): Map<number, Point[][]> {
  return new Map(frameIndices.map((fi) => [fi, [POLY]]));
}

describe("computeFadeExtensions", () => {
  it("returns empty maps when fadeFrames is 0", () => {
    const trackPolygons = polygonMap([10, 11, 12]);
    const { extensions, fadeAlphas } = computeFadeExtensions(trackPolygons, 0, 100);
    expect(extensions.size).toBe(0);
    expect(fadeAlphas.size).toBe(0);
  });

  it("returns empty maps when trackPolygons is empty", () => {
    const { extensions, fadeAlphas } = computeFadeExtensions(new Map(), 5, 100);
    expect(extensions.size).toBe(0);
    expect(fadeAlphas.size).toBe(0);
  });

  it("adds fade-in frames before the first covered frame", () => {
    // Run: frames 10–20; fade = 5 frames → pre-frames [5, 6, 7, 8, 9]
    const trackPolygons = polygonMap([10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20]);
    const { extensions, fadeAlphas } = computeFadeExtensions(trackPolygons, 5, 100);

    expect(extensions.has(9)).toBe(true);
    expect(extensions.has(5)).toBe(true);
    expect(extensions.has(4)).toBe(false);
    expect(fadeAlphas.has(9)).toBe(true);
    // alpha at fi=9: (9 - (10 - 5)) / 5 = 4/5 = 0.8
    expect(fadeAlphas.get(9)).toBeCloseTo(0.8);
    // alpha at fi=5: (5 - 5) / 5 = 0
    expect(fadeAlphas.get(5)).toBeCloseTo(0);
  });

  it("adds fade-out frames after the last covered frame", () => {
    // Run: frames 10–20; fade = 5 → post-frames [21, 22, 23, 24, 25]
    const trackPolygons = polygonMap([10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20]);
    const { extensions, fadeAlphas } = computeFadeExtensions(trackPolygons, 5, 100);

    expect(extensions.has(21)).toBe(true);
    expect(extensions.has(25)).toBe(true);
    expect(extensions.has(26)).toBe(false);
    // alpha at fi=21: 1 - (21-20)/5 = 0.8
    expect(fadeAlphas.get(21)).toBeCloseTo(0.8);
    // alpha at fi=25: 1 - (25-20)/5 = 0
    expect(fadeAlphas.get(25)).toBeCloseTo(0);
  });

  it("clips fade-in to video start (frame 0) without changing the alpha rate", () => {
    // Run starts at frame 3, fade = 10 → would start at -7, clipped to 0
    // At fi=0: alpha = (0 - (3 - 10)) / 10 = 7/10 = 0.7 (not 0)
    const trackPolygons = polygonMap([3, 4, 5]);
    const { extensions, fadeAlphas } = computeFadeExtensions(trackPolygons, 10, 100);

    expect(extensions.has(0)).toBe(true);
    expect(extensions.has(2)).toBe(true);
    expect(fadeAlphas.get(0)).toBeCloseTo(0.7);
    expect(fadeAlphas.get(2)).toBeCloseTo(0.9);
  });

  it("clips fade-out to the last video frame without changing the alpha rate", () => {
    // Run ends at frame 97, fade = 10, totalFrames = 100 → clipped at 99
    // At fi=99: alpha = 1 - (99-97)/10 = 0.8
    const trackPolygons = polygonMap([95, 96, 97]);
    const { extensions, fadeAlphas } = computeFadeExtensions(trackPolygons, 10, 100);

    expect(extensions.has(98)).toBe(true);
    expect(extensions.has(99)).toBe(true);
    expect(extensions.has(100)).toBe(false);
    expect(fadeAlphas.get(99)).toBeCloseTo(0.8);
  });

  it("handles two separate runs with independent fade windows", () => {
    // Run A: [10, 11]; Run B: [30, 31]; fade = 3
    const trackPolygons = polygonMap([10, 11, 30, 31]);
    const { extensions, fadeAlphas } = computeFadeExtensions(trackPolygons, 3, 100);

    // Run A fade-in: [7, 8, 9]
    expect(extensions.has(7)).toBe(true);
    expect(extensions.has(9)).toBe(true);
    // Run A fade-out: [12, 13, 14]
    expect(extensions.has(12)).toBe(true);
    expect(extensions.has(14)).toBe(true);
    // Run B fade-in: [27, 28, 29]
    expect(extensions.has(27)).toBe(true);
    expect(extensions.has(29)).toBe(true);
    // Gap frames (15–26) must not be added
    expect(extensions.has(20)).toBe(false);
    // Alphas for A and B are independent
    expect(fadeAlphas.get(14)).toBeCloseTo(0); // last fade-out frame of run A
    expect(fadeAlphas.get(27)).toBeCloseTo(0); // first fade-in frame of run B
  });

  it("uses the polygon from the endpoint frame for extension frames", () => {
    const altPoly: Point[] = [[100, 100], [200, 100], [200, 150], [100, 150]];
    const trackPolygons = new Map<number, Point[][]>([
      [10, [POLY]],
      [11, [altPoly]],
    ]);
    const { extensions } = computeFadeExtensions(trackPolygons, 2, 100);
    // Fade-in frames use the start-frame polygon (frame 10 → POLY)
    expect(extensions.get(8)).toEqual([POLY]);
    expect(extensions.get(9)).toEqual([POLY]);
    // Fade-out frames use the end-frame polygon (frame 11 → altPoly)
    expect(extensions.get(12)).toEqual([altPoly]);
    expect(extensions.get(13)).toEqual([altPoly]);
  });
});

describe("velocityFromBackCoverage", () => {
  it("returns [0, 0] for empty backCoverage", () => {
    expect(velocityFromBackCoverage([])).toEqual([0, 0]);
  });

  it("returns [0, 0] for a single-entry backCoverage", () => {
    const entry = { frameIndex: 10, polygon: rect(100, 50) };
    expect(velocityFromBackCoverage([entry])).toEqual([0, 0]);
  });

  it("returns negative vx for leftward motion (plate moving left as time increases)", () => {
    // backCoverage is descending frameIndex: [0]=newest, [1]=older
    // Newest (fi=9) centroid at x=90, oldest (fi=7) centroid at x=110
    // span = 9-7 = 2; dx = (90-110)/2 = -10 px/frame
    const entries = [
      { frameIndex: 9, polygon: rect(90, 50) },   // newest — closest to detection
      { frameIndex: 7, polygon: rect(110, 50) },  // older
    ];
    const [vx, vy] = velocityFromBackCoverage(entries);
    expect(vx).toBeCloseTo(-10);
    expect(vy).toBeCloseTo(0);
  });

  it("returns positive vx for rightward motion", () => {
    const entries = [
      { frameIndex: 10, polygon: rect(200, 60) },
      { frameIndex: 7, polygon: rect(170, 60) },
    ];
    const [vx] = velocityFromBackCoverage(entries);
    // dx = (200-170) / (10-7) = 30/3 = 10
    expect(vx).toBeCloseTo(10);
  });

  it("returns [0, 0] for a stationary plate (all entries at same position)", () => {
    const entries = [
      { frameIndex: 15, polygon: rect(300, 10) },
      { frameIndex: 13, polygon: rect(300, 10) },
      { frameIndex: 11, polygon: rect(300, 10) },
      { frameIndex: 9, polygon: rect(300, 10) },
    ];
    const [vx, vy] = velocityFromBackCoverage(entries);
    expect(vx).toBeCloseTo(0);
    expect(vy).toBeCloseTo(0);
  });

  it("uses only the first `count` entries (closest to the detection)", () => {
    // 5 entries, count=2: uses [0] and [1] only (fi=10 and fi=8)
    // dx = (100-80) / (10-8) = 10 px/frame
    const entries = [
      { frameIndex: 10, polygon: rect(100, 50) },
      { frameIndex: 8, polygon: rect(80, 50) },
      // These older entries have contradictory motion; should be ignored
      { frameIndex: 5, polygon: rect(500, 50) },
      { frameIndex: 3, polygon: rect(600, 50) },
      { frameIndex: 1, polygon: rect(700, 50) },
    ];
    const [vx] = velocityFromBackCoverage(entries, 2);
    expect(vx).toBeCloseTo(10);
  });

  it("handles vertical motion correctly", () => {
    // Plate moving upward (vy < 0 means moving toward top of frame)
    const entries = [
      { frameIndex: 20, polygon: rect(200, 30) },
      { frameIndex: 16, polygon: rect(200, 50) },
    ];
    const [vx, vy] = velocityFromBackCoverage(entries);
    // dy = (30-50) / (20-16) = -20/4 = -5
    expect(vx).toBeCloseTo(0);
    expect(vy).toBeCloseTo(-5);
  });
});
