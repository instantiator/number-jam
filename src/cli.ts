#!/usr/bin/env node
/**
 * number-jam CLI entry point.
 *
 * Accepts a video file, detects and tracks number plates via the selected ANPR
 * engine, optionally obscures them in the output video, and prints a JSON
 * result document to stdout.
 *
 * Progress messages are written to stderr to keep stdout clean for piping.
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Command } from "commander";
import { DockerAlprEngine } from "./detection/engines/docker-alpr";
import { buildOutputDoc } from "./output/formatter";
import { PLATE_FORMATS } from "./regions/plate-formats";
import {
  runExtraction,
  runPreProcessing,
  runDetection,
  runTrackBuilding,
  runTrackCoverage,
  runObscuring,
  runComposition,
} from "./cli/phases";

const program = new Command();

program
  .name("number-jam")
  .description("Detect, track, and optionally obscure number plates in a video file.")
  .requiredOption("-i, --input <path>", "Path to the input video file")
  .option("-o, --output <path>", "Path to the output video file (required with --obscure-number-plates)")
  .option("-p, --obscure-number-plates", "Obscure detected number plates in the output video")
  .option(
    "-r, --regions <codes>",
    "Comma-separated list of region codes to look for (e.g. gb,de,fr). Omit for all regions.",
    "*"
  )
  .option("--include-tracking", "Include full frame-by-frame tracking history in JSON output")
  .option(
    "--min-confidence <number>",
    "Drop detections whose OCR confidence is below this value (0-100). " +
      "Applies to the summary; the obscuring pass always uses all detections.",
    parseFloat
  )
  .option(
    "--extend-seconds <number>",
    "Velocity-extrapolate plate positions this many seconds beyond where visual tracking ends (default: 2)",
    parseFloat
  );

if (require.main === module) {
  program.parse(process.argv);

  const opts = program.opts<{
    input: string;
    output?: string;
    obscureNumberPlates?: boolean;
    regions: string;
    includeTracking?: boolean;
    minConfidence?: number;
    extendSeconds?: number;
  }>();

  main(opts).catch((err) => {
    process.stderr.write(`\nError: ${(err as Error).message}\n`);
    process.exit(1);
  });
}

async function main(opts: {
  input: string;
  output?: string;
  obscureNumberPlates?: boolean;
  regions: string;
  includeTracking?: boolean;
  minConfidence?: number;
  extendSeconds?: number;
}): Promise<void> {
  const startTime = Date.now();

  // Validate inputs
  if (!fs.existsSync(opts.input)) {
    throw new Error(`Input file not found: ${opts.input}`);
  }
  if (opts.obscureNumberPlates && !opts.output) {
    throw new Error("--output is required when --obscure-number-plates is set");
  }
  if (opts.output) {
    const outDir = path.dirname(path.resolve(opts.output));
    if (!fs.existsSync(outDir)) {
      throw new Error(`Output directory does not exist: ${outDir}`);
    }
  }

  const regions = parseRegions(opts.regions);
  warnUnknownRegions(regions);

  const engine = new DockerAlprEngine(opts.minConfidence ?? 0);
  await engine.check();
  await engine.startup();

  const inputPath = path.resolve(opts.input);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "number-jam-"));

  try {
    const framesDir = path.join(tmpDir, "frames");
    fs.mkdirSync(framesDir);

    const { frames, videoInfo } = await runExtraction(inputPath, framesDir);
    await runPreProcessing(frames, videoInfo.width);
    const frameResults = await runDetection(frames, regions, engine);
    const tracks = runTrackBuilding(frameResults, videoInfo.fps);

    if (opts.obscureNumberPlates && opts.output) {
      const extendFrames = Math.max(1, Math.round((opts.extendSeconds ?? 2) * videoInfo.fps));
      const trackPolygons = await runTrackCoverage(
        tracks, frames, extendFrames, videoInfo.width, videoInfo.height,
      );

      const obscureDir = path.join(tmpDir, "obscured");
      fs.mkdirSync(obscureDir);
      await runObscuring(frames, trackPolygons, obscureDir);
      await runComposition(
        obscureDir,
        videoInfo.fps,
        inputPath,
        path.resolve(opts.output),
        frames.length,
      );
    }

    const resolvedOutput =
      opts.obscureNumberPlates && opts.output ? path.resolve(opts.output) : null;
    const firstPlateAt =
      tracks.length > 0
        ? Math.round(Math.min(...tracks.map((t) => t.history[0].timestamp)) * 1000)
        : 0;
    const lastPlateAt =
      tracks.length > 0
        ? Math.round(
            Math.max(...tracks.map((t) => t.history[t.history.length - 1].timestamp)) * 1000
          )
        : 0;

    const doc = buildOutputDoc(
      {
        path: opts.input,
        regions,
        obscure: !!opts.obscureNumberPlates,
        includeTracking: !!opts.includeTracking,
      },
      tracks,
      videoInfo.durationSeconds,
      Date.now() - startTime,
      firstPlateAt,
      lastPlateAt,
      resolvedOutput,
    );

    process.stdout.write(JSON.stringify(doc, null, 2) + "\n");
  } finally {
    await engine.shutdown();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

/**
 * Parse the --regions flag value into a string array.
 * Exported for unit testing.
 */
export function parseRegions(raw: string): string[] {
  if (!raw || raw === "*") return ["*"];
  return raw
    .split(",")
    .map((r) => r.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Warn to stderr for any region code not found in PLATE_FORMATS.
 * Exported for unit testing.
 */
export function warnUnknownRegions(regions: string[]): void {
  if (regions.includes("*")) return;
  const known = new Set(PLATE_FORMATS.map((f) => f.code));
  for (const r of regions) {
    if (!known.has(r)) {
      process.stderr.write(
        `Warning: region code "${r}" is not in the plate-formats database; ` +
          `the engine may still detect plates from that region.\n`
      );
    }
  }
}
