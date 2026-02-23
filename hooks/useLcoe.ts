import { useMemo } from 'react';
import type { LcoeInputs, LcoeResult, LcoeStep, AdvancedToggles } from '../types';

// ---------------------------------------------------------------------------
// Operational-only variables: Phases A–D are invariant under changes to these.
// Used by the sensitivity optimisation to avoid redundant construction loops.
// ---------------------------------------------------------------------------
export const OPEX_ONLY_VARS = new Set<keyof LcoeInputs>(['fuelCost', 'omCost', 'loadHours', 'decommissioningCost']);

// ---------------------------------------------------------------------------
// DCF / CAPM framework: derive the blended nominal WACC.
//
// Following DCF Skill methodology (CAPM + target weighting):
//  - costOfDebt and costOfEquity are REAL rates (user inputs).
//  - Fisher equation converts each to nominal: W_nom = (1+W_real)(1+π)−1
//  - Target gearing (wD) used for blending: WACC = wD·Kd + wE·Ke
// ---------------------------------------------------------------------------
export function calcNominalWacc(inputs: LcoeInputs): {
  waccNomBlend: number;
  costOfDebtNom: number;
  costOfEquityNom: number;
} {
  const pi = inputs.inflationRate / 100;
  const gearing = Math.min(Math.max(inputs.targetGearing, 0), 100) / 100;

  const costOfDebtNom = (1 + inputs.costOfDebt / 100) * (1 + pi) - 1;
  const costOfEquityNom = (1 + inputs.costOfEquity / 100) * (1 + pi) - 1;

  const waccNomBlend = gearing * costOfDebtNom + (1 - gearing) * costOfEquityNom;
  return { waccNomBlend, costOfDebtNom, costOfEquityNom };
}

// ---------------------------------------------------------------------------
// Phase D: discount factor array.
//
// When declining=true, the COST OF EQUITY declines over 3 tranches.
// The decline is applied to the REAL rate before Fisher conversion,
// preventing distortions at high inflation:
//   Tranche 1: Ke_real (base)
//   Tranche 2: Ke_real × 2/3
//   Tranche 3: Ke_real / 3
// Cost of debt stays fixed (nominal).
//
// Mid-year convention (IEA/NEA): DF computed BEFORE advancing cumProduct.
// ---------------------------------------------------------------------------
export function buildDfArray(
  costOfEquityReal: number,
  costOfDebtNom: number,
  gearing: number,
  pi: number,
  usefulLife: number,
  declining: boolean,
  tcOffset: number,
): Float64Array {
  const df = new Float64Array(usefulLife);
  const TL = usefulLife;
  const L = Math.floor(TL / 3);

  // Base nominal Ke (for construction offset and tranche 1)
  const baseKeNom = (1 + costOfEquityReal) * (1 + pi) - 1;

  const getOpW = (opYear: number): number => {
    // Declining REAL cost of equity, then Fisher to nominal
    let keReal = costOfEquityReal;
    if (declining) {
      if (opYear > 2 * L) keReal = costOfEquityReal / 3;
      else if (opYear > L) keReal = costOfEquityReal * 2 / 3;
    }
    const keNom = (1 + keReal) * (1 + pi) - 1;
    return gearing * costOfDebtNom + (1 - gearing) * keNom;
  };

  // SOC offset: compound through construction years at base WACC
  const baseWacc = gearing * costOfDebtNom + (1 - gearing) * baseKeNom;
  let cumProduct = 1.0;
  for (let t = 1; t <= tcOffset; t++) {
    cumProduct *= 1 + baseWacc;
  }

  for (let k = 0; k < TL; k++) {
    const w = getOpW(k + 1);
    df[k] = 1 / (cumProduct * Math.sqrt(1 + w));
    cumProduct *= 1 + w;
  }
  return df;
}

