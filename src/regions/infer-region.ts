/**
 * Infers the likely region (country/state) of a plate from its text alone
 * by testing the text against the known plate-format regex database.
 *
 * fast-alpr does not include a region classifier, so this fills the gap when
 * the docker-alpr engine is unavailable.
 */

import { PLATE_FORMATS } from "./plate-formats";

/**
 * Result of a region inference attempt.
 */
export interface RegionInference {
  /** Best-matching ISO region code, or null if no regex matched. */
  region: string | null;
  /**
   * Synthetic confidence value.
   * - 1.0  → exactly one format matched (unambiguous)
   * - 0.5  → multiple formats matched (ambiguous, first match returned)
   * - 0.0  → no match
   */
  regionConfidence: number;
}

/**
 * Match plate text against every entry in PLATE_FORMATS.
 * Returns the first matching region code and a confidence score that reflects
 * how unambiguous the match was.
 *
 * @param plateText  The raw plate string returned by the ANPR engine.
 */
export function inferRegion(plateText: string): RegionInference {
  if (!plateText) return { region: null, regionConfidence: 0 };

  const upper = plateText.toUpperCase().replace(/\s+/g, "");
  const matches = PLATE_FORMATS.filter((f) => f.regex.test(upper));

  if (matches.length === 0) return { region: null, regionConfidence: 0 };
  if (matches.length === 1) return { region: matches[0].code, regionConfidence: 1.0 };
  return { region: matches[0].code, regionConfidence: 0.5 };
}
