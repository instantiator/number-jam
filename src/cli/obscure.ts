/**
 * obscure sub-command: read a detect JSON document (from -t file or stdin),
 * re-extract video frames, apply polygon obscuring, and write the output video.
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Command } from "commander";
import { buildOutputDoc } from "../output/formatter";
import { getVideoInfo } from "../video/extractor";
import { Point } from "../types";
import {
  runExtraction,
  runPreProcessing,
  runObscuring,
  runComposition,
  computeFadeExtensions,
  mergeOverlappingPolygons,
} from "./phases";
import { parsePaddingSpec } from "./shared";

const DEFAULT_FADE_DURATION_MS = 1000;

export function buildObscureCommand(): Command {
  const cmd = new Command("obscure");
  cmd
    .description(
      "Obscure number plates in a video using a detect JSON document. " +
      "Reads tracking data from -t <path> or stdin when -t is omitted."
    )
    .requiredOption("-i, --input <path>", "Path to the input video file")
    .requiredOption("-o, --output <path>", "Write the obscured video to this path")
    .option("-t, --tracking <path>", "Path to a detect JSON document (reads from stdin if omitted)")
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
    .helpOption("-h, --help", "Show all options");

  cmd.action(async (opts: {
    input: string;
    output: string;
    tracking?: string;
    fadeDuration?: number;
    paddingWidth?: string;
    paddingHeight?: string;
  }) => {
    await obscureMain(opts);
  });

  return cmd;
}

export async function obscureMain(opts: {
  input: string;
  output: string;
  tracking?: string;
  fadeDuration?: number;
  paddingWidth?: string;
  paddingHeight?: string;
}): Promise<void> {
  const startTime = Date.now();

  if (!fs.existsSync(opts.input)) {
    throw new Error(`Input file not found: ${opts.input}`);
  }

  const outDir = path.dirname(path.resolve(opts.output));
  if (!fs.existsSync(outDir)) {
    throw new Error(`Output directory does not exist: ${outDir}`);
  }

  const trackingDoc = readTrackingDoc(opts.tracking);

  const inputPath = path.resolve(opts.input);
  const videoInfo = await getVideoInfo(inputPath);
  const trackPolygons = buildTrackPolygons(trackingDoc.tracking, videoInfo.fps);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "number-jam-"));
  try {
    const framesDir = path.join(tmpDir, "frames");
    fs.mkdirSync(framesDir);

    const { frames } = await runExtraction(inputPath, framesDir);
    await runPreProcessing(frames, videoInfo.width);

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
      path.resolve(opts.output),
      frames.length,
    );

    const doc = buildOutputDoc(
      trackingDoc.request,
      trackingDoc.tracking.map((t) => ({
        plate: t.plate,
        region: null,
        history: t.history.map((h) => ({
          frameIndex: Math.round((h.timestamp / 1000) * videoInfo.fps),
          timestamp: h.timestamp / 1000,
          polygon: h.polygon,
        })),
      })),
      videoInfo.durationSeconds,
      Date.now() - startTime,
      path.resolve(opts.output),
    );

    process.stdout.write(JSON.stringify(doc, null, 2) + "\n");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

/**
 * Read and validate the detect JSON document from a file path or stdin.
 * Throws with a clear message on missing or malformed input.
 */
function readTrackingDoc(filePath?: string): DetectDoc {
  let raw: string;
  if (filePath) {
    if (!fs.existsSync(filePath)) throw new Error(`Tracking file not found: ${filePath}`);
    raw = fs.readFileSync(filePath, "utf8");
  } else {
    raw = fs.readFileSync("/dev/stdin", "utf8");
  }

  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch {
    throw new Error("Tracking input is not valid JSON.");
  }

  if (!doc || typeof doc !== "object") throw new Error("Tracking input must be a JSON object.");
  const obj = doc as Record<string, unknown>;
  if (!Array.isArray(obj["tracking"])) {
    throw new Error('Tracking input must have a "tracking" array (produced by `number-jam detect`).');
  }
  for (const entry of obj["tracking"] as unknown[]) {
    if (
      !entry ||
      typeof entry !== "object" ||
      typeof (entry as Record<string, unknown>)["plate"] !== "string" ||
      !Array.isArray((entry as Record<string, unknown>)["history"])
    ) {
      throw new Error(
        'Each entry in "tracking" must have a "plate" string and a "history" array.',
      );
    }
  }

  const request = (obj["request"] as Record<string, unknown>) ?? {};

  return {
    request: {
      path: typeof request["path"] === "string" ? request["path"] : "",
      regions: Array.isArray(request["regions"])
        ? (request["regions"] as string[])
        : [],
    },
    tracking: (obj["tracking"] as Array<Record<string, unknown>>).map((t) => ({
      plate: t["plate"] as string,
      history: ((t["history"] as Array<Record<string, unknown>>) ?? []).map((h) => ({
        timestamp: typeof h["timestamp"] === "number" ? h["timestamp"] : 0,
        polygon: (h["polygon"] as Point[]) ?? [],
      })),
    })),
  };
}

