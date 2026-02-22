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
// Phase A – S-Curve capital drawdown with inflation indexation.
//   inflationAccounting controls HOW inflation maps SOC→COD capital costs:
//
//   'dynamic' (default):
//     Each construction tranche is inflated to its own period:
//       cNom[t] = realDraw[t] × (1 + π)^t
//     This is the year-by-year JRC approach — more realistic but more complex.
//
//   'lump_sum':
//     The entire OCC is inflated once by the full construction duration:
//       capexCod = OCC × (1 + π)^Tc
//     Then distributed across periods via S-curve weights WITHOUT further
//     compounding. Simpler, assumes all costs are "stated at SOC" and a
//     single cumulative index translates them to COD.
//
// Phase B – IDC / carrying cost accumulation using the blended nominal WACC.
//   RAB surcharge is applied to the whole capital structure.
// ---------------------------------------------------------------------------
export function buildConstructionPhase(
  inputs: LcoeInputs,
  isRabEnabled: boolean,
  inflationAccounting: 'lump_sum' | 'dynamic' = 'dynamic',
): { assetCod: number; totalSurchargedIdc: number } {
  const { overnightCost, constructionTime, rabProportion, inflationRate } = inputs;

  const Tc = Math.max(constructionTime, 0);
  if (Tc === 0) {
    return { assetCod: overnightCost, totalSurchargedIdc: 0 };
  }

  const pi = inflationRate / 100;
  const rabFrac = isRabEnabled ? Math.min(Math.max(rabProportion, 0), 100) / 100 : 0;

  // Blended nominal WACC (Fisher) – used for whole-capital-structure carrying cost
  const { waccNomBlend } = calcNominalWacc(inputs);

  // Phase A: Sine-weighted S-Curve drawdown.
  // Weight_t = sin(π × (t + 0.5) / Tc), normalised so Σ weights = 1.
  const cNom = new Float64Array(Tc);
  const weights = new Float64Array(Tc);
  let weightSum = 0;
  for (let t = 0; t < Tc; t++) {
    weights[t] = Math.sin(Math.PI * (t + 0.5) / Tc);
    weightSum += weights[t];
  }

  if (inflationAccounting === 'lump_sum') {
    // Lump-Sum: inflate OCC once by full Tc, then distribute via weights
    const capexCod = overnightCost * Math.pow(1 + pi, Tc);
    for (let t = 0; t < Tc; t++) {
      cNom[t] = capexCod * (weights[t] / weightSum);
    }
  } else {
    // Dynamic: inflate each tranche to its period
    for (let t = 0; t < Tc; t++) {
      const realDraw = overnightCost * (weights[t] / weightSum);
      cNom[t] = realDraw * Math.pow(1 + pi, t);
    }
  }

  // Phase B: Capital accumulation with RAB intercept.
  //  - The ENTIRE capital structure (debt + equity) accrues a carrying cost.
  //  - Carrying Cost = accumulated capital base × blended nominal WACC.
  //  - RAB: surcharged portion paid by consumers; capitalised portion added to asset base.
  let K = 0;
  let totalSurchargedIdc = 0;
  let totalCapitalisedIdc = 0;

  for (let t = 0; t < Tc; t++) {
    const carryingCost = K * waccNomBlend;
    const surcharged = carryingCost * rabFrac;
    const capitalized = carryingCost * (1 - rabFrac);
    totalSurchargedIdc += surcharged;
    totalCapitalisedIdc += capitalized;
    K = K + cNom[t] + capitalized;
  }

  const totalNomCapital = cNom.reduce((acc, v) => acc + v, 0);
  const assetCod = totalNomCapital + totalCapitalisedIdc;

  return { assetCod, totalSurchargedIdc };
}

