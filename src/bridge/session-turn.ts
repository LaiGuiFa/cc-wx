export type SessionTurnTask<T> = () => Promise<T>;

export class SessionTurnCoordinator {
  private readonly tails = new Map<string, Promise<void>>();

  isActive(sessionId: string): boolean {
    return this.tails.has(sessionId);
  }

  async run<T>(sessionId: string, task: SessionTurnTask<T>): Promise<T> {
    const previous = this.tails.get(sessionId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.tails.set(sessionId, current);

    await previous;
    try {
      return await task();
    } finally {
      release();
      if (this.tails.get(sessionId) === current) {
        this.tails.delete(sessionId);
      }
    }
  }

  async waitForSessions(sessionIds: string[]): Promise<void> {
    const waitForCurrent = async (sessionId: string): Promise<void> => {
      while (true) {
        const tail = this.tails.get(sessionId);
        if (!tail) return;
        await tail;
        if (this.tails.get(sessionId) === tail) return;
      }
    };
    await Promise.all(sessionIds.map(waitForCurrent));
  }
}
