/**
 * Transforms internal tracking data into the public JSON output document.
 */

import { OutputDoc, PlateSummary, RequestInfo, Track } from "../types";

export function buildOutputDoc(
  request: RequestInfo,
  tracks: Track[],
  videoDuration: number,
  processingDuration: number,
  firstPlateAt: number,
  lastPlateAt: number,
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

  return {
    request,
    summary,
    tracking,
    videoDuration,
    processingDuration,
    firstPlateAt,
    lastPlateAt,
    output,
  };
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
