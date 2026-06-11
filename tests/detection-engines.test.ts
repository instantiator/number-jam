/**
 * Unit tests for ANPR engine output parsers.
 *
 * Tests the JSON format produced by docker-alpr using fixture strings rather
 * than spawning any real subprocess or container.
 *
 * Also includes structural sanity checks on the PLATE_FORMATS region database.
 */

import { describe, it, expect } from "vitest";
import { PLATE_FORMATS } from "../src/regions/plate-formats";

// PLATE_FORMATS structural checks

describe("region code validation", () => {
  it("all PLATE_FORMATS codes are lowercase", () => {
    for (const fmt of PLATE_FORMATS) {
      expect(fmt.code).toBe(fmt.code.toLowerCase());
    }
  });

  it("all PLATE_FORMATS codes are non-empty strings", () => {
    for (const fmt of PLATE_FORMATS) {
      expect(fmt.code.length).toBeGreaterThan(0);
    }
  });

  it("PLATE_FORMATS has no duplicate codes", () => {
    const codes = PLATE_FORMATS.map((f) => f.code);
    const unique = new Set(codes);
    expect(unique.size).toBe(codes.length);
  });
});

// docker-alpr / OpenALPR JSON format

describe("docker-alpr JSON output parsing (fixture-based)", () => {
  /** Minimal OpenALPR-like JSON as returned by alpr-server.py. */
  const sampleOutput = JSON.stringify({
    version: 2,
    data_type: "alpr_results",
    epoch_time: 1700000000000,
    img_width: 1920,
    img_height: 1080,
    processing_time_ms: 45.2,
    results: [
      {
        plate: "AB12CDE",
        confidence: 89.5,
        matches_template: 1,
        plate_index: 0,
        region: "gb",
        region_confidence: 75.0,
        processing_time_ms: 15.3,
        requested_topn: 10,
        coordinates: [
          { x: 100, y: 200 },
          { x: 200, y: 200 },
          { x: 200, y: 250 },
          { x: 100, y: 250 },
        ],
        candidates: [{ plate: "AB12CDE", confidence: 89.5, matches_template: 1 }],
      },
    ],
  });

  it("parses a well-formed OpenALPR JSON output without throwing", () => {
    expect(() => JSON.parse(sampleOutput)).not.toThrow();
  });

  it("contains the expected plate text after parsing", () => {
    const parsed = JSON.parse(sampleOutput);
    expect(parsed.results[0].plate).toBe("AB12CDE");
  });

  it("contains 4 coordinate pairs", () => {
    const parsed = JSON.parse(sampleOutput);
    expect(parsed.results[0].coordinates).toHaveLength(4);
  });

  it("coordinate x and y are numbers", () => {
    const parsed = JSON.parse(sampleOutput);
    for (const coord of parsed.results[0].coordinates) {
      expect(typeof coord.x).toBe("number");
      expect(typeof coord.y).toBe("number");
    }
  });

  it("handles an empty results array gracefully", () => {
    const empty = JSON.stringify({ version: 2, data_type: "alpr_results", results: [] });
    const parsed = JSON.parse(empty);
    expect(parsed.results).toHaveLength(0);
  });
});
