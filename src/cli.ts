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
import { PaddingSpec } from "./types";
import {
  runExtraction,
  runPreProcessing,
  runDetection,
  runTrackBuilding,
  runTrackCoverage,
  computeFadeExtensions,
  runObscuring,
  runComposition,
} from "./cli/phases";
import { runCharacterScan } from "./cli/character-scan";

const DEFAULT_EXTEND_DETECTION_MS = 2000;
const DEFAULT_MIN_VISIBLE_FRACTION = 0.01;
const DEFAULT_FADE_DURATION_MS = 1000;

const program = new Command();

program
  .name("number-jam")
  .description("Detect, track, and optionally obscure number plates in a video file.")
  .requiredOption("-i, --input <path>", "Path to the input video file")
  .option(
    "-o, --obscured-output <path>",
    "Obscure detected number plates and write the output video to this path"
  )
  .option(
    "-r, --regions <codes>",
    "Comma-separated list of region codes to look for (e.g. gb,de,fr). Omit for all regions.",
    "*"
  )
  .option("-v, --verbose", "Include full frame-by-frame tracking history in the JSON output")
  .option(
    "-c, --confidence <number>",
    "Drop detections whose OCR confidence is below this value (0-100). " +
      "Applies to the summary; the obscuring pass always uses all detections.",
    parseFloat
  )
  .option(
    "-x, --extend-detection <number>",
    `Velocity-extrapolate plate positions this many milliseconds beyond visual tracking (default: ${DEFAULT_EXTEND_DETECTION_MS})`,
    parseInt
  )
  .option(
    "-m, --min-fraction <number>",
    `Minimum visible plate fraction (0–1) required to include a frame in obscuring (default: ${DEFAULT_MIN_VISIBLE_FRACTION})`,
    parseFloat
  )
  .option(
    "-f, --fade-duration <ms>",
    "Fade obscuring polygons in/out over this many milliseconds at their first/last appearance (default: 1000)",
    parseInt
  )
  .option(
    "--padding-width <amount>",
    "Expand each obscuring polygon horizontally by this amount on each side (e.g. 10, 10px, 5%)"
  )
  .option(
    "--padding-height <amount>",
    "Expand each obscuring polygon vertically by this amount on each side (e.g. 10, 10px, 5%)"
  )
  .option(
    "--rebuild-docker-image",
    "Force a rebuild of the number-jam-alpr Docker image even if it already exists"
  )
  .helpOption("-h, --help", "Show all options, and list all accepted region codes");

program.addHelpText("after", formatRegionCodeHelp());

if (require.main === module) {
  program.exitOverride();
  try {
    program.parse(process.argv);
  } catch (err: unknown) {
    // Commander throws a CommanderError for --help display (code: commander.helpDisplayed)
    // and for real parse failures. Exit 0 for help, 1 for errors.
    const code = err && typeof err === "object" && "code" in err
      ? (err as { code: string }).code
      : "";
    if (code === "commander.helpDisplayed") {
      process.exit(0);
    }
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`\nError: ${msg}\n\n`);
    // Show options only (without region codes) on parse errors.
    process.stderr.write(program.helpInformation().split("Accepted region codes:")[0]);
    process.exit(1);
  }

  const opts = program.opts<{
    input: string;
    obscuredOutput?: string;
    regions: string;
    verbose?: boolean;
    confidence?: number;
    extendDetection?: number;
    minFraction?: number;
    fadeDuration?: number;
    paddingWidth?: string;
    paddingHeight?: string;
    rebuildDockerImage?: boolean;
  }>();

  main(opts).catch((err) => {
    process.stderr.write(`\nError: ${(err as Error).message}\n`);
    process.exit(1);
  });
}

