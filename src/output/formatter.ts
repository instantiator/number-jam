/**
 * Transforms internal tracking data into the public JSON output document.
 */

import { OutputDoc, PlateSummary, RequestInfo, Track } from "../types";

/**
 * Build the JSON output document from the processed pipeline results.
 *
 * @param request   The original CLI request parameters.
 * @param tracks    All tracks produced by the tracker.
 * @param duration  Duration of the input video in seconds.
 * @param output    Resolved path to the output video file, or null when
 *                  pixelation was not performed.
 */
export function buildOutputDoc(
  request: RequestInfo,
  tracks: Track[],
  duration: number,
  output: string | null,
): OutputDoc {
  const summary = buildSummary(tracks);
  const tracking = request.includeTracking
    ? tracks.map((t) => ({
        plate: t.plate,
        history: t.history.map((h) => ({
          timestamp: h.timestamp,
          polygon: h.polygon,
        })),
      }))
    : [];

  return { request, summary, tracking, duration, output };
}

/** Deduplicate tracks into a summary list of unique (plate, region) pairs. */
function buildSummary(tracks: Track[]): PlateSummary[] {
  const seen = new Map<string, string | null>();

  for (const track of tracks) {
    const key = track.plate;
    if (!seen.has(key)) {
      seen.set(key, track.region);
    } else if (track.region !== null && seen.get(key) === null) {
      // Upgrade a previously unknown region if we now know it.
      seen.set(key, track.region);
    }
  }

  return Array.from(seen.entries()).map(([plate, region]) => ({ plate, region }));
}
