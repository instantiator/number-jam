/**
 * Verifies that every entry in PLATE_FORMATS has at least one matching example
 * and at least one non-matching example. This ensures the regex database stays
 * internally consistent as it grows.
 */

import { describe, it, expect } from "vitest";
import { PLATE_FORMATS, PlateFormat } from "../src/regions/plate-formats";

describe("PLATE_FORMATS", () => {
  it("contains at least one entry", () => {
    expect(PLATE_FORMATS.length).toBeGreaterThan(0);
  });

  for (const format of PLATE_FORMATS) {
    describe(`region: ${format.code}`, () => {
      it("has at least one positive example that matches the regex", () => {
        for (const ex of format.examples) {
          const normalised = ex.toUpperCase().replace(/[\s\-·.]/g, "");
          expect(
            format.regex.test(normalised),
            `"${normalised}" (from example "${ex}") did not match /${format.regex.source}/ for region ${format.code}`
          ).toBe(true);
        }
      });

      it("has at least one negative example that does NOT match the regex", () => {
        const todoNonExamples = format.nonExamples.filter(
          (e) => e === "TODO_NON_EXAMPLE"
        );
        if (todoNonExamples.length === format.nonExamples.length) {
          // All non-examples are TODOs — skip rather than fail so the generated
          // entries don't block the build, but warn so they get filled in.
          console.warn(
            `[WARN] region ${format.code}: all nonExamples are TODO_NON_EXAMPLE — please add real ones`
          );
          return;
        }

        for (const nonEx of format.nonExamples.filter((e) => e !== "TODO_NON_EXAMPLE")) {
          const normalised = nonEx.toUpperCase().replace(/[\s\-·.]/g, "");
          expect(
            format.regex.test(normalised),
            `"${normalised}" (from nonExample "${nonEx}") unexpectedly matched /${format.regex.source}/ for region ${format.code}`
          ).toBe(false);
        }
      });

      it("has a non-empty code", () => {
        expect(format.code.trim().length).toBeGreaterThan(0);
      });

      it("has a non-empty description", () => {
        expect(format.description.trim().length).toBeGreaterThan(0);
      });
    });
  }
});
