import { describe, it, expect } from "vitest";
import { centroid, velocityFromHead, velocityFromTail, shiftPolygon } from "../src/tracking/motion";
import { TrackHistoryEntry } from "../src/types";

function makeEntry(frameIndex: number, x: number, y: number, w: number, h: number): TrackHistoryEntry {
  return {
    frameIndex,
    timestamp: frameIndex / 25,
    polygon: [
      [x, y],
      [x + w, y],
      [x + w, y + h],
      [x, y + h],
    ],
  };
}

describe("centroid", () => {
  it("returns the centre of an axis-aligned square", () => {
    const [cx, cy] = centroid([[0, 0], [10, 0], [10, 10], [0, 10]]);
    expect(cx).toBeCloseTo(5);
    expect(cy).toBeCloseTo(5);
  });

  it("handles a single-point degenerate polygon", () => {
    const [cx, cy] = centroid([[7, 3]]);
    expect(cx).toBe(7);
    expect(cy).toBe(3);
  });
});

describe("velocityFromHead", () => {
  it("returns [0, 0] for a single-entry history", () => {
    const h = [makeEntry(0, 100, 100, 80, 30)];
    expect(velocityFromHead(h)).toEqual([0, 0]);
  });

  it("computes the per-frame velocity from the first two entries", () => {
    // Centroid moves from (140, 115) to (145, 115): dx=5, dy=0 over 1 frame
    const h = [makeEntry(0, 100, 100, 80, 30), makeEntry(1, 105, 100, 80, 30)];
    const [dx, dy] = velocityFromHead(h);
    expect(dx).toBeCloseTo(5);
    expect(dy).toBeCloseTo(0);
  });

  it("averages over the sample window when more entries are available", () => {
    // Centroid: frame 0 at x=140, frame 2 at x=150 → dx = 5/frame over span of 2
    const h = [
      makeEntry(0, 100, 100, 80, 30),
      makeEntry(1, 105, 100, 80, 30),
      makeEntry(2, 110, 100, 80, 30),
    ];
    const [dx] = velocityFromHead(h, 3);
    expect(dx).toBeCloseTo(5);
  });

  it("respects the count parameter", () => {
    // count=2 should only use entries 0 and 1
    const h = [
      makeEntry(0, 100, 100, 80, 30),
      makeEntry(1, 105, 100, 80, 30),
      makeEntry(2, 200, 100, 80, 30), // far jump — should be ignored with count=2
    ];
    const [dx] = velocityFromHead(h, 2);
    expect(dx).toBeCloseTo(5);
  });

  it("returns [0, 0] when the frame span is zero", () => {
    // Two entries with the same frameIndex
    const h: TrackHistoryEntry[] = [
      { frameIndex: 5, timestamp: 0, polygon: [[100, 100], [180, 100], [180, 130], [100, 130]] },
      { frameIndex: 5, timestamp: 0, polygon: [[110, 100], [190, 100], [190, 130], [110, 130]] },
    ];
    expect(velocityFromHead(h)).toEqual([0, 0]);
  });
});

describe("velocityFromTail", () => {
  it("returns [0, 0] for a single-entry history", () => {
    const h = [makeEntry(0, 100, 100, 80, 30)];
    expect(velocityFromTail(h)).toEqual([0, 0]);
  });

  it("uses the last N entries to compute exit velocity", () => {
    // Last two entries: frame 8 centroid x=145, frame 9 centroid x=150 → dx=5
    const h = [
      makeEntry(0, 100, 100, 80, 30),
      makeEntry(8, 105, 100, 80, 30),
      makeEntry(9, 110, 100, 80, 30),
    ];
    const [dx] = velocityFromTail(h, 2);
    expect(dx).toBeCloseTo(5);
  });

  it("ignores early entries when count limits the tail window", () => {
    // count=2 only looks at frames 8 and 9; frame 0 should be ignored
    const h = [
      makeEntry(0, 0, 0, 80, 30),      // very different position
      makeEntry(8, 105, 100, 80, 30),
      makeEntry(9, 110, 100, 80, 30),
    ];
    const [dx] = velocityFromTail(h, 2);
    expect(dx).toBeCloseTo(5);
  });
});

describe("shiftPolygon", () => {
  it("translates all vertices by (dx, dy)", () => {
    const poly: [number, number][] = [[10, 20], [50, 20], [50, 40], [10, 40]];
    const shifted = shiftPolygon(poly, 5, -3);
    expect(shifted).toEqual([[15, 17], [55, 17], [55, 37], [15, 37]]);
  });

  it("is a no-op when dx and dy are both zero", () => {
    const poly: [number, number][] = [[10, 20], [50, 20], [50, 40], [10, 40]];
    expect(shiftPolygon(poly, 0, 0)).toEqual(poly);
  });

  it("handles negative shifts", () => {
    const poly: [number, number][] = [[100, 200], [200, 200], [200, 250], [100, 250]];
    const shifted = shiftPolygon(poly, -50, -75);
    expect(shifted[0]).toEqual([50, 125]);
  });
});
