import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import type { CodexExecSandbox } from "./sandbox.js";

export type BuildCodexExecArgsInput = {
  prompt: string;
  cwd: string;
  threadId?: string;
  sandbox?: CodexExecSandbox;
  model?: string;
  effort?: string;
  onThreadId?: (threadId: string) => Promise<void> | void;
  onDelta?: (delta: string) => Promise<void> | void;
  onProgress?: (message: string) => Promise<void> | void;
};

export function buildCodexExecArgs(input: BuildCodexExecArgsInput): string[] {
  const runtimeArgs = [
    ...(input.model ? ["--model", input.model] : []),
    ...(input.effort ? ["-c", `model_reasoning_effort=${JSON.stringify(input.effort)}`] : [])
  ];
  if (input.threadId) {
    if (input.sandbox) {
      return [
        "exec",
        "--skip-git-repo-check",
        "--sandbox",
        input.sandbox,
        ...runtimeArgs,
        "--json",
        "resume",
        input.threadId,
        input.prompt
      ];
    }
    return ["exec", "resume", "--skip-git-repo-check", ...runtimeArgs, "--json", input.threadId, input.prompt];
  }
  return [
    "exec",
    "--skip-git-repo-check",
    ...(input.sandbox ? ["--sandbox", input.sandbox] : []),
    ...runtimeArgs,
    "--json",
    input.prompt
  ];
}

export type CodexExecRunnerOptions = {
  codexBin?: string;
  sandbox?: CodexExecSandbox;
  timeoutMs?: number;
};

export type CodexRunResult = {
  text: string;
  threadId?: string;
  raw: string;
};

export class CodexExecInterruptedError extends Error {
  constructor(message = "codex exec run was interrupted") {
    super(message);
    this.name = "CodexExecInterruptedError";
  }
}

export class CodexExecTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodexExecTimeoutError";
  }
}

export class CodexExecRunner {
  private readonly activeRuns: Array<{ child: ChildProcess; threadId?: string; stopped: boolean }> = [];
  private closed = false;

  constructor(private readonly options: CodexExecRunnerOptions = {}) {}

