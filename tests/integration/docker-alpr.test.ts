/**
 * Integration test for the Docker + OpenALPR detection engine.
 *
 * Starts the engine, sends two real plate images, and verifies the shape of
 * the response.  Does not assert specific plate text because OCR accuracy
 * varies; it asserts that the engine returns structured results.
 *
 * Skipped unless RUN_INTEGRATION_TESTS=1 is set.
 * Fixtures:
 *   tests/fixtures/plate-ca.jpg  (Public Domain)
 *   tests/fixtures/plate-rs.jpg  (CC0)
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as path from "path";
import * as fs from "fs";
import { DockerAlprEngine } from "../../src/detection/engines/docker-alpr";

const FIXTURE_CA = path.resolve(__dirname, "../fixtures/plate-ca.jpg");
const FIXTURE_RS = path.resolve(__dirname, "../fixtures/plate-rs.jpg");
const SKIP = !process.env["RUN_INTEGRATION_TESTS"];

describe("docker-alpr engine integration", () => {
  let engine: DockerAlprEngine;

  /** Container startup (pull + Flask init) can take up to ~60s on first run. */
  beforeAll(async () => {
    if (SKIP) return;

    for (const f of [FIXTURE_CA, FIXTURE_RS]) {
      if (!fs.existsSync(f)) {
        throw new Error(`Fixture missing: ${f}\nRun: npm run download-fixtures`);
      }
    }

    engine = new DockerAlprEngine();
    await engine.check();
    await engine.startup();
  }, 90_000);

  afterAll(async () => {
    if (SKIP) return;
    await engine.shutdown();
  }, 30_000);

  it.skipIf(SKIP)("returns an array from the California plate image", async () => {
    const results = await engine.detectPlates(FIXTURE_CA, 0, ["*"]);
    expect(Array.isArray(results)).toBe(true);
  }, 30_000);

  it.skipIf(SKIP)("each result has a 4-point polygon for the CA image", async () => {
    const results = await engine.detectPlates(FIXTURE_CA, 0, ["*"]);
    for (const r of results) {
      expect(r.polygon.length).toBe(4);
      for (const pt of r.polygon) {
        expect(pt.length).toBe(2);
        expect(typeof pt[0]).toBe("number");
        expect(typeof pt[1]).toBe("number");
      }
    }
  }, 30_000);

  it.skipIf(SKIP)("plate string is defined (may be empty) for the CA image", async () => {
    const results = await engine.detectPlates(FIXTURE_CA, 0, ["*"]);
    for (const r of results) {
      expect(typeof r.plate).toBe("string");
    }
  }, 30_000);

  it.skipIf(SKIP)("returns an array from the Serbian plate image", async () => {
    const results = await engine.detectPlates(FIXTURE_RS, 1, ["*"]);
    expect(Array.isArray(results)).toBe(true);
  }, 30_000);
});
