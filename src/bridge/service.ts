import path from "node:path";

import { AccessController } from "./access.js";
import { parseActionBlocks } from "./actions.js";
import { buildPrompt, buildPromptPreview, chunkText, parsePrompt } from "./format.js";
import { PromptBuffer } from "./prompt-buffer.js";
import { SessionTurnCoordinator } from "./session-turn.js";
import type { CodexModelOption, CodexRuntimeInfo } from "../codex/app-server-runner.js";
import { HybridCodexRunner } from "../codex/runner.js";
import { ApprovalBroker, type ApprovalDecision, type ApprovalRequest } from "../codex/approval.js";
import type { CodexExecSandbox } from "../codex/sandbox.js";
import { isWorkspaceAllowed, type CcWxConfig } from "../state/config.js";
import { RuntimeStateStore, type ManagedSession } from "../state/runtime-state.js";
import { WeixinApiClient, isStaleContextError, type FetchLike } from "../weixin/api.js";
import {
  DEFAULT_MAX_OUTBOUND_MEDIA_BYTES,
  downloadInboundAttachments,
  InboundMediaTooLargeError,
  isAllowedLocalFile,
  sendLocalMediaFile
} from "../weixin/media.js";
import { userFacingMessageHandlingError } from "./errors.js";
import type { NormalizedWeixinMessage } from "../weixin/messages.js";
import type { PromptBufferItem } from "./prompt-buffer.js";

export type BridgeServiceOptions = {
  config: CcWxConfig;
  stateStore: RuntimeStateStore;
  weixin: WeixinApiClient;
  runner?: HybridCodexRunner;
  listCodexModels?: () => Promise<CodexModelOption[]>;
  inboundDir?: string;
  mediaFetch?: FetchLike;
  onTurnStatus?: (status: { senderId: string; sessionId: string; active: boolean }) => void;
  turnCoordinator?: SessionTurnCoordinator;
  accountId?: string;
  accountTurnCoordinator?: SessionTurnCoordinator;
  approvalBroker?: ApprovalBroker;
};

export class BridgeService {
  private readonly access: AccessController;
  private readonly buffers: PromptBuffer;
  private readonly runner: HybridCodexRunner;
  private readonly approvals: ApprovalBroker;

  constructor(private readonly options: BridgeServiceOptions) {
    this.access = new AccessController({
      allowedSenderIds: options.config.allowedSenderIds,
      pairedSenderIds: options.stateStore.listPairedSenderIds()
    });
    this.buffers = new PromptBuffer({
      maxItems: options.config.maxBufferItems,
      ttlMs: options.config.promptBufferTtlMs
    });
    this.runner = options.runner ?? new HybridCodexRunner({
      backend: options.config.codexBackend,
      codexBin: options.config.codexBin,
      execSandbox: options.config.codexExecSandbox
    });
    this.approvals = options.approvalBroker ?? new ApprovalBroker();
  }

  async handleMessage(message: NormalizedWeixinMessage): Promise<void> {
    if (message.contextToken) {
      this.options.stateStore.rememberContextToken(message.senderId, message.contextToken);
    }

    const access = this.access.requireAccess(message.senderId);
    if (!access.allowed) {
      await this.reply(message.senderId, access.message);
      return;
    }
    this.options.stateStore.setPairedSenderIds(this.access.listPairedSenderIds());
    this.options.stateStore.ensureActiveSession(message.senderId, this.options.config.defaultCwd);

    const command = parseCommand(message.text);
    if (command) {
      await this.handleCommand(message, command);
      return;
    }

    const items = await this.promptItemsFromMessageWithNotice(message);
    if (!items) return;

    if (this.buffers.isActive(message.senderId)) {
      for (const item of items) {
        this.buffers.append(message.senderId, item);
      }
      await this.reply(message.senderId, "Buffered. Send /end when ready.");
      return;
    }

    await this.runCodexTurn(message, "", items);
  }

