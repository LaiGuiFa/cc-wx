import crypto from "node:crypto";
import path from "node:path";

import { readJsonFile, writeJsonFile } from "./json-store.js";
import type { StatePaths } from "./paths.js";

export type ManagedSession = {
  id: string;
  senderId: string;
  title: string;
  workspace: string;
  threadId?: string;
  lastPromptPreview?: string;
  model?: string;
  effort?: string;
  streamReplies?: boolean;
  createdAt: string;
  updatedAt: string;
};

export type SessionRuntimeOverrides = {
  model?: string | null;
  effort?: string | null;
  streamReplies?: boolean | null;
};

export type RuntimeState = {
  pairedSenderIds: string[];
  lastActiveSenderId?: string;
  syncKey?: string;
  processedMessageIds: string[];
  contextTokens: Record<string, string>;
  sessions: ManagedSession[];
  activeSessionIds: Record<string, string>;
  pendingDeliveries: Array<{
    id: string;
    senderId: string;
    text: string;
    createdAt: string;
  }>;
};

export function emptyRuntimeState(): RuntimeState {
  return {
    pairedSenderIds: [],
    processedMessageIds: [],
    contextTokens: {},
    sessions: [],
    activeSessionIds: {},
    pendingDeliveries: []
  };
}

export class RuntimeStateStore {
  private state: RuntimeState;

  constructor(private readonly paths: StatePaths) {
    this.state = normalizeRuntimeState(readJsonFile<unknown>(paths.statePath, {}), paths.statePath);
  }

  get snapshot(): RuntimeState {
    return structuredClone(this.state);
  }

  save(): void {
    writeJsonFile(this.paths.statePath, this.state);
  }

  listPairedSenderIds(): string[] {
    return [...new Set(this.state.pairedSenderIds)].sort();
  }

  setPairedSenderIds(senderIds: string[]): void {
    this.state.pairedSenderIds = [...new Set(senderIds)].sort();
    this.save();
  }

  rememberContextToken(senderId: string, token: string): void {
    this.state.contextTokens[senderId] = token;
    this.state.lastActiveSenderId = senderId;
    this.save();
  }

  getContextToken(senderId: string): string | undefined {
    return this.state.contextTokens[senderId];
  }

  getLastActiveSenderId(): string | undefined {
    return this.state.lastActiveSenderId;
  }

  getSyncKey(): string | undefined {
    return this.state.syncKey;
  }

  setSyncKey(syncKey: string): void {
    if (!syncKey || this.state.syncKey === syncKey) {
      return;
    }
    this.state.syncKey = syncKey;
    this.save();
  }

  claimProcessedMessage(messageId: string): boolean {
    const id = messageId.trim();
    if (!id || this.state.processedMessageIds.includes(id)) {
      return false;
    }
    this.state.processedMessageIds.push(id);
    this.state.processedMessageIds = this.state.processedMessageIds.slice(-1_000);
    this.save();
    return true;
  }

  setWorkspace(senderId: string, workspace: string): void {
    this.ensureActiveSession(senderId, workspace);
    const session = this.mutableActiveSession(senderId)!;
    session.workspace = path.resolve(workspace);
    delete session.threadId;
    session.updatedAt = new Date().toISOString();
    this.save();
  }

  getWorkspace(senderId: string): string | undefined {
    return this.getActiveSession(senderId)?.workspace;
  }

  setThread(senderId: string, threadId: string): void {
    const session = this.mutableActiveSession(senderId);
    if (!session) {
      throw new Error(`No active session for sender: ${senderId}`);
    }
    if (threadId) {
      session.threadId = threadId;
    } else {
      delete session.threadId;
    }
    session.updatedAt = new Date().toISOString();
    this.save();
  }

  getThread(senderId: string): string | undefined {
    return this.getActiveSession(senderId)?.threadId;
  }

  setModelOverride(senderId: string, model?: string): void {
    const session = this.mutableActiveSession(senderId);
    if (!session) {
      throw new Error(`No active session for sender: ${senderId}`);
    }
    if (model?.trim()) {
      session.model = model.trim();
    } else {
      delete session.model;
    }
    session.updatedAt = new Date().toISOString();
    this.save();
  }

  setEffortOverride(senderId: string, effort?: string): void {
    const session = this.mutableActiveSession(senderId);
    if (!session) {
      throw new Error(`No active session for sender: ${senderId}`);
    }
    if (effort?.trim()) {
      session.effort = effort.trim();
    } else {
      delete session.effort;
    }
    session.updatedAt = new Date().toISOString();
    this.save();
  }

