import { Component, useEffect, useSyncExternalStore, type ReactNode } from "react";
import { useRpc } from "@getpaseo/plugin/client";
import { getLanguage, isLanguageSetting, resolveLanguage, setLanguage, type Language } from "../shared/i18n";
import { configReadRpc } from "../shared/rpc";
import { adoptPanelLanguage } from "./panel-title";
import { subscribeLanguage } from "../shared/common/i18n";

/**
 * The board's language. Starts with whatever is in force (the runtime locale guessed when the plugin
 * loaded), then reads the setting once over `kanban.config.read`; "system" uses the runtime's Intl
 * locale. Call it in the root component: changing state there re-renders every t() below it.
 */
export function useI18n(): Language {
  const readConfig = useRpc(configReadRpc);
  const language = useSyncExternalStore(subscribeLanguage, getLanguage, getLanguage);
  useEffect(() => {
    let live = true;
    Promise.resolve()
      .then(() => readConfig({}))
      .then((config) => {
        if (!live || !isLanguageSetting(config?.language)) return;
        const next = resolveLanguage(config.language);
        setLanguage(next);
        adoptPanelLanguage(next);
      })
      .catch(() => undefined); // an older server without the RPC: keep the current language
    return () => { live = false; };
    // Read once per mount; the setting changes only through the settings page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return language;
}

function LanguageReader(): null {
  useI18n();
  return null;
}

/** Renders nothing if the surface it sits in has no plugin RPC (useRpc throws there). */
class Quiet extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }
  render(): ReactNode {
    return this.state.failed ? null : this.props.children;
  }
}

/**
 * Reads the saved language from a mounted surface that has plugin RPC.
 * The standard sidebar row has no component slot, so it cannot host this probe.
 * The board, workspace and settings surfaces call useI18n themselves. The client entry does not mount this.
 */
export function LanguageProbe(): ReactNode {
  return (
    <Quiet>
      <LanguageReader />
    </Quiet>
  );
}
