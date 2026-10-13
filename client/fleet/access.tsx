import { useRpc } from "../rpc";
import { useQueryClient } from "@tanstack/react-query";
import { useQuery } from "../query";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { accessRpc, type AccessRoleView, type AccessServiceView, type AccessView } from "../../shared/fleet/access";
import { accessCounts, accessRefetchMs, accessTone, accountLine, roleFoldSummary, roleServices, roleUsers, serviceFoldSummary } from "../../shared/fleet/access-view";
import { clipError } from "../../shared/fleet/clip-error";
import { t } from "../../shared/fleet/i18n";
import { DoctorPanel } from "./doctor";
import { Badge, Empty, Fold, pressed, ResponsiveGrid, type Styles, timeAgo } from "./ui";

function useAccessPage() {
  const rpc = useRpc(accessRpc);
  const client = useQueryClient();
  const query = useQuery({
    queryKey: ["afc", "access"],
    queryFn: () => rpc({ refresh: false }),
    refetchInterval: (current) => accessRefetchMs(current.state.data),
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const checking = busy || Boolean(query.data?.checking);
  const recheck = () => {
    if (checking) return;
    setBusy(true);
    setError(null);
    rpc({ refresh: true })
      .then((view) => client.setQueryData(["afc", "access"], view))
      .catch((err: unknown) => setError(clipError(err, 160)))
      .finally(() => setBusy(false));
  };
  return { query, checking, error, recheck };
}

export function Access({ s }: { s: Styles }) {
  const page = useAccessPage();
  const data = page.query.data;
  return (
    <View style={{ gap: 28 }}>
      <DoctorPanel s={s} />
      <AccessToolbar s={s} data={data} checking={page.checking} onRecheck={page.recheck} />
      {page.query.isError ? <Text style={s.red}>{t("access.page.readFailed", { error: clipError(page.query.error, 160) })}</Text> : null}
      {page.error ? <Text style={s.red}>{t("access.page.checkFailed", { error: page.error })}</Text> : null}
      {data?.warning ? <Text style={s.yellow}>{data.warning}</Text> : null}
      {!data ? <Empty s={s} text={t("access.page.loading")} /> : null}
      <AccessFolds s={s} data={data} />
    </View>
  );
}

function AccessToolbar({ s, data, checking, onRecheck }: { s: Styles; data: AccessView | undefined; checking: boolean; onRecheck: () => void }) {
  return (
    <View style={s.between}>
      <Text style={[s.muted, { fontVariant: ["tabular-nums"], flexShrink: 1 }]}>{data?.checkedAt ? t("access.page.lastChecked", { ago: timeAgo(data.checkedAt) }) : t("access.page.neverChecked")}</Text>
      <Pressable accessibilityRole="button" accessibilityLabel={t("access.page.recheck")} accessibilityState={{ disabled: checking }} style={pressed([s.ghost, { flexShrink: 0, opacity: checking ? 0.72 : 1 }])} onPress={onRecheck}>
        <Text style={s.ghostText}>{checking ? t("access.page.checking") : t("access.page.recheck")}</Text>
      </Pressable>
    </View>
  );
}

function AccessFolds({ s, data }: { s: Styles; data: AccessView | undefined }) {
  if (!data) return null;
  const counts = accessCounts(data.services);
  return (
    <ResponsiveGrid s={s} maxColumns={2} cards>
      <ServiceFold s={s} data={data} summary={serviceFoldSummary(data.services.length, counts)} />
      <RoleFold s={s} roles={data.roles} />
    </ResponsiveGrid>
  );
}

function ServiceFold({ s, data, summary }: { s: Styles; data: AccessView; summary: string }) {
  return (
    <Fold s={s} title={t("access.page.byService")} summary={summary}>
      {data.services.length === 0 ? <Empty s={s} text={t("access.page.noServices")} /> : null}
      {data.services.map((row) => <ServiceRow key={row.id} s={s} row={row} />)}
    </Fold>
  );
}

function ServiceRow({ s, row }: { s: Styles; row: AccessServiceView }) {
  return (
    <View style={s.item}>
      <View style={s.between}>
        <View style={[s.row, { flexShrink: 1 }]}>
          <Text style={[s.text, { fontWeight: "600" }]}>{row.name}</Text>
          {row.noDispatch ? <Badge s={s} label={t("access.page.noDispatch")} tone="neutral" /> : null}
        </View>
        <Badge s={s} label={row.stateLabel} tone={accessTone(row.state)} />
      </View>
      <Text style={s.muted}>{t("access.page.login", { login: row.login })}</Text>
      <Text style={s.muted}>{accountLine(row.accountLive, row.account)}</Text>
      <ServicePermission s={s} row={row} />
      {row.constraint ? <Text style={s.muted}>{t("access.page.constraint", { constraint: row.constraint })}</Text> : null}
      <Text style={s.muted}>{t("access.page.users", { users: roleUsers(row.roles) })}</Text>
      {row.detail ? <Text style={s.muted}>{row.detail}</Text> : null}
    </View>
  );
}

function ServicePermission({ s, row }: { s: Styles; row: AccessServiceView }) {
  return (
    <Text style={s.muted}>
      {t("access.page.permission", { permission: row.permission })}
      {row.scopeCount !== null ? <Text style={{ fontVariant: ["tabular-nums"] }}>{t("access.page.scopes", { count: row.scopeCount })}</Text> : null}
    </Text>
  );
}

function RoleFold({ s, roles }: { s: Styles; roles: AccessRoleView[] }) {
  return (
    <Fold s={s} title={t("access.page.byRole")} summary={roleFoldSummary(roles.length)}>
      {roles.length === 0 ? <Empty s={s} text={t("access.page.noProfiles")} /> : null}
      {roles.map((row) => <RoleRow key={row.name} s={s} row={row} />)}
    </Fold>
  );
}

function RoleRow({ s, row }: { s: Styles; row: AccessRoleView }) {
  return (
    <View style={s.item}>
      <Text style={[s.text, { fontWeight: "600" }]}>{row.name}</Text>
      <Text style={s.muted}>{t("access.page.role", { role: row.roleLabel })}</Text>
      <Text style={s.muted}>{row.where}</Text>
      <Text style={s.muted}>{t("access.page.mode", { mode: row.mode })}</Text>
      <Text style={s.muted}>{t("access.page.services", { services: roleServices(row.services) })}</Text>
      <Text style={s.muted}>{t("access.page.limit", { limit: row.limit })}</Text>
    </View>
  );
}
