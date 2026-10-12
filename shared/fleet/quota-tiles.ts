import type { CompanyCard } from "./quota-companies";

/** Company cards on the quota pages: four across from tablet up, 2x2 tiles on a phone. */
export const COMPANY_COLUMNS = 4;
export const COMPANY_MIN_CELL_WIDTH = 200;
export const COMPANY_TILE_COLUMNS = 2;
export const COMPANY_TILE_MIN_CELL_WIDTH = 150;

/** The first window's dispatch state, the same window the tile's bar and remaining % describe. */
export function companyDispatchSummary(company: CompanyCard): string {
  return company.windows.map((row) => row.dispatchText).find((text) => text.length > 0) ?? "—";
}
