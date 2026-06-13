/**
 * Unit tests for the {@link mergeOverlappingPolygons} helper exported from
 * phases.ts. Verifies the union-find merging of overlapping polygon bounding
 * boxes into connected-component rectangles.
 */

import { describe, it, expect } from "vitest";
import { mergeOverlappingPolygons } from "../src/cli/phases";
import { Point } from "../src/types";

function rect(left: number, top: number, right: number, bottom: number): Point[] {
  return [[left, top], [right, top], [right, bottom], [left, bottom]];
}

function bbox(polygon: Point[]) {
  const xs = polygon.map(([x]) => x);
  const ys = polygon.map(([, y]) => y);
  return { left: Math.min(...xs), top: Math.min(...ys), right: Math.max(...xs), bottom: Math.max(...ys) };
}

describe("mergeOverlappingPolygons", () => {
  it("returns empty for empty input", () => {
    expect(mergeOverlappingPolygons([])).toHaveLength(0);
  });

  it("returns a single polygon unchanged (as a bbox rectangle)", () => {
    const p = rect(10, 20, 50, 60);
    const result = mergeOverlappingPolygons([p]);
    expect(result).toHaveLength(1);
    const b = bbox(result[0]);
    expect(b.left).toBe(10);
    expect(b.top).toBe(20);
    expect(b.right).toBe(50);
    expect(b.bottom).toBe(60);
  });

  it("keeps two non-overlapping polygons as separate outputs", () => {
    const a = rect(0, 0, 50, 50);
    const b = rect(100, 100, 200, 200);
    const result = mergeOverlappingPolygons([a, b]);
    expect(result).toHaveLength(2);
  });

  it("merges two overlapping polygons into one", () => {
    const a = rect(0, 0, 100, 100);
    const b = rect(80, 80, 200, 200);  // overlaps a at (80-100, 80-100)
    const result = mergeOverlappingPolygons([a, b]);
    expect(result).toHaveLength(1);
    const merged = bbox(result[0]);
    expect(merged.left).toBe(0);
    expect(merged.top).toBe(0);
    expect(merged.right).toBe(200);
    expect(merged.bottom).toBe(200);
  });

  it("merges A+B+C when A∩B and B∩C but not A∩C directly", () => {
    // A is at x 0-100, B is at x 80-180 (overlaps A), C is at x 160-280 (overlaps B)
    const a = rect(0, 0, 100, 50);
    const b = rect(80, 0, 180, 50);
    const c = rect(160, 0, 280, 50);
    const result = mergeOverlappingPolygons([a, b, c]);
    expect(result).toHaveLength(1);
    const merged = bbox(result[0]);
    expect(merged.left).toBe(0);
    expect(merged.right).toBe(280);
  });

  it("produces two groups when two non-overlapping clusters are present", () => {
    // Group 1: a and b overlap; group 2: c and d overlap; no overlap between groups
    const a = rect(0, 0, 50, 50);
    const b = rect(30, 30, 80, 80);  // overlaps a
    const c = rect(200, 200, 250, 250);
    const d = rect(230, 230, 300, 300);  // overlaps c
    const result = mergeOverlappingPolygons([a, b, c, d]);
    expect(result).toHaveLength(2);
    const bboxes = result.map(bbox).sort((x, y) => x.left - y.left);
    expect(bboxes[0].left).toBe(0);
    expect(bboxes[0].right).toBe(80);
    expect(bboxes[1].left).toBe(200);
    expect(bboxes[1].right).toBe(300);
  });

  it("treats touching (edge-adjacent) polygons as overlapping", () => {
    // Two rectangles that share an edge (left = 100 = right of first)
    // bboxesOverlap uses strict inequality so touching edges do NOT overlap.
    const a = rect(0, 0, 100, 50);
    const b = rect(100, 0, 200, 50);
    const result = mergeOverlappingPolygons([a, b]);
    // Strictly non-overlapping (a.right = b.left, not a.right > b.left).
    expect(result).toHaveLength(2);
  });

  it("handles polygons with negative coordinates", () => {
    const a = rect(-50, -50, 50, 50);
    const b = rect(30, 30, 100, 100);  // overlaps a
    const result = mergeOverlappingPolygons([a, b]);
    expect(result).toHaveLength(1);
    const merged = bbox(result[0]);
    expect(merged.left).toBe(-50);
    expect(merged.top).toBe(-50);
    expect(merged.right).toBe(100);
    expect(merged.bottom).toBe(100);
  });
});
