import { useAtomValue } from "@effect/atom-react";
import { isProviderAvailable, type EnvironmentId } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { T, useGT } from "gt-react";
import { useState } from "react";
import { useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import { serverEnvironment } from "../../state/server";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { SettingsRow } from "./settingsLayout";

export function ForkCoordinatorAccounts({ environmentId }: { environmentId: EnvironmentId }) {
  const gt = useGT();
  const settings = useAtomValue(serverEnvironment.settingsValueAtom(environmentId));
  const providers = useAtomValue(serverEnvironment.providersValueAtom(environmentId));
  const canEdit = useAtomValue(serverEnvironment.updateSettings.permissionAtom(environmentId));
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  const [editing, setEditing] = useState(false);
  const policy = settings?.forkCoordinatorRouting;
  const accounts = (providers ?? []).filter(
    (provider) =>
      (provider.driver === "codex" || provider.driver === "claude") &&
      provider.enabled &&
      provider.installed &&
      isProviderAvailable(provider) &&
      provider.status !== "error" &&
      provider.status !== "disabled" &&
      provider.auth.status === "authenticated" &&
      provider.auth.type !== "apiKey" &&
      provider.auth.type !== "bedrock" &&
      provider.auth.endpoint === undefined,
  );
  const accountName = (account: (typeof accounts)[number]) =>
    account.displayName ?? (account.driver === "codex" ? "Codex" : "Claude");
  const allowed = accounts.filter(
    (account) =>
      !policy?.excludedDrivers.includes(account.driver) &&
      !policy?.excludedInstances.includes(account.instanceId),
  );
  return (
    <SettingsRow
      title={gt("Coordinator accounts")}
      description={
        policy === undefined
          ? gt("Subscription routing is off.")
          : allowed.length === 0
            ? gt("No allowed subscriptions.")
            : new Intl.ListFormat().format(allowed.map(accountName))
      }
      control={
        <div className="flex items-center gap-2">
          <Link to="/usage" hash="limits" className="text-sm underline">
            <T>Usage limits</T>
          </Link>
          <Button
            variant="outline"
            size="sm"
            disabled={!canEdit || policy === undefined || accounts.length === 0}
            aria-expanded={editing}
            onClick={() => setEditing((open) => !open)}
          >
            {editing ? <T>Close</T> : <T>Edit</T>}
          </Button>
        </div>
      }
    >
      {editing ? (
        <div className="space-y-2">
          {policy?.excludedDrivers.some((driver) => driver === "claude") ? (
            <p className="text-sm text-muted-foreground">
              <T>All Claude accounts are excluded, including accounts added later.</T>
            </p>
          ) : null}
          {accounts.map((account) => {
            const excludedByProvider = policy?.excludedDrivers.includes(account.driver) ?? false;
            const checked =
              !excludedByProvider && !policy?.excludedInstances.includes(account.instanceId);
            return (
              <label key={account.instanceId} className="flex items-center justify-between gap-3">
                <span className="text-sm">{accountName(account)}</span>
                <Switch
                  checked={checked}
                  disabled={!canEdit || excludedByProvider}
                  onCheckedChange={(enabled) =>
                    updateSettings({
                      forkCoordinatorAccountAccess: {
                        instanceId: account.instanceId,
                        allowed: enabled,
                      },
                    })
                  }
                />
              </label>
            );
          })}
        </div>
      ) : null}
    </SettingsRow>
  );
}
