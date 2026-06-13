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
import { velocityFromHead, velocityFromTail, shiftPolygon } from "../tracking/motion";
import { obscureFrame } from "../obscuring/obscurer";
import { composeVideo } from "../video/composer";
import { createProgressBar } from "./progress";
import { DetectionEngine } from "../detection/engine";
import { FrameInfo, FrameResult, Track, Point, PlateDetection } from "../types";

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

      // When the first detection is within 40 px of the top edge the plate is
      // entering from above the frame. Backward SAD tracking will snap-back to
      // y ≈ 0 and produce incorrect frozen polygons. Skip that coverage and use
      // the first detection directly as the anchor for velocity extrapolation.
      // 40 px mirrors SEARCH_MARGIN in visual-tracker.ts (kept local to avoid coupling).
      const firstNearTopEdge = polygonMinY(first.polygon) < 40;
      const anchorBack = (!firstNearTopEdge && backCoverage.length > 0)
        ? backCoverage[backCoverage.length - 1]
        : first;

      const velHead = velocityFromHead(track.history);
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
      // When the plate enters from the top edge, skip backCoverage (SAD snap-back
      // positions are frozen at y ≈ 0 and would block the velocity-extrapolated
      // positions that correctly exit the frame).
      const backCoverageToUse = firstNearTopEdge ? [] : backCoverage;
      for (const { frameIndex, polygon } of [
        ...backCoverageToUse,
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
 * Phase 4: obscure detected plates in every frame, parallelised across CPU cores.
 *
 * @param frames         All extracted frames.
 * @param trackPolygons  Per-frameIndex polygon map from {@link runTrackCoverage}.
 * @param obscureDir     Directory to write obscured JPEGs into (must already exist).
 */
export async function runObscuring(
  frames: FrameInfo[],
  trackPolygons: Map<number, Point[][]>,
  obscureDir: string,
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
        await obscureFrame(frame.filePath, syntheticDetections, outFramePath);
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
