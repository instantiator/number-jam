/**
 * Transforms internal tracking data into the public JSON output document.
 */

import { OutputDoc, PlateSummary, RequestInfo, Track } from "../types";

export function buildOutputDoc(
  request: RequestInfo,
  tracks: Track[],
  videoDurationSeconds: number,
  processingDuration: number,
  output: string | null,
): OutputDoc {
  const summary = buildSummary(tracks);
  const tracking = tracks.map((t) => ({
    plate: t.plate,
    history: t.history.map((h) => ({
      timestamp: Math.round(h.timestamp * 1000),
      polygon: h.polygon,
    })),
  }));

  return {
    request,
    summary,
    tracking,
    videoDuration: Math.round(videoDurationSeconds * 1000),
    processingDuration,
    output,
  };
}

/** Deduplicate tracks into a summary list of unique plates with tracking time range. */
function buildSummary(tracks: Track[]): PlateSummary[] {
  const seen = new Map<string, { region: string | null; from: number; until: number }>();

  for (const track of tracks) {
    if (track.history.length === 0) continue;
    const key = track.plate;
    const fromMs = Math.round(track.history[0].timestamp * 1000);
    const untilMs = Math.round(track.history[track.history.length - 1].timestamp * 1000);

    if (!seen.has(key)) {
      seen.set(key, { region: track.region, from: fromMs, until: untilMs });
    } else {
      const existing = seen.get(key)!;
      if (track.region !== null && existing.region === null) {
        existing.region = track.region;
      }
      existing.from = Math.min(existing.from, fromMs);
      existing.until = Math.max(existing.until, untilMs);
    }
  }

  return Array.from(seen.entries()).map(([plate, { region, from, until }]) => ({
    plate,
    region,
    trackedFrom: from,
    trackedUntil: until,
  }));
}
