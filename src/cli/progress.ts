/**
 * Shared progress bar factory for CLI pipeline phases.
 *
 * Each phase creates a {@link SingleBar}, which writes to stderr and clears
 * itself on completion, keeping stdout clean for JSON output.
 */

import { SingleBar, Presets } from "cli-progress";

/**
 * Create and start a progress bar for a named processing phase.
 *
 * Call {@link SingleBar.increment} or {@link SingleBar.update} as work
 * progresses, then {@link SingleBar.stop} when the phase completes.
 *
 * @param label  Display label shown left of the bar (padded to a fixed width).
 * @param total  Expected total number of units.
 */
export function createProgressBar(label: string, total: number): SingleBar {
  const bar = new SingleBar(
    {
      format: `  ${label.padEnd(18)} |{bar}| {value}/{total}`,
      stream: process.stderr,
      clearOnComplete: true,
      hideCursor: true,
    },
    Presets.shades_classic,
  );
  bar.start(total, 0);
  return bar;
}
