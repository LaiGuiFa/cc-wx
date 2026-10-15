<h1 align="center">cc-wx</h1>

<p align="center">
  <a href="./README.md">中文</a> | <strong>English</strong>
</p>

<p align="center">
  <strong>Connect personal WeChat accounts to a local OpenAI Codex installation.</strong>
</p>

`cc-wx` (Codex Connect Weixin) is a cross-platform, local-only WeChat service for Codex. Start it to open a local Web management page, scan a WeChat QR code, and control Codex from private chats while managing workspaces and sessions.

```text
WeChat accounts <-> cc-wx <-> local Codex <-> allowed workspaces
```

The service listens only on `127.0.0.1`. It is not a general messaging gateway and does not expose the management page to the LAN or public Internet.

## Features

- Multiple isolated WeChat accounts with separate authorization, attachments, sessions, and runtime state.
- Text, images, voice, video, and file input; Codex can send local images, videos, and files back to WeChat.
- Web management for accounts, sessions, workspaces, models, reasoning effort, and process progress.
- WeChat commands for status, session lifecycle, workspace selection, model settings, prompt buffering, approval handling, and task interruption.
- Codex app-server first, with automatic fallback to `codex exec` when needed.
- Process progress enabled by default, with deduplication, recovery, and optional retained account history.

## WeChat commands

```text
/help                         Show commands
/status                       Show session, workspace, thread, backend, model, and effort
/work                          List allowed workspaces
/work <number>                 Switch the active session's workspace
/new                          Create a managed Codex session
/resume                       List historical sessions
/resume R<number>             Continue a selected session
/model                        Show or switch the model
/effort                       Show or switch reasoning effort
/stream                       Show or switch process progress
/start                        Buffer multiple messages
/end                          Submit the buffered prompt
/allow <id>                    Approve a Codex permission request
/deny <id>                     Reject a Codex permission request
/stop                         Interrupt the current task
```

In **Settings**, use the directory picker to configure the default workspace and the allowlist, which supports up to five workspaces. Send `/work` in WeChat to list them, then `/work 1` to switch. An invalid or out-of-range number shows the list again. Switching updates the active session's workspace and clears its Codex thread, so subsequent messages start a new context in the selected directory.

Regular messages enter the active session. Attachments are stored under the account's inbound directory and added to the prompt by local path; WeChat voice transcription is preferred when available.

`/start` begins buffering messages and attachments. Send `/end` to submit the buffered content to Codex as one prompt. Use `/stream on` or `/stream off` to control process-progress messages; progress updates and the final answer are sent separately.

## Sandbox and approvals

The Settings page offers three sandbox levels:

- `read-only`: read-only access; direct workspace changes are blocked.
- `workspace-write`: can modify the current workspace; network access is off by default.
- `danger-full-access`: removes file and network sandbox restrictions and should be treated as high risk.

Sandboxing and approvals are independent controls. Even with `danger-full-access`, Codex pauses before command execution, file changes, or extra permission requests and waits for approval. Full access does not disable approvals.

Approval requests appear in the Web management page and are sent to WeChat with an approval ID, command, directory, and reason. In WeChat, use `/allow <id>` or `/deny <id>`. A WeChat approval can only be resolved by the sender who owns that request; requests expire and cancel after 120 seconds. If approval handling is unavailable, the task stops instead of falling back to execution without approval.

## Start and restart

Development mode:

```bash
npm run dev
```

Production mode:

```bash
npm run build
npm start
```

The service listens on `http://127.0.0.1:8787` by default. Set `CC_WX_OPEN=0` to suppress automatic browser opening or `CC_WX_PORT` to choose another port. To restart, stop the old process and run the same start command again; enabled accounts and configuration are restored from `~/.cc-wx`.

## Sending local files

Codex can request local-file delivery in its final response:

````text
```cc-wx-actions
{
  "send": [
    { "type": "image", "path": "/absolute/path/chart.png" },
    { "type": "video", "path": "/absolute/path/demo.mp4" },
    { "type": "file", "path": "/absolute/path/report.pdf" }
  ]
}
```
````

Only absolute local paths are accepted. Remote URLs are not uploaded.

## Local data and security

Service state and the default Codex workspace are stored under:

```text
~/.cc-wx/
  accounts/                 WeChat account credentials
  retained-accounts.json    Recovery index for removed accounts
  runtime/<account-id>/     Authorization and session state
  inbound/<account-id>/     Inbound attachments
  config.json               Codex and workspace configuration
  logs/
```

Do not commit or share this directory. Non-local Host and Origin values are rejected, mutating APIs require a page token, credentials never reach the browser, and `/work` selects only from the workspace allowlist.

The service always binds to `127.0.0.1`. Enable `danger-full-access` only when full-machine Codex access is acceptable; it does not disable approvals.
