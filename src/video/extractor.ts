/**
 * Extract every frame of a video as a JPEG image using ffmpeg.
 *
 * Uses the bundled ffmpeg-static binary so no system ffmpeg installation is
 * required. Progress is written to stderr.
 */

import ffmpeg = require("fluent-ffmpeg");
import ffmpegStatic from "ffmpeg-static";
import ffprobeStatic = require("ffprobe-static");
import * as fs from "fs";
import * as path from "path";
import { FrameInfo } from "../types";

// Point fluent-ffmpeg at the bundled binaries.
if (ffmpegStatic) ffmpeg.setFfmpegPath(ffmpegStatic);
ffmpeg.setFfprobePath(ffprobeStatic.path);

/** Video metadata returned by ffprobe. */
export interface VideoInfo {
  durationSeconds: number;
  fps: number;
  frameCount: number;
  width: number;
  height: number;
}

/** Read basic metadata from a video file without extracting frames. */
export function getVideoInfo(inputPath: string): Promise<VideoInfo> {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(inputPath, (err, data) => {
      if (err) return reject(new Error(`ffprobe failed: ${err.message}`));

      const videoStream = data.streams.find((s) => s.codec_type === "video");
      if (!videoStream) return reject(new Error("No video stream found in input file"));

      const duration = data.format.duration ?? 0;
      const fpsRaw = videoStream.r_frame_rate ?? "25/1";
      const [num, den] = fpsRaw.split("/").map(Number);
      const fps = den ? num / den : num;
      const frameCount = videoStream.nb_frames
        ? parseInt(String(videoStream.nb_frames), 10)
        : Math.round(duration * fps);

      resolve({
        durationSeconds: duration,
        fps,
        frameCount,
        width: videoStream.width ?? 0,
        height: videoStream.height ?? 0,
      });
    });
  });
}

/**
 * Extract every frame from a video into the given output directory as JPEGs.
 * Returns a FrameInfo record for each frame, sorted by frame index.
 *
 * @param inputPath   Absolute path to the source video.
 * @param outputDir   Directory to write frame JPEGs into (must already exist).
 * @param onProgress  Optional callback invoked with the count of frames written so far.
 */
export async function extractFrames(
  inputPath: string,
  outputDir: string,
  onProgress?: (written: number, total: number) => void
): Promise<FrameInfo[]> {
  const info = await getVideoInfo(inputPath);

  await new Promise<void>((resolve, reject) => {
    ffmpeg(inputPath)
      .outputOptions([
        "-vsync", "0",        // Output every frame exactly once
        "-q:v", "2",          // High-quality JPEG
        "-f", "image2",
      ])
      .output(path.join(outputDir, "frame_%06d.jpg"))
      .on("progress", (prog: { frames: number }) => {
        if (onProgress && prog.frames) {
          onProgress(prog.frames, info.frameCount);
        }
      })
      .on("error", (err: Error) => reject(new Error(`ffmpeg frame extraction failed: ${err.message}`)))
      .on("end", () => resolve())
      .run();
  });

  // Collect the files that were actually written.
  const files = fs
    .readdirSync(outputDir)
    .filter((f) => f.startsWith("frame_") && f.endsWith(".jpg"))
    .sort();

  return files.map((filename, idx) => {
    const frameIndex = idx; // 0-based
    const timestamp = frameIndex / info.fps;
    return {
      frameIndex,
      filePath: path.join(outputDir, filename),
      timestamp,
    };
  });
}
