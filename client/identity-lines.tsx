import { Pressable, Text, View } from "react-native";
import { t } from "../shared/i18n";
import { identityBits } from "../shared/labels";
import { blockedFor, formatWhen, type Styles } from "./ui";

export function IdentityLines({
  s,
  roleLabel: role,
  currentText,
  executorText,
  agentId,
  executorAgentId,
  startedAt,
  onOpen,
}: {
  s: Styles;
  roleLabel: string;
  currentText: string | null;
  executorText: string | null;
  agentId: string | null;
  executorAgentId: string | null;
  startedAt: string | null;
  onOpen: (agentId: string) => void;
}) {
  const bits = identityBits({
    roleLabel: role,
    currentText,
    currentPress: Boolean(agentId),
    executorText,
    executorPress: Boolean(executorAgentId),
    startedLabel: startedAt ? t("identityLines.started", { when: formatWhen(startedAt), elapsed: blockedFor(startedAt) }) : null,
  });
  return (
    <View style={s.identity}>
      {bits.map((bit) => {
        const linked = bit.press && (bit.key === "current" ? agentId : executorAgentId);
        const text = (
          <Text testID={`identity-${bit.key}`} style={linked ? s.identityLink : s.identityText}>
            {bit.label} {bit.value}
          </Text>
        );
        if (!linked) {
          return (
            <View key={bit.key} style={s.identityItem}>
              {text}
            </View>
          );
        }
        const openId = bit.key === "current" ? agentId : executorAgentId;
        return (
          <Pressable
            key={bit.key}
            style={s.identityItem}
            accessibilityRole="button"
            accessibilityLabel={bit.key === "current" ? t("identityLines.openCurrent") : t("identityLines.openExecutor")}
            onPress={() => {
              if (openId) onOpen(openId);
            }}
          >
            {text}
          </Pressable>
        );
      })}
    </View>
  );
}
