interface ForkLiveUpdateQueue {
  readonly readHead: () => Promise<string>;
  readonly readInstalled: () => Promise<string | null>;
  readonly build: (
    head: string,
    installed: string | null,
    restartBase: string | null,
  ) => Promise<readonly string[] | null>;
  readonly onReady: (head: string, commits: readonly string[]) => void;
  readonly onFailure: (error: unknown) => Promise<void>;
  readonly signal: AbortSignal;
}

/** Coalesces ref changes into one build at a time and skips the installed or failed head. */
export function createForkLiveUpdateQueue(input: ForkLiveUpdateQueue) {
  let attempted: string | undefined;
  let restartBase: string | null | undefined;
  let pending = false;
  let active: Promise<void> | undefined;

  async function drain() {
    while (pending && !input.signal.aborted) {
      pending = false;
      try {
        const head = await input.readHead();
        if (head === attempted || input.signal.aborted) continue;
        attempted = head;
        const installed = await input.readInstalled();
        if (restartBase === undefined) restartBase = installed;
        if (head === installed) continue;
        const commits = await input.build(head, installed, restartBase);
        if (commits === null) attempted = undefined;
        else if (!input.signal.aborted) input.onReady(head, commits);
        pending = true;
      } catch (error) {
        if (!input.signal.aborted) await input.onFailure(error);
        // A Git event received during a failed build still gets processed.
      }
    }
  }

  return () => {
    pending = true;
    active ??= drain().finally(() => {
      active = undefined;
    });
    return active;
  };
}
