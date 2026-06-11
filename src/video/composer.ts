/**
 * Re-assemble a video from a directory of (potentially modified) frame JPEGs,
 * preserving the original audio stream.
 *
 * Uses the bundled ffmpeg-static binary; no system ffmpeg required.
 */

import ffmpeg = require("fluent-ffmpeg");
import ffmpegStatic from "ffmpeg-static";
import ffprobeStatic = require("ffprobe-static");
import * as path from "path";

if (ffmpegStatic) ffmpeg.setFfmpegPath(ffmpegStatic);
ffmpeg.setFfprobePath(ffprobeStatic.path);

/**
 * Compose an output video from a directory of sequential frame JPEGs.
 *
 * @param framesDir   Directory containing frame_000001.jpg … frame_NNNNNN.jpg.
 * @param fps         Frame rate to encode at (must match the source video).
 * @param originalInput  Path to the original video (used to copy its audio stream).
 * @param outputPath  Destination path for the encoded output video.
 * @param onProgress  Optional callback with current frame count.
 */
export async function composeVideo(
  framesDir: string,
  fps: number,
  originalInput: string,
  outputPath: string,
  onProgress?: (frame: number) => void
): Promise<void> {
  const framePattern = path.join(framesDir, "frame_%06d.jpg");

  await new Promise<void>((resolve, reject) => {
    ffmpeg()
      // Video input: the sequence of (modified) JPEGs.
      .input(framePattern)
      .inputOptions([`-framerate ${fps}`, "-f image2"])
      // Audio input: the original video's audio stream.
      .input(originalInput)
      .outputOptions([
        "-map 0:v:0",       // Use video from the JPEG sequence
        "-map 1:a?",        // Use audio from the original video (if any)
        "-c:v libx264",
        "-preset fast",
        "-crf 18",          // High-quality re-encode
        "-pix_fmt yuv420p", // Broad player compatibility
        "-c:a copy",        // Preserve original audio codec
        "-shortest",        // Match the shorter of video/audio
      ])
      .output(outputPath)
      .on("progress", (prog: { frames: number }) => {
        if (onProgress && prog.frames) onProgress(prog.frames);
      })
      .on("error", (err: Error) => reject(new Error(`ffmpeg compose failed: ${err.message}`)))
      .on("end", () => resolve())
      .run();
  });
}
