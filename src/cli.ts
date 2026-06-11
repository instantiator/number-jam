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
import sharp from "sharp";
import { Command } from "commander";
import { DockerAlprEngine } from "./detection/engines/docker-alpr";
import { extractFrames, getVideoInfo } from "./video/extractor";
import { detectAllFrames } from "./detection/detector";
import { buildTracks } from "./tracking/tracker";
import { obscureFrame } from "./obscuring/obscurer";
import { composeVideo } from "./video/composer";
import { buildOutputDoc } from "./output/formatter";
import { PLATE_FORMATS } from "./regions/plate-formats";
import { PlateDetection, Point } from "./types";

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
    "Extend plate obscuring this many seconds before and after each detected track (default: 2)",
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

  // Instantiate and verify the ANPR engine

  const engine = new DockerAlprEngine(opts.minConfidence ?? 0);
  await engine.check();
  await engine.startup();

  const inputPath = path.resolve(opts.input);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "number-jam-"));

  try {
    const framesDir = path.join(tmpDir, "frames");
    fs.mkdirSync(framesDir);

    // Phase 1: extract frames

    const videoInfo = await getVideoInfo(inputPath);
    process.stderr.write(
      `Video: ${videoInfo.frameCount} frames @ ${videoInfo.fps.toFixed(2)} fps ` +
        `(${videoInfo.durationSeconds.toFixed(1)}s)\n`
    );
    process.stderr.write("Extracting frames...\n");

    const frames = await extractFrames(inputPath, framesDir, (written, total) => {
      process.stderr.write(`  Extracted ${written}/${total} frames\r`);
    });
    process.stderr.write(`\nExtracted ${frames.length} frame(s)\n`);

    // Phase 1b: pre-process frames

    if (frames.length > 0) {
      process.stderr.write("Pre-processing frames...\n");
      const { width = 1920 } = await sharp(frames[0].filePath).metadata();
      const upscale = width < 1280;
      for (const frame of frames) {
        const tmp = frame.filePath + ".pre.jpg";
        let pipeline = sharp(frame.filePath).sharpen().normalise();
        if (upscale) pipeline = pipeline.resize(width * 2);
        await pipeline.jpeg({ quality: 95 }).toFile(tmp);
        fs.renameSync(tmp, frame.filePath);
      }
      process.stderr.write(`Pre-processed ${frames.length} frame(s)\n`);
    }

    // Phase 2: detect plates

    process.stderr.write("Scanning frames for number plates...\n");
    const frameResults = await detectAllFrames(frames, regions, engine);

    const totalDetections = frameResults.reduce((s, r) => s + r.detections.length, 0);
    process.stderr.write(`Found ${totalDetections} detection(s) across all frames\n`);

    // Phase 3: track plates

    process.stderr.write("Building tracks...\n");
    const tracks = buildTracks(frameResults, videoInfo.fps);
    process.stderr.write(`Identified ${tracks.length} track(s)\n`);

    // Phase 4: obscure plates (optional)

    if (opts.obscureNumberPlates && opts.output) {
      process.stderr.write("Obscuring plates...\n");

      const obscureDir = path.join(tmpDir, "obscured");
      fs.mkdirSync(obscureDir);

      // Build per-frame polygon coverage from detected tracks.
      // Each track's history (including tracker-interpolated frames) is added
      // first, then the coverage is extended by extendSeconds in both directions
      // using the endpoint polygons. This ensures a plate detected in only a
      // handful of frames (e.g. a stationary car in a short clip) is obscured
      // throughout the visible region rather than for a single imperceptible frame.
      const extendFrames = Math.max(
        1,
        Math.round((opts.extendSeconds ?? 2) * videoInfo.fps)
      );
      const trackPolygons = new Map<number, Point[][]>();

      for (const track of tracks) {
        if (track.history.length === 0) continue;

        // Add every history entry (actual + interpolated detection positions).
        for (const h of track.history) {
          if (h.polygon.length < 3) continue;
          const list = trackPolygons.get(h.frameIndex) ?? [];
          list.push(h.polygon);
          trackPolygons.set(h.frameIndex, list);
        }

        // Extend before first detection using the first entry's polygon.
        const first = track.history[0];
        const startFi = Math.max(0, first.frameIndex - extendFrames);
        for (let fi = startFi; fi < first.frameIndex; fi++) {
          if (first.polygon.length < 3) continue;
          const list = trackPolygons.get(fi) ?? [];
          list.push(first.polygon);
          trackPolygons.set(fi, list);
        }

        // Extend after last detection using the last entry's polygon.
        const last = track.history[track.history.length - 1];
        const endFi = Math.min(frames.length - 1, last.frameIndex + extendFrames);
        for (let fi = last.frameIndex + 1; fi <= endFi; fi++) {
          if (last.polygon.length < 3) continue;
          const list = trackPolygons.get(fi) ?? [];
          list.push(last.polygon);
          trackPolygons.set(fi, list);
        }
      }

      process.stderr.write(`${trackPolygons.size} frame(s) scheduled for obscuring\n`);

      let obscured = 0;
      for (const frame of frames) {
        const polygons = trackPolygons.get(frame.frameIndex) ?? [];
        const syntheticDetections: PlateDetection[] = polygons.map((polygon) => ({
          plate: "",
          confidence: 0,
          region: null,
          regionConfidence: 0,
          polygon,
          frameIndex: frame.frameIndex,
        }));
        const outFramePath = path.join(obscureDir, path.basename(frame.filePath));
        await obscureFrame(frame.filePath, syntheticDetections, outFramePath);
        if (syntheticDetections.some((d) => d.polygon.length >= 3)) obscured++;
      }

      process.stderr.write(
        `Obscured ${obscured} frame(s); composing output video...\n`
      );

      await composeVideo(
        obscureDir,
        videoInfo.fps,
        inputPath,
        path.resolve(opts.output),
        (frame) => process.stderr.write(`  Composing frame ${frame}\r`)
      );

      process.stderr.write(`\nOutput video written to ${opts.output}\n`);
    }

    // Phase 5: output JSON

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
    const processingDuration = Date.now() - startTime;

    const doc = buildOutputDoc(
      {
        path: opts.input,
        regions,
        obscure: !!opts.obscureNumberPlates,
        includeTracking: !!opts.includeTracking,
      },
      tracks,
      videoInfo.durationSeconds,
      processingDuration,
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
