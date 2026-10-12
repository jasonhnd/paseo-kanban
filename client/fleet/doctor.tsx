import { useRpc } from "@getpaseo/plugin/client";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { clipError } from "../../shared/fleet/clip-error";
import { doctorRpc, type DoctorItem, type DoctorReport, statusLabel } from "../../shared/fleet/doctor";
import { t } from "../../shared/fleet/i18n";
import { Badge, Empty, Fold, pressed, ResponsiveGrid, type Styles, timeAgo } from "./ui";

/** Health check button at the top of the Access tab: runs the same read-only checks as `bin/afc-doctor` and shows the red / yellow / green cards. */
export function DoctorPanel({ s }: { s: Styles }) {
  const rpc = useRpc(doctorRpc);
  const [report, setReport] = useState<DoctorReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    rpc({})
      .then(setReport)
      .catch((err: unknown) => setError(clipError(err, 160)))
      .finally(() => setBusy(false));
  };
  return (
    <View style={{ gap: 12 }}>
      <View style={s.between}>
        <Text style={[s.muted, { flexShrink: 1 }]}>{report ? t("doctor.panel.ranAt", { ago: timeAgo(report.at), ...report.counts }) : t("doctor.panel.intro")}</Text>
        <Pressable accessibilityRole="button" accessibilityLabel={t("doctor.panel.button")} accessibilityState={{ disabled: busy }} style={pressed([s.ghost, { flexShrink: 0, opacity: busy ? 0.72 : 1 }])} onPress={run}>
          <Text style={s.ghostText}>{busy ? t("doctor.panel.running") : t("doctor.panel.button")}</Text>
        </Pressable>
      </View>
      {error ? <Text style={s.red}>{t("doctor.panel.failed", { error })}</Text> : null}
      {report ? (
        <ResponsiveGrid s={s} maxColumns={2} cards>
          {report.items.map((item) => <DoctorCard key={item.id} s={s} item={item} />)}
        </ResponsiveGrid>
      ) : null}
    </View>
  );
}

function DoctorCard({ s, item }: { s: Styles; item: DoctorItem }) {
  const listed = item.findings.filter((finding) => item.status === "green" || finding.status !== "green");
  return (
    <View style={{ gap: 6 }} accessibilityLabel={t("doctor.panel.cardLabel", { title: item.title, status: statusLabel(item.status) })}>
      <View style={s.between}>
        <Text style={[s.text, { fontWeight: "600", flexShrink: 1 }]}>{item.title}</Text>
        <Badge s={s} label={statusLabel(item.status)} tone={item.status} />
      </View>
      <Text style={s.muted}>{item.summary}</Text>
      {item.status !== "green" ? listed.map((finding) => <Text key={finding.key} style={finding.status === "red" ? s.red : s.yellow}>{finding.text}</Text>) : null}
      <Fold s={s} title={t("doctor.panel.details")} summary={t("doctor.panel.detailCount", { count: item.findings.length })}>
        {item.findings.length === 0 ? <Empty s={s} text={t("doctor.panel.noDetails")} /> : null}
        {item.findings.map((finding) => <Text key={finding.key} style={s.muted}>{finding.text}</Text>)}
        {item.evidence.map((line) => <Text key={line} style={s.muted}>{t("doctor.panel.evidence", { line })}</Text>)}
      </Fold>
    </View>
  );
}