// ---------------------------------------------------------------------------
// Phases A + B: Construction cost build-up and IDC.
//
// inflationMode:
//   'lump_sum' (Step 1 wrong): OCC × (1+π)^Tc then S-curve distribute
//   'dynamic'  (Step 2+):      each tranche inflated to its period
//
// idcMode:
//   'whole_wacc' (Step 1 wrong): carrying cost on FULL capital at blended WACC
//   'debt_only'  (Step 2 correct): interest only on debt tranche at Kd_nom
//
// rabFrac:
//   fraction of carrying cost paid by consumers (Step 3 RAB toggle)
// ---------------------------------------------------------------------------
export function buildConstructionPhase(
  inputs: LcoeInputs,
  inflationMode: 'lump_sum' | 'dynamic',
  idcMode: 'whole_wacc' | 'debt_only',
  rabFrac: number,
): { assetCod: number; totalSurchargedIdc: number } {
  const { overnightCost, constructionTime, inflationRate } = inputs;

  const Tc = Math.max(constructionTime, 0);
  if (Tc === 0) return { assetCod: overnightCost, totalSurchargedIdc: 0 };

  const pi = inflationRate / 100;
  const gearing = Math.min(Math.max(inputs.targetGearing, 0), 100) / 100;
  const { waccNomBlend, costOfDebtNom } = calcNominalWacc(inputs);

  // Phase A: S-Curve drawdown
  const cNom = new Float64Array(Tc);
  const weights = new Float64Array(Tc);
  let weightSum = 0;
  for (let t = 0; t < Tc; t++) {
    weights[t] = Math.sin(Math.PI * (t + 0.5) / Tc);
    weightSum += weights[t];
  }

  if (inflationMode === 'lump_sum') {
    const capexCod = overnightCost * Math.pow(1 + pi, Tc);
    for (let t = 0; t < Tc; t++) cNom[t] = capexCod * (weights[t] / weightSum);
  } else {
    for (let t = 0; t < Tc; t++) {
      cNom[t] = overnightCost * (weights[t] / weightSum) * Math.pow(1 + pi, t);
    }
  }

  // Phase B: IDC accumulation
  let totalSurchargedIdc = 0;
  let totalCapitalisedIdc = 0;

  if (idcMode === 'whole_wacc') {
    // STEP 1 (wrong): interest on whole capital at blended WACC
    let K = 0;
    for (let t = 0; t < Tc; t++) {
      const carryingCost = (K + cNom[t] / 2) * waccNomBlend;
      const surcharged = carryingCost * rabFrac;
      const capitalized = carryingCost * (1 - rabFrac);
      totalSurchargedIdc += surcharged;
      totalCapitalisedIdc += capitalized;
      K += cNom[t] + capitalized;
    }
  } else {
    // STEP 2+ (correct): interest only on debt tranche at Kd_nom
    // Equity required return is handled via discounting, not as capitalized interest.
    let D = 0; // accumulated debt balance
    for (let t = 0; t < Tc; t++) {
      const interest = (D + cNom[t] * gearing / 2) * costOfDebtNom;
      const surcharged = interest * rabFrac;
      const capitalized = interest * (1 - rabFrac);
      totalSurchargedIdc += surcharged;
      totalCapitalisedIdc += capitalized;
      D += cNom[t] * gearing + capitalized;
    }
  }

  const totalNomCapital = cNom.reduce((a, v) => a + v, 0);
  const assetCod = totalNomCapital + totalCapitalisedIdc;

  return { assetCod, totalSurchargedIdc };
}

