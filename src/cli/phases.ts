/**
 * Named async functions for each processing phase of the number-jam pipeline.
 *
 * Each function owns its concurrency strategy and progress bar lifecycle,
 * keeping {@link main} in cli.ts as a slim orchestrator.
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import sharp from "sharp";
import pLimit from "p-limit";
import { getVideoInfo, extractFrames as rawExtractFrames, VideoInfo } from "../video/extractor";
import { detectAllFrames } from "../detection/detector";
import { buildTracks } from "../tracking/tracker";
import { trackBack, trackForward, trackGap, MIN_VISIBLE_FRACTION } from "../tracking/visual-tracker";
import { centroid, velocityFromHead, velocityFromTail, shiftPolygon } from "../tracking/motion";
import { obscureFrame } from "../obscuring/obscurer";
import { composeVideo } from "../video/composer";
import { createProgressBar } from "./progress";
import { DetectionEngine } from "../detection/engine";
import { FrameInfo, FrameResult, Track, Point, PlateDetection, PaddingSpec } from "../types";

/**
 * Phase 1: probe video metadata then extract all frames as JPEGs.
 *
 * @param inputPath  Absolute path to the source video.
 * @param framesDir  Directory to write frame JPEGs into (must already exist).
 */
export async function runExtraction(
  inputPath: string,
  framesDir: string,
): Promise<{ frames: FrameInfo[]; videoInfo: VideoInfo }> {
  const videoInfo = await getVideoInfo(inputPath);
  process.stderr.write(
    `Video: ${videoInfo.frameCount} frames @ ${videoInfo.fps.toFixed(2)} fps ` +
      `(${videoInfo.durationSeconds.toFixed(1)}s)\n`,
  );
  const bar = createProgressBar("Extracting", videoInfo.frameCount);
  const frames = await rawExtractFrames(inputPath, framesDir, (written) => bar.update(written));
  bar.update(frames.length);
  bar.stop();
  process.stderr.write(`Extracted ${frames.length} frame(s)\n`);
  return { frames, videoInfo };
}

/**
 * Phase 1b: sharpen and normalise every frame in-place, parallelised across CPU
 * cores. Upscales frames when the source video is narrower than 1280 px.
 *
 * @param frames      Frames to process (files are replaced in-place).
 * @param videoWidth  Source video pixel width; used to decide whether to upscale.
 */
export async function runPreProcessing(frames: FrameInfo[], videoWidth: number): Promise<void> {
  if (frames.length === 0) return;
  const upscale = videoWidth < 1280;
  const limit = pLimit(os.cpus().length);
  const bar = createProgressBar("Pre-processing", frames.length);

  await Promise.all(
    frames.map((frame) =>
      limit(async () => {
        const tmp = frame.filePath + ".pre.jpg";
        let pipeline = sharp(frame.filePath).sharpen().normalise();
        if (upscale) pipeline = pipeline.resize(videoWidth * 2);
        await pipeline.jpeg({ quality: 95 }).toFile(tmp);
        fs.renameSync(tmp, frame.filePath);
        bar.increment();
      }),
    ),
  );

  bar.stop();
  process.stderr.write(`Pre-processed ${frames.length} frame(s)\n`);
}

/**
 * Phase 2: run ANPR detection on every frame with up to 4 concurrent engine requests.
 *
 * @param frames   All extracted frames.
 * @param regions  Region filter codes (["*"] = all regions).
 * @param engine   The ANPR backend to use.
 */
export async function runDetection(
  frames: FrameInfo[],
  regions: string[],
  engine: DetectionEngine,
): Promise<FrameResult[]> {
  const bar = createProgressBar("Detecting plates", frames.length);
  const results = await detectAllFrames(frames, regions, engine, {
    concurrency: 4,
    onProgress: (done) => bar.update(done),
  });
  bar.stop();
  const total = results.reduce((s, r) => s + r.detections.length, 0);
  process.stderr.write(`Found ${total} detection(s) across ${frames.length} frame(s)\n`);
  return results;
}

// Fraction of a polygon's bounding box that is visible within a frame of
// dimensions (w × h). Mirrors the logic in visual-tracker.ts without coupling
// the two modules on a shared internal utility.
function polygonVisibleFraction(polygon: Point[], w: number, h: number): number {
  const xs = polygon.map(([x]) => x);
  const ys = polygon.map(([, y]) => y);
  const left = Math.min(...xs), right = Math.max(...xs);
  const top = Math.min(...ys), bottom = Math.max(...ys);
  const totalArea = (right - left) * (bottom - top);
  if (totalArea <= 0) return 0;
  const vW = Math.min(w, right) - Math.max(0, left);
  const vH = Math.min(h, bottom) - Math.max(0, top);
  if (vW <= 0 || vH <= 0) return 0;
  return (vW * vH) / totalArea;
}

