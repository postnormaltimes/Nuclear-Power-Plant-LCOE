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
// Model Contract: costOfDebt and costOfEquity are REAL rates (user inputs).
//   Fisher equation converts each to nominal: W_nom = (1+W_real)(1+π)−1
//   Target gearing (wD) used for blending: WACC = wD·Kd + wE·Ke
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
    // Declining REAL cost of equity, then Fisher to nominal.
    // Guard: L must be > 0 to apply tranches (avoids immediate drop for TL < 3).
    let keReal = costOfEquityReal;
    if (declining && L > 0) {
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
// Construction phase result types.
// ---------------------------------------------------------------------------

/** Strict IDC mode type: AFUDC (regulated utility) vs debt-only (project finance). */
export type IdcMode = 'afudc_whole_wacc' | 'debt_only';

export interface ConstructionResult {
  /** PV at SOC of nominal capital draws (overnight cost component). */
  pvOccSOC: number;
  /** PV at SOC of capitalized financing during construction. */
  pvFinancingSOC: number;
  /** pvOccSOC + pvFinancingSOC. */
  pvCapexSOC: number;

  /** Economic FV at COD for turnkey (NPV=0 at SOC):
   *  Σ cNom[t] × (1+wacc)^(Tc − t − 0.5). */
  fvEconomicCOD: number;

  /** COD-basis OCC ratio: fvOccBookCOD / fvEconomicCOD.
   *  fvOccBookCOD = inflation-only compounded draws.
   *  Financing bucket = WACC uplift over pure inflation. */
  occRatioCOD: number;

  /** PV at SOC of surcharged carrying costs (RAB). Memo line. */
  pvSurchargedIdcSOC: number;

  /** Economic FV at COD of construction-period surcharges.
   *  = Σ surchargeNom[t] × (1+wacc)^(Tc − t − 0.5).
   *  Used for (i) netting in turnkey pricing, (ii) post-COD repayment liability. */
  fvSurchargedCOD: number;
}

// ---------------------------------------------------------------------------
// Phases A + B: Construction cost build-up and capitalized financing.
//
// Returns PV-at-SOC components (consistent with df[tcOffset=Tc]),
// Economic FV-at-COD (for turnkey developer pricing),
// and FV-at-COD of surcharges (for RAB post-COD repayment).
//
// Model Contract: All cost inputs are real SOC-year currency.
//
// inflationMode:
//   'lump_sum' (Step 1 wrong): OCC × (1+π)^Tc then S-curve distribute
//   'dynamic'  (Step 2+):      each tranche inflated to its mid-year period
//
// idcMode:
//   'afudc_whole_wacc' (Step 1): AFUDC proxy — carrying cost on whole capital
//   'debt_only' (Step 2+):       interest only on debt tranche at Kd_nom
//
// RAB model: surcharges collected during construction are temporary prepayments.
//   fvSurchargedCOD = WACC-compounded FV of surcharges at COD.
//   Post-COD, the plant owner must repay this liability via a level annuity.
// ---------------------------------------------------------------------------
export function buildConstructionPhase(
  inputs: LcoeInputs,
  inflationMode: 'lump_sum' | 'dynamic',
  idcMode: IdcMode,
  rabFrac: number,
): ConstructionResult {
  const { overnightCost, constructionTime, inflationRate } = inputs;

  const Tc = Math.max(0, Math.round(constructionTime));
  if (Tc === 0) return {
    pvOccSOC: overnightCost,
    pvFinancingSOC: 0,
    pvCapexSOC: overnightCost,
    fvEconomicCOD: overnightCost,
    occRatioCOD: 1,
    pvSurchargedIdcSOC: 0,
    fvSurchargedCOD: 0,
  };

  const pi = inflationRate / 100;
  const gearing = Math.min(Math.max(inputs.targetGearing, 0), 100) / 100;
  const { waccNomBlend, costOfDebtNom } = calcNominalWacc(inputs);

  // Phase A: S-Curve drawdown (nominal at each mid-year t+0.5; inputs are real SOC-year)
  const cNom = new Float64Array(Tc);
  const weights = new Float64Array(Tc);
  let weightSum = 0;

  for (let t = 0; t < Tc; t++) {
    weights[t] = Math.sin(Math.PI * (t + 0.5) / Tc);
    weightSum += weights[t];
  }

  if (inflationMode === 'lump_sum') {
    // Intentionally "wrong example" mode
    const capexCod = overnightCost * Math.pow(1 + pi, Tc);
    for (let t = 0; t < Tc; t++) cNom[t] = capexCod * (weights[t] / weightSum);
  } else {
    for (let t = 0; t < Tc; t++) {
      cNom[t] = overnightCost * (weights[t] / weightSum) * Math.pow(1 + pi, t + 0.5);
    }
  }

  // Phase B: Capitalized financing during construction + RAB surcharge tracking
  const capIdcPerYear = new Float64Array(Tc);

  // PV@SOC of surcharges (RAB memo line) + FV@COD of surcharges (RAB liability)
  let pvSurchargedIdcSOC = 0;
  let fvSurchargedCOD = 0;

  if (idcMode === 'afudc_whole_wacc') {
    // AFUDC proxy: carrying cost on whole capital at WACC
    let K = 0;
    for (let t = 0; t < Tc; t++) {
      const carryingCost = (K + cNom[t] / 2) * waccNomBlend;
      const surcharged = carryingCost * rabFrac;
      const capitalized = carryingCost * (1 - rabFrac);

      const dfSoc = 1 / Math.pow(1 + waccNomBlend, t + 0.5);
      pvSurchargedIdcSOC += surcharged * dfSoc;

      // FV@COD of surcharge: same timing, WACC-compounded to COD
      const compWacc = Math.pow(1 + waccNomBlend, Tc - (t + 0.5));
      fvSurchargedCOD += surcharged * compWacc;

      capIdcPerYear[t] = capitalized;
      K += cNom[t] + capitalized;
    }
  } else {
    // Debt-only IDC: interest only on debt tranche at Kd_nom
    let D = 0;
    for (let t = 0; t < Tc; t++) {
      const interest = (D + cNom[t] * gearing / 2) * costOfDebtNom;
      const surcharged = interest * rabFrac;
      const capitalized = interest * (1 - rabFrac);

      const dfSoc = 1 / Math.pow(1 + waccNomBlend, t + 0.5);
      pvSurchargedIdcSOC += surcharged * dfSoc;

      const compWacc = Math.pow(1 + waccNomBlend, Tc - (t + 0.5));
      fvSurchargedCOD += surcharged * compWacc;

      capIdcPerYear[t] = capitalized;
      D += cNom[t] * gearing + capitalized;
    }
  }

  // Phase C: PV@SOC of construction components
  let pvOccSOC = 0;
  let pvFinancingSOC = 0;

  // Economic FV@COD (WACC-compounded) of construction cash outflows
  let fvEconomicCOD = 0;

  // COD book FV@COD (inflation-only) of the same draws => OCC bucket basis
  let fvOccBookCOD = 0;

  for (let t = 0; t < Tc; t++) {
    const dfSoc = 1 / Math.pow(1 + waccNomBlend, t + 0.5);
    pvOccSOC += cNom[t] * dfSoc;
    pvFinancingSOC += capIdcPerYear[t] * dfSoc;

    const compWacc = Math.pow(1 + waccNomBlend, Tc - (t + 0.5));
    fvEconomicCOD += cNom[t] * compWacc;

    // Keep Step 1 internally consistent: in lump_sum mode, cNom is already COD-year nominal
    const compInfl = inflationMode === 'lump_sum'
      ? 1
      : Math.pow(1 + pi, Tc - (t + 0.5));

    fvOccBookCOD += cNom[t] * compInfl;
  }

  const pvCapexSOC = pvOccSOC + pvFinancingSOC;

  // Turnkey decomposition: OCC = COD-book (inflation-only), Financing = WACC uplift
  const occRatioCOD = fvEconomicCOD > 0 ? fvOccBookCOD / fvEconomicCOD : 1;

  return {
    pvOccSOC, pvFinancingSOC, pvCapexSOC,
    fvEconomicCOD, occRatioCOD,
    pvSurchargedIdcSOC, fvSurchargedCOD,
  };
}

// ---------------------------------------------------------------------------
// Core LCOE computation (single or double life).
//
// Model Contract: All cost inputs are real SOC-year currency.
// Operational costs escalated by (1+π)^(Tc + k + 0.5) to account for
// inflation from SOC through construction into each operational year.
//
// RAB effect: surcharges reduce pvFinancingSOC (capitalized IDC is lower).
// pvSurchargedIdcSOC is kept as a memo line only (not added to total).
//
// All inputs are PV-at-SOC consistent:
//   pvOccSOC, pvFinancingSOC = PV at SOC of construction components
//   df[] includes tcOffset=Tc, so operational PVs are also at SOC.
// ---------------------------------------------------------------------------
function computeCoreLcoe(
  inputs: LcoeInputs,
  pvOccSOC: number,
  pvFinancingSOC: number,
  pvSurchargedIdcSOC: number,
  df: Float64Array,
  twoLives: boolean,
): LcoeResult {
  const { usefulLife, constructionTime, fuelCost, omCost, loadHours, decommissioningCost, inflationRate } = inputs;
  const pi = inflationRate / 100;
  const TL = Math.max(Math.round(usefulLife), 0);
  const Tc = Math.max(Math.round(constructionTime), 0);
  const annualMwh = loadHours > 0 ? loadHours / 1000 : 0;
  const zero: LcoeResult = { totalLcoe: 0, occLcoe: 0, financingLcoe: 0, fuelLcoe: 0, omLcoe: 0, decommissioningLcoe: 0, surchargedIdcLcoe: 0 };
  if (annualMwh <= 0 || TL <= 0) return zero;

  // Decom sinking fund — rate is REAL, Fisher-convert to nominal.
  // SOC-real decom cost → nominal at end-of-life (Tc + TL from SOC).
  const decomFundRateReal = 0.01;
  const decomFundRateNom = (1 + decomFundRateReal) * (1 + pi) - 1;
  const futureDecomCost = decommissioningCost * Math.pow(1 + pi, Tc + TL);
  const annualDecom = decomFundRateNom > 0 && TL > 0
    ? futureDecomCost * (decomFundRateNom / (Math.pow(1 + decomFundRateNom, TL) - 1))
    : (TL > 0 ? futureDecomCost / TL : 0);

  const baseFuelCost = fuelCost * annualMwh;
  const baseOmCost = omCost;

  if (!twoLives) {
    // ---------- SINGLE LIFE ----------
    let pvEnergy = 0, pvOm = 0, pvFuel = 0, pvDecom = 0;
    for (let k = 0; k < TL; k++) {
      const d = df[k];
      // SOC-real inputs → nominal at operational mid-year: (1+π)^(Tc + k + 0.5)
      const esc = Math.pow(1 + pi, Tc + k + 0.5);
      pvEnergy += annualMwh * d;
      pvOm += baseOmCost * esc * d;
      pvFuel += baseFuelCost * esc * d;
      pvDecom += annualDecom * d;
    }
    if (pvEnergy <= 0) return zero;
    const totalPvCost = pvOccSOC + pvFinancingSOC + pvOm + pvFuel + pvDecom;
    return {
      totalLcoe: totalPvCost / pvEnergy,
      occLcoe: pvOccSOC / pvEnergy,
      financingLcoe: pvFinancingSOC / pvEnergy,
      fuelLcoe: pvFuel / pvEnergy,
      omLcoe: pvOm / pvEnergy,
      decommissioningLcoe: pvDecom / pvEnergy,
      surchargedIdcLcoe: pvSurchargedIdcSOC > 0 ? pvSurchargedIdcSOC / pvEnergy : 0,
    };
  }

  // ---------- 2-LIVES (PV-correct aggregation) ----------
  const N1 = Math.ceil(TL / 2);

  let pvE1 = 0, pvO1 = 0, pvF1 = 0, pvD1 = 0;
  let pvE2 = 0, pvO2 = 0, pvF2 = 0, pvD2 = 0;

  for (let k = 0; k < TL; k++) {
    const d = df[k];
    const esc = Math.pow(1 + pi, Tc + k + 0.5);
    const e = annualMwh * d;
    const o = baseOmCost * esc * d;
    const f = baseFuelCost * esc * d;
    const dc = annualDecom * d;
    if (k < N1) { pvE1 += e; pvO1 += o; pvF1 += f; pvD1 += dc; }
    else { pvE2 += e; pvO2 += o; pvF2 += f; pvD2 += dc; }
  }

  const pvEnergyTotal = pvE1 + pvE2;
  if (pvEnergyTotal <= 0) return zero;

  const pvOpexTotal = (pvO1 + pvO2) + (pvF1 + pvF2) + (pvD1 + pvD2);
  const totalLcoe = (pvOccSOC + pvFinancingSOC + pvOpexTotal) / pvEnergyTotal;

  const halfLcoe1 = pvE1 > 0 ? (pvOccSOC + pvFinancingSOC + pvO1 + pvF1 + pvD1) / pvE1 : 0;
  const halfLcoe2 = pvE2 > 0 ? (pvO2 + pvF2 + pvD2) / pvE2 : 0;

  return {
    totalLcoe,
    occLcoe: pvOccSOC / pvEnergyTotal,
    financingLcoe: pvFinancingSOC / pvEnergyTotal,
    fuelLcoe: (pvF1 + pvF2) / pvEnergyTotal,
    omLcoe: (pvO1 + pvO2) / pvEnergyTotal,
    decommissioningLcoe: (pvD1 + pvD2) / pvEnergyTotal,
    surchargedIdcLcoe: pvSurchargedIdcSOC > 0 ? pvSurchargedIdcSOC / pvEnergyTotal : 0,
    halfLcoe1,
    halfLcoe2,
  };
}

// ---------------------------------------------------------------------------
// Economic Turnkey model with RAB support.
//
// Developer model: builds the plant, sells at COD.
//   fvEconomicCOD = Σ cNom[t] × (1+wacc)^(Tc−t−0.5).
//   Under RAB, developer receives surcharges during construction.
//   Net COD recovery = max(0, fvEconomicCOD − fvSurchargedCOD).
//   Payment in 3 mid-year tranches post-COD.
//
// Buyer model: t=0 = COD, pays 3 tranches then operates.
//   LCOE = PV(sale tranches + opex) / PV(MWh) from buyer's perspective.
//   OCC invariant: occRatioNet = fvOccBookCOD / fvEconomicNetCOD.
//   RAB permanently reduces financing (no post-COD repayment).
// ---------------------------------------------------------------------------
function computeTurnkeyLcoe(
  inputs: LcoeInputs,
  fvEconomicCOD: number,
  fvSurchargedCOD: number,
  occRatioCOD: number,
  declining: boolean,
): LcoeResult {
  const { usefulLife, constructionTime, fuelCost, omCost, loadHours, decommissioningCost, inflationRate } = inputs;
  const pi = inflationRate / 100;
  const TL = Math.max(Math.round(usefulLife), 0);
  const Tc = Math.max(Math.round(constructionTime), 0);
  const annualMwh = loadHours > 0 ? loadHours / 1000 : 0;
  const zero: LcoeResult = { totalLcoe: 0, occLcoe: 0, financingLcoe: 0, fuelLcoe: 0, omLcoe: 0, decommissioningLcoe: 0, surchargedIdcLcoe: 0 };
  if (annualMwh <= 0 || TL <= 0) return zero;

  // Developer sale price: net of RAB surcharge inflows during construction.
  // Developer requires fvEconomicCOD at COD but already received surcharges
  // worth fvSurchargedCOD (WACC-compounded to COD).
  const fvEconomicNetCOD = Math.max(0, fvEconomicCOD - fvSurchargedCOD);

  // Buyer model: t=0 = COD, no construction-period discounting
  const { costOfDebtNom: kdNom } = calcNominalWacc(inputs);
  const keReal = inputs.costOfEquity / 100;
  const gearingFrac = Math.min(Math.max(inputs.targetGearing, 0), 100) / 100;
  const buyerDf = buildDfArray(keReal, kdNom, gearingFrac, pi, TL, declining, 0);

  // Paid in 3 mid-year tranches post-COD.
  // Annuity factor from buyerDf (not constant waccNom) ensures same discount
  // curve for solving and valuing the payment — critical when declining=true.
  const nTranches = Math.min(3, TL);
  let annuityFactor = 0;
  for (let k = 0; k < nTranches; k++) annuityFactor += buyerDf[k];
  const annualPayment = annuityFactor > 0 ? fvEconomicNetCOD / annuityFactor : fvEconomicNetCOD;
  const developerSalePrice = annualPayment * nTranches;

  // Decom sinking fund — SOC-real → nominal at end-of-life (Tc + TL from SOC)
  const decomFundRateReal = 0.01;
  const decomFundRateNom = (1 + decomFundRateReal) * (1 + pi) - 1;
  const futureDecomCost = decommissioningCost * Math.pow(1 + pi, Tc + TL);
  const annualDecom = decomFundRateNom > 0 && TL > 0
    ? futureDecomCost * (decomFundRateNom / (Math.pow(1 + decomFundRateNom, TL) - 1))
    : (TL > 0 ? futureDecomCost / TL : 0);

  const baseFuelCost = fuelCost * annualMwh;
  const baseOmCost = omCost;

  // PV of sale tranches — same buyerDf used for annuity, so pvSaleTranches ≈ fvEconomicNetCOD
  let pvSaleTranches = 0;
  for (let k = 0; k < nTranches; k++) pvSaleTranches += annualPayment * buyerDf[k];

  let pvEnergy = 0, pvOm = 0, pvFuel = 0, pvDecom = 0;
  for (let k = 0; k < TL; k++) {
    const d = buyerDf[k];
    // SOC-real inputs → nominal at operational mid-year: (1+π)^(Tc + k + 0.5)
    const esc = Math.pow(1 + pi, Tc + k + 0.5);
    pvEnergy += annualMwh * d;
    pvOm += baseOmCost * esc * d;
    pvFuel += baseFuelCost * esc * d;
    pvDecom += annualDecom * d;
  }

  if (pvEnergy <= 0) return zero;

  // OCC-invariant decomposition: derive fvOccBookCOD from occRatioCOD.
  // occRatioCOD = fvOccBookCOD / fvEconomicCOD (set in buildConstructionPhase).
  // occRatioNet = fvOccBookCOD / fvEconomicNetCOD.
  // Since pvSaleTranches / fvEconomicNetCOD = constant (annuity ratio),
  // pvOcc = pvSaleTranches * occRatioNet is invariant under RAB.
  const fvOccBookCOD = occRatioCOD * fvEconomicCOD;
  const occRatioNet = fvEconomicNetCOD > 0 ? Math.min(fvOccBookCOD / fvEconomicNetCOD, 1) : 1;
  const pvOcc = pvSaleTranches * occRatioNet;
  const pvFinancing = pvSaleTranches * (1 - occRatioNet);

  // Total cost = sale tranches (net of RAB) + operating costs. No post-COD repayment.
  const totalPvCost = pvSaleTranches + pvOm + pvFuel + pvDecom;
  return {
    totalLcoe: totalPvCost / pvEnergy,
    occLcoe: pvOcc / pvEnergy,
    financingLcoe: pvFinancing / pvEnergy,
    fuelLcoe: pvFuel / pvEnergy,
    omLcoe: pvOm / pvEnergy,
    decommissioningLcoe: pvDecom / pvEnergy,
    surchargedIdcLcoe: 0, // buyer did not pay during construction
    developerSalePrice,
  };
}

// ---------------------------------------------------------------------------
// Main entry point: step-aware calculateLcoe.
// ---------------------------------------------------------------------------
export const calculateLcoe = (
  inputs: LcoeInputs,
  step: LcoeStep,
  adv: AdvancedToggles,
  precomputed?: ConstructionResult & { df: Float64Array },
): LcoeResult => {
  const { usefulLife, constructionTime } = inputs;
  const TL = Math.max(Math.round(usefulLife), 0);
  const Tc = Math.max(Math.round(constructionTime), 0);
  const { waccNomBlend, costOfDebtNom } = calcNominalWacc(inputs);

  // --- Step-dependent modes ---
  const inflationMode: 'lump_sum' | 'dynamic' = step === 1 ? 'lump_sum' : 'dynamic';
  const idcMode: IdcMode = step === 1 ? 'afudc_whole_wacc' : 'debt_only';
  const rabFrac = (step === 3 && adv.rabEnabled) ? 1.0 : 0;
  const declining = step === 3 && adv.decliningWacc;
  const twoLives = step === 3 && adv.twoLives;
  const turnkey = step === 3 && adv.turnkey;

  // Valuation point: always SOC
  const tcOffset = Tc;

  // --- Construction phase ---
  const constr = precomputed ?? buildConstructionPhase(inputs, inflationMode, idcMode, rabFrac);

  // --- Discount factors (calcNominalWacc cached above) ---
  const costOfEquityReal = inputs.costOfEquity / 100;
  const gearingFrac = Math.min(Math.max(inputs.targetGearing, 0), 100) / 100;
  const piRate = inputs.inflationRate / 100;
  const df = precomputed?.df ?? buildDfArray(costOfEquityReal, costOfDebtNom, gearingFrac, piRate, TL, declining, tcOffset);

  // --- Turnkey mode ---
  if (turnkey) {
    return computeTurnkeyLcoe(
      inputs, constr.fvEconomicCOD, constr.fvSurchargedCOD,
      constr.occRatioCOD, declining,
    );
  }

  // --- Standard / 2-Lives computation ---
  return computeCoreLcoe(inputs, constr.pvOccSOC, constr.pvFinancingSOC, constr.pvSurchargedIdcSOC, df, twoLives);
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