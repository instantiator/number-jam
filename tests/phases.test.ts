/**
 * Unit tests for helper functions exported from {@link src/cli/phases.ts}.
 */

import { describe, it, expect } from "vitest";
import { velocityFromBackCoverage } from "../src/cli/phases";
import { Point } from "../src/types";

function rect(cx: number, cy: number, w = 40, h = 20): Point[] {
  return [
    [cx - w / 2, cy - h / 2],
    [cx + w / 2, cy - h / 2],
    [cx + w / 2, cy + h / 2],
    [cx - w / 2, cy + h / 2],
  ];
}

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
