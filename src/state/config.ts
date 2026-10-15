import os from "node:os";
import fs from "node:fs";
import path from "node:path";

import { parseCodexExecSandbox, type CodexExecSandbox } from "../codex/sandbox.js";
import { readJsonFile, writeJsonFile } from "./json-store.js";
import type { StatePaths } from "./paths.js";

export const MAX_INBOUND_BYTES = 100 * 1024 * 1024;
const LEGACY_DEFAULT_INBOUND_BYTES = 50 * 1024 * 1024;

export type CcWxConfig = {
  defaultCwd: string;
  allowedSenderIds: string[];
  allowedWorkspaces: string[];
  codexBin: string;
  codexBackend: "auto" | "app-server" | "exec";
  codexExecSandbox?: CodexExecSandbox;
  model?: string;
  effort?: string;
  streamReplies: boolean;
  maxBufferItems: number;
  promptBufferTtlMs: number;
  maxInboundBytes: number;
};

export function defaultConfig(cwd = path.join(os.homedir(), ".cc-wx")): CcWxConfig {
  return {
    defaultCwd: path.resolve(cwd),
    allowedSenderIds: [],
    allowedWorkspaces: [path.resolve(cwd)],
    codexBin: "codex",
    codexBackend: "auto",
    streamReplies: true,
    maxBufferItems: 50,
    promptBufferTtlMs: 10 * 60_000,
    maxInboundBytes: MAX_INBOUND_BYTES
  };
}

export function loadConfig(paths: StatePaths, cwd?: string): CcWxConfig {
  const base = cwd ? defaultConfig(cwd) : defaultConfig();
  const loaded = readJsonFile<Partial<CcWxConfig>>(paths.configPath, {});
  const codexExecSandbox = parseCodexExecSandbox(loaded.codexExecSandbox);
  const defaultCwd = canonicalPath(typeof loaded.defaultCwd === "string" ? loaded.defaultCwd : base.defaultCwd);
  const allowedWorkspaces = (loaded.allowedWorkspaces?.length ? loaded.allowedWorkspaces : base.allowedWorkspaces)
    .map((workspace) => canonicalPath(workspace));
  if (!isWorkspaceAllowed(defaultCwd, allowedWorkspaces)) {
    allowedWorkspaces.unshift(defaultCwd);
  }
  return {
    ...base,
    ...loaded,
    defaultCwd,
    codexExecSandbox,
    streamReplies: typeof loaded.streamReplies === "boolean" ? loaded.streamReplies : base.streamReplies,
    maxInboundBytes: normalizeInboundBytes(loaded.maxInboundBytes, base.maxInboundBytes),
    allowedSenderIds: loaded.allowedSenderIds ?? base.allowedSenderIds,
    allowedWorkspaces: allowedWorkspaces.slice(0, 5)
  };
}

export function saveConfig(paths: StatePaths, config: CcWxConfig): void {
  writeJsonFile(paths.configPath, {
    ...config,
    maxInboundBytes: normalizeInboundBytes(config.maxInboundBytes, MAX_INBOUND_BYTES)
  });
}

function normalizeInboundBytes(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return fallback;
  const bytes = Math.floor(value);
  if (bytes === LEGACY_DEFAULT_INBOUND_BYTES) return MAX_INBOUND_BYTES;
  return Math.min(bytes, MAX_INBOUND_BYTES);
}

export function isWorkspaceAllowed(workspace: string, allowedWorkspaces: string[]): boolean {
  const resolved = canonicalPath(workspace);
  return allowedWorkspaces.some((allowed) => {
    const root = canonicalPath(allowed);
    const relative = path.relative(root, resolved);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  });
}

function canonicalPath(value: string): string {
  const resolved = path.resolve(value);
  let current = resolved;
  const missingParts: string[] = [];
  while (true) {
    try {
      const canonicalRoot = fs.realpathSync.native(current);
      return path.join(canonicalRoot, ...missingParts.reverse());
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return resolved;
      missingParts.push(path.basename(current));
      current = parent;
    }
  }
}
