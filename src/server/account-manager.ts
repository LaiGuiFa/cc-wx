import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { parseActionBlocks } from "../bridge/actions.js";
import { buildPrompt, buildPromptPreview, parsePrompt } from "../bridge/format.js";
import type { PromptBufferItem } from "../bridge/prompt-buffer.js";
import { BridgeService } from "../bridge/service.js";
import { SessionTurnCoordinator } from "../bridge/session-turn.js";
import { userFacingMessageHandlingError } from "../bridge/errors.js";
import type { CodexHistoryMessage, CodexModelOption, CodexRuntimeInfo } from "../codex/app-server-runner.js";
import { HybridCodexRunner } from "../codex/runner.js";
import { isWorkspaceAllowed, loadConfig, type CcWxConfig } from "../state/config.js";
import { accountStatePaths, type StatePaths } from "../state/paths.js";
import { RuntimeStateStore, type ManagedSession, type SessionRuntimeOverrides } from "../state/runtime-state.js";
import {
  deleteAccount,
  forgetRetainedAccount,
  listAccounts,
  loadAccount,
  publicAccount,
  retainAccountHistory,
  setAccountDisplayName,
  setAccountEnabled,
  type PublicWeixinAccount,
  type WeixinAccount
} from "../weixin/accounts.js";
import { WeixinApiClient } from "../weixin/api.js";
import { monitorWeixin, type MonitorOptions } from "../weixin/monitor.js";
import { inferMediaKind, isAllowedLocalFile, sanitizeFileName } from "../weixin/media.js";

export type AccountRunStatus = "stopped" | "starting" | "running" | "error";

export type AccountSummary = PublicWeixinAccount & {
  status: AccountRunStatus;
  error?: string;
  pairedSenderIds: string[];
  lastActiveSenderId?: string;
  sessionCount: number;
};

export type AccountSession = ManagedSession & {
  accountId: string;
  active: boolean;
  responding: boolean;
};

export type SessionChatResult = {
  threadId: string;
  message: SessionHistoryMessage;
};

export type SessionUpload = {
  name: string;
  data: Buffer;
};

export type SessionMessageAttachment = {
  index: number;
  type: "image" | "file" | "video";
  name: string;
  size?: number;
  available: boolean;
};

export type SessionHistoryMessage = CodexHistoryMessage & {
  attachments: SessionMessageAttachment[];
};

export type SessionAttachmentFile = SessionMessageAttachment & {
  path: string;
};

type InternalSessionHistoryMessage = CodexHistoryMessage & {
  attachments: SessionAttachmentFile[];
};

type RuntimeEntry = {
  status: AccountRunStatus;
  controller?: AbortController;
  task?: Promise<void>;
  service?: BridgeService;
  store?: RuntimeStateStore;
  error?: string;
};

export type AccountManagerOptions = {
  paths: StatePaths;
  configProvider?: () => CcWxConfig;
  clientFactory?: (account: WeixinAccount) => WeixinApiClient;
  bridgeFactory?: (input: ConstructorParameters<typeof BridgeService>[0]) => BridgeService;
  monitor?: (options: MonitorOptions) => Promise<void>;
  runnerFactory?: (config: CcWxConfig) => HybridCodexRunner;
};

export class AccountManager {
  private readonly entries = new Map<string, RuntimeEntry>();
  private readonly stores = new Map<string, RuntimeStateStore>();
  private readonly respondingSessions = new Map<string, number>();
  private readonly closingAccounts = new Set<string>();
  private readonly stoppingAccounts = new Map<string, number>();
  private readonly configProvider: () => CcWxConfig;
  private readonly clientFactory: (account: WeixinAccount) => WeixinApiClient;
  private readonly bridgeFactory: (input: ConstructorParameters<typeof BridgeService>[0]) => BridgeService;
  private readonly monitor: (options: MonitorOptions) => Promise<void>;
  private readonly runnerFactory: (config: CcWxConfig) => HybridCodexRunner;
  private readonly turnCoordinator = new SessionTurnCoordinator();
  private readonly accountTurnCoordinator = new SessionTurnCoordinator();
  private readonly accountRunners = new Map<string, HybridCodexRunner>();
  private utilityRunner?: HybridCodexRunner;

