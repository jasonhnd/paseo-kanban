declare module "react-test-renderer" {
  import type { ReactElement } from "react";

  interface Renderer {
    toJSON(): { type: string; props: Record<string, unknown>; children: Array<string | null> | null } | string | null;
  }

  function create(element: ReactElement): Renderer;
  export default { create };
}