// ---------------------------------------------------------------------------
// Main calculateLcoe function – the full five-phase waterfall.
//
// All-Nominal methodology:
//  - Phase A/B: capital draws and IDC in nominal terms.
//  - Phase D:   blended nominal WACC as discount rate.
//  - Phase E:   OPEX escalated year-by-year by π.
//
// lifeTreatment:
//  - 'single': standard single-period LCOE over the full useful life.
//  - 'double': 2-stage LCOE with capex recovered entirely in the first half;
//    second half operates fully depreciated. Final LCOE = arithmetic mean.
// ---------------------------------------------------------------------------
export const calculateLcoe = (
  inputs: LcoeInputs,
  isRabEnabled: boolean,
  t0Timing: 'soc' | 'cod',
  waccProfile: 'constant' | 'declining',
  inflationAccounting: 'lump_sum' | 'dynamic' = 'dynamic',
  lifeTreatment: 'single' | 'double' = 'single',
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
  const { assetCod, totalSurchargedIdc } = precomputed ?? buildConstructionPhase(inputs, isRabEnabled, inflationAccounting);

  // --- Phase C: Temporal anchor ---
  const tcOffset = t0Timing === 'soc' ? Tc : 0;

  // --- Phase D: Discount factor array (nominal WACC, mid-year, declining tranches) ---
  const df: Float64Array = precomputed?.df ?? buildDfArray(waccNomBlend, TL, waccProfile, tcOffset);

  // --- Phase E: All-Nominal Matrix Summation ---
  const decomFundRate = 0.01;
  const annualDecom = decomFundRate > 0 && TL > 0
    ? decommissioningCost * (decomFundRate / (Math.pow(1 + decomFundRate, TL) - 1))
    : (TL > 0 ? decommissioningCost / TL : 0);

  const baseFuelCost = fuelCost * annualMwh;
  const baseOmCost = omCost;

  // Capital PV and decomposition
  const pvCapex = assetCod;
  const occShare = assetCod > 0 ? Math.min(overnightCost / assetCod, 1) : 1;
  const pvOcc = pvCapex * occShare;
  const pvFinancing = pvCapex * (1 - occShare);
  const surchargedIdcLcoe = totalSurchargedIdc > 0 ? totalSurchargedIdc : 0;

  // ----------- SINGLE LIFE MODE (standard) -----------
  if (lifeTreatment === 'single') {
    let pvEnergy = 0, pvOm = 0, pvFuel = 0, pvDecom = 0;

    for (let k = 0; k < TL; k++) {
      const d = df[k];
      const escalation = Math.pow(1 + pi, k + 1);
      pvEnergy += annualMwh * d;
      pvOm += baseOmCost * escalation * d;
      pvFuel += baseFuelCost * escalation * d;
      pvDecom += annualDecom * d;
    }

    if (pvEnergy <= 0) return zero;

    const totalPvCost = pvOcc + pvFinancing + pvOm + pvFuel + pvDecom;
    return {
      totalLcoe: totalPvCost / pvEnergy,
      occLcoe: pvOcc / pvEnergy,
      financingLcoe: pvFinancing / pvEnergy,
      fuelLcoe: pvFuel / pvEnergy,
      omLcoe: pvOm / pvEnergy,
      decommissioningLcoe: pvDecom / pvEnergy,
      surchargedIdcLcoe: surchargedIdcLcoe / pvEnergy,
    };
  }

  // ----------- DOUBLE LIFE MODE (2-stage LCOE) -----------
  // Half 1: years 1..N1, full capex recovery + opex.
  // Half 2: years N1+1..N, NO capex recovery, opex only.
  // Per-driver final = (driver_half1 + driver_half2) / 2
  const N1 = Math.ceil(TL / 2);
  const N2 = TL - N1;

  // Helper: sum PV costs and energy over a year range [start, end) with optional capex
  const sumHalf = (startK: number, endK: number, includeCapex: boolean) => {
    let pvE = 0, pvO = 0, pvF = 0, pvD = 0;
    for (let k = startK; k < endK; k++) {
      const d = df[k];
      const escalation = Math.pow(1 + pi, k + 1);
      pvE += annualMwh * d;
      pvO += baseOmCost * escalation * d;
      pvF += baseFuelCost * escalation * d;
      pvD += annualDecom * d;
    }
    if (pvE <= 0) return { lcoeOcc: 0, lcoeFin: 0, lcoeFuel: 0, lcoeOm: 0, lcoeDecom: 0, lcoeSurcharge: 0, total: 0 };

    const lcoeOcc = includeCapex ? pvOcc / pvE : 0;
    const lcoeFin = includeCapex ? pvFinancing / pvE : 0;
    const lcoeSurcharge = includeCapex ? surchargedIdcLcoe / pvE : 0;
    const lcoeFuel = pvF / pvE;
    const lcoeOm = pvO / pvE;
    const lcoeDecom = pvD / pvE;
    const total = lcoeOcc + lcoeFin + lcoeFuel + lcoeOm + lcoeDecom;
    return { lcoeOcc, lcoeFin, lcoeFuel, lcoeOm, lcoeDecom, lcoeSurcharge, total };
  };

  const h1 = sumHalf(0, N1, true);
  const h2 = sumHalf(N1, TL, false);

  // Arithmetic mean of per-driver contributions
  const occLcoe = (h1.lcoeOcc + h2.lcoeOcc) / 2;
  const financingLcoe = (h1.lcoeFin + h2.lcoeFin) / 2;
  const fuelLcoeVal = (h1.lcoeFuel + h2.lcoeFuel) / 2;
  const omLcoe = (h1.lcoeOm + h2.lcoeOm) / 2;
  const decommissioningLcoe = (h1.lcoeDecom + h2.lcoeDecom) / 2;
  const surchargedLcoe = (h1.lcoeSurcharge + h2.lcoeSurcharge) / 2;
  const totalLcoe = occLcoe + financingLcoe + fuelLcoeVal + omLcoe + decommissioningLcoe;

  return {
    totalLcoe,
    occLcoe,
    financingLcoe,
    fuelLcoe: fuelLcoeVal,
    omLcoe,
    decommissioningLcoe,
    surchargedIdcLcoe: surchargedLcoe,
    halfLcoe1: h1.total,
    halfLcoe2: h2.total,
  };
};

// ---------------------------------------------------------------------------
// useLcoe hook
// ---------------------------------------------------------------------------
export const useLcoe = (
  inputs: LcoeInputs,
  isRabEnabled: boolean,
  t0Timing: 'soc' | 'cod',
  waccProfile: 'constant' | 'declining',
  inflationAccounting: 'lump_sum' | 'dynamic' = 'dynamic',
  lifeTreatment: 'single' | 'double' = 'single',
): LcoeResult => {
  return useMemo(
    () => calculateLcoe(inputs, isRabEnabled, t0Timing, waccProfile, inflationAccounting, lifeTreatment),
    [inputs, isRabEnabled, t0Timing, waccProfile, inflationAccounting, lifeTreatment],
  );
};