  constructor(private readonly options: AccountManagerOptions) {
    this.configProvider = options.configProvider ?? (() => loadConfig(options.paths));
    this.clientFactory = options.clientFactory ?? ((account) => new WeixinApiClient({
      baseUrl: account.baseUrl,
      token: account.token
    }));
    this.bridgeFactory = options.bridgeFactory ?? ((input) => new BridgeService(input));
    this.monitor = options.monitor ?? monitorWeixin;
    this.runnerFactory = options.runnerFactory ?? ((config) => new HybridCodexRunner({
      backend: config.codexBackend,
      codexBin: config.codexBin,
      execSandbox: config.codexExecSandbox
    }));
  }

  async startAll(): Promise<void> {
    await Promise.all(listAccounts(this.options.paths)
      .filter((account) => account.enabled)
      .map((account) => this.startAccount(account.accountId, false)));
  }

  async stopAll(): Promise<void> {
    await Promise.all(listAccounts(this.options.paths)
      .filter((account) => this.entries.get(account.accountId)?.status === "running")
      .map((account) => this.stopAccount(account.accountId, false)));
    this.closeRunners();
  }

  async restartRunning(): Promise<void> {
    const running = listAccounts(this.options.paths)
      .filter((account) => this.entries.get(account.accountId)?.status === "running")
      .map((account) => account.accountId);
    await Promise.all(running.map((accountId) => this.stopAccount(accountId, false)));
    this.closeRunners();
    await Promise.all(running.map((accountId) => this.startAccount(accountId, false)));
  }

  async refreshAccount(accountId: string): Promise<AccountSummary> {
    this.ensureAccountOpen(accountId);
    const account = loadAccount(this.options.paths, accountId);
    const existing = this.entries.get(account.accountId);
    if (existing?.status === "running" || existing?.status === "starting") {
      await this.stopAccount(account.accountId, false);
    }
    return this.startAccount(account.accountId, false);
  }

  async startAccount(accountId: string, persist = true): Promise<AccountSummary> {
    this.ensureAccountOpen(accountId);
    const account = persist ? setAccountEnabled(this.options.paths, accountId, true) : loadAccount(this.options.paths, accountId);
    const existing = this.entries.get(account.accountId);
    if (existing?.status === "running" || existing?.status === "starting") {
      return this.summary(account);
    }

    const controller = new AbortController();
    const statePaths = accountStatePaths(this.options.paths, account.accountId);
    const store = new RuntimeStateStore(statePaths);
    this.stores.set(account.accountId, store);
    const client = this.clientFactory(account);
    const config = this.configProvider();
    const service = this.bridgeFactory({
      config,
      stateStore: store,
      weixin: client,
      inboundDir: statePaths.inboundDir,
      runner: this.runnerForAccount(account.accountId, config),
      accountId: account.accountId,
      accountTurnCoordinator: this.accountTurnCoordinator,
      turnCoordinator: this.turnCoordinator,
      listCodexModels: () => this.getCodexModels(),
      onTurnStatus: ({ sessionId, active }) => this.setSessionResponding(account.accountId, sessionId, active)
    });
    const entry: RuntimeEntry = { status: "starting", controller, service, store };
    this.entries.set(account.accountId, entry);

    entry.status = "running";
    entry.task = this.monitor({
      client,
      signal: controller.signal,
      initialSyncKey: store.getSyncKey(),
      onSyncKey: (syncKey) => store.setSyncKey(syncKey),
      claimMessage: (message) => store.claimProcessedMessage(message.id),
      onMessage: (message) => service.handleMessage(message),
      onMessageError: async (error, message) => {
        await client.sendText({
          toUserId: message.senderId,
          text: userFacingMessageHandlingError(error),
          contextToken: store.getContextToken(message.senderId)
        });
      }
    }).then(() => {
      entry.status = "stopped";
    }).catch((error: unknown) => {
      if (controller.signal.aborted) {
        entry.status = "stopped";
        return;
      }
      entry.status = "error";
      entry.error = error instanceof Error ? error.message : String(error);
    });
    return this.summary(account);
  }

