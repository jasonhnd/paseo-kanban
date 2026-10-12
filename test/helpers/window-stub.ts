// React Query turns polling off when `window` is missing (it assumes a server). The real panel runs in a
// browser or app, so tests that check timer refreshes import this before React Query to look like one.
(globalThis as { window?: unknown }).window ??= globalThis;
export {};
