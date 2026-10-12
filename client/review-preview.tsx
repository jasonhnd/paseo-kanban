import { Text, View } from "react-native";
import { t } from "../shared/i18n";
import type { Styles } from "./ui";

/** Read-only proposals; task routing remains governed by the existing cross-family checks. */
export function ReviewPreview({ s }: { s: Styles }) {
  return <View testID="review-preview" style={{ gap: 8 }}>
    <Text style={s.h2}>{t("reviewPreview.title")}</Text>
    <Text style={s.muted}>{t("reviewPreview.setup")}</Text>
    <Text style={s.muted}>{t("reviewPreview.independent")}</Text>
    <Text style={s.muted}>{t("reviewPreview.optionA")}</Text>
    <Text style={s.muted}>{t("reviewPreview.optionB")}</Text>
    <Text style={s.muted}>{t("reviewPreview.l4")}</Text>
    <Text style={s.muted}>{t("reviewPreview.current")}</Text>
  </View>;
}
