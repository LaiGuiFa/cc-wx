export function userFacingMessageHandlingError(error: unknown): string {
  if (error instanceof Error && error.name === "CodexExecInterruptedError") {
    return "Codex 任务已停止。";
  }
  const message = error instanceof Error ? error.message : String(error);
  if (/CreateProcessAsUserW failed:\s*1312|codexExecSandbox/i.test(message)) {
    return [
      "[cc-wx] Windows Codex sandbox 启动失败。",
      "可在 ~/.cc-wx/config.json 中设置 \"codexExecSandbox\": \"danger-full-access\" 后重启。",
      "该设置会让 Codex 获得本机完整访问权限，请仅在理解并接受安全风险时启用。"
    ].join("\n");
  }
  if (/timed out|timeout/i.test(message)) {
    return "[cc-wx] 本轮任务执行时间过长，已停止处理。请拆成更小的步骤后重试。";
  }
  return "[cc-wx] 本轮消息处理失败，详细错误已写入本机服务输出。";
}

export function userFacingHttpError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/^Message text or attachment is required$/i.test(message)) return message;
  if (/^Request body is too large$/i.test(message)) return message;
  if (/^Attachments exceed the \d+(?:\.\d+)? (?:MiB|bytes?) limit$/i.test(message)) return message;
  if (/^Too many attachments; maximum is \d+$/.test(message)) return message;
  if (/^Invalid (?:multipart form data|attachment|session attachment index|request token)$/i.test(message)) {
    return message;
  }
  if (/^Session attachment not found$/i.test(message)) return message;
  if (/^Session is responding; wait for the current task to finish before (?:resetting|deleting)$/.test(message)) {
    return message;
  }
  if (/^Account is (?:being removed|stopping):/.test(message)) {
    return message.replace(/:.*$/, "");
  }
  if (/^Workspace is not allowed:/.test(message)) return "Workspace is not allowed";
  if (/^Login session not found:/.test(message)) return "Login session not found";
  if (/^WeChat account not found:/.test(message)) return "WeChat account not found";
  if (/^Managed session not found:/.test(message)) return "Managed session not found";
  if (/^No WeChat account found\./.test(message)) return "No WeChat account found";
  if (/^Multiple accounts found\./.test(message)) return "Multiple WeChat accounts found";
  if (/^The scanned WeChat account does not match/.test(message)) return "The scanned WeChat account does not match the existing account";
  if (/^Codex runner is closed$|^Codex app-server runner is closed$/.test(message)) return "Codex runner is closed";
  if (/timed out|timeout/i.test(message)) return "The request timed out";
  if (/not found/i.test(message)) return "Not found";
  if (/required|invalid|empty|too large|too many|exceed/i.test(message)) return "Invalid request";
  return "Request failed. Details were written to the local service output.";
}