  private async handleCommand(message: NormalizedWeixinMessage, command: { name: string; arg: string }): Promise<void> {
    switch (command.name) {
      case "help":
      case "h":
        await this.reply(message.senderId, helpText());
        return;
      case "status":
      case "where":
        await this.reply(message.senderId, await this.statusText(message.senderId));
        return;
      case "work":
        await this.selectWorkspace(message.senderId, command.arg);
        return;
      case "new":
        this.options.stateStore.createSession(message.senderId, this.options.stateStore.getWorkspace(message.senderId) ?? this.options.config.defaultCwd);
        await this.reply(message.senderId, "Created a new Codex session for the next message.");
        return;
      case "resume":
        await this.handleResumeCommand(message.senderId, command.arg);
        return;
      case "model":
        await this.handleModelCommand(message.senderId, command.arg);
        return;
      case "effort":
        await this.handleEffortCommand(message.senderId, command.arg);
        return;
      case "stream":
        await this.handleStreamCommand(message.senderId, command.arg);
        return;
      case "start":
        await this.handlePromptCommand(message.senderId, command.arg ? `start ${command.arg}` : "start");
        return;
      case "end":
        await this.handlePromptCommand(message.senderId, command.arg ? `done ${command.arg}` : "done");
        return;
      case "allow":
      case "deny":
        await this.handleApprovalCommand(message.senderId, command.name, command.arg);
        return;
      case "stop":
        const stopped = await this.runner.stop(this.options.stateStore.getThread(message.senderId));
        await this.reply(message.senderId, stopped ? "Stop signal sent." : "No active Codex task was found.");
        return;
      default:
        await this.reply(message.senderId, `Unknown command: /${command.name}. Send /help.`);
    }
  }

  private async selectWorkspace(senderId: string, rawInput: string): Promise<void> {
    const workspaces = this.options.config.allowedWorkspaces.map((workspace) => path.resolve(workspace));
    const input = rawInput.trim();
    if (/^\d+$/.test(input)) {
      const index = Number(input);
      if (Number.isSafeInteger(index) && index >= 1 && index <= workspaces.length) {
        const workspace = workspaces[index - 1];
        this.options.stateStore.setWorkspace(senderId, workspace);
        await this.reply(senderId, `已切换到工作目录：\n${workspace}`);
        return;
      }
    }
    await this.reply(senderId, [
      "允许的工作目录：",
      ...workspaces.map((workspace, index) => `${index + 1}、${workspace}`)
    ].join("\n"));
  }

  private async handleResumeCommand(senderId: string, arg: string): Promise<void> {
    const sessions = this.options.stateStore.listSessions().filter((session) => session.senderId === senderId);
    const input = arg.trim();
    if (!input) {
      const activeId = this.options.stateStore.getActiveSession(senderId)?.id;
      const previews = await Promise.all(sessions.map((session) => this.sessionPromptPreview(session)));
      const lines = ["历史会话（最近更新优先）："];
      for (const [index, session] of sessions.entries()) {
        lines.push(
          `[R${index + 1}] ${session.id === activeId ? "【当前】" : ""}${session.title}`,
          `   最近内容：${previews[index]}（${formatSessionTime(session.updatedAt)}）`
        );
      }
      lines.push("", "发送 /resume R1 这类切换编号继续会话；R1 是切换编号，“会话 6”等是会话名称。");
      for (const chunk of chunkText(lines.join("\n"))) {
        await this.reply(senderId, chunk);
      }
      return;
    }
    if (/^\d+$/.test(input)) {
      await this.reply(senderId, "请使用列表中 R 开头的切换编号，例如 /resume R1；不要使用会话名称里的数字。");
      return;
    }
    const match = /^r([1-9]\d*)$/i.exec(input);
    if (!match) {
      await this.reply(senderId, "用法：/resume 或 /resume R<编号>，例如 /resume R1。");
      return;
    }
    const selected = sessions[Number(match[1]) - 1];
    if (!selected) {
      await this.reply(senderId, "没有这个切换编号。发送 /resume 查看可用的 R 编号。");
      return;
    }
    const preview = await this.sessionPromptPreview(selected);
    this.options.stateStore.activateSession(selected.id);
    await this.reply(senderId, [
      `已通过 ${input.toUpperCase()} 切换到：${selected.title}`,
      `最近内容：${preview}`,
      selected.threadId ? "下一条消息将继续该历史会话。" : "该会话尚无历史内容，下一条消息将创建新上下文。"
    ].join("\n"));
  }

