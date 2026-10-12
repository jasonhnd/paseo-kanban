import { useRpc } from "@getpaseo/plugin/client";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useDeferredValue } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import { t } from "../shared/i18n";
import { HISTORY_PAGE } from "../shared/labels";
import { historyRpc } from "../shared/rpc";
import { Button, Empty, formatWhen, type Styles } from "./ui";

/** Archived cards, folded by default, newest archive first, read one page at a time. */
export function HistoryPanel({
  s,
  project,
  total,
  open,
  onToggle,
  query,
  onQuery,
  onOpenCard,
}: {
  s: Styles;
  project: string;
  total: number;
  open: boolean;
  onToggle: () => void;
  query: string;
  onQuery: (text: string) => void;
  onOpenCard: (id: number) => void;
}) {
  const loadHistory = useRpc(historyRpc);
  const search = useDeferredValue(query.trim());
  const history = useInfiniteQuery({
    queryKey: ["kanban", "history", project, search],
    queryFn: ({ pageParam }) =>
      loadHistory({ project: project || undefined, query: search || undefined, offset: pageParam, limit: HISTORY_PAGE }),
    initialPageParam: 0,
    getNextPageParam: (last, pages) => {
      const loaded = pages.reduce((sum, page) => sum + page.items.length, 0);
      return last.items.length > 0 && loaded < last.total ? loaded : undefined;
    },
    enabled: open,
  });
  const items = history.data?.pages.flatMap((page) => page.items) ?? [];
  const found = history.data?.pages[0]?.total ?? 0;

  return (
    <View testID="archive-panel" style={s.card}>
      <Pressable accessibilityRole="button" accessibilityLabel={open ? t("history.collapse") : t("history.expand")} accessibilityState={{ expanded: open }} onPress={onToggle}>
        <Text style={s.h2}>
          {open ? "▾" : "▸"} Archive <Text style={s.count}>{total}</Text>
        </Text>
      </Pressable>
      {open ? (
        <View style={{ gap: 8, alignSelf: "stretch" }}>
          <TextInput
            accessibilityLabel={t("history.searchLabel")}
            placeholder={t("history.searchPlaceholder")}
            placeholderTextColor={s.p.hint}
            style={s.input}
            value={query}
            onChangeText={onQuery}
          />
          {search && history.data ? <Text style={s.muted}>{t("history.found", { count: found })}</Text> : null}
          {history.isError ? <Text style={s.bad}>{t("cardDrawer.load.failed", { error: String(history.error) })}</Text> : null}
          {history.isLoading ? <Text style={s.muted}>{t("history.loading")}</Text> : null}
          {history.data && items.length === 0 ? <Empty s={s} text={search ? t("history.noMatch") : t("history.none")} /> : null}
          {items.map((item) => (
            <Pressable key={item.id} accessibilityRole="button" accessibilityLabel={t("history.open", { code: item.code })} onPress={() => onOpenCard(item.id)} style={s.listRow}>
              <Text style={s.text}>
                <Text style={item.outcome === "done" ? s.text : s.warn}>{item.outcome === "done" ? "✓" : t("history.dropped")}</Text>
                {` ${item.code} ${item.title}`}
              </Text>
              <Text style={s.muted}>{`${item.project} · ${formatWhen(item.archivedAt)}${item.auto ? ` · ${t("history.auto")}` : ""}`}</Text>
            </Pressable>
          ))}
          {history.hasNextPage ? (
            <Button
              s={s}
              label={history.isFetchingNextPage ? t("board.loading") : t("history.more", { count: HISTORY_PAGE })}
              tone="secondary"
              accessibilityLabel={t("history.more", { count: HISTORY_PAGE })}
              onPress={() => void history.fetchNextPage()}
            />
          ) : null}
        </View>
      ) : null}
    </View>
  );
}
