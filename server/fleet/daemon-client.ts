// Development-only input for the generated Node client bundle. Preparation builds
// this local module before the plugin compiler checks the server entries.
import { createPaseoClient as createSdkClient } from "@getpaseo/client";
import type { createPaseoClient as createBundledClient } from "./paseo-client.bundle.mjs";

// Type-check the handwritten production declaration against the pinned SDK.
export const createPaseoClient: typeof createBundledClient = createSdkClient;