  private async sessionPromptPreview(session: ManagedSession): Promise<string> {
    if (session.lastPromptPreview) return session.lastPromptPreview;
    if (!session.threadId) return "尚未开始对话";
    try {
      const history = await this.runner.getHistory(session.threadId);
      const lastUserMessage = [...history].reverse().find((message) => message.role === "user");
      if (!lastUserMessage) return "暂无内容摘要";
      const parsed = parsePrompt(lastUserMessage.text);
      const preview = buildPromptPreview(parsed.text, parsed.attachments);
      if (!preview) return "暂无内容摘要";
      this.options.stateStore.setSessionPromptPreview(session.id, preview);
      return preview;
    } catch (error) {
      console.warn(`Unable to read Codex history for session ${session.id}: ${error instanceof Error ? error.message : String(error)}`);
      return "历史摘要暂不可用";
    }
  }

  private async handlePromptCommand(senderId: string, arg: string): Promise<void> {
    const sub = arg.trim().toLowerCase();
    if (sub === "start") {
      const result = this.buffers.start(senderId);
      await this.reply(senderId, result.status === "started" ? "Prompt buffer started." : "Prompt buffer is already active.");
      return;
    }
    if (sub === "done") {
      const flushed = this.buffers.done(senderId);
      if (flushed.status === "empty") {
        await this.reply(senderId, "Prompt buffer is empty.");
        return;
      }
      await this.runCodexTurn({ id: "buffer", senderId, text: "", attachments: [], raw: {} }, "", flushed.items);
      return;
    }
    await this.reply(senderId, "Usage: /start or /end");
  }

  private async handleApprovalCommand(senderId: string, command: string, arg: string): Promise<void> {
    const id = arg.trim().split(/\s+/)[0] ?? "";
    if (!id) {
      await this.reply(senderId, `用法：/${command} <审批编号>`);
      return;
    }
    const resolved = this.approvals.resolve(
      id,
      command === "allow" ? "accept" : "decline",
      (request) => request.senderId === senderId
    );
    await this.reply(senderId, resolved ? `审批 ${id.toUpperCase()} 已${command === "allow" ? "允许" : "拒绝"}。` : "审批编号不存在或已过期。");
  }

  private async handleModelCommand(senderId: string, arg: string): Promise<void> {
    const models = await this.listCodexModels();
    const input = arg.trim();
    if (!input) {
      const runtime = await this.effectiveRuntime(senderId);
      const session = this.options.stateStore.getActiveSession(senderId);
      const lines = [
        `当前模型：${runtime.model ?? "Codex 默认"}${session?.model ? "（本会话）" : "（继承 Web/Codex 设置）"}`
      ];
      if (models.length) {
        lines.push("", "可用模型：", ...models.map((model, index) => `${index + 1}. ${model.displayName}（${model.model}）`));
        lines.push("", "发送 /model <序号或模型 ID> 切换；/model default 恢复继承设置。");
      } else {
        lines.push("", "暂时无法读取模型列表。仍可发送 /model <完整模型 ID> 切换。", "/model default 恢复继承设置。");
      }
      await this.reply(senderId, lines.join("\n"));
      return;
    }
    if (input.toLowerCase() === "default") {
      this.options.stateStore.setModelOverride(senderId);
      const runtime = await this.effectiveRuntime(senderId);
      await this.reply(senderId, `已恢复继承 Web/Codex 模型设置。\n当前模型：${runtime.model ?? "Codex 默认"}`);
      return;
    }

    const selected = selectModel(models, input);
    if (!selected && (models.length || !isPlausibleModelId(input))) {
      await this.reply(senderId, "模型不存在。发送 /model 查看可用模型，或使用 /model default 恢复继承设置。");
      return;
    }
    const currentRuntime = await this.effectiveRuntime(senderId);
    const model = selected?.model ?? input;
    this.options.stateStore.setModelOverride(senderId, model);
    let adjustedEffort: string | undefined;
    if (currentRuntime.effort && selected?.supportedEfforts.length && !selected.supportedEfforts.some((option) => option.effort === currentRuntime.effort)) {
      adjustedEffort = selected.supportedEfforts.some((option) => option.effort === selected.defaultEffort)
        ? selected.defaultEffort
        : selected.supportedEfforts[0]?.effort;
      this.options.stateStore.setEffortOverride(senderId, adjustedEffort);
    }
    await this.reply(senderId, [
      `本会话模型已切换为：${selected?.displayName ?? model}（${model}）`,
      ...(adjustedEffort ? [`原来的推理强度不受该模型支持，已自动调整为：${formatEffort(adjustedEffort)}`] : []),
      "下一条消息开始生效。"
    ].join("\n"));
  }