// ---------------------------------------------------------------------------
// Core LCOE computation (single or double life).
//
// Returns the standard PV identity:  LCOE = PV(costs) / PV(MWh)
// ---------------------------------------------------------------------------
function computeCoreLcoe(
  inputs: LcoeInputs,
  assetCod: number,
  totalSurchargedIdc: number,
  df: Float64Array,
  twoLives: boolean,
): LcoeResult {
  const { usefulLife, overnightCost, fuelCost, omCost, loadHours, decommissioningCost, inflationRate } = inputs;
  const pi = inflationRate / 100;
  const TL = Math.max(Math.round(usefulLife), 0);
  const annualMwh = loadHours > 0 ? loadHours / 1000 : 0;
  const zero: LcoeResult = { totalLcoe: 0, occLcoe: 0, financingLcoe: 0, fuelLcoe: 0, omLcoe: 0, decommissioningLcoe: 0, surchargedIdcLcoe: 0 };
  if (annualMwh <= 0 || TL <= 0) return zero;

  // Decommissioning sinking fund targets inflated end-of-life cost
  const decomFundRate = 0.01;
  const futureDecomCost = decommissioningCost * Math.pow(1 + pi, TL);
  const annualDecom = decomFundRate > 0 && TL > 0
    ? futureDecomCost * (decomFundRate / (Math.pow(1 + decomFundRate, TL) - 1))
    : (TL > 0 ? futureDecomCost / TL : 0);

  const baseFuelCost = fuelCost * annualMwh;
  const baseOmCost = omCost;

  // Capital PV decomposition
  const pvCapex = assetCod;
  const occShare = assetCod > 0 ? Math.min(overnightCost / assetCod, 1) : 1;
  const pvOcc = pvCapex * occShare;
  const pvFinancing = pvCapex * (1 - occShare);

  if (!twoLives) {
    // ---------- SINGLE LIFE ----------
    let pvEnergy = 0, pvOm = 0, pvFuel = 0, pvDecom = 0;
    for (let k = 0; k < TL; k++) {
      const d = df[k];
      const esc = Math.pow(1 + pi, k + 0.5);
      pvEnergy += annualMwh * d;
      pvOm += baseOmCost * esc * d;
      pvFuel += baseFuelCost * esc * d;
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
      surchargedIdcLcoe: totalSurchargedIdc > 0 ? totalSurchargedIdc / pvEnergy : 0,
    };
  }

  // ---------- 2-LIVES (PV-correct aggregation) ----------
  // Half 1: years 0..N1-1, full capex + opex
  // Half 2: years N1..TL-1, NO capex, opex only
  // Total LCOE = PV(all costs) / PV(all energy)  (NOT arithmetic mean of ratios)
  // Half-LCOEs are still reported as PV(half costs) / PV(half energy) for each subperiod.
  const N1 = Math.ceil(TL / 2);

  let pvE1 = 0, pvO1 = 0, pvF1 = 0, pvD1 = 0;
  let pvE2 = 0, pvO2 = 0, pvF2 = 0, pvD2 = 0;

  for (let k = 0; k < TL; k++) {
    const d = df[k];
    const esc = Math.pow(1 + pi, k + 0.5);
    const e = annualMwh * d;
    const o = baseOmCost * esc * d;
    const f = baseFuelCost * esc * d;
    const dc = annualDecom * d;
    if (k < N1) { pvE1 += e; pvO1 += o; pvF1 += f; pvD1 += dc; }
    else { pvE2 += e; pvO2 += o; pvF2 += f; pvD2 += dc; }
  }

  const pvEnergyTotal = pvE1 + pvE2;
  if (pvEnergyTotal <= 0) return zero;

  // Total LCOE from aggregate PVs (capex assigned entirely to full life)
  const pvOpexTotal = (pvO1 + pvO2) + (pvF1 + pvF2) + (pvD1 + pvD2);
  const totalLcoe = (pvOcc + pvFinancing + pvOpexTotal) / pvEnergyTotal;

  // Half-LCOEs for reporting: capex only in half 1
  const halfLcoe1 = pvE1 > 0 ? (pvOcc + pvFinancing + pvO1 + pvF1 + pvD1) / pvE1 : 0;
  const halfLcoe2 = pvE2 > 0 ? (pvO2 + pvF2 + pvD2) / pvE2 : 0;

  // Driver breakdown: allocate capex to full-life PV(energy), opex from full life
  return {
    totalLcoe,
    occLcoe: pvOcc / pvEnergyTotal,
    financingLcoe: pvFinancing / pvEnergyTotal,
    fuelLcoe: (pvF1 + pvF2) / pvEnergyTotal,
    omLcoe: (pvO1 + pvO2) / pvEnergyTotal,
    decommissioningLcoe: (pvD1 + pvD2) / pvEnergyTotal,
    surchargedIdcLcoe: totalSurchargedIdc > 0 ? totalSurchargedIdc / pvEnergyTotal : 0,
    halfLcoe1,
    halfLcoe2,
  };
}