function polygonMinY(polygon: Point[]): number {
  return Math.min(...polygon.map(([, y]) => y));
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

function unionBbox(
  a: { left: number; top: number; right: number; bottom: number },
  b: { left: number; top: number; right: number; bottom: number },
): { left: number; top: number; right: number; bottom: number } {
  return {
    left: Math.min(a.left, b.left),
    top: Math.min(a.top, b.top),
    right: Math.max(a.right, b.right),
    bottom: Math.max(a.bottom, b.bottom),
  };
}

function bboxToPolygon(b: { left: number; top: number; right: number; bottom: number }): Point[] {
  return [[b.left, b.top], [b.right, b.top], [b.right, b.bottom], [b.left, b.bottom]];
}

/**
 * Merge a list of polygons into connected components of overlapping bounding
 * boxes. Returns one rectangular polygon per connected component. Non-
 * overlapping polygons are returned unchanged. Exported for unit testing.
 */
export function mergeOverlappingPolygons(polygons: Point[][]): Point[][] {
  if (polygons.length === 0) return [];
  const bboxes = polygons.map(polygonBbox);
  // Union-find: parent[i] = representative index for polygon i.
  const parent = polygons.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; }
    return i;
  };
  const union = (a: number, b: number) => { parent[find(a)] = find(b); };

  for (let i = 0; i < bboxes.length; i++) {
    for (let j = i + 1; j < bboxes.length; j++) {
      if (bboxesOverlap(bboxes[i], bboxes[j])) union(i, j);
    }
  }

  // Merge bboxes within each component.
  const merged = new Map<number, { left: number; top: number; right: number; bottom: number }>();
  for (let i = 0; i < bboxes.length; i++) {
    const root = find(i);
    merged.set(root, merged.has(root) ? unionBbox(merged.get(root)!, bboxes[i]) : bboxes[i]);
  }

  return [...merged.values()].map(bboxToPolygon);
}

/**
 * For each frame, compute the union of all spatially overlapping polygons
 * within a rolling time window of ±{@link halfWindow} frames. Replaces each
 * frame's polygon list with the merged result that is spatially connected to
 * that frame's own polygon.
 *
 * This reduces flicker: the obscuring region for frame fi can only grow or
 * stay stable across adjacent frames, never shrink abruptly.
 */
function mergePolygonsInWindow(
  trackPolygons: Map<number, Point[][]>,
  halfWindow: number,
): void {
  const sorted = [...trackPolygons.keys()].sort((a, b) => a - b);
  // Precompute bboxes once; we read trackPolygons but write from a snapshot.
  const snapshot = new Map(sorted.map((fi) => [fi, trackPolygons.get(fi)!]));

  for (const fi of sorted) {
    const ownPolygons = snapshot.get(fi)!;
    if (!ownPolygons.length) continue;

    // Collect all polygons from the time window.
    const windowPolygons: Point[][] = [];
    for (const wfi of sorted) {
      if (wfi < fi - halfWindow) continue;
      if (wfi > fi + halfWindow) break;
      windowPolygons.push(...snapshot.get(wfi)!);
    }

    // Merge overlapping bboxes in the window.
    const merged = mergeOverlappingPolygons(windowPolygons);

    // Keep only merged groups spatially connected to this frame's polygon.
    const ownBboxes = ownPolygons.map(polygonBbox);
    const kept = merged.filter((mp) => {
      const mpBbox = polygonBbox(mp);
      return ownBboxes.some((ob) => bboxesOverlap(ob, mpBbox));
    });

    trackPolygons.set(fi, kept.length > 0 ? kept : ownPolygons);
  }
}

/**
 * Estimate per-frame velocity (dx, dy) from the entries in a backward-coverage
 * array. backCoverage is in descending frameIndex order — element 0 is the
 * frame immediately before the detection (newest in time), the last element is
 * the furthest frame visual tracking reached (oldest). Uses the first `count`
 * entries (closest to the detection) which are the most reliable.
 *
 * Returns [0, 0] when fewer than 2 entries are available or when the plate is
 * stationary (all centroids coincide).
 *
 * Exported for unit testing.
 */