  private async handleEffortCommand(senderId: string, arg: string): Promise<void> {
    const models = await this.listCodexModels();
    const runtime = await this.effectiveRuntime(senderId);
    const model = models.find((option) => option.model === runtime.model);
    const efforts = availableEfforts(model, models);
    const input = arg.trim();
    if (!input) {
      const session = this.options.stateStore.getActiveSession(senderId);
      await this.reply(senderId, [
        `当前推理强度：${formatEffort(runtime.effort)}${session?.effort ? "（本会话）" : "（继承 Web/Codex 设置）"}`,
        `当前模型：${runtime.model ?? "Codex 默认"}`,
        "",
        "可用推理强度：",
        ...efforts.map((effort, index) => `${index + 1}. ${formatEffort(effort)}`),
        "",
        "发送 /effort <序号或英文值> 切换；/effort default 恢复继承设置。"
      ].join("\n"));
      return;
    }
    if (input.toLowerCase() === "default") {
      this.options.stateStore.setEffortOverride(senderId);
      const nextRuntime = await this.effectiveRuntime(senderId);
      await this.reply(senderId, `已恢复继承 Web/Codex 推理强度设置。\n当前推理强度：${formatEffort(nextRuntime.effort)}`);
      return;
    }
    const effort = selectEffort(efforts, input);
    if (!effort) {
      await this.reply(senderId, "该模型不支持这个推理强度。发送 /effort 查看可用选项。");
      return;
    }
    this.options.stateStore.setEffortOverride(senderId, effort);
    await this.reply(senderId, `本会话推理强度已切换为：${formatEffort(effort)}\n下一条消息开始生效。`);
  }

  private async handleStreamCommand(senderId: string, arg: string): Promise<void> {
    const input = arg.trim().toLowerCase();
    const session = this.options.stateStore.getActiveSession(senderId);
    const inherited = this.options.config.streamReplies;
    if (!input) {
      const effective = session?.streamReplies ?? inherited;
      const source = typeof session?.streamReplies === "boolean" ? "本会话设置" : "继承全局";
      await this.reply(senderId, `当前过程进度：${effective ? "开启" : "关闭"}（${source}）\n发送 /stream on、/stream off 或 /stream default 切换。`);
      return;
    }
    if (input === "default") {
      this.options.stateStore.setStreamRepliesOverride(senderId);
      await this.reply(senderId, `已恢复继承全局设置。当前过程进度：${inherited ? "开启" : "关闭"}。`);
      return;
    }
    if (input !== "on" && input !== "off") {
      await this.reply(senderId, "用法：/stream on、/stream off 或 /stream default");
      return;
    }
    const enabled = input === "on";
    this.options.stateStore.setStreamRepliesOverride(senderId, enabled);
    await this.reply(senderId, `本会话过程进度已${enabled ? "开启" : "关闭"}。`);
  }

  private async promptItemsFromMessage(message: NormalizedWeixinMessage): Promise<PromptBufferItem[]> {
    const items: PromptBufferItem[] = [];
    if (message.text.trim()) {
      items.push({ kind: "text", text: message.text });
    }
    const attachments = message.attachments ?? [];
    if (!attachments.length) {
      return items;
    }
    try {
      const downloaded = await downloadInboundAttachments({
        rootDir: this.options.inboundDir ?? path.join(this.options.config.defaultCwd, ".cc-wx-inbound"),
        senderId: message.senderId,
        messageId: message.id,
        attachments,
        maxBytes: this.options.config.maxInboundBytes,
        fetch: this.options.mediaFetch
      });
      for (const attachment of downloaded) {
        items.push({
          kind: attachment.kind,
          path: attachment.path,
          label: attachment.label
        });
      }
    } catch (error) {
      if (error instanceof InboundMediaTooLargeError) throw error;
      items.push({
        kind: "text",
        text: `[WeChat attachment download failed: ${userFacingMessageHandlingError(error)}]`
      });
    }
    return items;
  }

