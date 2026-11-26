/** One decision a worker agent has to put to the user, with what a good pick looks like. */
export interface Case {
  readonly id: string;
  /** Saved memory the turn carries, as [title, body]. */
  readonly memories: ReadonlyArray<readonly [string, string]>;
  readonly request: string;
  readonly decision: string;
  /** A word the recommended option's label should contain. Absent when either pick is sound. */
  readonly expect?: string;
  /** A word from the matching memory that the reason should name, if one applies. */
  readonly memoryWord?: string;
}

export const cases: ReadonlyArray<Case> = [
  {
    id: "dependency-rule",
    memories: [
      [
        "Ask before adding dependencies",
        "Never add a new dependency without asking first. Applies to every project.",
      ],
    ],
    request: "Add a spending chart to the home screen of tally.",
    decision: "Use a chart library, or draw the chart with plain SVG.",
    expect: "svg",
    memoryWord: "dependenc",
  },
  {
    id: "ledger-decision",
    memories: [
      [
        "Acknowledge webhooks after the ledger write",
        "Write the ledger entry first, then acknowledge the webhook, so a retry never charges twice.",
      ],
    ],
    request: "billing is double-charging on webhook retries again. Fix it.",
    decision:
      "Acknowledge the webhook first and write the ledger after, or write the ledger first and acknowledge after.",
    expect: "ledger",
    memoryWord: "ledger",
  },
  {
    id: "no-memory-reboot",
    memories: [],
    request:
      "Backups didn't run last night. The NAS needs a reboot to fix the backup job, and someone is streaming a film from it right now.",
    decision: "Reboot the NAS now, or wait until tomorrow morning.",
    expect: "wait",
  },
  {
    id: "no-memory-rename",
    memories: [],
    request:
      "Rename parse() to parseDocument() in quill. It's a public function; quill follows semver and 3.0 is the next major release.",
    decision: "Ship the rename in 3.0, or keep parse() as a deprecated alias through 2.x.",
  },
];