export function velocityFromBackCoverage(
  backCoverage: Array<{ frameIndex: number; polygon: Point[] }>,
  count = 4,
): [number, number] {
  if (backCoverage.length < 2) return [0, 0];
  const slice = backCoverage.slice(0, Math.min(count, backCoverage.length));
  const newest = slice[0];
  const oldest = slice[slice.length - 1];
  const span = newest.frameIndex - oldest.frameIndex;
  if (span === 0) return [0, 0];
  const [nx, ny] = centroid(newest.polygon);
  const [ox, oy] = centroid(oldest.polygon);
  return [(nx - ox) / span, (ny - oy) / span];
}

/**
 * Phase 3: build multi-frame tracks from per-frame detections.
 *
 * @param frameResults  Per-frame detection results from {@link runDetection}.
 * @param fps           Frames per second of the source video.
 */
export function runTrackBuilding(frameResults: FrameResult[], fps: number): Track[] {
  const tracks = buildTracks(frameResults, fps);
  process.stderr.write(`Identified ${tracks.length} track(s)\n`);
  return tracks;
}

/**
 * Phase 3b: extend each track with unconstrained SAD visual tracking and apply
 * velocity extrapolation at the outermost edges. Any intra-track frame gaps are
 * filled with visual tracking before falling back to linear interpolation.
 *
 * All tracks are extended in parallel.
 *
 * @param tracks               Tracks from {@link runTrackBuilding}.
 * @param frames               All extracted frames.
 * @param extendFrames         Number of frames to velocity-extrapolate beyond the point
 *                             where visual tracking stops.
 * @param frameW               Frame pixel width (used to filter off-screen polygons).
 * @param frameH               Frame pixel height.
 * @param fps                  Frames per second of the source video; used to size the
 *                             rolling-window polygon merger (default: 30).
 * @param minVisibleFraction   Polygons with less than this visible fraction are not
 *                             added to the coverage map (default: {@link MIN_VISIBLE_FRACTION}).
 */
