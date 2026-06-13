/**
 * Unit tests for the CLI helper functions.
 *
 * The two exported helpers ({@link parseRegions}, {@link warnUnknownRegions})
 * contain all the testable logic from the CLI entry point. The main pipeline
 * wiring and file-system orchestration are left to end-to-end or integration tests.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { parseRegions, warnUnknownRegions } from "../src/cli";

// parseRegions

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

// warnUnknownRegions

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

  it("lists all accepted region codes when an unknown code is provided", () => {
    const written: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      written.push(String(chunk));
      return true;
    });
    warnUnknownRegions(["zz"]);
    const combined = written.join("");
    // Should include the accepted region codes section with at least one known code.
    expect(combined).toContain("Accepted region codes");
    expect(combined).toContain("gb");
  });
});