interface DetectDoc {
  request: { path: string; regions: string[] };
  tracking: Array<{
    plate: string;
    history: Array<{ timestamp: number; polygon: Point[] }>;
  }>;
}

/**
 * Reconstruct a frame-keyed polygon map from per-plate tracking histories.
 * Timestamps (ms) are converted to frame indices using the video fps.
 * A rolling half-second window merge is applied to reduce flicker at coverage boundaries.
 */
function buildTrackPolygons(
  tracking: DetectDoc["tracking"],
  fps: number,
): Map<number, Point[][]> {
  const trackPolygons = new Map<number, Point[][]>();

  for (const t of tracking) {
    for (const h of t.history) {
      if (!h.polygon || h.polygon.length < 3) continue;
      const fi = Math.round((h.timestamp / 1000) * fps);
      const existing = trackPolygons.get(fi) ?? [];
      // Avoid duplicate polygons for the same frame index (can occur when two
      // history entries round to the same frame at low fps).
      if (!existing.some((p) => polygonsEqual(p, h.polygon))) {
        existing.push(h.polygon);
      }
      trackPolygons.set(fi, existing);
    }
  }

  // Merge overlapping polygons within a rolling ±0.5 s window, matching the
  // merge applied in runTrackCoverage during the detect phase.
  const rollingHalfFrames = Math.max(1, Math.round(fps * 0.5));
  mergePolygonsInWindowLocal(trackPolygons, rollingHalfFrames);

  return trackPolygons;
}

function polygonsEqual(a: Point[], b: Point[]): boolean {
  if (a.length !== b.length) return false;
  return a.every(([ax, ay], i) => ax === b[i][0] && ay === b[i][1]);
}

/**
 * Local copy of mergePolygonsInWindow from phases.ts; avoids exporting an
 * internal helper that isn't part of the phases public API.
 */
function mergePolygonsInWindowLocal(
  trackPolygons: Map<number, Point[][]>,
  halfWindow: number,
): void {
  const sorted = [...trackPolygons.keys()].sort((a, b) => a - b);
  const snapshot = new Map(sorted.map((fi) => [fi, trackPolygons.get(fi)!]));

  for (const fi of sorted) {
    const ownPolygons = snapshot.get(fi)!;
    if (!ownPolygons.length) continue;

    const windowPolygons: Point[][] = [];
    for (const wfi of sorted) {
      if (wfi < fi - halfWindow) continue;
      if (wfi > fi + halfWindow) break;
      windowPolygons.push(...snapshot.get(wfi)!);
    }

    const merged = mergeOverlappingPolygons(windowPolygons);

    const ownBboxes = ownPolygons.map(polygonBbox);
    const kept = merged.filter((mp) => {
      const mpBbox = polygonBbox(mp);
      return ownBboxes.some((ob) => bboxesOverlap(ob, mpBbox));
    });

    trackPolygons.set(fi, kept.length > 0 ? kept : ownPolygons);
  }
}

function polygonBbox(polygon: Point[]): { left: number; top: number; right: number; bottom: number } {
  const xs = polygon.map(([x]) => x);
  const ys = polygon.map(([, y]) => y);
  return { left: Math.min(...xs), top: Math.min(...ys), right: Math.max(...xs), bottom: Math.max(...ys) };
}

function bboxesOverlap(
  a: { left: number; top: number; right: number; bottom: number },
  b: { left: number; top: number; right: number; bottom: number },
): boolean {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}