// ---------------------------------------------------------------------------
// Turnkey two-model structure.
//
// Developer model: builds the plant, sells at COD.
//   Sale price such that developer NPV = 0 (sale proceeds = assetCod).
//   Payment in 3 equal tranches during years 1–3 post-COD.
//
// Buyer model: t=0 = COD, pays 3 tranches then operates.
//   LCOE = PV(sale tranches + opex) / PV(MWh)  from buyer's perspective.
// ---------------------------------------------------------------------------
function computeTurnkeyLcoe(
  inputs: LcoeInputs,
  assetCod: number,
  totalSurchargedIdc: number,
  waccNom: number,
  declining: boolean,
  twoLives: boolean,
): LcoeResult {
  const { usefulLife, fuelCost, omCost, loadHours, decommissioningCost, inflationRate } = inputs;
  const pi = inflationRate / 100;
  const TL = Math.max(Math.round(usefulLife), 0);
  const annualMwh = loadHours > 0 ? loadHours / 1000 : 0;
  const zero: LcoeResult = { totalLcoe: 0, occLcoe: 0, financingLcoe: 0, fuelLcoe: 0, omLcoe: 0, decommissioningLcoe: 0, surchargedIdcLcoe: 0 };
  if (annualMwh <= 0 || TL <= 0) return zero;

  // Developer sale price: NPV=0 means developer recoups assetCod.
  // Sale tranches in years 1–3 post-COD. Developer discounts at waccNom.
  // Use mid-year convention (t-0.5) to match the buyer's DF array.
  // P_annual × Σ(1/(1+w)^(t-0.5), t=1..3) = assetCod
  const nTranches = Math.min(3, TL);
  let annuityFactor = 0;
  for (let t = 1; t <= nTranches; t++) annuityFactor += 1 / Math.pow(1 + waccNom, t - 0.5);
  const annualPayment = annuityFactor > 0 ? assetCod / annuityFactor : assetCod;
  const developerSalePrice = annualPayment * nTranches;

  // Buyer model: t=0 = COD, no construction-period discounting
  const { costOfDebtNom: kdNom } = calcNominalWacc(inputs);
  const keReal = inputs.costOfEquity / 100;
  const gearingFrac = Math.min(Math.max(inputs.targetGearing, 0), 100) / 100;
  const buyerDf = buildDfArray(keReal, kdNom, gearingFrac, pi, TL, declining, 0);

  // Decom fund
  const decomFundRate = 0.01;
  const futureDecomCost = decommissioningCost * Math.pow(1 + pi, TL);
  const annualDecom = decomFundRate > 0 && TL > 0
    ? futureDecomCost * (decomFundRate / (Math.pow(1 + decomFundRate, TL) - 1))
    : (TL > 0 ? futureDecomCost / TL : 0);

  const baseFuelCost = fuelCost * annualMwh;
  const baseOmCost = omCost;

  // PV of sale tranches (buyer pays in years 1..nTranches)
  let pvSaleTranches = 0;
  for (let k = 0; k < nTranches; k++) pvSaleTranches += annualPayment * buyerDf[k];

  let pvEnergy = 0, pvOm = 0, pvFuel = 0, pvDecom = 0;
  for (let k = 0; k < TL; k++) {
    const d = buyerDf[k];
    const esc = Math.pow(1 + pi, k + 0.5);
    pvEnergy += annualMwh * d;
    pvOm += baseOmCost * esc * d;
    pvFuel += baseFuelCost * esc * d;
    pvDecom += annualDecom * d;
  }

  if (pvEnergy <= 0) return zero;

  // Decompose sale payments into OCC vs Financing using the same ratio as
  // the standard model: occShare = overnightCost / assetCod.
  // This gives the buyer the same D/E structure and makes the financing
  // component reflect the developer's IDC markup over base OCC.
  const occShare = assetCod > 0 ? Math.min(inputs.overnightCost / assetCod, 1) : 1;
  const pvOcc = pvSaleTranches * occShare;
  const pvFinancing = pvSaleTranches * (1 - occShare);

  const totalPvCost = pvSaleTranches + pvOm + pvFuel + pvDecom;
  return {
    totalLcoe: totalPvCost / pvEnergy,
    occLcoe: pvOcc / pvEnergy,
    financingLcoe: pvFinancing / pvEnergy,
    fuelLcoe: pvFuel / pvEnergy,
    omLcoe: pvOm / pvEnergy,
    decommissioningLcoe: pvDecom / pvEnergy,
    surchargedIdcLcoe: 0,
    developerSalePrice,
  };
}

