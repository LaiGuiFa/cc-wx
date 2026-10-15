import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

import { resolveCodexCommand, type CodexRunResult } from "./exec-runner.js";
import type { ApprovalDecision, ApprovalRequest } from "./approval.js";
import type { CodexExecSandbox } from "./sandbox.js";

const CLIENT_VERSION = readPackageVersion();

export class CodexTurnInterruptedError extends Error {
  constructor(message = "Codex app-server turn was interrupted") {
    super(message);
    this.name = "CodexTurnInterruptedError";
  }
}

export class CodexTurnStartedError extends Error {
  readonly causeError: Error;

  constructor(cause: unknown) {
    const message = cause instanceof Error ? cause.message : String(cause);
    super(message);
    this.name = "CodexTurnStartedError";
    this.causeError = cause instanceof Error ? cause : new Error(message);
  }
}

export type AppServerRunnerOptions = {
  codexBin?: string;
  requestTimeoutMs?: number;
};

export type CodexRunnerInput = {
  prompt: string;
  cwd: string;
  threadId?: string;
  onThreadId?: (threadId: string) => Promise<void> | void;
  model?: string;
  effort?: string;
  onDelta?: (delta: string) => Promise<void> | void;
  onProgress?: (message: string) => Promise<void> | void;
  sandbox?: CodexExecSandbox;
  onApproval?: (request: Omit<ApprovalRequest, "id" | "createdAt">) => Promise<ApprovalDecision>;
};

export type CodexHistoryMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  kind?: "progress";
  createdAt?: string;
};

export type CodexRuntimeInfo = {
  model?: string;
  effort?: string;
  provider?: string;
};

export type CodexModelOption = {
  model: string;
  displayName: string;
  description: string;
  isDefault: boolean;
  defaultEffort?: string;
  supportedEfforts: Array<{
    effort: string;
    description: string;
  }>;
};

type JsonRpcId = number | string;