  private async promptItemsFromMessageWithNotice(message: NormalizedWeixinMessage): Promise<PromptBufferItem[] | undefined> {
    try {
      return await this.promptItemsFromMessage(message);
    } catch (error) {
      if (!(error instanceof InboundMediaTooLargeError)) throw error;
      const maxMiB = Math.floor(error.maxBytes / (1024 * 1024));
      await this.reply(message.senderId, `附件超过 ${maxMiB} MiB 上限，请压缩或裁剪后重新发送。`);
      return undefined;
    }
  }

  private async runCodexTurn(message: NormalizedWeixinMessage, text: string, attachments: PromptBufferItem[] = []): Promise<void> {
    const session = this.options.stateStore.ensureActiveSession(message.senderId, this.options.config.defaultCwd);
    const promptPreview = buildPromptPreview(text, attachments);
    if (promptPreview) {
      this.options.stateStore.setSessionPromptPreview(session.id, promptPreview);
    }
    const run = async (): Promise<void> => {
      const currentSession = this.options.stateStore.getSession(session.id);
      if (!currentSession) {
        throw new Error(`Managed session not found: ${session.id}`);
      }
      const workspace = currentSession.workspace;
      if (!isWorkspaceAllowed(workspace, this.options.config.allowedWorkspaces)) {
        throw new Error("Session workspace is no longer allowed by the current configuration");
      }
      const threadId = currentSession.threadId;
      const progressEnabled = currentSession.streamReplies ?? this.options.config.streamReplies;
      const sentProgress = new Set<string>();
      this.options.onTurnStatus?.({ senderId: message.senderId, sessionId: currentSession.id, active: true });
      try {
        await this.withTyping(message.senderId, async () => {
          console.log(`[cc-wx] starting Codex turn for ${message.senderId} in ${workspace}`);
          const result = await this.runner.run({
            prompt: buildPrompt(text, attachments),
            cwd: workspace,
            threadId,
            onThreadId: (nextThreadId) => {
              this.options.stateStore.setSessionThread(currentSession.id, nextThreadId);
            },
            model: currentSession.model ?? this.options.config.model,
            effort: currentSession.effort ?? this.options.config.effort,
            sandbox: this.options.config.codexExecSandbox ?? "workspace-write",
            onApproval: (request) => this.requestApproval(message.senderId, currentSession.id, request),
            ...(progressEnabled ? {
              onProgress: async (progress: string) => {
                const progressText = progress.trim();
                if (!progressText || sentProgress.has(progressText)) return;
                sentProgress.add(progressText);
                await this.reply(message.senderId, `【进度】${progressText}`);
              }
            } : {})
          });
          console.log(`[cc-wx] Codex turn completed for ${message.senderId}; text=${result.text.length} chars`);
          if (result.threadId) {
            this.options.stateStore.setSessionThread(currentSession.id, result.threadId);
          }
          const parsed = parseActionBlocks(result.text);
          const remaining = chunkText(parsed.visibleText);
          if (remaining.length) {
            for (const chunk of remaining) {
              await this.reply(message.senderId, chunk);
            }
          }
          for (const action of parsed.actions.send) {
            await this.sendLocalMedia(message.senderId, action);
          }
        });
      } finally {
        this.options.onTurnStatus?.({ senderId: message.senderId, sessionId: currentSession.id, active: false });
      }
    };
    const runAccount = this.options.accountTurnCoordinator && this.options.accountId
      ? () => this.options.accountTurnCoordinator!.run(this.options.accountId!, run)
      : run;
    if (this.options.accountTurnCoordinator && this.options.accountId) {
      if (this.options.turnCoordinator) {
        await this.options.turnCoordinator.run(session.id, runAccount);
      } else {
        await runAccount();
      }
    } else {
      if (this.options.turnCoordinator) {
        await this.options.turnCoordinator.run(session.id, run);
      } else {
        await run();
      }
    }
  }