export async function runTrackCoverage(
  tracks: Track[],
  frames: FrameInfo[],
  extendFrames: number,
  frameW: number,
  frameH: number,
  fps = 30,
  minVisibleFraction = MIN_VISIBLE_FRACTION,
): Promise<Map<number, Point[][]>> {
  const trackPolygons = new Map<number, Point[][]>();

  // Seed from history entries (actual + interpolated detection positions).
  for (const track of tracks) {
    for (const h of track.history) {
      if (h.polygon.length < 3) continue;
      const existing = trackPolygons.get(h.frameIndex) ?? [];
      existing.push(h.polygon);
      trackPolygons.set(h.frameIndex, existing);
    }
  }

  const bar = createProgressBar("Extending tracks", tracks.length);

  await Promise.all(
    tracks.map(async (track) => {
      if (track.history.length === 0) {
        bar.increment();
        return;
      }

      const first = track.history[0];
      const last = track.history[track.history.length - 1];

      // Unconstrained visual tracking from each endpoint, run in parallel.
      const [backCoverage, fwdCoverage] = await Promise.all([
        trackBack(frames, track, minVisibleFraction),
        trackForward(frames, track, minVisibleFraction),
      ]);

      // Fill any intra-track frame gaps (e.g. from occlusion) with visual tracking.
      const gapCoverage: Array<{ frameIndex: number; polygon: Point[] }> = [];
      for (let i = 0; i < track.history.length - 1; i++) {
        const from = track.history[i];
        const to = track.history[i + 1];
        if (to.frameIndex - from.frameIndex > 1) {
          gapCoverage.push(...(await trackGap(frames, from, to)));
        }
      }

      const anchorBack = backCoverage.length > 0
        ? backCoverage[backCoverage.length - 1]
        : first;

      // Prefer velocity estimated from backward visual-tracking results (closest
      // frames to the detection, most reliable); fall back to track-history velocity.
      const velFromCoverage = velocityFromBackCoverage(backCoverage);
      const velHead: [number, number] = (velFromCoverage[0] !== 0 || velFromCoverage[1] !== 0)
        ? velFromCoverage
        : velocityFromHead(track.history);
      const nearTopEdge = polygonMinY(anchorBack.polygon) < 40;
      // Wider window when the plate is entering from the top — it may be
      // visible for several seconds before ANPR detects it.
      const backWindow = nearTopEdge ? extendFrames * 4 : extendFrames;

      // Enforce a minimum upward velocity so the polygon exits the top of the
      // frame within a reasonable number of frames. Without this, near-zero
      // measured velocity keeps the polygon hovering at y ≈ 0, leaving a visible
      // sliver of plate. Cap the exit window at 10 s so a large backWindow (e.g.
      // from a generous integration-test setting) doesn't dilute the velocity.
      const anchorHeight = Math.max(
        1,
        Math.max(...anchorBack.polygon.map(([, y]) => y)) - polygonMinY(anchorBack.polygon),
      );
      const exitWindow = Math.min(backWindow, Math.round(fps * 10));
      const minVelY = anchorHeight / exitWindow;
      const effectiveVelHead: [number, number] = [
        velHead[0],
        nearTopEdge ? Math.max(velHead[1], minVelY) : velHead[1],
      ];

      const backExt: Array<{ frameIndex: number; polygon: Point[] }> = [];
      const startFi = Math.max(0, anchorBack.frameIndex - backWindow);
      for (let fi = startFi; fi < anchorBack.frameIndex; fi++) {
        const steps = anchorBack.frameIndex - fi;
        const polygon = shiftPolygon(anchorBack.polygon, -effectiveVelHead[0] * steps, -effectiveVelHead[1] * steps);
        if (polygonVisibleFraction(polygon, frameW, frameH) >= minVisibleFraction) {
          backExt.push({ frameIndex: fi, polygon });
        }
      }

      const anchorFwd = fwdCoverage.length > 0
        ? fwdCoverage[fwdCoverage.length - 1]   // furthest frame visual tracking reached
        : last;
      const velTail = velocityFromTail(track.history);
      const fwdExt: Array<{ frameIndex: number; polygon: Point[] }> = [];
      const endFi = Math.min(frames.length - 1, anchorFwd.frameIndex + extendFrames);
      for (let fi = anchorFwd.frameIndex + 1; fi <= endFi; fi++) {
        const steps = fi - anchorFwd.frameIndex;
        const polygon = shiftPolygon(anchorFwd.polygon, velTail[0] * steps, velTail[1] * steps);
        if (polygonVisibleFraction(polygon, frameW, frameH) >= minVisibleFraction) {
          fwdExt.push({ frameIndex: fi, polygon });
        }
      }

      // Merge all coverage; history entries already present take priority.
      for (const { frameIndex, polygon } of [
        ...backCoverage,
        ...fwdCoverage,
        ...gapCoverage,
        ...backExt,
        ...fwdExt,
      ]) {
        if (polygon.length < 3 || trackPolygons.has(frameIndex)) continue;
        trackPolygons.set(frameIndex, [polygon]);
      }

      bar.increment();
    }),
  );

  // Rolling 1-second window (±0.5 s): merge overlapping polygons across time
  // to eliminate abrupt shape changes at coverage-source boundaries.
  const rollingHalfFrames = Math.max(1, Math.round(fps * 0.5));
  mergePolygonsInWindow(trackPolygons, rollingHalfFrames);

  bar.stop();
  process.stderr.write(`${trackPolygons.size} frame(s) scheduled for obscuring\n`);
  return trackPolygons;
}

/**
 * Compute fade-in and fade-out extension frames for each contiguous run of
 * rendered polygons in {@link trackPolygons}.
 *
 * For each run `[F_start … F_end]`:
 * - Adds up to {@link fadeFrames} new entries **before** F_start using the
 *   polygon from F_start (fade in from transparent).
 * - Adds up to {@link fadeFrames} new entries **after** F_end using the
 *   polygon from F_end (fade out to transparent).
 *
 * If the fade window would extend past the video boundaries it is clipped, but
 * the alpha rate is unchanged so the fade appears to start or finish partway
 * through (as requested by the caller).
 *
 * Exported for unit testing.
 *
 * @param trackPolygons  Current frame→polygon map (not mutated).
 * @param fadeFrames     Number of frames for the full fade transition.
 * @param totalFrames    Total frame count of the video.
 * @returns              `extensions` — new frame→polygon entries to merge into
 *                       trackPolygons, and `fadeAlphas` — per-frame alpha for
 *                       each extension frame.
 */
