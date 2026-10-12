/// <reference types="node" />
// Quota snapshot for other tools (Paseo Kanban's dispatcher reads it to pick a pool).
// Keys are the `pool` values used in Paseo agent profiles: the plan ids of plans.json (shared/quota-adapters.ts). The configured dispatch rules are applied here,
// so readers only need `dispatchable`, `deprioritize`, `prefer`, and optional `onlyRoles` (docs/KANBAN-CONTRACT.md §1).
//
// Split by progress line (pools-pace.ts), status (pools-status.ts, with window stops, unread reads, and the
// reviewer exception beside it), and alerts (pools-alerts.ts).

export {
  PACE_AHEAD,
  PACE_BEHIND,
  PACE_TARGET,
  judgePace,
  oneMonthBefore,
  paceOf,
  paceTarget,
  periodBounds,
  preferPool,
  softenPaceHold,
  tokyoLabel,
} from "./pools-pace";
export type { BurnPaceClock, Pace, PaceFlags, PaceState, PreferInput } from "./pools-pace";

export {
  cursorLogoutHoldReason,
  MANUAL_STOP,
  cursorDispatch,
  cursorLogoutBlocksDispatch,
  handCopyDispatch,
  supergrokDispatch,
  supergrokManualDispatch,
} from "./pools-windows";
export type { CursorDispatch, CursorWindow, SuperGrokDispatch, SuperGrokWindow } from "./pools-windows";

export {
  POOL_STALE_MINUTES,
  cursorReadAlarm,
  poolAlerts,
  poolSnapshotStale,
} from "./pools-alerts";
export type { PoolAlert } from "./pools-alerts";

export {
  CLAUDE_UNREAD_MAX_AGE_MS,
  claudeUnreadReset,
  claudeUnreadStop,
  codexUnreadStop,
  claudeReadingFromHistory,
  claudeReadingFromSnapshot,
  decideClaudeUnread,
  decidePoolUnread,
  newerClaudeReading,
} from "./pools-unread";
export type { ClaudeUnreadDecision, ClaudeUsedReading, UnreadPolicy } from "./pools-unread";

export {
  activeReviewerException,
  parseReviewerException,
  readPlansReviewerException,
  withReviewerException,
} from "./pools-reviewer";
export type { ReviewerException } from "./pools-reviewer";

export { codexCouponInHand, configuredStopPct } from "./pools-hard";

export {
  codexCouponPreferNote,
  POOL_STATUS,
  applyCursorLogoutHold,
  carriedPools,
  poolStatus,
  withoutCarriedReadings,
  writePoolStatus,
} from "./pools-status";
export type { CursorReadMeta, PoolStatus, PoolStatusOptions, SuperGrokReadMeta } from "./pools-types";
