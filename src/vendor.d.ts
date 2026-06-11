/** Type declarations for packages that ship without @types definitions. */

declare module "ffprobe-static" {
  /** Absolute path to the bundled ffprobe binary. */
  const ffprobePath: { path: string };
  export = ffprobePath;
}
