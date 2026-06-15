#!/usr/bin/env node
/**
 * number-jam CLI entry point.
 *
 * Provides two sub-commands:
 *   detect   — extract frames, run ANPR, build tracks, write JSON to stdout
 *   obscure  — read detect JSON, obscure plates in the video, write output video
 *
 * Progress messages are written to stderr; JSON results go to stdout.
 */

import { Command } from "commander";
import { buildDetectCommand } from "./cli/detect";
import { buildObscureCommand } from "./cli/obscure";

// Re-export helpers so existing tests that import from ./cli still work.
export { parseRegions, warnUnknownRegions, parsePaddingSpec } from "./cli/shared";

const program = new Command();

program
  .name("number-jam")
  .description("Detect, track, and optionally obscure number plates in a video file.")
  .addCommand(buildDetectCommand())
  .addCommand(buildObscureCommand());

if (require.main === module) {
  program.exitOverride();
  try {
    program.parse(process.argv);
  } catch (err: unknown) {
    const code = err && typeof err === "object" && "code" in err
      ? (err as { code: string }).code
      : "";
    if (code === "commander.helpDisplayed") {
      process.exit(0);
    }
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`\nError: ${msg}\n\n`);
    process.stderr.write(program.helpInformation());
    process.exit(1);
  }
}
