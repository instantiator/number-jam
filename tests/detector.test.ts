/**
 * Unit tests for the frame detection orchestrator.
 *
 * {@link detectAllFrames} delegates detection to a {@link DetectionEngine} and
 * applies a post-filter on the results.  These tests exercise the region
 * filtering logic using a minimal stub engine — no subprocess or network call
 * is made.
 */

import { describe, it, expect } from "vitest";
import { detectAllFrames } from "../src/detection/detector";
import { DetectionEngine } from "../src/detection/engine";
import { FrameInfo, PlateDetection } from "../src/types";

/**
 * Build a {@link FrameInfo} with sensible defaults so test cases can focus
 * only on the fields that matter.
 */
function frameInfo(frameIndex: number): FrameInfo {
  return {
    frameIndex,
    filePath: `/frames/frame_${String(frameIndex).padStart(6, "0")}.jpg`,
    timestamp: frameIndex / 25,
  };
}

/**
 * Build a minimal {@link PlateDetection} carrying only the fields exercised
 * by the region filter.
 */
function detection(plate: string, region: string | null): PlateDetection {
  return {
    plate,
    confidence: 90,
    region,
    regionConfidence: region ? 75 : 0,
    polygon: [
      [10, 20],
      [60, 20],
      [60, 40],
      [10, 40],
    ],
    frameIndex: 0,
  };
}

/**
 * Creates a stub {@link DetectionEngine} that returns a fixed set of
 * detections for every frame, regardless of input.
 */
function stubEngine(detections: PlateDetection[]): DetectionEngine {
  return {
    check: async () => {},
    startup: async () => {},
    shutdown: async () => {},
    detectPlates: async () => detections,
  };
}

describe("detectAllFrames – frame iteration", () => {
  it("returns an empty array when given no frames", async () => {
    const results = await detectAllFrames([], ["*"], stubEngine([]));
    expect(results).toEqual([]);
  });

  it("returns one result per input frame", async () => {
    const frames = [frameInfo(0), frameInfo(1), frameInfo(2)];
    const results = await detectAllFrames(frames, ["*"], stubEngine([]));
    expect(results).toHaveLength(3);
  });

  it("copies frameIndex, filePath, and timestamp faithfully from FrameInfo", async () => {
    const frames = [frameInfo(7)];
    const results = await detectAllFrames(frames, ["*"], stubEngine([]));
    expect(results[0].frameIndex).toBe(7);
    expect(results[0].filePath).toBe("/frames/frame_000007.jpg");
    expect(results[0].timestamp).toBeCloseTo(7 / 25);
  });
});

describe("detectAllFrames – region filtering", () => {
  const gbDetection = detection("AB12CDE", "gb");
  const deDetection = detection("B MU1234", "de");
  const subCodeDetection = detection("7ABC123", "us-ca");
  const nullRegion = detection("UNKNOWN", null);

  it("wildcard [\"*\"] passes all detections through unfiltered", async () => {
    const frames = [frameInfo(0)];
    const results = await detectAllFrames(
      frames,
      ["*"],
      stubEngine([gbDetection, deDetection])
    );
    expect(results[0].detections).toHaveLength(2);
  });

  it("empty regions [] passes all detections through (treated as wildcard)", async () => {
    const frames = [frameInfo(0)];
    const results = await detectAllFrames(
      frames,
      [],
      stubEngine([gbDetection, deDetection])
    );
    expect(results[0].detections).toHaveLength(2);
  });

  it("single region keeps only matching detections", async () => {
    const frames = [frameInfo(0)];
    const results = await detectAllFrames(
      frames,
      ["gb"],
      stubEngine([gbDetection, deDetection])
    );
    expect(results[0].detections).toHaveLength(1);
    expect(results[0].detections[0].region).toBe("gb");
  });

  it("sub-code match: region filter [\"us\"] keeps a detection with region \"us-ca\"", async () => {
    const frames = [frameInfo(0)];
    const results = await detectAllFrames(
      frames,
      ["us"],
      stubEngine([subCodeDetection, gbDetection])
    );
    const regions = results[0].detections.map((d) => d.region);
    expect(regions).toContain("us-ca");
    expect(regions).not.toContain("gb");
  });

  it("non-matching region drops the detection", async () => {
    const frames = [frameInfo(0)];
    const results = await detectAllFrames(
      frames,
      ["de"],
      stubEngine([gbDetection])
    );
    expect(results[0].detections).toHaveLength(0);
  });

  it("multiple region codes keep detections matching any of them", async () => {
    const frames = [frameInfo(0)];
    const results = await detectAllFrames(
      frames,
      ["gb", "de"],
      stubEngine([gbDetection, deDetection, subCodeDetection])
    );
    const regions = results[0].detections.map((d) => d.region);
    expect(regions).toContain("gb");
    expect(regions).toContain("de");
    expect(regions).not.toContain("us-ca");
  });

  it("null-region detections always pass through regardless of region filter", async () => {
    const frames = [frameInfo(0)];
    const results = await detectAllFrames(
      frames,
      ["gb"],
      stubEngine([nullRegion, deDetection])
    );
    const regions = results[0].detections.map((d) => d.region);
    expect(regions).toContain(null);
    expect(regions).not.toContain("de");
  });
});
