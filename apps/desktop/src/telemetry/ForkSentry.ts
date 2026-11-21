import * as Sentry from "@sentry/electron/main";
import { FORK_SENTRY_DSN, FORK_SENTRY_ENV, forkSentryEnabled } from "@t3tools/shared/forkSentry";
import * as Electron from "electron";

/** T3 fork: main-process errors and native crashes in fork builds. Runs before the app starts. */
export function initForkSentry(): void {
  if (!forkSentryEnabled(process.env[FORK_SENTRY_ENV], Electron.app.getVersion())) return;
  Sentry.init({
    dsn: FORK_SENTRY_DSN.desktop,
    release: `t3-fork@${Electron.app.getVersion()}`,
    environment: "production",
  });
}
