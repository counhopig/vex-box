/**
 * YamlLoader — reads and parses a YAML config file.
 *
 * Ported from the archive's loadConfigFromFile + mergeConfigs. This is
 * Tier 2 of the config resolution chain (after built-in defaults).
 */

import { readFileSync, existsSync, statSync } from "fs";
import yaml from "yaml";
import { getChildLogger } from "../../utils/logger.js";
import { VexConfigSchema } from "../schema.js";

const logger = getChildLogger("yaml-loader");

export type YamlConfig = Record<string, unknown>;

// Sentinel mtime for the "file does not exist" cache entry — real mtimes are >= 0.
const NO_FILE_MTIME = -1;

interface YamlCacheEntry {
  mtimeMs: number;
  data: YamlConfig;
}

export class YamlLoader {
  private readonly path: string;
  // Per-instance cache, keyed on mtimeMs; mtime bumps (e.g. WeChatChannel.persistToken) invalidate correctly.
  // Throws are not cached — operators must still see validation failures in logs every load.
  private cached: YamlCacheEntry | null = null;

  constructor(path: string) {
    this.path = path;
  }

  /** Load, parse, and validate the YAML file. Returns an empty object when
   *  the file does not exist or is empty (not an error — the file is optional). */
  load(): YamlConfig {
    if (!existsSync(this.path)) {
      if (this.cached?.mtimeMs === NO_FILE_MTIME) {
        return this.cached.data;
      }
      logger.debug({ path: this.path }, "Config file not found, skipping");
      this.cached = { mtimeMs: NO_FILE_MTIME, data: {} };
      return {};
    }

    const mtimeMs = statSync(this.path).mtimeMs;
    if (this.cached && this.cached.mtimeMs === mtimeMs) {
      return this.cached.data;
    }

    const content = readFileSync(this.path, "utf-8");
    if (!content.trim()) {
      logger.debug({ path: this.path }, "Config file is empty, skipping");
      this.cached = { mtimeMs, data: {} };
      return {};
    }

    const parsed = yaml.parse(content) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      logger.warn({ path: this.path }, "Config file has no valid top-level object, skipping");
      this.cached = { mtimeMs, data: {} };
      return {};
    }

    // Validate through Zod to get defaults applied, then return the raw
    // validated data so ConfigStore can merge it with defaults properly.
    const result = VexConfigSchema.safeParse(parsed);
    if (!result.success) {
      // Do NOT cache the throw path — validation failures must surface every load.
      logger.error({ path: this.path, issues: result.error.issues }, "Config validation failed");
      throw new Error(`Invalid config at ${this.path}: ${result.error.message}`);
    }

    logger.debug({ path: this.path, keys: Object.keys(result.data) }, "Config file loaded");
    this.cached = { mtimeMs, data: result.data as unknown as YamlConfig };
    return this.cached.data;
  }

  /** Drop the cached entry — useful when tests mutate the file without bumping mtime. */
  invalidate(): void {
    this.cached = null;
  }
}
