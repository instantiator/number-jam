/**
 * Unit tests for the CLI helper functions.
 *
 * The three exported helpers ({@link parseRegions}, {@link warnUnknownRegions},
 * {@link createEngine}) contain all the testable logic from the CLI entry point.
 * The main pipeline wiring and file-system orchestration are left to end-to-end
 * or integration tests.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { parseRegions, warnUnknownRegions, createEngine } from "../src/cli";
import { DockerAlprEngine } from "../src/detection/engines/docker-alpr";
import { FastAlprEngine } from "../src/detection/engines/fast-alpr";

// ── parseRegions ─────────────────────────────────────────────────────────────

describe("parseRegions", () => {
  it("returns [\"*\"] for the literal wildcard string", () => {
    expect(parseRegions("*")).toEqual(["*"]);
  });

  it("returns [\"*\"] for an empty string", () => {
    expect(parseRegions("")).toEqual(["*"]);
  });

  it("returns a single-element array for a single region code", () => {
    expect(parseRegions("gb")).toEqual(["gb"]);
  });

  it("splits a comma-separated list into multiple codes", () => {
    expect(parseRegions("gb,de,fr")).toEqual(["gb", "de", "fr"]);
  });

  it("lowercases all codes", () => {
    expect(parseRegions("GB,DE,FR")).toEqual(["gb", "de", "fr"]);
  });

  it("trims whitespace from each code", () => {
    expect(parseRegions(" gb , de ")).toEqual(["gb", "de"]);
  });

  it("filters out empty segments from double commas", () => {
    expect(parseRegions("gb,,de")).toEqual(["gb", "de"]);
  });
});

// ── createEngine ─────────────────────────────────────────────────────────────

describe("createEngine", () => {
  it("returns a DockerAlprEngine for \"docker-alpr\"", () => {
    expect(createEngine("docker-alpr")).toBeInstanceOf(DockerAlprEngine);
  });

  it("returns a FastAlprEngine for \"fast-alpr\"", () => {
    expect(createEngine("fast-alpr")).toBeInstanceOf(FastAlprEngine);
  });

  it("throws for an unknown engine identifier", () => {
    expect(() => createEngine("unknown-engine")).toThrow(/docker-alpr/);
  });

  it("error message for unknown engine mentions valid options", () => {
    expect(() => createEngine("bad")).toThrow(/fast-alpr/);
  });
});

// ── warnUnknownRegions ────────────────────────────────────────────────────────

describe("warnUnknownRegions", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not write to stderr for the wildcard [\"*\"]", () => {
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    warnUnknownRegions(["*"]);
    expect(spy).not.toHaveBeenCalled();
  });

  it("does not write to stderr for a known region code", () => {
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    warnUnknownRegions(["gb"]);
    expect(spy).not.toHaveBeenCalled();
  });

  it("writes a warning to stderr for an unrecognised region code", () => {
    const written: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      written.push(String(chunk));
      return true;
    });
    warnUnknownRegions(["xx"]);
    expect(written.some((s) => s.includes("xx"))).toBe(true);
  });

  it("writes one warning per unknown code", () => {
    const written: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      written.push(String(chunk));
      return true;
    });
    warnUnknownRegions(["xx", "yy"]);
    expect(written.some((s) => s.includes("xx"))).toBe(true);
    expect(written.some((s) => s.includes("yy"))).toBe(true);
  });
});
