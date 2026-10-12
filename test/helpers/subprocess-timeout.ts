/**
 * Kill-switch for child processes that cold-start tsx (or a CLI that does).
 * Startup alone takes seconds on a busy machine, so this guards against a
 * genuine hang rather than measuring speed; speed gates live in the isolated
 * performance phase.
 */
export const SUBPROCESS_TIMEOUT_MS = 600_000;
