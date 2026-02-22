import { useMemo } from 'react';
import type { LcoeInputs, LcoeResult } from '../types';

// ---------------------------------------------------------------------------
// Operational-only variables: Phases A–D are invariant under changes to these.
// Used by the sensitivity optimisation to avoid redundant construction loops.
// ---------------------------------------------------------------------------
export const OPEX_ONLY_VARS = new Set<keyof LcoeInputs>(['fuelCost', 'omCost', 'loadHours', 'decommissioningCost']);

// ---------------------------------------------------------------------------
// Derive the blended nominal WACC from the three project-finance inputs.
//
// Assumptions (per spec):
//  - costOfDebt and costOfEquity are REAL rates supplied by the user.
//  - Fisher equation converts each to nominal before blending.
//  - The resulting waccNomBlend is used as the Phase D discount rate.
// ---------------------------------------------------------------------------
export function calcNominalWacc(inputs: LcoeInputs): {
  waccNomBlend: number;
  costOfDebtNom: number;
  costOfEquityNom: number;
} {
  const pi = inputs.inflationRate / 100;
  const gearing = Math.min(Math.max(inputs.targetGearing, 0), 100) / 100;

  // Fisher: W_nom = (1 + W_real) × (1 + π) − 1
  const costOfDebtNom = (1 + inputs.costOfDebt / 100) * (1 + pi) - 1;
  const costOfEquityNom = (1 + inputs.costOfEquity / 100) * (1 + pi) - 1;

  // Blended nominal WACC
  const waccNomBlend = gearing * costOfDebtNom + (1 - gearing) * costOfEquityNom;
  return { waccNomBlend, costOfDebtNom, costOfEquityNom };
}

// ---------------------------------------------------------------------------
// Phase D helper: build a Float64Array of per-year discount factors DF[k].
//
// waccFrac    – NOMINAL blended WACC (fraction) – already includes inflation.
// usefulLife  – operational years (TL).
// waccProfile – 'constant' | 'declining'.
// tcOffset    – SOC: compound through Tc construction years first so revenues
//               are penalised by the construction-period delay.
//
// Mid-year convention:
//   DF_mid,k = 1 / (cumProduct × √(1 + W_k))
//   reflects continuous electricity generation throughout the year.
// ---------------------------------------------------------------------------
export function buildDfArray(
  waccFrac: number,
  usefulLife: number,
  waccProfile: 'constant' | 'declining',
  tcOffset: number,
): Float64Array {
  const df = new Float64Array(usefulLife);
  const TL = usefulLife;
  const L = Math.floor(TL / 3);

  // Declining-tranche rate based on operational year (1-indexed)
  const getOpW = (opYear: number): number => {
    if (waccProfile === 'constant') return waccFrac;
    if (opYear <= L) return waccFrac;
    if (opYear <= 2 * L) return Math.max(0, waccFrac - 0.015);
    return Math.max(0, waccFrac - 0.030);
  };

  // SOC: compound through Tc construction years first (base WACC).
  let cumProduct = 1.0;
  for (let t = 1; t <= tcOffset; t++) {
    cumProduct *= 1 + waccFrac;
  }

  // Operational years with mid-year convention + declining tranches
  for (let k = 0; k < TL; k++) {
    const opYear = k + 1;
    const w = getOpW(opYear);
    cumProduct *= 1 + w;
    df[k] = 1 / (cumProduct * Math.sqrt(1 + w));
  }
  return df;
}