  run(input: BuildCodexExecArgsInput): Promise<CodexRunResult> {
    if (this.closed) {
      return Promise.reject(new Error("Codex exec runner is closed"));
    }
    const codexCommand = resolveCodexCommand(this.options.codexBin ?? "codex");
    const timeoutMs = this.options.timeoutMs ?? 600_000;
    const args = buildCodexExecArgs({
      ...input,
      sandbox: this.options.sandbox ?? input.sandbox
    });

    return new Promise((resolve, reject) => {
      const child = spawn(codexCommand.command, [...codexCommand.argsPrefix, ...args], {
        cwd: input.cwd,
        stdio: ["ignore", "pipe", "pipe"],
        shell: false,
        windowsHide: true
      });
      const activeRun = { child, threadId: input.threadId, stopped: false };
      this.activeRuns.push(activeRun);
      const removeActiveRun = () => {
        const index = this.activeRuns.indexOf(activeRun);
        if (index >= 0) {
          this.activeRuns.splice(index, 1);
        }
      };
      const timer = setTimeout(() => {
        activeRun.stopped = true;
        child.kill();
        reject(new CodexExecTimeoutError(`codex exec timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let stdoutLineBuffer = "";
      let callbackFailure: unknown;
      let threadCallbackPromise: Promise<void> | undefined;
      let threadNotified = Boolean(input.threadId);
      const processStdoutLine = (line: string): void => {
        if (threadNotified || !line.trim()) return;
        try {
          const event = JSON.parse(line) as { type?: unknown; thread_id?: unknown };
          if (event.type !== "thread.started" || typeof event.thread_id !== "string" || !event.thread_id) return;
          threadNotified = true;
          activeRun.threadId = event.thread_id;
          if (input.onThreadId) {
            threadCallbackPromise = Promise.resolve()
              .then(() => input.onThreadId!(event.thread_id as string))
              .then(() => undefined)
              .catch((error) => {
                callbackFailure = error;
                activeRun.stopped = true;
                child.kill();
              });
          }
        } catch {
          // Ignore non-JSON progress lines; final parsing handles the complete output.
        }
      };
      const finish = async (code: number | null): Promise<void> => {
        await threadCallbackPromise;
        clearTimeout(timer);
        removeActiveRun();
        const raw = Buffer.concat(stdout).toString("utf8");
        const err = Buffer.concat(stderr).toString("utf8");
        if (callbackFailure) {
          reject(callbackFailure);
          return;
        }
        if (code !== 0) {
          if (activeRun.stopped) {
            reject(new CodexExecInterruptedError());
            return;
          }
          reject(formatCodexExecFailure(code, err));
          return;
        }
        const parsed = parseCodexExecOutput(raw);
        resolve({ raw, text: parsed.text, threadId: parsed.threadId });
      };
      child.stdout.on("data", (chunk: Buffer) => {
        stdout.push(chunk);
        stdoutLineBuffer += chunk.toString("utf8");
        const lines = stdoutLineBuffer.split(/\r?\n/);
        stdoutLineBuffer = lines.pop() ?? "";
        for (const line of lines) {
          processStdoutLine(line);
        }
      });
      child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
      child.on("error", (error) => {
        void (async () => {
          await threadCallbackPromise;
          clearTimeout(timer);
          removeActiveRun();
          reject(callbackFailure ?? error);
        })();
      });
      child.on("close", (code) => {
        processStdoutLine(stdoutLineBuffer);
        stdoutLineBuffer = "";
        void finish(code);
      });
    });
  }

  async stop(threadId?: string): Promise<boolean> {
    if (!threadId) return false;
    const target = threadId
      ? [...this.activeRuns].reverse().find((run) => run.threadId === threadId)
      : this.activeRuns.at(-1);
    if (target) {
      target.stopped = true;
      target.child.kill();
      return true;
    }
    return false;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const run of this.activeRuns.splice(0)) {
      run.child.kill();
    }
  }
}

export function formatCodexExecFailure(code: number | null, stderr: string): Error {
  const detail = stderr.trim();
  const base = `codex exec exited with code ${code ?? "unknown"}: ${detail}`;
  if (/CreateProcessAsUserW failed:\s*1312/i.test(detail)) {
    return new Error(
      `${base}\nWindows background sandbox startup failed. ` +
      `Set "codexExecSandbox": "danger-full-access" in ~/.cc-wx/config.json only if you accept full access to this machine.`
    );
  }
  return new Error(base);
}

export type ResolveCodexCommandOptions = {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  execPath?: string;
  existsSync?: (target: string) => boolean;
  readdirSync?: (target: string) => string[];
  statSync?: (target: string) => { mtimeMs: number };
};

export function resolveCodexCommand(
  codexBin: string,
  options: ResolveCodexCommandOptions = {}
): { command: string; argsPrefix: string[] } {
  const execPath = options.execPath ?? process.execPath;
  if (/\.(?:js|mjs|cjs)$/i.test(codexBin)) {
    return { command: execPath, argsPrefix: [codexBin] };
  }

  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const existsSync = options.existsSync ?? fs.existsSync;
  const readdirSync = options.readdirSync ?? ((target) => fs.readdirSync(target, "utf8"));
  const statSync = options.statSync ?? fs.statSync;
  if (platform === "darwin" && codexBin === "codex" && !commandExistsOnPath(codexBin, env, existsSync)) {
    const bundledCli = resolveMacDesktopCodex(env, existsSync);
    if (bundledCli) {
      return { command: bundledCli, argsPrefix: [] };
    }
  }
  if (platform !== "win32") {
    return { command: codexBin, argsPrefix: [] };
  }

  const pathApi = platform === "win32" ? path.win32 : path;
  const npmCli = resolveWindowsNpmCli(codexBin, env, pathApi, existsSync);
  if (npmCli) {
    return { command: execPath, argsPrefix: [npmCli] };
  }

  const pathCommand = resolveWindowsPathCommand(codexBin, env, pathApi, existsSync);
  if (pathCommand) {
    return { command: pathCommand, argsPrefix: [] };
  }

  const desktopCommand = resolveWindowsDesktopCodex(env, pathApi, existsSync, readdirSync, statSync);
  if (desktopCommand) {
    return { command: desktopCommand, argsPrefix: [] };
  }

  return { command: codexBin, argsPrefix: [] };
}

function resolveWindowsNpmCli(
  codexBin: string,
  env: NodeJS.ProcessEnv,
  pathApi: typeof path.win32,
  existsSync: (target: string) => boolean
): string | undefined {
  const configuredShim = env.CHAT_CODEX_BIN
    || (pathApi.isAbsolute(codexBin) && /\.(?:cmd|ps1)$/i.test(codexBin) ? codexBin : undefined);
  const npmRoots = [
    configuredShim ? pathApi.dirname(configuredShim) : undefined,
    env.APPDATA ? pathApi.join(env.APPDATA, "npm") : undefined
  ].filter((value): value is string => Boolean(value));

  for (const npmRoot of npmRoots) {
    const bundledCli = pathApi.join(npmRoot, "node_modules", "@openai", "codex", "bin", "codex.js");
    if (existsSync(bundledCli)) return bundledCli;
  }
  return undefined;
}

function resolveWindowsPathCommand(
  codexBin: string,
  env: NodeJS.ProcessEnv,
  pathApi: typeof path.win32,
  existsSync: (target: string) => boolean
): string | undefined {
  const pathValue = env.Path ?? env.PATH ?? "";
  const commandName = pathApi.basename(codexBin);
  const extension = pathApi.extname(commandName).toLowerCase();
  const names = extension
    ? [commandName]
    : [`${commandName}.exe`, `${commandName}.cmd`];

  for (const directory of pathValue.split(pathApi.delimiter).filter(Boolean)) {
    for (const name of names) {
      const candidate = pathApi.join(directory, name);
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

function resolveWindowsDesktopCodex(
  env: NodeJS.ProcessEnv,
  pathApi: typeof path.win32,
  existsSync: (target: string) => boolean,
  readdirSync: (target: string) => string[],
  statSync: (target: string) => { mtimeMs: number }
): string | undefined {
  if (!env.LOCALAPPDATA) return undefined;
  const installRoot = pathApi.join(env.LOCALAPPDATA, "OpenAI", "Codex", "bin");
  let versionDirectories: string[];
  try {
    versionDirectories = readdirSync(installRoot);
  } catch {
    return undefined;
  }

  return versionDirectories
    .map((versionDirectory) => pathApi.join(installRoot, versionDirectory, "codex.exe"))
    .filter((candidate) => existsSync(candidate))
    .sort((left, right) => {
      try {
        return statSync(right).mtimeMs - statSync(left).mtimeMs;
      } catch {
        return 0;
      }
    })[0];
}

function commandExistsOnPath(
  command: string,
  env: NodeJS.ProcessEnv,
  existsSync: (target: string) => boolean
): boolean {
  const pathApi = path.posix;
  return (env.PATH ?? "")
    .split(pathApi.delimiter)
    .filter(Boolean)
    .some((directory) => existsSync(pathApi.join(directory, command)));
}

function resolveMacDesktopCodex(
  env: NodeJS.ProcessEnv,
  existsSync: (target: string) => boolean
): string | undefined {
  const home = env.HOME;
  const candidates = [
    env.CHAT_CODEX_BIN,
    "/Applications/ChatGPT.app/Contents/Resources/codex",
    "/Applications/Codex.app/Contents/Resources/codex",
    ...(home ? [
      path.join(home, "Applications", "ChatGPT.app", "Contents", "Resources", "codex"),
      path.join(home, "Applications", "Codex.app", "Contents", "Resources", "codex")
    ] : [])
  ];
  return candidates.find((candidate): candidate is string => Boolean(candidate && existsSync(candidate)));
}

export function parseCodexExecOutput(raw: string): { text: string; threadId?: string } {
  const lines = raw.split(/\r?\n/).filter(Boolean);
  let lastText = "";
  let threadId: string | undefined;
  for (const line of lines) {
    try {
      const event = JSON.parse(line) as Record<string, unknown>;
      const type = String(event.type ?? event.event ?? "");
      if (type === "thread.started" && typeof event.thread_id === "string") {
        threadId = event.thread_id;
        continue;
      }

      const item = event.item as Record<string, unknown> | undefined;
      if (type === "item.completed" && item?.type === "agent_message" && typeof item.text === "string") {
        lastText = item.text;
        continue;
      }

      if (/message|response|final|output/i.test(type)) {
        const value = event.text ?? event.content ?? event.message;
        if (typeof value === "string") {
          lastText = value;
        }
      }
    } catch {
      lastText = line;
    }
  }
  return { text: lastText || raw.trim(), threadId };
}

export function extractFinalText(raw: string): string {
  return parseCodexExecOutput(raw).text;
}