  async stopAccount(accountId: string, persist = true): Promise<AccountSummary> {
    const account = persist ? setAccountEnabled(this.options.paths, accountId, false) : loadAccount(this.options.paths, accountId);
    this.stoppingAccounts.set(account.accountId, (this.stoppingAccounts.get(account.accountId) ?? 0) + 1);
    try {
      const entry = this.entries.get(account.accountId);
      this.closeAccountRunner(account.accountId);
      if (entry) {
        entry.controller?.abort();
        await entry.task;
        entry.status = "stopped";
      }
      const store = entry?.store ?? this.stores.get(account.accountId);
      await this.accountTurnCoordinator.waitForSessions([account.accountId]);
      await this.turnCoordinator.waitForSessions((store?.listSessions() ?? []).map((session) => session.id));
      this.closeAccountRunner(account.accountId);
      return this.summary(account);
    } finally {
      const remaining = (this.stoppingAccounts.get(account.accountId) ?? 1) - 1;
      if (remaining > 0) {
        this.stoppingAccounts.set(account.accountId, remaining);
      } else {
        this.stoppingAccounts.delete(account.accountId);
      }
    }
  }

  async removeAccount(accountId: string, options: { retainHistory?: boolean } = {}): Promise<void> {
    const account = loadAccount(this.options.paths, accountId);
    if (this.closingAccounts.has(account.accountId)) {
      throw new Error(`Account is already being removed: ${account.accountId}`);
    }
    this.closingAccounts.add(account.accountId);
    try {
      await this.stopAccount(accountId, false);
      const store = this.entries.get(account.accountId)?.store ?? this.storeFor(account.accountId);
      await this.turnCoordinator.waitForSessions(store.listSessions().map((session) => session.id));
      if (options.retainHistory) {
        retainAccountHistory(this.options.paths, account);
      } else if (account.userId) {
        forgetRetainedAccount(this.options.paths, { accountId: account.accountId, userId: account.userId });
      }
      deleteAccount(this.options.paths, accountId);
      if (!options.retainHistory) {
        fs.rmSync(path.dirname(accountStatePaths(this.options.paths, account.accountId).statePath), {
          recursive: true,
          force: true
        });
        fs.rmSync(accountStatePaths(this.options.paths, account.accountId).inboundDir, {
          recursive: true,
          force: true
        });
      }
      this.entries.delete(account.accountId);
      this.stores.delete(account.accountId);
    } finally {
      this.closingAccounts.delete(account.accountId);
    }
  }

  renameAccount(accountId: string, displayName: string): AccountSummary {
    this.ensureAccountOpen(accountId);
    const normalized = displayName.trim();
    if (normalized.length > 40) {
      throw new Error("Account display name must be 40 characters or fewer");
    }
    return this.summary(setAccountDisplayName(this.options.paths, accountId, normalized));
  }

  listAccounts(): AccountSummary[] {
    return listAccounts(this.options.paths).map((account) => this.summary(account));
  }