type PendingRequest = {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

type TurnCompletion = {
  status: string;
  text: string;
  raw: string;
  error?: string;
};

type TurnWaiter = {
  resolve: (value: CodexRunResult) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

type TurnStream = {
  onDelta?: (delta: string) => Promise<void> | void;
  onProgress?: (message: string) => Promise<void> | void;
  onApproval?: CodexRunnerInput["onApproval"];
  chain: Promise<void>;
};

type QueuedTurnEvent = {
  type: "delta" | "progress";
  text: string;
};

type WireMessage = {
  id?: JsonRpcId;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: {
    code?: number;
    message?: string;
    data?: unknown;
  };
};

export class AppServerCodexRunner {
  private child?: ChildProcessWithoutNullStreams;
  private lines?: readline.Interface;
  private connectPromise?: Promise<void>;
  private initialized = false;
  private closed = false;
  private nextId = 1;
  private stderr = "";
  private readonly pending = new Map<JsonRpcId, PendingRequest>();
  private readonly activeTurns = new Map<string, string>();
  private readonly turnWaiters = new Map<string, TurnWaiter>();
  private readonly turnEvents = new Map<string, string[]>();
  private readonly turnTexts = new Map<string, string>();
  private readonly completedTurns = new Map<string, TurnCompletion>();
  private readonly turnStreams = new Map<string, TurnStream>();
  private readonly queuedTurnEvents = new Map<string, QueuedTurnEvent[]>();
  private readonly approvalHandlersByThread = new Map<string, CodexRunnerInput["onApproval"]>();
  private readonly itemPhasesByTurn = new Map<string, Map<string, string>>();
  private readonly runtimeInfoByThread = new Map<string, CodexRuntimeInfo>();
  private modelOptions?: CodexModelOption[];

  constructor(private readonly options: AppServerRunnerOptions = {}) {}

  async run(input: CodexRunnerInput): Promise<CodexRunResult> {
    await this.ensureConnected();

    const threadResponse = await this.request(
      input.threadId ? "thread/resume" : "thread/start",
      compactObject({
        ...(input.threadId ? { threadId: input.threadId } : {}),
        cwd: input.cwd,
        model: input.model,
        approvalPolicy: approvalPolicyFor(input.sandbox),
        sandboxPolicy: sandboxPolicyFor(input.sandbox, input.cwd)
      })
    ) as Record<string, unknown>;
    const thread = threadResponse.thread as Record<string, unknown> | undefined;
    const threadId = typeof thread?.id === "string" ? thread.id : input.threadId;
    if (!threadId) {
      throw new Error("Codex app-server did not return a thread id");
    }
    this.runtimeInfoByThread.set(threadId, runtimeInfoFromThreadResponse(threadResponse));
    try {
      await input.onThreadId?.(threadId);
    } catch (error) {
      throw new CodexTurnStartedError(error);
    }

    let turnResponse: Record<string, unknown>;
    try {
      this.approvalHandlersByThread.set(threadId, input.onApproval);
      turnResponse = await this.request("turn/start", compactObject({
        threadId,
        input: [{ type: "text", text: input.prompt, text_elements: [] }],
        cwd: input.cwd,
        approvalPolicy: approvalPolicyFor(input.sandbox),
        sandboxPolicy: sandboxPolicyFor(input.sandbox, input.cwd),
        model: input.model,
        effort: input.effort
      })) as Record<string, unknown>;
    } catch (error) {
      throw new CodexTurnStartedError(error);
    }
    const turn = turnResponse.turn as Record<string, unknown> | undefined;
    const turnId = typeof turn?.id === "string" ? turn.id : undefined;
    if (!turnId) {
      throw new Error("Codex app-server did not return a turn id");
    }

    this.activeTurns.set(threadId, turnId);
    if (input.onDelta || input.onProgress || input.onApproval) {
      const key = turnKey(threadId, turnId);
      this.turnStreams.set(key, {
        onDelta: input.onDelta,
        onProgress: input.onProgress,
        onApproval: input.onApproval,
        chain: Promise.resolve()
      });
      for (const event of this.queuedTurnEvents.get(key) ?? []) {
        this.enqueueTurnEvent(key, event);
      }
      this.queuedTurnEvents.delete(key);
    }
    return this.waitForTurn(threadId, turnId);
  }

  async listSessions(): Promise<unknown> {
    await this.ensureConnected();
    return this.request("thread/list", {});
  }

  async getHistory(threadId: string): Promise<CodexHistoryMessage[]> {
    await this.ensureConnected();
    const response = await this.request("thread/read", { threadId, includeTurns: true }) as Record<string, unknown>;
    const thread = response.thread as Record<string, unknown> | undefined;
    return parseThreadHistory(thread);
  }

  async getRuntimeInfo(cwd: string, threadId?: string): Promise<CodexRuntimeInfo> {
    const active = threadId ? this.runtimeInfoByThread.get(threadId) : undefined;
    if (active?.model || active?.effort) {
      return active;
    }
    await this.ensureConnected();
    const response = await this.request("config/read", { cwd, includeLayers: false }) as Record<string, unknown>;
    const config = response.config as Record<string, unknown> | undefined;
    return compactRuntimeInfo({
      model: config?.model,
      effort: config?.model_reasoning_effort,
      provider: config?.model_provider ?? config?.modelProvider
    });
  }

  async listModels(forceRefresh = false): Promise<CodexModelOption[]> {
    if (!forceRefresh && this.modelOptions) {
      return structuredClone(this.modelOptions);
    }
    if (forceRefresh) {
      this.modelOptions = undefined;
    }
    await this.ensureConnected();
    const models: CodexModelOption[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    do {
      const response = await this.request("model/list", compactObject({
        cursor,
        includeHidden: false,
        limit: 100
      })) as Record<string, unknown>;
      const data = Array.isArray(response.data) ? response.data : [];
      for (const item of data) {
        const option = parseModelOption(item);
        if (option && !models.some((candidate) => candidate.model === option.model)) {
          models.push(option);
        }
      }
      const nextCursor = typeof response.nextCursor === "string" && response.nextCursor
        ? response.nextCursor
        : undefined;
      if (!nextCursor || seenCursors.has(nextCursor)) break;
      seenCursors.add(nextCursor);
      cursor = nextCursor;
    } while (cursor);
    this.modelOptions = models;
    return structuredClone(models);
  }

  async stop(threadId?: string): Promise<boolean> {
    if (!this.initialized || !this.child || this.child.exitCode !== null) {
      return false;
    }

    if (!threadId) return false;
    const turnId = this.activeTurns.get(threadId);
    const target = turnId ? { threadId, turnId } : undefined;
    if (!target) {
      return false;
    }

    await this.request("turn/interrupt", target);
    return true;
  }

  close(): void {
    this.closed = true;
    this.failTransport(new Error("Codex app-server runner closed"), true);
  }

  private async ensureConnected(): Promise<void> {
    if (this.closed) {
      throw new Error("Codex app-server runner is closed");
    }
    if (this.initialized && this.child?.exitCode === null && !this.child.stdin.destroyed) {
      return;
    }
    if (!this.connectPromise) {
      this.connectPromise = this.startAppServer().finally(() => {
        this.connectPromise = undefined;
      });
    }
    await this.connectPromise;
  }

  private async startAppServer(): Promise<void> {
    const command = resolveCodexCommand(this.options.codexBin ?? "codex");
    const child = spawn(command.command, [...command.argsPrefix, "app-server", "--stdio"], {
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
      windowsHide: true
    });
    this.child = child;
    this.stderr = "";
    this.lines = readline.createInterface({ input: child.stdout });
    this.lines.on("line", (line) => this.handleMessage(line));
    child.stderr.on("data", (chunk: Buffer) => {
      this.stderr = `${this.stderr}${chunk.toString("utf8")}`.slice(-20_000);
    });
    child.once("error", (error) => this.handleChildFailure(child, error));
    child.once("exit", (code, signal) => {
      const detail = this.stderr.trim();
      const suffix = detail ? `: ${detail}` : "";
      this.handleChildFailure(
        child,
        new Error(`Codex app-server exited with code ${code ?? "unknown"}${signal ? ` (${signal})` : ""}${suffix}`)
      );
    });

    try {
      await this.request("initialize", {
        clientInfo: {
          name: "cc-wx",
          title: "CC-WX",
          version: CLIENT_VERSION
        },
        capabilities: {
          experimentalApi: false,
          requestAttestation: false
        }
      }, Math.min(this.options.requestTimeoutMs ?? 600_000, 15_000));
      this.notify("initialized", {});
      this.initialized = true;
    } catch (error) {
      this.failTransport(error instanceof Error ? error : new Error(String(error)), true);
      throw error;
    }
  }

  private request(
    method: string,
    params: Record<string, unknown>,
    timeoutMs = this.options.requestTimeoutMs ?? 600_000
  ): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const error = new Error(`app-server request ${method} timed out after ${timeoutMs}ms`);
        this.pending.delete(id);
        reject(error);
        this.failTransport(error, true);
      }, timeoutMs);
      this.pending.set(id, { method, resolve, reject, timer });
      try {
        this.send({ id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  private notify(method: string, params: Record<string, unknown>): void {
    this.send({ method, params });
  }

  private send(message: WireMessage): void {
    if (!this.child || this.child.exitCode !== null || this.child.stdin.destroyed) {
      throw new Error("Codex app-server stdio transport is not connected");
    }
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private handleMessage(raw: string): void {
    let message: WireMessage;
    try {
      message = JSON.parse(raw) as WireMessage;
    } catch {
      return;
    }

    if (message.method && message.id !== undefined) {
      this.handleServerRequest(message);
      return;
    }
    if (message.method) {
      this.handleNotification(message.method, message.params ?? {}, raw);
      return;
    }
    if (message.id === undefined) {
      return;
    }

    const pending = this.pending.get(message.id);
    if (!pending) {
      return;
    }
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error) {
      const code = message.error.code === undefined ? "" : ` (${message.error.code})`;
      pending.reject(new Error(`app-server ${pending.method} failed${code}: ${message.error.message ?? "unknown error"}`));
    } else {
      pending.resolve(message.result);
    }
  }

  private handleNotification(method: string, params: Record<string, unknown>, raw: string): void {
    if (method === "item/started") {
      const key = turnKeyFromParams(params);
      const item = params.item as Record<string, unknown> | undefined;
      const itemId = typeof item?.id === "string" ? item.id : undefined;
      if (key && itemId && item?.type === "agentMessage" && typeof item.phase === "string") {
        const phases = this.itemPhasesByTurn.get(key) ?? new Map<string, string>();
        phases.set(itemId, item.phase);
        this.itemPhasesByTurn.set(key, phases);
      }
      return;
    }

    if (method === "item/agentMessage/delta") {
      const key = turnKeyFromParams(params);
      const itemId = typeof params.itemId === "string" ? params.itemId : undefined;
      const delta = typeof params.delta === "string" ? params.delta : "";
      if (!key || !itemId || !delta || this.itemPhasesByTurn.get(key)?.get(itemId) === "commentary") {
        return;
      }
      if (this.turnStreams.has(key)) {
        this.enqueueTurnEvent(key, { type: "delta", text: delta });
      } else {
        this.queueTurnEvent(key, { type: "delta", text: delta });
      }
      return;
    }

    if (method === "item/completed") {
      const threadId = typeof params.threadId === "string" ? params.threadId : undefined;
      const turnId = typeof params.turnId === "string" ? params.turnId : undefined;
      if (!threadId || !turnId) {
        return;
      }
      const key = turnKey(threadId, turnId);
      this.appendTurnEvent(key, raw);
      const item = params.item as Record<string, unknown> | undefined;
      if (item?.type === "agentMessage" && typeof item.text === "string") {
        if (item.phase === "commentary") {
          const progress = item.text.trim();
          if (progress) {
            if (this.turnStreams.has(key)) {
              this.enqueueTurnEvent(key, { type: "progress", text: progress });
            } else {
              this.queueTurnEvent(key, { type: "progress", text: progress });
            }
          }
        } else {
          this.turnTexts.set(key, item.text);
        }
      }
      return;
    }

    if (method !== "turn/completed") {
      return;
    }
    const threadId = typeof params.threadId === "string" ? params.threadId : undefined;
    const turn = params.turn as Record<string, unknown> | undefined;
    const turnId = typeof turn?.id === "string" ? turn.id : undefined;
    if (!threadId || !turnId) {
      return;
    }
    const key = turnKey(threadId, turnId);
    this.appendTurnEvent(key, raw);
    const status = typeof turn?.status === "string" ? turn.status : "completed";
    const errorValue = turn?.error as Record<string, unknown> | undefined;
    const completion: TurnCompletion = {
      status,
      text: this.turnTexts.get(key) ?? extractAgentMessageFromTurn(turn),
      raw: (this.turnEvents.get(key) ?? []).join("\n"),
      error: typeof errorValue?.message === "string" ? errorValue.message : undefined
    };
    this.activeTurns.delete(threadId);
    const waiter = this.turnWaiters.get(key);
    if (!waiter) {
      this.completedTurns.set(key, completion);
      return;
    }
    this.turnWaiters.delete(key);
    clearTimeout(waiter.timer);
    void this.finishTurn(threadId, key, completion, waiter.resolve, waiter.reject);
  }

  private waitForTurn(threadId: string, turnId: string): Promise<CodexRunResult> {
    const key = turnKey(threadId, turnId);
    const completed = this.completedTurns.get(key);
    if (completed) {
      this.completedTurns.delete(key);
      return new Promise((resolve, reject) => {
        void this.finishTurn(threadId, key, completed, resolve, reject);
      });
    }

    const timeoutMs = this.options.requestTimeoutMs ?? 600_000;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.turnWaiters.delete(key);
        const error = new Error(`app-server turn timed out after ${timeoutMs}ms`);
        reject(error);
        this.failTransport(error, true);
      }, timeoutMs);
      this.turnWaiters.set(key, { resolve, reject, timer });
    });
  }

  private async finishTurn(
    threadId: string,
    key: string,
    completion: TurnCompletion,
    resolve: (value: CodexRunResult) => void,
    reject: (error: Error) => void
  ): Promise<void> {
    const stream = this.turnStreams.get(key);
    this.turnStreams.delete(key);
    await stream?.chain;
    this.turnEvents.delete(key);
    this.turnTexts.delete(key);
    this.queuedTurnEvents.delete(key);
    this.itemPhasesByTurn.delete(key);
    this.approvalHandlersByThread.delete(threadId);
    if (completion.status === "completed") {
      resolve({ text: completion.text, threadId, raw: completion.raw });
      return;
    }
    if (completion.status === "interrupted") {
      reject(new CodexTurnInterruptedError());
      return;
    }
    reject(new Error(completion.error ?? `Codex app-server turn ended with status ${completion.status}`));
  }

  private appendTurnEvent(key: string, raw: string): void {
    const events = this.turnEvents.get(key) ?? [];
    events.push(raw);
    this.turnEvents.set(key, events);
  }

  private queueTurnEvent(key: string, event: QueuedTurnEvent): void {
    const queued = this.queuedTurnEvents.get(key) ?? [];
    queued.push(event);
    this.queuedTurnEvents.set(key, queued);
  }

  private enqueueTurnEvent(key: string, event: QueuedTurnEvent): void {
    const stream = this.turnStreams.get(key);
    if (!stream) return;
    const callback = event.type === "progress" ? stream.onProgress : stream.onDelta;
    if (!callback) return;
    stream.chain = stream.chain
      .then(() => callback(event.text))
      .then(() => undefined)
      .catch((error) => {
        console.warn(`Codex ${event.type} callback failed: ${error instanceof Error ? error.message : String(error)}`);
      });
  }

  private async handleServerRequest(message: WireMessage): Promise<void> {
    const id = message.id as JsonRpcId;
    const params = message.params ?? {};
    const threadId = typeof params.threadId === "string" ? params.threadId : "";
    const turnId = typeof params.turnId === "string" ? params.turnId : "";
    const onApproval = this.turnStreams.get(turnKey(
      threadId,
      turnId
    ))?.onApproval ?? this.approvalHandlersByThread.get(threadId);
    switch (message.method) {
      case "item/commandExecution/requestApproval":
        this.send({ id, result: { decision: await this.askApproval(onApproval, {
          kind: "command",
          command: typeof params.command === "string" ? params.command : undefined,
          cwd: typeof params.cwd === "string" ? params.cwd : undefined,
          reason: typeof params.reason === "string" ? params.reason : undefined,
          threadId: typeof params.threadId === "string" ? params.threadId : undefined,
          turnId: typeof params.turnId === "string" ? params.turnId : undefined
        }) } });
        return;
      case "item/fileChange/requestApproval":
        this.send({ id, result: { decision: await this.askApproval(onApproval, {
          kind: "file-change",
          reason: typeof params.reason === "string" ? params.reason : undefined,
          threadId: typeof params.threadId === "string" ? params.threadId : undefined,
          turnId: typeof params.turnId === "string" ? params.turnId : undefined
        }) } });
        return;
      case "execCommandApproval":
        this.send({ id, result: { decision: await this.askApproval(onApproval, {
          kind: "command",
          command: typeof params.command === "string" ? params.command : undefined,
          cwd: typeof params.cwd === "string" ? params.cwd : undefined,
          reason: typeof params.reason === "string" ? params.reason : undefined,
          threadId: typeof params.threadId === "string" ? params.threadId : undefined,
          turnId: typeof params.turnId === "string" ? params.turnId : undefined
        }) } });
        return;
      case "applyPatchApproval":
        this.send({ id, result: { decision: await this.askApproval(onApproval, {
          kind: "file-change",
          reason: typeof params.reason === "string" ? params.reason : undefined,
          threadId: typeof params.threadId === "string" ? params.threadId : undefined,
          turnId: typeof params.turnId === "string" ? params.turnId : undefined
        }) } });
        return;
      case "item/tool/requestUserInput":
        this.send({ id, result: { answers: {} } });
        return;
      case "mcpServer/elicitation/request":
        this.send({ id, result: { action: "cancel", content: null, _meta: null } });
        return;
      case "item/permissions/requestApproval": {
        const decision = await this.askApproval(onApproval, {
          kind: "permissions",
          cwd: typeof params.cwd === "string" ? params.cwd : undefined,
          reason: typeof params.reason === "string" ? params.reason : undefined,
          permissions: params.permissions,
          threadId: typeof params.threadId === "string" ? params.threadId : undefined,
          turnId: typeof params.turnId === "string" ? params.turnId : undefined
        });
        this.send({
          id,
          result: {
            permissions: decision === "accept" && params.permissions && typeof params.permissions === "object"
              ? params.permissions
              : {},
            scope: "turn",
            strictAutoReview: true
          }
        });
        return;
      }
      case "item/tool/call":
        this.send({
          id,
          result: {
            contentItems: [{ type: "inputText", text: "Dynamic tools are not available in cc-wx." }],
            success: false
          }
        });
        return;
      case "currentTime/read":
        this.send({ id, result: { currentTimeAt: Math.floor(Date.now() / 1_000) } });
        return;
      default:
        this.send({
          id,
          error: { code: -32601, message: `Unsupported app-server request: ${message.method ?? "unknown"}` }
        });
    }
  }

  private async askApproval(
    onApproval: CodexRunnerInput["onApproval"],
    request: Omit<ApprovalRequest, "id" | "createdAt">
  ): Promise<"accept" | "decline" | "cancel"> {
    if (!onApproval) return "cancel";
    try {
      return await onApproval(request);
    } catch {
      return "cancel";
    }
  }

  private handleChildFailure(child: ChildProcessWithoutNullStreams, error: Error): void {
    if (this.child !== child) {
      return;
    }
    this.failTransport(error, false);
  }

  private failTransport(error: Error, kill: boolean): void {
    const child = this.child;
    this.child = undefined;
    this.initialized = false;
    this.lines?.close();
    this.lines = undefined;
    if (kill && child?.exitCode === null) {
      child.kill();
    }
    for (const [id, pending] of this.pending.entries()) {
      this.pending.delete(id);
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    for (const [key, waiter] of this.turnWaiters.entries()) {
      this.turnWaiters.delete(key);
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.activeTurns.clear();
    this.turnEvents.clear();
    this.turnTexts.clear();
    this.completedTurns.clear();
    this.turnStreams.clear();
    this.queuedTurnEvents.clear();
    this.itemPhasesByTurn.clear();
    this.runtimeInfoByThread.clear();
    this.modelOptions = undefined;
  }
}

function readPackageVersion(): string {
  try {
    const packagePath = fileURLToPath(new URL("../../package.json", import.meta.url));
    const value = JSON.parse(fs.readFileSync(packagePath, "utf8")) as { version?: unknown };
    return typeof value.version === "string" ? value.version : "unknown";
  } catch {
    return "unknown";
  }
}

function turnKeyFromParams(params: Record<string, unknown>): string | undefined {
  const threadId = typeof params.threadId === "string" ? params.threadId : undefined;
  const turnId = typeof params.turnId === "string" ? params.turnId : undefined;
  return threadId && turnId ? turnKey(threadId, turnId) : undefined;
}

function parseModelOption(value: unknown): CodexModelOption | undefined {
  const model = value as Record<string, unknown>;
  const modelId = typeof model.model === "string" && model.model
    ? model.model
    : typeof model.id === "string" ? model.id : "";
  if (!modelId || model.hidden === true) return undefined;
  const efforts = Array.isArray(model.supportedReasoningEfforts)
    ? model.supportedReasoningEfforts.flatMap((value) => {
      const effort = value as Record<string, unknown>;
      return typeof effort.reasoningEffort === "string" && effort.reasoningEffort
        ? [{
          effort: effort.reasoningEffort,
          description: typeof effort.description === "string" ? effort.description : ""
        }]
        : [];
    })
    : [];
  return {
    model: modelId,
    displayName: typeof model.displayName === "string" && model.displayName ? model.displayName : modelId,
    description: typeof model.description === "string" ? model.description : "",
    isDefault: model.isDefault === true,
    ...(typeof model.defaultReasoningEffort === "string" && model.defaultReasoningEffort
      ? { defaultEffort: model.defaultReasoningEffort }
      : {}),
    supportedEfforts: efforts
  };
}

function runtimeInfoFromThreadResponse(response: Record<string, unknown>): CodexRuntimeInfo {
  return compactRuntimeInfo({
    model: response.model,
    effort: response.reasoningEffort,
    provider: response.modelProvider ?? response.model_provider
  });
}

function compactRuntimeInfo(input: { model?: unknown; effort?: unknown; provider?: unknown }): CodexRuntimeInfo {
  return {
    ...(typeof input.model === "string" && input.model ? { model: input.model } : {}),
    ...(typeof input.effort === "string" && input.effort ? { effort: input.effort } : {}),
    ...(typeof input.provider === "string" && input.provider ? { provider: input.provider } : {})
  };
}

function compactObject(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}

function approvalPolicyFor(_sandbox?: CodexExecSandbox): "on-request" {
  return "on-request";
}

function sandboxPolicyFor(sandbox: CodexExecSandbox | undefined, cwd: string): Record<string, unknown> {
  switch (sandbox ?? "workspace-write") {
    case "read-only":
      return { type: "readOnly", networkAccess: false };
    case "danger-full-access":
      return { type: "dangerFullAccess" };
    case "workspace-write":
    default:
      return { type: "workspaceWrite", writableRoots: [cwd], networkAccess: false };
  }
}

function turnKey(threadId: string, turnId: string): string {
  return `${threadId}\u0000${turnId}`;
}

function extractAgentMessageFromTurn(turn: Record<string, unknown> | undefined): string {
  const items = Array.isArray(turn?.items) ? turn.items : [];
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index] as Record<string, unknown>;
    if (item?.type === "agentMessage" && typeof item.text === "string") {
      return item.text;
    }
  }
  return "";
}

