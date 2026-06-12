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
import { trackBack, trackForward, trackGap } from "../tracking/visual-tracker";
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
 * @param tracks        Tracks from {@link runTrackBuilding}.
 * @param frames        All extracted frames.
 * @param extendFrames  Number of frames to velocity-extrapolate beyond the point
 *                      where visual tracking stops.
 */
export async function runTrackCoverage(
  tracks: Track[],
  frames: FrameInfo[],
  extendFrames: number,
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
        trackBack(frames, track),
        trackForward(frames, track),
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

      // Velocity extrapolation: applied at the outermost edges, beyond wherever
      // visual tracking stopped (or from the detection endpoint if it found nothing).
      const anchorBack = backCoverage.length > 0
        ? backCoverage[backCoverage.length - 1]   // furthest frame visual tracking reached
        : first;
      const velHead = velocityFromHead(track.history);
      const backExt: Array<{ frameIndex: number; polygon: Point[] }> = [];
      const startFi = Math.max(0, anchorBack.frameIndex - extendFrames);
      for (let fi = startFi; fi < anchorBack.frameIndex; fi++) {
        const steps = anchorBack.frameIndex - fi;
        backExt.push({
          frameIndex: fi,
          polygon: shiftPolygon(anchorBack.polygon, -velHead[0] * steps, -velHead[1] * steps),
        });
      }

      const anchorFwd = fwdCoverage.length > 0
        ? fwdCoverage[fwdCoverage.length - 1]   // furthest frame visual tracking reached
        : last;
      const velTail = velocityFromTail(track.history);
      const fwdExt: Array<{ frameIndex: number; polygon: Point[] }> = [];
      const endFi = Math.min(frames.length - 1, anchorFwd.frameIndex + extendFrames);
      for (let fi = anchorFwd.frameIndex + 1; fi <= endFi; fi++) {
        const steps = fi - anchorFwd.frameIndex;
        fwdExt.push({
          frameIndex: fi,
          polygon: shiftPolygon(anchorFwd.polygon, velTail[0] * steps, velTail[1] * steps),
        });
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