// ---------------------------------------------------------------------------
// Phases A + B: return assetCod and the total surcharged IDC.
//
// Phase A – S-Curve capital drawdown (sine-weighted) with JRC inflation indexation.
// Phase B – IDC accumulation:
//   - Only the DEBT tranche (targetGearing × debt balance) accrues interest.
//   - Interest is calculated using the NOMINAL cost of debt (Fisher-converted).
//   - RAB surcharge is applied only to this debt-only interest pool.
// ---------------------------------------------------------------------------
export function buildConstructionPhase(
  inputs: LcoeInputs,
  isRabEnabled: boolean,
): { assetCod: number; totalSurchargedIdc: number } {
  const { overnightCost, constructionTime, rabProportion, inflationRate } = inputs;

  const Tc = Math.max(constructionTime, 0);
  if (Tc === 0) {
    return { assetCod: overnightCost, totalSurchargedIdc: 0 };
  }

  const pi = inflationRate / 100;
  const rabFrac = isRabEnabled ? Math.min(Math.max(rabProportion, 0), 100) / 100 : 0;
  const gearing = Math.min(Math.max(inputs.targetGearing, 0), 100) / 100;

  // Nominal cost of debt (Fisher) – used exclusively for IDC interest calculation
  const { costOfDebtNom } = calcNominalWacc(inputs);

  // Phase A: Sine-weighted S-Curve drawdown with real→nominal inflation indexation.
  // Weight_t = sin(π × (t + 0.5) / Tc), normalised so Σ weights = 1.
  const cNom = new Float64Array(Tc);
  const weights = new Float64Array(Tc);
  let weightSum = 0;
  for (let t = 0; t < Tc; t++) {
    weights[t] = Math.sin(Math.PI * (t + 0.5) / Tc);
    weightSum += weights[t];
  }
  for (let t = 0; t < Tc; t++) {
    const realDraw = overnightCost * (weights[t] / weightSum);
    cNom[t] = realDraw * Math.pow(1 + pi, t);
  }

  // Phase B: Debt accumulation with RAB intercept.
  //  - Only the DEBT tranche (gearing × cNom[t]) accrues interest each period.
  //  - Interest = accumulated debt balance × nominal cost of debt.
  //  - RAB: surcharged portion paid by consumers; capitalised portion added to debt.
  //  - assetCod = Σ cNom (total nominal draws) + Σ capitalised IDC
  let D = 0;                     // accumulated debt balance
  let totalSurchargedIdc = 0;
  let totalCapitalisedIdc = 0;

  for (let t = 0; t < Tc; t++) {
    const interest = D * costOfDebtNom;
    const surcharged = interest * rabFrac;          // consumer levy
    const capitalized = interest * (1 - rabFrac);    // added to project debt
    totalSurchargedIdc += surcharged;
    totalCapitalisedIdc += capitalized;
    // Debt balance grows by: debt share of this period's draw + capitalised interest
    D = D + cNom[t] * gearing + capitalized;
  }

  // Total nominal capital outlay (sum of all inflation-adjusted draws)
  const totalNomCapital = cNom.reduce((acc, v) => acc + v, 0);
  // Asset at COD = total nominal capital + all IDC that was capitalised into the asset
  const assetCod = totalNomCapital + totalCapitalisedIdc;

  return { assetCod, totalSurchargedIdc };
}

