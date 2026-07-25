import { loadFiles as loadFilesInternal } from "../cli/loader.js";
import type { GlobalCliOptions, LoadResult } from "../cli/loader.js";

/**
 * Runtime configuration accepted by {@link loadFiles}.
 *
 * Provider-specific credentials continue to come from each adapter's
 * environment-variable conventions. Set `provider` explicitly or use
 * `FILES_SDK_PROVIDER`.
 */
export type LoadFilesOptions = GlobalCliOptions;

/** The configured client and selected provider returned by {@link loadFiles}. */
export type LoadFilesResult = LoadResult;

/**
 * Construct a {@link import("../index.js").Files} client from a provider name
 * and flat runtime configuration while preserving lazy provider imports.
 */
export const loadFiles = (
  options: LoadFilesOptions
): Promise<LoadFilesResult> => loadFilesInternal(options);
