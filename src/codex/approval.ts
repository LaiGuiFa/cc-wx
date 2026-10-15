import crypto from "node:crypto";

export type ApprovalKind = "command" | "file-change" | "permissions";

export type ApprovalRequest = {
  id: string;
  kind: ApprovalKind;
  accountId?: string;
  senderId?: string;
  sessionId?: string;
  command?: string;
  cwd?: string;
  reason?: string;
  permissions?: unknown;
  threadId?: string;
  turnId?: string;
  createdAt: string;
};

export type ApprovalDecision = "accept" | "decline" | "cancel";

type PendingApproval = {
  request: ApprovalRequest;
  resolve: (decision: ApprovalDecision) => void;
  timer: NodeJS.Timeout;
};

export class ApprovalBroker {
  private readonly pending = new Map<string, PendingApproval>();

  constructor(
    private readonly onCreated?: (request: ApprovalRequest) => void | Promise<void>,
    private readonly timeoutMs = 120_000
  ) {}

  async request(
    input: Omit<ApprovalRequest, "id" | "createdAt">,
    onCreated?: (request: ApprovalRequest) => void | Promise<void>
  ): Promise<ApprovalDecision> {
    const request: ApprovalRequest = {
      ...input,
      id: crypto.randomBytes(5).toString("hex").toUpperCase(),
      createdAt: new Date().toISOString()
    };
    return new Promise<ApprovalDecision>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(request.id);
        resolve("cancel");
      }, this.timeoutMs);
      this.pending.set(request.id, { request, resolve, timer });
      void this.onCreated?.(request);
      void onCreated?.(request);
    });
  }

  list(): ApprovalRequest[] {
    return [...this.pending.values()].map(({ request }) => ({ ...request }));
  }

  resolve(
    id: string,
    decision: ApprovalDecision,
    predicate?: (request: ApprovalRequest) => boolean
  ): boolean {
    const pending = this.pending.get(id.trim().toUpperCase());
    if (!pending || (predicate && !predicate(pending.request))) return false;
    this.pending.delete(pending.request.id);
    clearTimeout(pending.timer);
    pending.resolve(decision);
    return true;
  }

  cancelAll(): void {
    this.cancelWhere(() => true);
  }

  cancelWhere(predicate: (request: ApprovalRequest) => boolean): void {
    for (const id of [...this.pending.keys()]) {
      this.resolve(id, "cancel", predicate);
    }
  }
}