  private requestApproval(
    senderId: string,
    sessionId: string,
    request: Omit<ApprovalRequest, "id" | "createdAt">
  ): Promise<ApprovalDecision> {
    return this.approvals.request({
      ...request,
      accountId: this.options.accountId,
      senderId,
      sessionId
    }, async (created) => {
      const details = [
        `Codex 请求权限（${created.id}）`,
        `类型：${approvalKindText(created.kind)}`,
        created.command ? `命令：${created.command}` : "",
        created.cwd ? `目录：${created.cwd}` : "",
        created.reason ? `原因：${created.reason}` : "",
        created.permissions ? `权限：${formatApprovalPermissions(created.permissions)}` : "",
        "",
        `发送 /allow ${created.id} 允许`,
        `发送 /deny ${created.id} 拒绝`
      ].filter(Boolean).join("\n");
      await this.reply(senderId, details);
    });
  }

  private async sendLocalMedia(senderId: string, action: { type: "image" | "file" | "video"; path: string }): Promise<void> {
    if (!isAllowedLocalFile(action.path, this.options.config.allowedWorkspaces)) {
      await this.reply(senderId, "[cc-wx] Refused to send a file outside the allowed workspace.");
      return;
    }
    try {
      await sendLocalMediaFile({
        client: this.options.weixin,
        toUserId: senderId,
        contextToken: this.options.stateStore.getContextToken(senderId),
        filePath: action.path,
        kind: action.type,
        allowedRoots: this.options.config.allowedWorkspaces,
        maxBytes: Math.min(this.options.config.maxInboundBytes, DEFAULT_MAX_OUTBOUND_MEDIA_BYTES)
      });
    } catch (error) {
      await this.reply(senderId, `[cc-wx] Failed to send ${action.type}: ${userFacingMessageHandlingError(error)}`);
    }
  }

  private async withTyping(senderId: string, run: () => Promise<void>): Promise<void> {
    const sendTyping = async (typing: boolean) => {
      try {
        await this.options.weixin.sendTyping({
          toUserId: senderId,
          contextToken: this.options.stateStore.getContextToken(senderId),
          typing
        });
      } catch (error) {
        console.warn(`WeChat typing indicator failed for ${senderId}: ${error instanceof Error ? error.message : String(error)}`);
      }
    };

    await sendTyping(true);
    const timer = setInterval(() => {
      void sendTyping(true);
    }, 5_000);
    try {
      await run();
    } finally {
      clearInterval(timer);
      await sendTyping(false);
    }
  }

  private async statusText(senderId: string): Promise<string> {
    const session = this.options.stateStore.getActiveSession(senderId);
    const workspace = session?.workspace ?? this.options.config.defaultCwd;
    const runtime = await this.effectiveRuntime(senderId);
    return [
      `模型：${runtime.model ?? "Codex 默认"}`,
      `思考强度：${formatEffort(runtime.effort)}`,
      `工作目录：${workspace}`,
      `会话 ID：${session?.threadId || "尚未创建"}`,
      `沙箱权限：${formatSandboxPermission(this.options.config.codexExecSandbox)}`
    ].join("\n");
  }

