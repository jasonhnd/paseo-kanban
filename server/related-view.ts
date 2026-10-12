import { roleLabel, statusLabel } from "../shared/labels";
import type { TaskDetail } from "./task-detail";
import { t, type MessageKey } from "../shared/i18n";

export interface RelatedComment {
  at: string;
  author: string;
  body: string;
}

export interface RelatedVerdict {
  at: string;
  verdict: string;
  reason: string;
  findings: string;
}

/** Whitelist view of a card another card may read. No events, runs or agent fields. */
export interface RelatedView {
  related: true;
  /** Reminder that everything below was written by other cards, not addressed to the reader. */
  notice: string;
  id: number;
  code: string;
  title: string;
  project: string;
  role: string;
  status: string;
  tier: string | null;
  brief: string;
  handoff: unknown;
  comments: RelatedComment[];
  reviews: RelatedVerdict[];
  pr: { url: string | null; repo: string | null; awaiting: boolean } | null;
  parents: string[];
  children: string[];
  /** Project grants expose only whitelisted event data. */
  events?: Array<{ at: string; kind: string; fromStatus: string | null; toStatus: string | null; actor: string; data: Record<string, string> }>;
  readScope?: "project" | null;
}

export function relatedNotice(): string {
  return t("relatedView.notice");
}

const AUTHOR_LABEL_KEYS: Record<string, MessageKey> = { kanban: "relatedView.author.board", scheduler: "relatedView.author.board", user: "relatedView.author.user" };
const REVIEW_KINDS = new Set(["approve", "request_changes"]);

/** Comment author as a role label. Anything that is not a known role or system name reads as the board. */
function authorLabel(author: string): string {
  const key = Object.hasOwn(AUTHOR_LABEL_KEYS, author) ? AUTHOR_LABEL_KEYS[author] : undefined;
  if (key) return t(key);
  const role = roleLabel(author);
  return role === author ? t("relatedView.author.board") : role;
}

function parseHandoff(raw: string | null): unknown {
  if (raw == null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function verdicts(events: TaskDetail["events"]): RelatedVerdict[] {
  return events
    .filter((event) => REVIEW_KINDS.has(event.kind))
    .map((event) => {
      let data: Record<string, unknown> = {};
      try {
        data = JSON.parse(event.data) as Record<string, unknown>;
      } catch {
        data = {};
      }
      return {
        at: event.at,
        verdict: event.kind,
        reason: text(data.reason) || text(data.summary),
        findings: text(data.findings),
      };
    });
}

export function relatedView(detail: TaskDetail): RelatedView {
  const { task } = detail;
  return {
    related: true,
    notice: relatedNotice(),
    id: task.id,
    code: task.code,
    title: task.title,
    project: task.project,
    role: task.role,
    status: task.status,
    tier: task.tier ?? null,
    brief: task.brief,
    handoff: parseHandoff(task.handoff),
    comments: detail.comments.map((c) => ({ at: c.createdAt, author: authorLabel(c.author), body: c.body })),
    reviews: verdicts(detail.events),
    pr: detail.pr ? { url: detail.pr.url, repo: detail.pr.repo, awaiting: detail.pr.awaiting } : null,
    parents: detail.parents.map((p) => p.code),
    children: detail.children.map((c) => c.code),
  };
}

/** Never return raw audit payloads: they can contain tokens, environment data and agent identities. */
export function projectReadView(detail: TaskDetail): RelatedView {
  return {
    ...relatedView(detail),
    readScope: detail.task.readScope,
    events: detail.events.map(event => {
      const data: Record<string, string> = {};
      try {
        const raw: unknown = JSON.parse(event.data);
        if (raw && typeof raw === "object" && !Array.isArray(raw)) {
          for (const key of ["summary", "reason", "findings", "scope", "project"]) {
            const value = (raw as Record<string, unknown>)[key];
            if (typeof value === "string") data[key] = value;
          }
        }
      } catch { /* Malformed legacy event: the timestamp and kind are still readable. */ }
      return { at: event.at, kind: event.kind, fromStatus: event.fromStatus, toStatus: event.toStatus,
        actor: authorLabel(event.actor ?? ""), data };
    }),
  };
}

function indented(value: unknown): string {
  return JSON.stringify(value, null, 2).replace(/^/gm, "  ");
}

/** Readable text for a related-card view: every field, bodies in full. */
export function formatRelated(view: RelatedView): string {
  const none = t("relatedView.none");
  const listSep = t("common.listSep");
  const pr = view.pr
    ? `${view.pr.url ?? t("relatedView.pr.unbound")}${view.pr.repo ? t("common.paren", { text: view.pr.repo }) : ""}${view.pr.awaiting ? t("relatedView.pr.awaiting") : ""}`
    : none;
  const lines = [
    t("relatedView.header", { notice: relatedNotice() }),
    `${view.code} ${view.title}`,
    t("relatedView.field.project", { value: view.project }),
    t("relatedView.field.role", { value: roleLabel(view.role) }),
    t("relatedView.field.status", { value: statusLabel(view.status) }),
    t("relatedView.field.tier", { value: view.tier ?? t("relatedView.tier.unset") }),
    t("relatedView.field.brief", { value: view.brief }),
    t("relatedView.field.handoff", { value: view.handoff == null ? none : `\n${indented(view.handoff)}` }),
    t("relatedView.field.comments", { value: view.comments.length ? "" : none }),
    ...view.comments.map((c) => t("relatedView.comment", { at: c.at, author: c.author, body: c.body })),
    t("relatedView.field.reviews", { value: view.reviews.length ? "" : none }),
    ...view.reviews.map((r) => t("relatedView.review", { at: r.at, verdict: r.verdict, reason: r.reason, findings: r.findings ? `\n${r.findings}` : "" })),
    ...(view.readScope !== undefined ? [t("readGrants.field.scope", { value: view.readScope ?? none })] : []),
    ...(view.events ? [t("readGrants.field.events"), ...view.events.map(e => t("readGrants.event", { at: e.at, kind: e.kind, actor: e.actor, data: JSON.stringify(e.data) }))] : []),
    t("relatedView.field.pr", { value: pr }),
    t("relatedView.field.parents", { value: view.parents.join(listSep) || none }),
    t("relatedView.field.children", { value: view.children.join(listSep) || none }),
    t("relatedView.footer", { end: t("relatedView.end") }),
  ];
  return lines.join("\n");
}

export function isRelatedView(data: unknown): data is RelatedView {
  return Boolean(data) && typeof data === "object" && (data as { related?: unknown }).related === true;
}
