// T3 fork's own Sentry projects. DSNs are public client keys: they allow sending, not reading.
export const FORK_SENTRY_DSN = {
  server:
    "https://2061c84651158a74ebae87cabe957245@o4505994951065600.ingest.us.sentry.io/4512471137976320",
  web: "https://688070812a28dc7aa0a219ed869ff608@o4505994951065600.ingest.us.sentry.io/4512471138041856",
  desktop:
    "https://42fe0935d5d71f7f255eb735b72be6d0@o4505994951065600.ingest.us.sentry.io/4512471138369536",
} as const;

export type ForkSentrySurface = keyof typeof FORK_SENTRY_DSN;

/**
 * RPCs a user starts on purpose. Browser and server both keep every trace that makes one, so
 * the two halves of the same trace reach Sentry together.
 */
export const FORK_TRACED_RPCS: ReadonlyArray<string> = [
  "orchestration.dispatchCommand",
  "forkCoordinator.open",
  "forkDream.start",
  "forkMemory.save",
  "forkMemory.forget",
];

/** `1` turns Sentry on and `0` off, whatever the build; the desktop sets it for its server. */
export const FORK_SENTRY_ENV = "T3_FORK_SENTRY";

/**
 * Only T3 fork's own builds report: the fork's sync stamps their version `X.Y.Z-fork.<date>.<n>`.
 * Other builds of this code, and dev servers, send nothing unless `setting` is `1`.
 */
export const forkSentryEnabled = (setting: string | undefined, version: string): boolean =>
  setting === "1" || (setting !== "0" && /-fork\.\d+\.\d+$/.test(version));

export interface SentryOtlpEndpoint {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
}

/** Sentry's OTLP ingest endpoint for a DSN. Sentry ingests traces and logs, not OTLP metrics. */
export const sentryOtlpEndpoint = (
  dsn: string,
  signal: "traces" | "logs",
): SentryOtlpEndpoint | undefined => {
  let parsed: URL;
  try {
    parsed = new URL(dsn);
  } catch {
    return undefined;
  }
  const publicKey = parsed.username;
  const projectId = parsed.pathname.replace(/^\/+/, "");
  if (publicKey === "" || !/^\d+$/.test(projectId)) return undefined;
  return {
    url: `${parsed.protocol}//${parsed.host}/api/${projectId}/integration/otlp/v1/${signal}`,
    headers: { "x-sentry-auth": `sentry sentry_key=${publicKey}` },
  };
};
