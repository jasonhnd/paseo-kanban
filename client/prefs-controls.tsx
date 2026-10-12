import { useRef, useState } from "react";
import { View } from "react-native";
import { t, type MessageKey } from "../shared/i18n";
import { type FontStep, type PanelPrefs } from "../shared/panel-prefs";
import { Banner, Segmented, type Styles } from "./ui";

const FONT_OPTIONS: ReadonlyArray<{ value: FontStep; key: MessageKey }> = [
  { value: "sm", key: "prefsControls.font.sm" },
  { value: "md", key: "prefsControls.font.md" },
  { value: "lg", key: "prefsControls.font.lg" },
];
/** Options with their labels in the current language. */
function labelled<T>(options: ReadonlyArray<{ value: T; key: MessageKey }>): Array<{ value: T; label: string }> {
  return options.map((option) => ({ value: option.value, label: t(option.key) }));
}

export interface PrefsSaveResult extends PanelPrefs {
  notice: string | null;
}

/** Font choices. A broken file comes back as defaults plus one notice sentence. */
export function PanelPrefsControls({
  s,
  prefs,
  save,
  onOptimistic,
  onSettled,
  onRevert,
}: {
  s: Styles;
  prefs: PanelPrefs;
  save: (next: PanelPrefs) => Promise<PrefsSaveResult>;
  onOptimistic: (next: PanelPrefs) => void;
  onSettled: (saved: PanelPrefs) => void;
  onRevert: () => void;
}) {
  const [notice, setNotice] = useState<string | null>(null);
  const rev = useRef(0);

  function choose(next: PanelPrefs) {
    const id = ++rev.current;
    onOptimistic(next);
    save(next)
      .then((saved) => {
        if (rev.current !== id) return;
        onSettled({ fontStep: saved.fontStep });
        setNotice(saved.notice);
      })
      .catch((err: unknown) => {
        if (rev.current !== id) return;
        onRevert();
        setNotice(err instanceof Error ? err.message : String(err));
      });
  }

  return (
    <View style={{ gap: 8, maxWidth: "100%" }}>
      {notice ? <Banner s={s} tone="warning" text={notice} /> : null}
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, maxWidth: "100%" }}>
        <Segmented s={s} label={t("prefsControls.font.label")} value={prefs.fontStep} options={labelled(FONT_OPTIONS)} onChange={(fontStep) => choose({ ...prefs, fontStep })} />
      </View>
    </View>
  );
}
