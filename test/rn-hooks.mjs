const stub = new URL("./rn-stub.mjs", import.meta.url).href;
const hostUiStub = new URL("./plugin-rn-stub.mjs", import.meta.url).href;
const sidebarKitStub = new URL("./plugin-ui-stub.mjs", import.meta.url).href;

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "react-native") return { url: stub, shortCircuit: true };
  if (specifier === "@getpaseo/plugin/client/react-native") return { url: hostUiStub, shortCircuit: true };
  if (specifier === "@getpaseo/plugin/client/ui") return { url: sidebarKitStub, shortCircuit: true };
  return nextResolve(specifier, context);
}