// ---------------------------------------------------------------------------
// Main entry point: step-aware calculateLcoe.
//
// Step 1 (Wrong):    lump-sum inflation + whole-WACC IDC
// Step 2 (Standard): dynamic inflation + debt-only IDC
// Step 3 (Advanced): same baseline as Step 2, plus independent toggles
// ---------------------------------------------------------------------------
export const calculateLcoe = (
  inputs: LcoeInputs,
  step: LcoeStep,
  adv: AdvancedToggles,
  // Optional pre-computed (sensitivity optimisation)
  precomputed?: { assetCod: number; totalSurchargedIdc: number; df: Float64Array },
): LcoeResult => {
  const { usefulLife, constructionTime } = inputs;
  const TL = Math.max(Math.round(usefulLife), 0);
  const Tc = Math.max(Math.round(constructionTime), 0);
  const { waccNomBlend } = calcNominalWacc(inputs);

  // --- Step-dependent modes ---
  const inflationMode: 'lump_sum' | 'dynamic' = step === 1 ? 'lump_sum' : 'dynamic';
  const idcMode: 'whole_wacc' | 'debt_only' = step === 1 ? 'whole_wacc' : 'debt_only';
  const rabFrac = (step === 3 && adv.rabEnabled) ? 1.0 : 0;
  const declining = step === 3 && adv.decliningWacc;
  const twoLives = step === 3 && adv.twoLives;
  const turnkey = step === 3 && adv.turnkey;

  // Valuation point: always SOC (Turnkey buyer uses COD internally via its own DF array)
  const tcOffset = Tc;

  // --- Construction phase ---
  const { assetCod, totalSurchargedIdc } = precomputed ?? buildConstructionPhase(inputs, inflationMode, idcMode, rabFrac);

  // --- Discount factors ---
  const { costOfDebtNom } = calcNominalWacc(inputs);
  const costOfEquityReal = inputs.costOfEquity / 100;
  const gearingFrac = Math.min(Math.max(inputs.targetGearing, 0), 100) / 100;
  const piRate = inputs.inflationRate / 100;
  const df = precomputed?.df ?? buildDfArray(costOfEquityReal, costOfDebtNom, gearingFrac, piRate, TL, declining, tcOffset);

  // --- Turnkey mode ---
  if (turnkey) {
    return computeTurnkeyLcoe(inputs, assetCod, totalSurchargedIdc, waccNomBlend, declining, twoLives);
  }

  // --- Standard / 2-Lives computation ---
  return computeCoreLcoe(inputs, assetCod, totalSurchargedIdc, df, twoLives);
};

// ---------------------------------------------------------------------------
// useLcoe hook
// ---------------------------------------------------------------------------
export const useLcoe = (
  inputs: LcoeInputs,
  step: LcoeStep,
  adv: AdvancedToggles,
): LcoeResult => {
  return useMemo(
    () => calculateLcoe(inputs, step, adv),
    [inputs, step, adv],
  );
};