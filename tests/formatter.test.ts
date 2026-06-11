/**
 * Unit tests for the output formatter.
 *
 * {@link buildOutputDoc} is a pure function with no external dependencies, so
 * every code path can be exercised here using synthetic data structures.
 */

import { describe, it, expect } from "vitest";
import { buildOutputDoc } from "../src/output/formatter";
import { RequestInfo, Track } from "../src/types";

/** Minimal {@link RequestInfo} used across multiple tests. Tracking on by default so
 * existing tests that inspect doc.tracking continue to work. */
const REQ: RequestInfo = {
  path: "video.mp4",
  regions: ["gb"],
  pixelate: false,
  includeTracking: true,
};

/**
 * Builds a minimal {@link Track} with a single history entry, to keep
 * test fixtures concise.
 */
function track(
  plate: string,
  region: string | null = null,
  frameIndex = 0,
  timestamp = 0
): Track {
  return {
    plate,
    region,
    history: [
      {
        frameIndex,
        timestamp,
        polygon: [
          [10, 20],
          [50, 20],
          [50, 40],
          [10, 40],
        ],
      },
    ],
  };
}

describe("buildOutputDoc", () => {
  it("returns empty summary and tracking arrays when given no tracks", () => {
    const doc = buildOutputDoc(REQ, [], 10, null);
    expect(doc.summary).toEqual([]);
    expect(doc.tracking).toEqual([]);
  });

  it("echoes the request object unchanged into the output", () => {
    const req: RequestInfo = {
      path: "my-video.mp4",
      regions: ["de", "fr"],
      pixelate: true,
      includeTracking: false,
    };
    const doc = buildOutputDoc(req, [], 5, null);
    expect(doc.request).toEqual(req);
  });

  it("produces one summary entry and one tracking entry for a single track", () => {
    const doc = buildOutputDoc(REQ, [track("AB12CDE", "gb")], 10, null);
    expect(doc.summary).toHaveLength(1);
    expect(doc.summary[0]).toEqual({ plate: "AB12CDE", region: "gb" });
    expect(doc.tracking).toHaveLength(1);
    expect(doc.tracking[0].plate).toBe("AB12CDE");
  });

  it("history entries expose only timestamp and polygon, not frameIndex", () => {
    const doc = buildOutputDoc(REQ, [track("AB12CDE", "gb", 5, 0.2)], 10, null);
    const entry = doc.tracking[0].history[0];
    expect("frameIndex" in entry).toBe(false);
    expect(entry.timestamp).toBe(0.2);
    expect(entry.polygon).toHaveLength(4);
  });

  it("deduplicates two tracks with the same plate text into one summary entry", () => {
    const tracks = [track("AB12CDE", "gb", 0), track("AB12CDE", "gb", 5)];
    const doc = buildOutputDoc(REQ, tracks, 10, null);
    expect(doc.summary).toHaveLength(1);
    expect(doc.summary[0].plate).toBe("AB12CDE");
  });

  it("retains two separate summary entries for tracks with different plate text", () => {
    const tracks = [track("AB12CDE", "gb"), track("XY34FGH", "gb")];
    const doc = buildOutputDoc(REQ, tracks, 10, null);
    expect(doc.summary).toHaveLength(2);
    const plates = doc.summary.map((s) => s.plate).sort();
    expect(plates).toEqual(["AB12CDE", "XY34FGH"]);
  });

  it("upgrades a null region to a known region when a later track provides one", () => {
    const tracks = [track("AB12CDE", null), track("AB12CDE", "gb")];
    const doc = buildOutputDoc(REQ, tracks, 10, null);
    expect(doc.summary).toHaveLength(1);
    expect(doc.summary[0].region).toBe("gb");
  });

  it("does not downgrade a known region to null for a duplicate plate", () => {
    const tracks = [track("AB12CDE", "gb"), track("AB12CDE", null)];
    const doc = buildOutputDoc(REQ, tracks, 10, null);
    expect(doc.summary).toHaveLength(1);
    expect(doc.summary[0].region).toBe("gb");
  });

  it("includes a partial (empty-string) plate track in the summary", () => {
    const tracks = [track("", null), track("AB12CDE", "gb")];
    const doc = buildOutputDoc(REQ, tracks, 10, null);
    const plates = doc.summary.map((s) => s.plate);
    expect(plates).toContain("");
  });

  it("returns an empty tracking array when includeTracking is false", () => {
    const req: RequestInfo = { ...REQ, includeTracking: false };
    const doc = buildOutputDoc(req, [track("AB12CDE", "gb")], 10, null);
    expect(doc.tracking).toEqual([]);
    expect(doc.summary).toHaveLength(1);
  });

  it("populates tracking when includeTracking is true", () => {
    const req: RequestInfo = { ...REQ, includeTracking: true };
    const doc = buildOutputDoc(req, [track("AB12CDE", "gb")], 10, null);
    expect(doc.tracking).toHaveLength(1);
    expect(doc.tracking[0].plate).toBe("AB12CDE");
  });

  it("includes duration and output at the top level of the document", () => {
    const doc = buildOutputDoc(REQ, [], 42.5, "/tmp/out.mp4");
    expect(doc.duration).toBe(42.5);
    expect(doc.output).toBe("/tmp/out.mp4");
  });

  it("passes output as null when pixelation was not performed", () => {
    const doc = buildOutputDoc(REQ, [], 10, null);
    expect(doc.output).toBeNull();
  });
});