// ---------------------------------------------------------------------------
// Main calculateLcoe function – the full five-phase waterfall.
//
// All-Nominal methodology:
//  - Phase A/B: capital draws and IDC are in nominal terms (inflation-indexed).
//  - Phase D:   blended nominal WACC used as the discount rate.
//  - Phase E:   OPEX (fuel + O&M) escalated year-by-year by π before discounting.
//               Energy generation is kept constant (no degradation assumed).
// ---------------------------------------------------------------------------
export const calculateLcoe = (
  inputs: LcoeInputs,
  isRabEnabled: boolean,
  t0Timing: 'soc' | 'cod',
  waccProfile: 'constant' | 'declining',
  // Optional pre-computed construction phase (sensitivity optimisation)
  precomputed?: { assetCod: number; totalSurchargedIdc: number; df: Float64Array },
): LcoeResult => {
  const {
    usefulLife,
    overnightCost,
    constructionTime,
    fuelCost,
    omCost,
    loadHours,
    decommissioningCost,
    inflationRate,
  } = inputs;

  const annualMwh = loadHours > 0 ? loadHours / 1000 : 0;
  const zero: LcoeResult = { totalLcoe: 0, occLcoe: 0, financingLcoe: 0, fuelLcoe: 0, omLcoe: 0, decommissioningLcoe: 0, surchargedIdcLcoe: 0 };
  if (annualMwh <= 0 || usefulLife <= 0) return zero;

  const pi = inflationRate / 100;
  const Tc = Math.max(Math.round(constructionTime), 0);
  const TL = Math.max(Math.round(usefulLife), 0);

  // Blended nominal WACC for Phase D discounting
  const { waccNomBlend } = calcNominalWacc(inputs);

  // --- Phases A + B (skip if pre-computed) ---
  const { assetCod, totalSurchargedIdc } = precomputed ?? buildConstructionPhase(inputs, isRabEnabled);

  // --- Phase C: Temporal anchor ---
  const tcOffset = t0Timing === 'soc' ? Tc : 0;

  // --- Phase D: Discount factor array (nominal WACC, mid-year, declining tranches) ---
  const df: Float64Array = precomputed?.df ?? buildDfArray(waccNomBlend, TL, waccProfile, tcOffset);

  // --- Phase E: All-Nominal Matrix Summation ---
  // Decommissioning sinking fund (real, not escalated – regulated provision)
  const decomFundRate = 0.01;
  const annualDecom = decomFundRate > 0 && TL > 0
    ? decommissioningCost * (decomFundRate / (Math.pow(1 + decomFundRate, TL) - 1))
    : (TL > 0 ? decommissioningCost / TL : 0);

  // Base-year (real) OPEX amounts
  const baseFuelCost = fuelCost * annualMwh; // $/kW-yr
  const baseOmCost = omCost;               // $/kW-yr

  let pvEnergy = 0;
  let pvOm = 0;
  let pvFuel = 0;
  let pvDecom = 0;

  for (let k = 0; k < TL; k++) {
    const d = df[k];
    const opYear = k + 1;
    // Nominal escalation: OPEX grows at π per year (All-Nominal methodology)
    const escalation = Math.pow(1 + pi, opYear);

    pvEnergy += annualMwh * d;                       // energy constant (no degradation)
    pvOm += baseOmCost * escalation * d;
    pvFuel += baseFuelCost * escalation * d;
    pvDecom += annualDecom * d;                    // decom fund: real annuity, not escalated
  }

  if (pvEnergy <= 0) return zero;

  // Capital PV: assetCod at face value in both COD and SOC modes.
  // SOC penalty is carried entirely through the smaller revenue PV (operational DF
  // compounds through Tc construction years, making the denominator smaller).
  const pvCapex = assetCod;

  // OCC vs. Financing decomposition (capitalised IDC is the financing component)
  const occShare = assetCod > 0 ? Math.min(overnightCost / assetCod, 1) : 1;
  const pvOcc = pvCapex * occShare;
  const pvFinancing = pvCapex * (1 - occShare);

  // Surcharged IDC (RAB consumer burden): reported separately, NOT in project NPV
  const surchargedIdcLcoe = totalSurchargedIdc > 0 ? totalSurchargedIdc / pvEnergy : 0;

  const totalPvCost = pvOcc + pvFinancing + pvOm + pvFuel + pvDecom;
  const totalLcoe = totalPvCost / pvEnergy;
  const occLcoe = pvOcc / pvEnergy;
  const financingLcoe = pvFinancing / pvEnergy;
  const omLcoe = pvOm / pvEnergy;
  const fuelLcoe = pvFuel / pvEnergy;
  const decommissioningLcoe = pvDecom / pvEnergy;

  return { totalLcoe, occLcoe, financingLcoe, fuelLcoe, omLcoe, decommissioningLcoe, surchargedIdcLcoe };
};

// ---------------------------------------------------------------------------
// useLcoe hook
// ---------------------------------------------------------------------------
export const useLcoe = (
  inputs: LcoeInputs,
  isRabEnabled: boolean,
  t0Timing: 'soc' | 'cod',
  waccProfile: 'constant' | 'declining',
): LcoeResult => {
  return useMemo(
    () => calculateLcoe(inputs, isRabEnabled, t0Timing, waccProfile),
    [inputs, isRabEnabled, t0Timing, waccProfile],
  );
};