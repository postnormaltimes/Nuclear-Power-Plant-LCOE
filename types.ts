
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
  /** Real overnight CapEx for 20-year Life Extension (LTE/LTO), SOC currency ($/kW). */
  extensionCapEx: number;
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
  /** Interval 1 LCOE (2-Lives: years 1..TL with initial CAPEX). */
  halfLcoe1?: number;
  /** Interval 2 LCOE (2-Lives: years TL+1..TL+20, extension CAPEX only). */
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
  /** 2-Lives: adds 20-year LTE/LTO with extension CAPEX. */
  twoLives: boolean;
  /** SOC vs COD valuation point (affects all steps). */
  valuationPoint: 'soc' | 'cod';
}
