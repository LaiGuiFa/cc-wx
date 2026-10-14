import {
  AppServerCodexRunner,
  CodexTurnStartedError,
  CodexTurnInterruptedError,
  type CodexHistoryMessage,
  type CodexModelOption,
  type CodexRunnerInput,
  type CodexRuntimeInfo
} from "./app-server-runner.js";
import {
  CodexExecInterruptedError,
  CodexExecRunner,
  type CodexRunResult
} from "./exec-runner.js";
import type { CodexExecSandbox } from "./sandbox.js";

export type CodexBackend = "auto" | "app-server" | "exec";

export type HybridCodexRunnerOptions = {
  backend: CodexBackend;
  codexBin?: string;
  execSandbox?: CodexExecSandbox;
  timeoutMs?: number;
};

export class HybridCodexRunner {
  private readonly appServer: AppServerCodexRunner;
  private readonly exec: CodexExecRunner;
  private closed = false;

  constructor(private readonly options: HybridCodexRunnerOptions) {
    this.appServer = new AppServerCodexRunner({
      codexBin: options.codexBin,
      requestTimeoutMs: options.timeoutMs
    });
    this.exec = new CodexExecRunner({
      codexBin: options.codexBin,
      sandbox: options.execSandbox,
      timeoutMs: options.timeoutMs
    });
  }

  async run(input: CodexRunnerInput): Promise<CodexRunResult> {
    if (this.closed) {
      throw new Error("Codex runner is closed");
    }
    const requiresAppServerForStreaming = Boolean(input.onDelta || input.onProgress);
    if (this.options.backend === "exec" && !requiresAppServerForStreaming) {
      return this.exec.run(input);
    }
    try {
      return await this.appServer.run(input);
    } catch (error) {
      if (this.options.backend === "app-server" || !isSafeToFallback(error)) {
        throw error;
      }
      if (this.closed) {
        throw new Error("Codex runner is closed");
      }
      const fallback = await this.exec.run({
        ...input,
        onDelta: undefined,
        onProgress: undefined
      });
      return {
        ...fallback,
        text: `Warning: Codex app-server was unavailable, used codex exec fallback.\n\n${fallback.text}`
      };
    }
  }

  async stop(threadId?: string): Promise<boolean> {
    const results = await Promise.allSettled([
      this.appServer.stop(threadId),
      this.exec.stop(threadId)
    ]);
    const stopped = results.some((result) => result.status === "fulfilled" && result.value);
    if (stopped) return true;
    const failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failure) throw failure.reason;
    return false;
  }

  async getHistory(threadId: string): Promise<CodexHistoryMessage[]> {
    return this.appServer.getHistory(threadId);
  }

  async getRuntimeInfo(cwd: string, threadId?: string): Promise<CodexRuntimeInfo> {
    return this.appServer.getRuntimeInfo(cwd, threadId);
  }

  async listModels(): Promise<CodexModelOption[]> {
    return this.appServer.listModels();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.appServer.close();
    this.exec.close();
  }
}

function isSafeToFallback(error: unknown): boolean {
  if (
    error instanceof CodexTurnInterruptedError
    || error instanceof CodexTurnStartedError
    || error instanceof CodexExecInterruptedError
  ) return false;
  const message = error instanceof Error ? error.message : String(error);
  return !/runner (?:is )?closed|turn (?:was )?interrupted|turn timed out|ended with status|request .* timed out/i.test(message);
}