export function parseThreadHistory(thread: Record<string, unknown> | undefined): CodexHistoryMessage[] {
  const turns = Array.isArray(thread?.turns) ? thread.turns : [];
  const messages: CodexHistoryMessage[] = [];
  for (const rawTurn of turns) {
    const turn = rawTurn as Record<string, unknown>;
    const items = Array.isArray(turn.items) ? turn.items : [];
    const userCreatedAt = unixSecondsToIso(turn.startedAt);
    const assistantCreatedAt = unixSecondsToIso(turn.completedAt ?? turn.startedAt);
    for (const rawItem of items) {
      const item = rawItem as Record<string, unknown>;
      const id = typeof item.id === "string" ? item.id : `${String(turn.id ?? "turn")}:${messages.length}`;
      if (item.type === "userMessage") {
        const text = extractUserMessageText(item.content);
        if (text) {
          messages.push({ id, role: "user", text, ...(userCreatedAt ? { createdAt: userCreatedAt } : {}) });
        }
        continue;
      }
      if (
        item.type === "agentMessage"
        && typeof item.text === "string"
        && item.text.trim()
      ) {
        messages.push({
          id,
          role: "assistant",
          text: item.text.trim(),
          ...(item.phase === "commentary" ? { kind: "progress" as const } : {}),
          ...(assistantCreatedAt ? { createdAt: assistantCreatedAt } : {})
        });
      }
    }
  }
  return messages;
}

function extractUserMessageText(value: unknown): string {
  if (!Array.isArray(value)) {
    return "";
  }
  return value.map((raw) => {
    const item = raw as Record<string, unknown>;
    if (item.type === "text" && typeof item.text === "string") {
      return item.text;
    }
    if (item.type === "localImage" && typeof item.path === "string") {
      return `[本机图片: ${item.path}]`;
    }
    if (item.type === "image" && typeof item.url === "string") {
      return `[图片: ${item.url}]`;
    }
    return "";
  }).filter(Boolean).join("\n").trim();
}

function unixSecondsToIso(value: unknown): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  return new Date(value * 1_000).toISOString();
}
