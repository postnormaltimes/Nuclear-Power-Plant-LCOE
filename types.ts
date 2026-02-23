
export interface LcoeInputs {
  usefulLife: number;
  overnightCost: number;
  constructionTime: number;
  /** Real cost of equity (%), assumed pre-tax. Used in the WACC blend for Phase D discounting. */
  costOfEquity: number;
  /** Real cost of debt (%), used via Fisher equation for Phase B IDC accumulation. */
  costOfDebt: number;
  /** Target debt fraction (0–100 %): gearing = Debt / (Debt + Equity). */
  targetGearing: number;
  fuelCost: number;
  omCost: number;
  loadHours: number;
  decommissioningCost: number;
  /** Percentage (0–100) of Interest During Construction passed to ratepayers under the RAB model. */
  rabProportion: number;
  /** Annual inflation rate in percent (e.g. 2 = 2 %) for JRC-adjusted nominal capital draws and OPEX escalation. */
  inflationRate: number;
}

export interface LcoeResult {
  totalLcoe: number;
  occLcoe: number;
  financingLcoe: number;
  fuelLcoe: number;
  omLcoe: number;
  decommissioningLcoe: number;
  /** Consumer surcharge from RAB interest payments, expressed as $/MWh (optional). */
  surchargedIdcLcoe?: number;
  /** Half 1 LCOE (double-life mode only): capex fully recovered in first half. */
  halfLcoe1?: number;
  /** Half 2 LCOE (double-life mode only): fully depreciated, opex only. */
  halfLcoe2?: number;
  /** Developer sale price in Turnkey mode ($/kW). */
  developerSalePrice?: number;
}

// ---------------------------------------------------------------------------
// Step enum for 3-step pedagogical flow
// ---------------------------------------------------------------------------
export type LcoeStep = 1 | 2 | 3;

// ---------------------------------------------------------------------------
// Advanced toggles for Step 3
// ---------------------------------------------------------------------------
export interface AdvancedToggles {
  /** RAB model: share of IDC paid by consumers during construction. */
  rabEnabled: boolean;
  /** Declining WACC: 3-tranche declining discount rate. */
  decliningWacc: boolean;
  /** Turnkey: developer sells at COD, buyer computes LCOE from sale price. */
  turnkey: boolean;
  /** 2-Lives: simple average of two half-LCOEs. */
  twoLives: boolean;
  /** SOC vs COD valuation point (affects all steps). */
  valuationPoint: 'soc' | 'cod';
}
