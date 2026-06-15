/**
 * detect sub-command: extract frames, run ANPR, build tracks with visual
 * tracking and velocity extrapolation, then write a JSON document to stdout.
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Command } from "commander";
import { DockerAlprEngine } from "../detection/engines/docker-alpr";
import { buildOutputDoc } from "../output/formatter";
import {
  runExtraction,
  runPreProcessing,
  runDetection,
  runTrackBuilding,
  runTrackCoverage,
} from "./phases";
import { runCharacterScan } from "./character-scan";
import { parseRegions, warnUnknownRegions, formatRegionCodeHelp } from "./shared";

const DEFAULT_EXTEND_DETECTION_MS = 2000;
const DEFAULT_MIN_VISIBLE_FRACTION = 0.01;

export function buildDetectCommand(): Command {
  const cmd = new Command("detect");
  cmd
    .description("Detect and track number plates in a video file, writing a JSON document to stdout.")
    .requiredOption("-i, --input <path>", "Path to the input video file")
    .option(
      "-r, --regions <codes>",
      "Comma-separated list of region codes to look for (e.g. gb,de,fr). Omit for all regions.",
      "*"
    )
    .option(
      "-c, --confidence <number>",
      "Drop detections whose OCR confidence is below this value (0–100).",
      parseFloat
    )
    .option(
      "-x, --extend-detection <number>",
      `Velocity-extrapolate plate positions this many milliseconds beyond visual tracking (default: ${DEFAULT_EXTEND_DETECTION_MS})`,
      parseInt
    )
    .option(
      "-m, --min-fraction <number>",
      `Minimum visible plate fraction (0–1) required to include a frame (default: ${DEFAULT_MIN_VISIBLE_FRACTION})`,
      parseFloat
    )
    .option(
      "--rebuild-docker-image",
      "Force a rebuild of the number-jam-alpr Docker image even if it already exists"
    )
    .helpOption("-h, --help", "Show all options, and list all accepted region codes")
    .addHelpText("after", formatRegionCodeHelp());

  cmd.action(async (opts: {
    input: string;
    regions: string;
    confidence?: number;
    extendDetection?: number;
    minFraction?: number;
    rebuildDockerImage?: boolean;
  }) => {
    await detectMain(opts);
  });

  return cmd;
}

export async function detectMain(opts: {
  input: string;
  regions: string;
  confidence?: number;
  extendDetection?: number;
  minFraction?: number;
  rebuildDockerImage?: boolean;
}): Promise<void> {
  const startTime = Date.now();

  if (!fs.existsSync(opts.input)) {
    throw new Error(`Input file not found: ${opts.input}`);
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

    frameResults = await runCharacterScan(frames, frameResults, videoInfo.width, videoInfo.height);

    const tracks = runTrackBuilding(frameResults, videoInfo.fps);

    const extendMs = opts.extendDetection ?? DEFAULT_EXTEND_DETECTION_MS;
    const extendFrames = Math.max(1, Math.round((extendMs / 1000) * videoInfo.fps));
    const minFraction = opts.minFraction ?? DEFAULT_MIN_VISIBLE_FRACTION;
    const { extendedTracks } = await runTrackCoverage(
      tracks, frames, extendFrames, videoInfo.width, videoInfo.height, videoInfo.fps, minFraction,
    );

    const doc = buildOutputDoc(
      { path: opts.input, regions },
      extendedTracks,
      videoInfo.durationSeconds,
      Date.now() - startTime,
      null,
    );

    process.stdout.write(JSON.stringify(doc, null, 2) + "\n");
  } finally {
    await engine.shutdown();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}
