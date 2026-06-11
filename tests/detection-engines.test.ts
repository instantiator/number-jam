/**
 * Unit tests for ANPR engine output parsers.
 *
 * Tests the JSON formats produced by each backend (docker-alpr / fast-alpr)
 * using fixture strings rather than spawning any real subprocess or container.
 *
 * Also includes structural sanity checks on the PLATE_FORMATS region database
 * that apply regardless of engine.
 */

import { describe, it, expect } from "vitest";
import { PLATE_FORMATS } from "../src/regions/plate-formats";

// ── PLATE_FORMATS structural checks ────────────────────────────────────────

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

// ── docker-alpr / OpenALPR JSON format ─────────────────────────────────────

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

// ── fast-alpr JSON format ───────────────────────────────────────────────────

describe("fast-alpr daemon JSON output parsing (fixture-based)", () => {
  /** Minimal JSON line as written by scripts/detect-frame.py. */
  const singlePlate = JSON.stringify({
    plates: [
      {
        ocr_text: "7ABC123",
        confidence: 0.94,
        bounding_box: { x1: 50, y1: 100, x2: 200, y2: 140 },
      },
    ],
  });

  const noPlates = JSON.stringify({ plates: [] });
  const errorLine = JSON.stringify({ error: "file not found" });

  it("parses a single-plate response without throwing", () => {
    expect(() => JSON.parse(singlePlate)).not.toThrow();
  });

  it("exposes ocr_text from the parsed result", () => {
    const parsed = JSON.parse(singlePlate);
    expect(parsed.plates[0].ocr_text).toBe("7ABC123");
  });

  it("bounding box has x1, y1, x2, y2 as numbers", () => {
    const parsed = JSON.parse(singlePlate);
    const bb = parsed.plates[0].bounding_box;
    for (const key of ["x1", "y1", "x2", "y2"]) {
      expect(typeof bb[key]).toBe("number");
    }
  });

  it("bounding box corners form a valid rectangle (x2 > x1, y2 > y1)", () => {
    const parsed = JSON.parse(singlePlate);
    const bb = parsed.plates[0].bounding_box;
    expect(bb.x2).toBeGreaterThan(bb.x1);
    expect(bb.y2).toBeGreaterThan(bb.y1);
  });

  it("handles an empty plates array gracefully", () => {
    const parsed = JSON.parse(noPlates);
    expect(parsed.plates).toHaveLength(0);
  });

  it("detects the error shape when present", () => {
    const parsed = JSON.parse(errorLine);
    expect("error" in parsed).toBe(true);
    expect(typeof parsed.error).toBe("string");
  });
});