  private async listCodexModels(): Promise<CodexModelOption[]> {
    try {
      return await (this.options.listCodexModels?.() ?? this.runner.listModels());
    } catch (error) {
      console.warn(`Codex model list unavailable: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    }
  }

  private async effectiveRuntime(senderId: string): Promise<CodexRuntimeInfo> {
    const session = this.options.stateStore.getActiveSession(senderId);
    const workspace = session?.workspace ?? this.options.config.defaultCwd;
    let runtime: CodexRuntimeInfo = {};
    try {
      runtime = await this.runner.getRuntimeInfo(workspace, session?.threadId);
    } catch (error) {
      console.warn(`Codex runtime info unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }
    return {
      model: session?.model ?? this.options.config.model ?? runtime.model,
      effort: session?.effort ?? this.options.config.effort ?? runtime.effort,
      provider: runtime.provider
    };
  }

  private async reply(senderId: string, text: string): Promise<void> {
    const contextToken = this.options.stateStore.getContextToken(senderId);
    try {
      console.log(`[cc-wx] sending reply to ${senderId}; text=${text.length} chars`);
      await this.options.weixin.sendText({ toUserId: senderId, text, contextToken });
      console.log(`[cc-wx] sent reply to ${senderId}`);
    } catch (error) {
      if (isStaleContextError(error)) {
        console.warn(`WeChat context token is stale for ${senderId}; ask user to send a fresh message.`);
        return;
      }
      throw error;
    }
  }

  allowSender(senderId: string): void {
    this.access.allow(senderId);
    this.options.stateStore.setPairedSenderIds(this.access.listPairedSenderIds());
  }

  removeSender(senderId: string): void {
    this.access.remove(senderId);
    this.options.stateStore.setPairedSenderIds(this.access.listPairedSenderIds());
  }

  listAllowedSenders(): string[] {
    return this.access.listPairedSenderIds();
  }
}

function parseCommand(text: string): { name: string; arg: string } | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) {
    return undefined;
  }
  const [name, ...rest] = trimmed.slice(1).split(/\s+/);
  return { name: name.toLowerCase(), arg: rest.join(" ") };
}

function helpText(): string {
  return [
    "cc-wx commands:",
    "/help - show commands",
    "/status - show current binding",
    "/work [number] - list or switch allowed workspaces",
    "/new - create a new managed Codex session",
    "/resume [R-number] - list or switch historical sessions",
    "/model [number|model-id|default] - view or switch this session's model",
    "/effort [number|level|default] - view or switch reasoning effort",
    "/stream [on|off|default] - view or switch streaming replies",
    "/start - buffer multiple WeChat messages",
    "/end - submit buffered prompt",
    "/allow <id> - approve a pending Codex permission request",
    "/deny <id> - reject a pending Codex permission request",
    "/stop - interrupt the current Codex task"
  ].join("\n");
}

function formatSessionTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "时间未知";
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

const fallbackEfforts = ["minimal", "low", "medium", "high", "xhigh", "max", "ultra"];

function selectModel(models: CodexModelOption[], input: string): CodexModelOption | undefined {
  if (/^\d+$/.test(input)) {
    return models[Number(input) - 1];
  }
  const normalized = input.toLowerCase();
  return models.find((model) => model.model.toLowerCase() === normalized);
}

function isPlausibleModelId(input: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/.test(input);
}

function availableEfforts(model: CodexModelOption | undefined, models: CodexModelOption[]): string[] {
  const advertised = model?.supportedEfforts.length
    ? model.supportedEfforts.map((option) => option.effort)
    : models.flatMap((option) => option.supportedEfforts.map((effort) => effort.effort));
  return advertised.length ? [...new Set(advertised)] : fallbackEfforts;
}

function selectEffort(efforts: string[], input: string): string | undefined {
  if (/^\d+$/.test(input)) {
    return efforts[Number(input) - 1];
  }
  const normalized = input.toLowerCase();
  return efforts.find((effort) => effort.toLowerCase() === normalized);
}

function formatEffort(effort?: string): string {
  if (!effort) return "Codex 默认";
  const labels: Record<string, string> = {
    minimal: "最小",
    low: "低",
    medium: "中",
    high: "高",
    xhigh: "超高",
    max: "最大",
    ultra: "极高"
  };
  return labels[effort] ? `${labels[effort]}（${effort}）` : effort;
}

function formatSandboxPermission(sandbox?: CodexExecSandbox): string {
  const labels: Record<CodexExecSandbox, string> = {
    "read-only": "只读",
    "workspace-write": "工作区可写",
    "danger-full-access": "完整访问"
  };
  return sandbox ? labels[sandbox] : "Codex 默认";
}

function approvalKindText(kind: ApprovalRequest["kind"]): string {
  return {
    command: "命令执行",
    "file-change": "文件修改",
    permissions: "额外权限"
  }[kind];
}

function formatApprovalPermissions(permissions: unknown): string {
  try {
    const text = JSON.stringify(permissions);
    return text && text.length <= 500 ? text : "详情过长，请在 Web 管理页查看";
  } catch {
    return "无法解析权限详情";
  }
}
