import { mergeXUltraPlans } from "../../../shared/fleet/x-ultra";
/// <reference types="node" />
import { providerBanned } from "../../../shared/fleet/provider-policy";
import { readBannedProviders } from "./config";
// plans.json as the pool definitions: the plan list, the pool catalog and the company list built from it.
// Files only; no command or daemon call.
import { join } from "node:path";
import {
  type AdapterSwitches,
  type CompanyEntry,
  companyCatalog,
  type PlanSource,
  type PoolEntry,
  poolCatalog,
} from "../../../shared/fleet/quota-adapters";
import { readJson, STATE_DIR } from "../util";
import { adapterSwitches } from "./config";

export const PLANS_FILE = join(STATE_DIR, "plans.json");

/** Plans as written in plans.json; entries without a string id are dropped. */
export function plansOf(file: unknown): PlanSource[] {
  const plans = file && typeof file === "object" ? (file as { plans?: unknown }).plans : undefined;
  if (!Array.isArray(plans)) return [];
  return mergeXUltraPlans(plans.filter((plan): plan is PlanSource => Boolean(plan) && typeof plan === "object" && typeof (plan as { id?: unknown }).id === "string"));
}

export async function readPlanSources(path: string = PLANS_FILE): Promise<PlanSource[]> {
  return plansOf(await readJson<unknown>(path, null)).filter((plan) => !providerBanned(plan, readBannedProviders()));
}

/** Pool catalog of plans.json under the current switches. */
export async function readPoolCatalog(switches: AdapterSwitches = adapterSwitches()): Promise<PoolEntry[]> {
  return poolCatalog(await readPlanSources(), switches);
}

export async function readCompanyCatalog(switches: AdapterSwitches = adapterSwitches()): Promise<CompanyEntry[]> {
  return companyCatalog(await readPlanSources(), switches);
}
