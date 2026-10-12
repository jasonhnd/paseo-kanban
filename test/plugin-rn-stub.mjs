// Stand-in for the host-provided @getpaseo/plugin/client/react-native. The published SDK ships only
// types for it (the runtime module is `export {}`); Paseo supplies the real one inside the app.

/** Texts the panel copied, in order. */
export const copied = [];
let denyCopy = false;

/** Test hook: make the next copies reject, as a platform that denies the clipboard does. */
export function __denyCopy(value) {
  denyCopy = value;
}

export async function copyText(text) {
  if (denyCopy) throw new Error("clipboard denied");
  copied.push(text);
}