  setStreamRepliesOverride(senderId: string, streamReplies?: boolean): void {
    const session = this.mutableActiveSession(senderId);
    if (!session) {
      throw new Error(`No active session for sender: ${senderId}`);
    }
    if (typeof streamReplies === "boolean") {
      session.streamReplies = streamReplies;
    } else {
      delete session.streamReplies;
    }
    session.updatedAt = new Date().toISOString();
    this.save();
  }

  listSessions(): ManagedSession[] {
    return structuredClone(this.state.sessions)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  getSession(sessionId: string): ManagedSession | undefined {
    const session = this.state.sessions.find((candidate) => candidate.id === sessionId);
    return session ? structuredClone(session) : undefined;
  }

  getActiveSession(senderId: string): ManagedSession | undefined {
    const sessionId = this.state.activeSessionIds[senderId];
    const session = this.state.sessions.find((candidate) => candidate.id === sessionId && candidate.senderId === senderId);
    return session ? structuredClone(session) : undefined;
  }

  ensureActiveSession(senderId: string, workspace: string): ManagedSession {
    const active = this.mutableActiveSession(senderId);
    if (active) {
      return structuredClone(active);
    }
    return this.createSession(senderId, workspace);
  }

  createSession(senderId: string, workspace: string, title?: string): ManagedSession {
    const now = new Date().toISOString();
    const number = this.state.sessions.filter((session) => session.senderId === senderId).length + 1;
    const session: ManagedSession = {
      id: crypto.randomUUID(),
      senderId,
      title: cleanTitle(title) ?? `会话 ${number}`,
      workspace: path.resolve(workspace),
      createdAt: now,
      updatedAt: now
    };
    this.state.sessions.push(session);
    this.state.activeSessionIds[senderId] = session.id;
    this.save();
    return structuredClone(session);
  }

  setSessionPromptPreview(sessionId: string, preview: string): ManagedSession {
    const session = this.mutableSession(sessionId);
    const normalized = cleanPromptPreview(preview);
    if (normalized) session.lastPromptPreview = normalized;
    else delete session.lastPromptPreview;
    this.save();
    return structuredClone(session);
  }

  renameSession(sessionId: string, title: string): ManagedSession {
    const session = this.mutableSession(sessionId);
    const nextTitle = cleanTitle(title);
    if (!nextTitle) {
      throw new Error("Session title cannot be empty");
    }
    session.title = nextTitle;
    session.updatedAt = new Date().toISOString();
    this.save();
    return structuredClone(session);
  }

  activateSession(sessionId: string): ManagedSession {
    const session = this.mutableSession(sessionId);
    this.state.activeSessionIds[session.senderId] = session.id;
    session.updatedAt = new Date().toISOString();
    this.save();
    return structuredClone(session);
  }

  resetSession(sessionId: string): ManagedSession {
    const session = this.mutableSession(sessionId);
    delete session.threadId;
    session.updatedAt = new Date().toISOString();
    this.save();
    return structuredClone(session);
  }

  setSessionThread(sessionId: string, threadId: string): ManagedSession {
    const session = this.mutableSession(sessionId);
    if (threadId) {
      session.threadId = threadId;
    } else {
      delete session.threadId;
    }
    session.updatedAt = new Date().toISOString();
    this.save();
    return structuredClone(session);
  }

  updateSessionRuntime(sessionId: string, overrides: SessionRuntimeOverrides): ManagedSession {
    const session = this.mutableSession(sessionId);
    if (Object.hasOwn(overrides, "model")) {
      const model = overrides.model?.trim();
      if (model) session.model = model;
      else delete session.model;
    }
    if (Object.hasOwn(overrides, "effort")) {
      const effort = overrides.effort?.trim();
      if (effort) session.effort = effort;
      else delete session.effort;
    }
    if (Object.hasOwn(overrides, "streamReplies")) {
      if (typeof overrides.streamReplies === "boolean") session.streamReplies = overrides.streamReplies;
      else delete session.streamReplies;
    }
    session.updatedAt = new Date().toISOString();
    this.save();
    return structuredClone(session);
  }

  deleteSession(sessionId: string): void {
    const session = this.mutableSession(sessionId);
    this.state.sessions = this.state.sessions.filter((candidate) => candidate.id !== sessionId);
    if (this.state.activeSessionIds[session.senderId] === sessionId) {
      const fallback = this.state.sessions
        .filter((candidate) => candidate.senderId === session.senderId)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
      if (fallback) {
        this.state.activeSessionIds[session.senderId] = fallback.id;
      } else {
        delete this.state.activeSessionIds[session.senderId];
      }
    }
    this.save();
  }

  private mutableSession(sessionId: string): ManagedSession {
    const session = this.state.sessions.find((candidate) => candidate.id === sessionId);
    if (!session) {
      throw new Error(`Managed session not found: ${sessionId}`);
    }
    return session;
  }

  private mutableActiveSession(senderId: string): ManagedSession | undefined {
    const sessionId = this.state.activeSessionIds[senderId];
    return this.state.sessions.find((candidate) => candidate.id === sessionId && candidate.senderId === senderId);
  }
}

function normalizeRuntimeState(value: unknown, filePath: string): RuntimeState {
  if (!isRecord(value)) {
    throw new Error(`Invalid runtime state in ${filePath}: expected an object`);
  }
  const pairedSenderIds = readStringArray(value, "pairedSenderIds", filePath);
  const processedMessageIds = readStringArray(value, "processedMessageIds", filePath);
  const contextTokens = readStringRecord(value, "contextTokens", filePath);
  const activeSessionIds = readStringRecord(value, "activeSessionIds", filePath);
  const sessions = readSessions(value, filePath);
  const pendingDeliveries = readPendingDeliveries(value, filePath);
  if (value.lastActiveSenderId !== undefined && typeof value.lastActiveSenderId !== "string") {
    throw invalidRuntimeState(filePath, "lastActiveSenderId");
  }
  if (value.syncKey !== undefined && typeof value.syncKey !== "string") {
    throw invalidRuntimeState(filePath, "syncKey");
  }
  return {
    ...emptyRuntimeState(),
    ...(value.lastActiveSenderId === undefined ? {} : { lastActiveSenderId: value.lastActiveSenderId }),
    ...(value.syncKey === undefined ? {} : { syncKey: value.syncKey }),
    pairedSenderIds,
    processedMessageIds: processedMessageIds.slice(-1_000),
    contextTokens,
    sessions,
    activeSessionIds,
    pendingDeliveries
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function readStringArray(value: Record<string, unknown>, key: string, filePath: string): string[] {
  if (value[key] === undefined) return [];
  if (!Array.isArray(value[key]) || value[key].some((item) => typeof item !== "string")) {
    throw invalidRuntimeState(filePath, key);
  }
  return [...new Set(value[key] as string[])];
}

function readStringRecord(value: Record<string, unknown>, key: string, filePath: string): Record<string, string> {
  if (value[key] === undefined) return {};
  if (!isRecord(value[key]) || Object.values(value[key]).some((item) => typeof item !== "string")) {
    throw invalidRuntimeState(filePath, key);
  }
  return { ...(value[key] as Record<string, string>) };
}

function readSessions(value: Record<string, unknown>, filePath: string): ManagedSession[] {
  if (value.sessions === undefined) return [];
  if (!Array.isArray(value.sessions)) throw invalidRuntimeState(filePath, "sessions");
  return value.sessions.map((candidate, index) => {
    if (!isRecord(candidate)) throw invalidRuntimeState(filePath, `sessions[${index}]`);
    for (const key of ["id", "senderId", "title", "workspace", "createdAt", "updatedAt"]) {
      if (typeof candidate[key] !== "string" || !candidate[key]) {
        throw invalidRuntimeState(filePath, `sessions[${index}].${key}`);
      }
    }
    for (const key of ["threadId", "lastPromptPreview", "model", "effort"]) {
      if (candidate[key] !== undefined && typeof candidate[key] !== "string") {
        throw invalidRuntimeState(filePath, `sessions[${index}].${key}`);
      }
    }
    if (candidate.streamReplies !== undefined && typeof candidate.streamReplies !== "boolean") {
      throw invalidRuntimeState(filePath, `sessions[${index}].streamReplies`);
    }
    return candidate as unknown as ManagedSession;
  });
}

function readPendingDeliveries(value: Record<string, unknown>, filePath: string): RuntimeState["pendingDeliveries"] {
  if (value.pendingDeliveries === undefined) return [];
  if (!Array.isArray(value.pendingDeliveries)) throw invalidRuntimeState(filePath, "pendingDeliveries");
  return value.pendingDeliveries.map((candidate, index) => {
    if (!isRecord(candidate)) throw invalidRuntimeState(filePath, `pendingDeliveries[${index}]`);
    for (const key of ["id", "senderId", "text", "createdAt"]) {
      if (typeof candidate[key] !== "string") throw invalidRuntimeState(filePath, `pendingDeliveries[${index}].${key}`);
    }
    return candidate as unknown as RuntimeState["pendingDeliveries"][number];
  });
}

function invalidRuntimeState(filePath: string, field: string): Error {
  return new Error(`Invalid runtime state in ${filePath}: invalid ${field}`);
}

function cleanTitle(value?: string): string | undefined {
  const clean = value?.trim().replace(/\s+/g, " ").slice(0, 80);
  return clean || undefined;
}

function cleanPromptPreview(value?: string): string | undefined {
  const clean = value?.trim().replace(/\s+/g, " ").slice(0, 120);
  return clean || undefined;
}
