import { z } from "zod";
import { companyCardSchema } from "./quota-companies";

export const homeViewSchema = z.object({
  companies: z.array(companyCardSchema),
  days: z.array(z.object({
    label: z.string(),
    today: z.boolean(),
    claude: z.number(),
    cursor: z.number(),
    grok: z.number(),
  })),
  roleShares: z.array(z.object({
    name: z.string(),
    pct: z.number(),
    tokens: z.number(),
  })),
  roleCards: z.array(z.object({
    name: z.string(),
    who: z.string(),
    status: z.string(),
    tone: z.enum(["green", "yellow", "red"]),
    weekCount: z.number(),
    recent: z.array(z.object({ project: z.string(), title: z.string(), code: z.string() })),
    tokens: z.number().nullable(),
  })),
  /** Named Claude burn week. Omitted outside that week. */
  banner: z.string().nullable().optional(),
});

export type HomeView = z.infer<typeof homeViewSchema>;

export const EMPTY_HOME: HomeView = { companies: [], days: [], roleShares: [], roleCards: [] };
