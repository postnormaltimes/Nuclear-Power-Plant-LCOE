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
  // Financially correct two-stage construct:
  //   LCOE_total = PV(all costs) / PV(all energy)
  // where both periods are sequential. Capex is only in H1's cost pool,
  // but is charged against PV(energy) over the FULL useful life.
  //
  // Half-LCOEs are subperiod reporting metrics:
  //   LCOE_H1 = PV(capex + opex_H1) / PV(energy_H1)
  //   LCOE_H2 = PV(opex_H2) / PV(energy_H2)
  //
  // The identity holds:
  //   LCOE_total = w1 × LCOE_H1 + w2 × LCOE_H2
  //   where wi = PV(energy_Hi) / PV(total_energy)  (PV-energy weights)
  const N1 = Math.ceil(TL / 2);

  // Sum PV components over each half
  let pvE1 = 0, pvOm1 = 0, pvFuel1 = 0, pvDecom1 = 0;
  let pvE2 = 0, pvOm2 = 0, pvFuel2 = 0, pvDecom2 = 0;

  for (let k = 0; k < TL; k++) {
    const d = df[k];
    const escalation = Math.pow(1 + pi, k + 1);
    const e = annualMwh * d;
    const om = baseOmCost * escalation * d;
    const fl = baseFuelCost * escalation * d;
    const dc = annualDecom * d;

    if (k < N1) {
      pvE1 += e; pvOm1 += om; pvFuel1 += fl; pvDecom1 += dc;
    } else {
      pvE2 += e; pvOm2 += om; pvFuel2 += fl; pvDecom2 += dc;
    }
  }

  const pvEnergyTotal = pvE1 + pvE2;
  if (pvEnergyTotal <= 0) return zero;

  // --- Total LCOE: PV(all costs) / PV(all energy) ---
  // Capex is a lump-sum PV at COD charged against full-life energy.
  const pvOmTotal = pvOm1 + pvOm2;
  const pvFuelTotal = pvFuel1 + pvFuel2;
  const pvDecomTotal = pvDecom1 + pvDecom2;
  const totalPvCost = pvOcc + pvFinancing + pvOmTotal + pvFuelTotal + pvDecomTotal;

  const totalLcoe = totalPvCost / pvEnergyTotal;
  const occLcoeVal = pvOcc / pvEnergyTotal;
  const financingLcoeVal = pvFinancing / pvEnergyTotal;
  const fuelLcoeVal = pvFuelTotal / pvEnergyTotal;
  const omLcoeVal = pvOmTotal / pvEnergyTotal;
  const decommissioningVal = pvDecomTotal / pvEnergyTotal;
  const surchargedLcoeVal = surchargedIdcLcoe / pvEnergyTotal;

  // --- Subperiod reporting LCOEs ---
  const halfLcoe1 = pvE1 > 0
    ? (pvOcc + pvFinancing + pvOm1 + pvFuel1 + pvDecom1) / pvE1
    : 0;
  const halfLcoe2 = pvE2 > 0
    ? (pvOm2 + pvFuel2 + pvDecom2) / pvE2   // no capex in H2
    : 0;

  return {
    totalLcoe,
    occLcoe: occLcoeVal,
    financingLcoe: financingLcoeVal,
    fuelLcoe: fuelLcoeVal,
    omLcoe: omLcoeVal,
    decommissioningLcoe: decommissioningVal,
    surchargedIdcLcoe: surchargedLcoeVal,
    halfLcoe1,
    halfLcoe2,
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