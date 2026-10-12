import React from "react";

export function View(props) {
  return React.createElement("View", props);
}

export function Text(props) {
  return React.createElement("Text", props);
}

export function Pressable(props) {
  return React.createElement("Pressable", props);
}

export function ScrollView(props) {
  return React.createElement("ScrollView", props);
}

export function TextInput(props) {
  return React.createElement("TextInput", props);
}

export const Platform = {
  OS: "web",
  select(spec) {
    return spec.web ?? spec.default;
  },
};

export const StyleSheet = {
  hairlineWidth: 1,
  create(styles) {
    return styles;
  },
};

export const Linking = {
  async openURL() {
    return undefined;
  },
};

export function useWindowDimensions() {
  return { width: 375, height: 812, scale: 2, fontScale: 1 };
}

const appStateListeners = new Set();
export const AppState = {
  addEventListener(type, listener) {
    appStateListeners.add(listener);
    return { remove: () => appStateListeners.delete(listener) };
  },
  /** Test hook: report a foreground change to every listener. */
  __emit(state) {
    for (const listener of appStateListeners) listener(state);
  },
};
