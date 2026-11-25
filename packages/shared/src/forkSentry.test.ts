import { describe, expect, it } from "@effect/vitest";
import { FORK_SENTRY_DSN, forkSentryEnabled, sentryOtlpEndpoint } from "./forkSentry.ts";

describe("sentryOtlpEndpoint", () => {
  it("derives the project's OTLP endpoint and auth header from a DSN", () => {
    expect(sentryOtlpEndpoint("https://abc123@o1.ingest.us.sentry.io/42", "traces")).toEqual({
      url: "https://o1.ingest.us.sentry.io/api/42/integration/otlp/v1/traces",
      headers: { "x-sentry-auth": "sentry sentry_key=abc123" },
    });
    expect(sentryOtlpEndpoint(FORK_SENTRY_DSN.server, "logs")?.url).toMatch(
      /\/api\/4512471137976320\/integration\/otlp\/v1\/logs$/,
    );
  });

  it.each(["not a url", "https://o1.ingest.sentry.io/42", "https://key@o1.ingest.sentry.io/abc"])(
    "rejects %s",
    (dsn) => expect(sentryOtlpEndpoint(dsn, "traces")).toBeUndefined(),
  );
});

describe("forkSentryEnabled", () => {
  it.each([
    [undefined, "0.1.12-fork.20261121.5051", true],
    [undefined, "0.1.12-nightly.20261121.5051", false],
    [undefined, "0.1.12", false],
    ["0", "0.1.12-fork.20261121.5051", false],
    ["1", "0.1.12", true],
  ] as const)("setting %s on %s is %s", (setting, version, enabled) =>
    expect(forkSentryEnabled(setting, version)).toBe(enabled),
  );
});
