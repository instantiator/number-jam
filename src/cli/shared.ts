/**
 * Utilities shared between the detect and obscure sub-commands.
 */

import { PLATE_FORMATS } from "../regions/plate-formats";
import { PaddingSpec } from "../types";

/**
 * Parse the --regions flag value into a string array.
 * Exported for unit testing.
 */
export function parseRegions(raw: string): string[] {
  if (!raw || raw === "*") return ["*"];
  return raw
    .split(",")
    .map((r) => r.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Warn to stderr for any region code not found in PLATE_FORMATS.
 * Lists all known region codes when any unknown code is provided.
 * Exported for unit testing.
 */
export function warnUnknownRegions(regions: string[]): void {
  if (regions.includes("*")) return;
  const known = new Set(PLATE_FORMATS.map((f) => f.code));
  const unknown = regions.filter((r) => !known.has(r));
  if (unknown.length === 0) return;

  for (const r of unknown) {
    process.stderr.write(
      `Warning: region code "${r}" is not recognised; the engine may still detect plates from that region.\n`
    );
  }
  process.stderr.write(formatRegionCodeHelp() + "\n");
}

/**
 * Parse a padding amount string into a {@link PaddingSpec}.
 *
 * Accepts bare numbers (`"10"`), pixel-suffixed values (`"10px"`), and
 * percentage values (`"5%"`). Throws on invalid input.
 * Exported for unit testing.
 */
export function parsePaddingSpec(raw: string): PaddingSpec {
  const trimmed = raw.trim();
  if (trimmed.endsWith("%")) {
    const value = parseFloat(trimmed.slice(0, -1));
    if (isNaN(value) || value < 0) throw new Error(`Invalid padding value: "${raw}"`);
    return { value, unit: "%" };
  }
  const numPart = trimmed.endsWith("px") ? trimmed.slice(0, -2) : trimmed;
  const value = parseFloat(numPart);
  if (isNaN(value) || value < 0) throw new Error(`Invalid padding value: "${raw}"`);
  return { value, unit: "px" };
}

/** Format the region codes section for help and warning output. */
export function formatRegionCodeHelp(): string {
  const codes = PLATE_FORMATS.map((f) => f.code);
  const lines: string[] = [];
  let line = "  ";
  for (const code of codes) {
    const segment = (line === "  " ? "" : "  ") + code;
    if (line.length + segment.length > 80) {
      lines.push(line.trimEnd());
      line = "  " + code;
    } else {
      line += segment;
    }
  }
  if (line.trim()) lines.push(line);
  return "\nAccepted region codes:\n" + lines.join("\n");
}