async function main(opts: {
  input: string;
  obscuredOutput?: string;
  regions: string;
  verbose?: boolean;
  confidence?: number;
  extendDetection?: number;
  minFraction?: number;
  fadeDuration?: number;
  paddingWidth?: string;
  paddingHeight?: string;
  rebuildDockerImage?: boolean;
}): Promise<void> {
  const startTime = Date.now();

  if (!fs.existsSync(opts.input)) {
    throw new Error(`Input file not found: ${opts.input}`);
  }
  if (opts.obscuredOutput) {
    const outDir = path.dirname(path.resolve(opts.obscuredOutput));
    if (!fs.existsSync(outDir)) {
      throw new Error(`Output directory does not exist: ${outDir}`);
    }
  }

  const regions = parseRegions(opts.regions);
  warnUnknownRegions(regions);

  const engine = new DockerAlprEngine(opts.confidence ?? 0, !!opts.rebuildDockerImage);
  await engine.check();
  await engine.startup();

  const inputPath = path.resolve(opts.input);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "number-jam-"));

  try {
    const framesDir = path.join(tmpDir, "frames");
    fs.mkdirSync(framesDir);

    const { frames, videoInfo } = await runExtraction(inputPath, framesDir);
    await runPreProcessing(frames, videoInfo.width);
    let frameResults = await runDetection(frames, regions, engine);

    if (opts.obscuredOutput) {
      frameResults = await runCharacterScan(frames, frameResults, videoInfo.width, videoInfo.height);
    }

    const tracks = runTrackBuilding(frameResults, videoInfo.fps);

    if (opts.obscuredOutput) {
      const extendMs = opts.extendDetection ?? DEFAULT_EXTEND_DETECTION_MS;
      const extendFrames = Math.max(1, Math.round((extendMs / 1000) * videoInfo.fps));
      const minFraction = opts.minFraction ?? DEFAULT_MIN_VISIBLE_FRACTION;
      const trackPolygons = await runTrackCoverage(
        tracks, frames, extendFrames, videoInfo.width, videoInfo.height, videoInfo.fps, minFraction,
      );

      const fadeDurationMs = opts.fadeDuration ?? DEFAULT_FADE_DURATION_MS;
      const fadeFrames = Math.max(0, Math.round((fadeDurationMs / 1000) * videoInfo.fps));
      const { extensions, fadeAlphas } = computeFadeExtensions(trackPolygons, fadeFrames, frames.length);
      for (const [fi, polys] of extensions) {
        trackPolygons.set(fi, polys);
      }

      const obscureDir = path.join(tmpDir, "obscured");
      fs.mkdirSync(obscureDir);
      await runObscuring(frames, trackPolygons, obscureDir, {
        fadeAlphas,
        paddingW: opts.paddingWidth ? parsePaddingSpec(opts.paddingWidth) : undefined,
        paddingH: opts.paddingHeight ? parsePaddingSpec(opts.paddingHeight) : undefined,
      });
      await runComposition(
        obscureDir,
        videoInfo.fps,
        inputPath,
        path.resolve(opts.obscuredOutput),
        frames.length,
      );
    }

    const doc = buildOutputDoc(
      {
        path: opts.input,
        regions,
        obscure: !!opts.obscuredOutput,
        verbose: !!opts.verbose,
      },
      tracks,
      videoInfo.durationSeconds,
      Date.now() - startTime,
      opts.obscuredOutput ? path.resolve(opts.obscuredOutput) : null,
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
 * Lists all known region codes when any unknown code is provided.
 * Exported for unit testing.
 */
export function warnUnknownRegions(regions: string[]): void {
  if (regions.includes("*")) return;
  const known = new Set(PLATE_FORMATS.map((f) => f.code));
  const unknown = regions.filter((r) => !known.has(r));
  if (unknown.length === 0) return;

  for (const r of unknown) {
    process.stderr.write(
      `Warning: region code "${r}" is not recognised; the engine may still detect plates from that region.\n`
    );
  }
  process.stderr.write(formatRegionCodeHelp() + "\n");
}

/**
 * Parse a padding amount string into a {@link PaddingSpec}.
 *
 * Accepts bare numbers (`"10"`), pixel-suffixed values (`"10px"`), and
 * percentage values (`"5%"`). Throws on invalid input.
 * Exported for unit testing.
 */
export function parsePaddingSpec(raw: string): PaddingSpec {
  const trimmed = raw.trim();
  if (trimmed.endsWith("%")) {
    const value = parseFloat(trimmed.slice(0, -1));
    if (isNaN(value) || value < 0) throw new Error(`Invalid padding value: "${raw}"`);
    return { value, unit: "%" };
  }
  const numPart = trimmed.endsWith("px") ? trimmed.slice(0, -2) : trimmed;
  const value = parseFloat(numPart);
  if (isNaN(value) || value < 0) throw new Error(`Invalid padding value: "${raw}"`);
  return { value, unit: "px" };
}

/** Format the region codes section for help and warning output. */
function formatRegionCodeHelp(): string {
  const codes = PLATE_FORMATS.map((f) => f.code);
  const lines: string[] = [];
  let line = "  ";
  for (const code of codes) {
    const segment = (line === "  " ? "" : "  ") + code;
    if (line.length + segment.length > 80) {
      lines.push(line.trimEnd());
      line = "  " + code;
    } else {
      line += segment;
    }
  }
  if (line.trim()) lines.push(line);
  return "\nAccepted region codes:\n" + lines.join("\n");
}