export function computeFadeExtensions(
  trackPolygons: Map<number, Point[][]>,
  fadeFrames: number,
  totalFrames: number,
): { extensions: Map<number, Point[][]>; fadeAlphas: Map<number, number> } {
  const extensions = new Map<number, Point[][]>();
  const fadeAlphas = new Map<number, number>();

  if (fadeFrames <= 0 || trackPolygons.size === 0) {
    return { extensions, fadeAlphas };
  }

  const sorted = [...trackPolygons.keys()].sort((a, b) => a - b);

  // Identify contiguous runs (consecutive frame indices with gap ≤ 1).
  const runs: Array<{ start: number; end: number }> = [];
  let runStart = sorted[0];
  let prev = sorted[0];
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] > prev + 1) {
      runs.push({ start: runStart, end: prev });
      runStart = sorted[i];
    }
    prev = sorted[i];
  }
  runs.push({ start: runStart, end: prev });

  for (const { start, end } of runs) {
    const startPolygons = trackPolygons.get(start)!;
    const endPolygons   = trackPolygons.get(end)!;

    // Fade-in: frames before F_start, clipped to video start.
    const fadeInStart = Math.max(0, start - fadeFrames);
    for (let fi = fadeInStart; fi < start; fi++) {
      if (trackPolygons.has(fi) || extensions.has(fi)) continue;
      extensions.set(fi, startPolygons);
      // fi=start maps to alpha=1; fi=(start-fadeFrames) maps to alpha=0.
      const alpha = (fi - (start - fadeFrames)) / fadeFrames;
      fadeAlphas.set(fi, Math.min(1, Math.max(0, alpha)));
    }

    // Fade-out: frames after F_end, clipped to last frame.
    const fadeOutEnd = Math.min(totalFrames - 1, end + fadeFrames);
    for (let fi = end + 1; fi <= fadeOutEnd; fi++) {
      if (trackPolygons.has(fi) || extensions.has(fi)) continue;
      extensions.set(fi, endPolygons);
      // fi=end+1 maps to alpha=(fadeFrames-1)/fadeFrames; fi=end+fadeFrames maps to alpha=0.
      const alpha = 1 - (fi - end) / fadeFrames;
      fadeAlphas.set(fi, Math.min(1, Math.max(0, alpha)));
    }
  }

  return { extensions, fadeAlphas };
}

/** Options controlling how polygons are rendered during the obscuring phase. */
export interface ObscureOptions {
  /** Alpha values (0–1) for fade-extension frames; absent frames default to 1. */
  fadeAlphas?: Map<number, number>;
  /** Horizontal expansion applied to each polygon on each side. */
  paddingW?: PaddingSpec;
  /** Vertical expansion applied to each polygon on each side. */
  paddingH?: PaddingSpec;
}

/**
 * Phase 4: obscure detected plates in every frame, parallelised across CPU cores.
 *
 * @param frames         All extracted frames.
 * @param trackPolygons  Per-frameIndex polygon map from {@link runTrackCoverage}.
 * @param obscureDir     Directory to write obscured JPEGs into (must already exist).
 * @param options        Optional rendering controls (fade alpha, padding).
 */
export async function runObscuring(
  frames: FrameInfo[],
  trackPolygons: Map<number, Point[][]>,
  obscureDir: string,
  options: ObscureOptions = {},
): Promise<void> {
  const limit = pLimit(os.cpus().length);
  const bar = createProgressBar("Obscuring", frames.length);
  let obscured = 0;

  await Promise.all(
    frames.map((frame) =>
      limit(async () => {
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
        const fadeAlpha = options.fadeAlphas?.get(frame.frameIndex) ?? 1;
        await obscureFrame(frame.filePath, syntheticDetections, outFramePath, {
          fadeAlpha,
          paddingW: options.paddingW,
          paddingH: options.paddingH,
        });
        if (syntheticDetections.some((d) => d.polygon.length >= 3)) obscured++;
        bar.increment();
      }),
    ),
  );

  bar.stop();
  process.stderr.write(`Obscured ${obscured} frame(s)\n`);
}

/**
 * Phase 5: re-assemble the obscured frames into an output video with original audio.
 *
 * @param obscureDir  Directory containing the obscured JPEG frames.
 * @param fps         Frames per second for the output video.
 * @param inputPath   Absolute path to the original video (for audio extraction).
 * @param outputPath  Absolute path to write the output video.
 * @param frameCount  Total number of frames (used to size the progress bar).
 */
export async function runComposition(
  obscureDir: string,
  fps: number,
  inputPath: string,
  outputPath: string,
  frameCount: number,
): Promise<void> {
  const bar = createProgressBar("Composing video", frameCount);
  await composeVideo(obscureDir, fps, inputPath, outputPath, (frame) => bar.update(frame));
  bar.stop();
  process.stderr.write(`Output video written to ${outputPath}\n`);
}