  listSessions(): AccountSession[] {
    return listAccounts(this.options.paths).flatMap((account) => {
      const store = this.storeFor(account.accountId);
      const activeIds = new Set(Object.values(store.snapshot.activeSessionIds));
      return store.listSessions().map((session) => ({
        ...session,
        accountId: account.accountId,
        active: activeIds.has(session.id),
        responding: this.isSessionResponding(account.accountId, session.id)
      }));
    }).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async getCodexRuntimeInfo(): Promise<CodexRuntimeInfo> {
    const config = this.configProvider();
    const configured: CodexRuntimeInfo = {
      ...(config.model ? { model: config.model } : {}),
      ...(config.effort ? { effort: config.effort } : {})
    };
    try {
      const runtime = await this.utilityRunnerFor(config).getRuntimeInfo(config.defaultCwd);
      return {
        model: configured.model ?? runtime.model,
        effort: configured.effort ?? runtime.effort,
        ...(runtime.provider ? { provider: runtime.provider } : {})
      };
    } catch (error) {
      console.warn(`Codex runtime info unavailable: ${error instanceof Error ? error.message : String(error)}`);
      return configured;
    }
  }

  async getCodexModels(forceRefresh = false): Promise<CodexModelOption[]> {
    let models: CodexModelOption[] = [];
    try {
      models = await this.utilityRunnerFor().listModels(forceRefresh);
    } catch (error) {
      console.warn(`Codex model list unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }
    const runtime = await this.getCodexRuntimeInfo();
    return addProviderModelFamily(models, runtime.provider);
  }

  createSession(accountId: string, senderId: string, workspace?: string, title?: string): AccountSession {
    this.ensureAccountOpen(accountId);
    const config = this.configProvider();
    const targetWorkspace = workspace ?? config.defaultCwd;
    if (!isWorkspaceAllowed(targetWorkspace, config.allowedWorkspaces)) {
      throw new Error(`Workspace is not allowed: ${targetWorkspace}`);
    }
    const session = this.storeFor(accountId).createSession(senderId, targetWorkspace, title);
    return this.sessionSummary(accountId, session, true);
  }

  renameSession(accountId: string, sessionId: string, title: string): AccountSession {
    this.ensureAccountOpen(accountId);
    const session = this.storeFor(accountId).renameSession(sessionId, title);
    return this.sessionSummary(accountId, session, this.isActive(accountId, session.id));
  }

  updateSessionRuntime(accountId: string, sessionId: string, overrides: SessionRuntimeOverrides): AccountSession {
    this.ensureAccountOpen(accountId);
    const session = this.storeFor(accountId).updateSessionRuntime(sessionId, overrides);
    return this.sessionSummary(accountId, session, this.isActive(accountId, session.id));
  }

  isSessionStreamEnabled(accountId: string, sessionId: string): boolean {
    const session = requireSession(this.storeFor(accountId), sessionId);
    return session.streamReplies ?? this.configProvider().streamReplies;
  }

  activateSession(accountId: string, sessionId: string): AccountSession {
    this.ensureAccountOpen(accountId);
    const session = this.storeFor(accountId).activateSession(sessionId);
    return this.sessionSummary(accountId, session, true);
  }

  resetSession(accountId: string, sessionId: string): AccountSession {
    this.ensureAccountOpen(accountId);
    if (this.turnCoordinator.isActive(sessionId)) {
      throw new Error("Session is responding; wait for the current task to finish before resetting");
    }
    const session = this.storeFor(accountId).resetSession(sessionId);
    return this.sessionSummary(accountId, session, this.isActive(accountId, session.id));
  }

  deleteSession(accountId: string, sessionId: string): void {
    this.ensureAccountOpen(accountId);
    if (this.turnCoordinator.isActive(sessionId)) {
      throw new Error("Session is responding; wait for the current task to finish before deleting");
    }
    this.storeFor(accountId).deleteSession(sessionId);
    this.respondingSessions.delete(sessionRuntimeKey(accountId, sessionId));
  }

  async getSessionMessages(accountId: string, sessionId: string): Promise<SessionHistoryMessage[]> {
    const messages = await this.readSessionMessages(accountId, sessionId);
    return messages.map((message) => ({
      ...message,
      attachments: message.attachments.map(({ path: _path, ...attachment }) => attachment)
    }));
  }

  async getSessionAttachment(
    accountId: string,
    sessionId: string,
    messageId: string,
    attachmentIndex: number
  ): Promise<SessionAttachmentFile> {
    const messages = await this.readSessionMessages(accountId, sessionId);
    const attachment = messages.find((message) => message.id === messageId)
      ?.attachments.find((candidate) => candidate.index === attachmentIndex);
    if (!attachment?.available) {
      throw new Error("Session attachment not found");
    }
    return attachment;
  }

  private async readSessionMessages(accountId: string, sessionId: string): Promise<InternalSessionHistoryMessage[]> {
    const store = this.storeFor(accountId);
    const session = requireSession(store, sessionId);
    if (!session.threadId) {
      return [];
    }
    const history = await this.runnerForAccount(accountId).getHistory(session.threadId);
    return history.flatMap((message) => {
      if (message.role === "user") {
        const parsed = parsePrompt(message.text);
        const inboundRoot = accountStatePaths(this.options.paths, accountId).inboundDir;
        const attachments = parsed.attachments
          .filter((attachment) => isPathWithin(inboundRoot, attachment.path))
          .map((attachment, index) => sessionAttachment({
            type: attachment.kind === "audio" ? "file" : attachment.kind,
            path: attachment.path
          }, index, this.configProvider().allowedWorkspaces));
        return parsed.text || attachments.length ? [{ ...message, text: parsed.text, attachments }] : [];
      }
      const parsed = parseAssistantMessage(message.text);
      const attachments = parsed.actions.send
        .filter((action) => isAllowedLocalFile(action.path, this.configProvider().allowedWorkspaces))
        .map((action, index) => sessionAttachment(action, index, this.configProvider().allowedWorkspaces));
      const text = parsed.visibleText.trim();
      return text || attachments.length ? [{ ...message, text, attachments }] : [];
    });
  }

  async continueSession(
    accountId: string,
    sessionId: string,
    text: string,
    uploads: SessionUpload[] = [],
    onProgress?: (message: string) => Promise<void> | void
  ): Promise<SessionChatResult> {
    if (this.closingAccounts.has(accountId)) {
      throw new Error(`Account is being removed: ${accountId}`);
    }
    if (this.stoppingAccounts.has(accountId)) {
      throw new Error(`Account is stopping: ${accountId}`);
    }
    const prompt = text.trim();
    if (!prompt && !uploads.length) {
      throw new Error("Message text or attachment is required");
    }
    const store = this.storeFor(accountId);
    const session = requireSession(store, sessionId);
    this.setSessionResponding(accountId, session.id, true);
    try {
      const run = async (): Promise<SessionChatResult> => {
        const currentSession = requireSession(store, session.id);
        const config = this.configProvider();
        const attachments = this.saveSessionUploads(accountId, currentSession.id, uploads);
        const promptPreview = buildPromptPreview(prompt, attachments);
        if (promptPreview) {
          store.setSessionPromptPreview(currentSession.id, promptPreview);
        }
        const result = await this.runnerForAccount(accountId, config).run({
          prompt: buildPrompt(prompt, attachments, "Web"),
          cwd: currentSession.workspace,
          threadId: currentSession.threadId,
          onThreadId: (nextThreadId) => {
            store.setSessionThread(currentSession.id, nextThreadId);
          },
          model: currentSession.model ?? config.model,
          effort: currentSession.effort ?? config.effort,
          ...((currentSession.streamReplies ?? config.streamReplies) && onProgress
            ? { onProgress }
            : {})
        });
        const threadId = result.threadId ?? currentSession.threadId;
        if (!threadId) {
          throw new Error("Codex did not return a thread id");
        }
        store.setSessionThread(currentSession.id, threadId);
        const parsed = parseAssistantMessage(result.text);
        return {
          threadId,
          message: {
            id: crypto.randomUUID(),
            role: "assistant",
            text: parsed.visibleText.trim(),
            createdAt: new Date().toISOString(),
            attachments: parsed.actions.send
              .filter((action) => isAllowedLocalFile(action.path, config.allowedWorkspaces))
              .map((action, index) => {
                const { path: _path, ...attachment } = sessionAttachment(action, index, config.allowedWorkspaces);
                return attachment;
              })
          }
        };
      };
      return await this.turnCoordinator.run(
        session.id,
        () => this.accountTurnCoordinator.run(accountId, run)
      );
    } finally {
      this.setSessionResponding(accountId, session.id, false);
    }
  }

  private saveSessionUploads(accountId: string, sessionId: string, uploads: SessionUpload[]): PromptBufferItem[] {
    if (!uploads.length) return [];
    const sessionDir = path.join(
      accountStatePaths(this.options.paths, accountId).inboundDir,
      "web",
      safePathSegment(sessionId),
      crypto.randomUUID()
    );
    fs.mkdirSync(sessionDir, { recursive: true });
    try {
      return uploads.map((upload) => {
        const label = sanitizeFileName(upload.name);
        const targetPath = uniqueFilePath(sessionDir, label);
        fs.writeFileSync(targetPath, upload.data, { flag: "wx" });
        return {
          kind: inferMediaKind(label),
          label,
          path: targetPath
        };
      });
    } catch (error) {
      fs.rmSync(sessionDir, { recursive: true, force: true });
      throw error;
    }
  }

  allowSender(accountId: string, senderId: string): void {
    this.ensureAccountOpen(accountId);
    const entry = this.entries.get(loadAccount(this.options.paths, accountId).accountId);
    if (entry?.service) {
      entry.service.allowSender(senderId);
      return;
    }
    const store = this.storeFor(accountId);
    store.setPairedSenderIds([...store.listPairedSenderIds(), senderId]);
  }

  removeSender(accountId: string, senderId: string): void {
    this.ensureAccountOpen(accountId);
    const entry = this.entries.get(loadAccount(this.options.paths, accountId).accountId);
    if (entry?.service) {
      entry.service.removeSender(senderId);
      return;
    }
    const store = this.storeFor(accountId);
    store.setPairedSenderIds(store.listPairedSenderIds().filter((candidate) => candidate !== senderId));
  }

  private storeFor(accountId: string): RuntimeStateStore {
    const account = loadAccount(this.options.paths, accountId);
    const active = this.entries.get(account.accountId)?.store;
    if (active) {
      this.stores.set(account.accountId, active);
      return active;
    }
    const cached = this.stores.get(account.accountId);
    if (cached) return cached;
    const store = new RuntimeStateStore(accountStatePaths(this.options.paths, account.accountId));
    this.stores.set(account.accountId, store);
    return store;
  }

  private ensureAccountOpen(accountId: string): void {
    if (this.closingAccounts.has(accountId)) {
      throw new Error(`Account is being removed: ${accountId}`);
    }
    if (this.stoppingAccounts.has(accountId)) {
      throw new Error(`Account is stopping: ${accountId}`);
    }
  }

  private isActive(accountId: string, sessionId: string): boolean {
    return Object.values(this.storeFor(accountId).snapshot.activeSessionIds).includes(sessionId);
  }

  private sessionSummary(accountId: string, session: ManagedSession, active: boolean): AccountSession {
    return {
      ...session,
      accountId,
      active,
      responding: this.isSessionResponding(accountId, session.id)
    };
  }

  private isSessionResponding(accountId: string, sessionId: string): boolean {
    return (this.respondingSessions.get(sessionRuntimeKey(accountId, sessionId)) ?? 0) > 0;
  }

  private setSessionResponding(accountId: string, sessionId: string, active: boolean): void {
    const key = sessionRuntimeKey(accountId, sessionId);
    const count = this.respondingSessions.get(key) ?? 0;
    const next = active ? count + 1 : Math.max(0, count - 1);
    if (next) {
      this.respondingSessions.set(key, next);
    } else {
      this.respondingSessions.delete(key);
    }
  }

  private runnerForAccount(accountId: string, config = this.configProvider()): HybridCodexRunner {
    const existing = this.accountRunners.get(accountId);
    if (existing) return existing;
    const runner = this.runnerFactory(config);
    this.accountRunners.set(accountId, runner);
    return runner;
  }

  private utilityRunnerFor(config = this.configProvider()): HybridCodexRunner {
    this.utilityRunner ??= this.runnerFactory(config);
    return this.utilityRunner;
  }

  private closeAccountRunner(accountId: string): void {
    const runner = this.accountRunners.get(accountId);
    runner?.close();
    this.accountRunners.delete(accountId);
  }

  private closeRunners(): void {
    for (const runner of this.accountRunners.values()) runner.close();
    this.accountRunners.clear();
    this.utilityRunner?.close();
    this.utilityRunner = undefined;
  }

  private summary(account: WeixinAccount): AccountSummary {
    const entry = this.entries.get(account.accountId);
    const store = entry?.store ?? this.storeFor(account.accountId);
    return {
      ...publicAccount(account),
      status: entry?.status ?? "stopped",
      ...(entry?.error ? { error: entry.error } : {}),
      pairedSenderIds: store.listPairedSenderIds(),
      lastActiveSenderId: store.getLastActiveSenderId(),
      sessionCount: store.listSessions().length
    };
  }
}

function requireSession(store: RuntimeStateStore, sessionId: string): ManagedSession {
  const session = store.getSession(sessionId);
  if (!session) {
    throw new Error(`Managed session not found: ${sessionId}`);
  }
  return session;
}

function parseAssistantMessage(text: string): ReturnType<typeof parseActionBlocks> {
  try {
    return parseActionBlocks(text);
  } catch {
    return { visibleText: text.trim(), actions: { send: [], control: [] } };
  }
}

function sessionAttachment(
  action: { type: "image" | "file" | "video"; path: string },
  index: number,
  allowedRoots: string[]
): SessionAttachmentFile {
  let size: number | undefined;
  const available = isAllowedLocalFile(action.path, allowedRoots);
  try {
    if (available) size = fs.statSync(action.path).size;
  } catch {
    // Keep historical attachments visible even after their local file is moved.
  }
  return {
    index,
    type: action.type,
    path: action.path,
    name: path.basename(action.path),
    ...(size === undefined ? {} : { size }),
    available
  };
}

function uniqueFilePath(dir: string, fileName: string): string {
  const parsed = path.parse(fileName);
  let candidate = path.join(dir, fileName);
  for (let index = 2; fs.existsSync(candidate); index += 1) {
    candidate = path.join(dir, `${parsed.name}-${index}${parsed.ext}`);
  }
  return candidate;
}

function safePathSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "_") || "session";
}

function isPathWithin(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function sessionRuntimeKey(accountId: string, sessionId: string): string {
  return `${accountId}\n${sessionId}`;
}

function addProviderModelFamily(models: CodexModelOption[], provider?: string): CodexModelOption[] {
  if (provider?.toLowerCase() !== "ikuncoding") {
    return models;
  }
  const commonEfforts = ["low", "medium", "high", "xhigh", "max"];
  const descriptions: Record<string, { displayName: string; description: string; efforts: string[] }> = {
    "gpt-5.6-sol": {
      displayName: "GPT-5.6 Sol",
      description: "Frontier agentic coding model for complex work.",
      efforts: [...commonEfforts, "ultra"]
    },
    "gpt-5.6-terra": {
      displayName: "GPT-5.6 Terra",
      description: "Balanced agentic coding model for everyday work.",
      efforts: [...commonEfforts, "ultra"]
    },
    "gpt-5.6-luna": {
      displayName: "GPT-5.6 Luna",
      description: "Fast and efficient model for simpler coding tasks.",
      efforts: commonEfforts
    }
  };
  const family = Object.entries(descriptions).map(([model, details]) => ({
    model,
    displayName: details.displayName,
    description: details.description,
    isDefault: false,
    defaultEffort: "medium",
    supportedEfforts: details.efforts.map((effort) => ({ effort, description: "" }))
  }));
  return [
    ...family.filter((option) => !models.some((model) => model.model === option.model)),
    ...models
  ];
}
