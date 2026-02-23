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
// Construction phase result: PV-at-SOC components + FV-at-COD for turnkey.
// ---------------------------------------------------------------------------
export interface ConstructionResult {
  /** PV at SOC of nominal capital draws (overnight cost component). */
  pvOccSOC: number;
  /** PV at SOC of capitalized debt IDC (financing component). */
  pvFinancingSOC: number;
  /** pvOccSOC + pvFinancingSOC. */
  pvCapexSOC: number;
  /** FV at COD of developer outflows compounded at WACC (turnkey pricing). */
  fvCapexCOD: number;
  /** Surcharged IDC passed to ratepayers (RAB). */
  totalSurchargedIdc: number;
}

// ---------------------------------------------------------------------------
// Phases A + B: Construction cost build-up and IDC.
//
// Returns PV-at-SOC components (consistent with df[tcOffset=Tc])
// and FV-at-COD (for turnkey developer pricing).
//
// inflationMode:
//   'lump_sum' (Step 1 wrong): OCC × (1+π)^Tc then S-curve distribute
//   'dynamic'  (Step 2+):      each tranche inflated to its period
//
// idcMode:
//   'whole_wacc' (Step 1 wrong): carrying cost on FULL capital at blended WACC
//   'debt_only'  (Step 2 correct): interest only on debt tranche at Kd_nom
// ---------------------------------------------------------------------------
export function buildConstructionPhase(
  inputs: LcoeInputs,
  inflationMode: 'lump_sum' | 'dynamic',
  idcMode: 'whole_wacc' | 'debt_only',
  rabFrac: number,
): ConstructionResult {
  const { overnightCost, constructionTime, inflationRate } = inputs;

  const Tc = Math.max(constructionTime, 0);
  if (Tc === 0) return {
    pvOccSOC: overnightCost,
    pvFinancingSOC: 0,
    pvCapexSOC: overnightCost,
    fvCapexCOD: overnightCost,
    totalSurchargedIdc: 0,
  };

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

  // Phase B: IDC accumulation — track per-year capitalized IDC
  const capIdcPerYear = new Float64Array(Tc);
  let totalSurchargedIdc = 0;

  if (idcMode === 'whole_wacc') {
    let K = 0;
    for (let t = 0; t < Tc; t++) {
      const carryingCost = (K + cNom[t] / 2) * waccNomBlend;
      const surcharged = carryingCost * rabFrac;
      const capitalized = carryingCost * (1 - rabFrac);
      totalSurchargedIdc += surcharged;
      capIdcPerYear[t] = capitalized;
      K += cNom[t] + capitalized;
    }
  } else {
    let D = 0;
    for (let t = 0; t < Tc; t++) {
      const interest = (D + cNom[t] * gearing / 2) * costOfDebtNom;
      const surcharged = interest * rabFrac;
      const capitalized = interest * (1 - rabFrac);
      totalSurchargedIdc += surcharged;
      capIdcPerYear[t] = capitalized;
      D += cNom[t] * gearing + capitalized;
    }
  }

  // Phase C: Compute PV at SOC and asset cost at COD.
  // Construction cash flows occur at mid-year of each period (t + 0.5).
  let pvOccSOC = 0;
  let pvFinancingSOC = 0;
  let totalNomCapital = 0;
  let totalCapitalisedIdc = 0;

  for (let t = 0; t < Tc; t++) {
    const dfSoc = 1 / Math.pow(1 + waccNomBlend, t + 0.5);
    pvOccSOC += cNom[t] * dfSoc;
    pvFinancingSOC += capIdcPerYear[t] * dfSoc;
    totalNomCapital += cNom[t];
    totalCapitalisedIdc += capIdcPerYear[t];
  }

  const pvCapexSOC = pvOccSOC + pvFinancingSOC;

  // Turnkey developer required recovery at COD = asset book value at COD.
  // This is Σ cNom + Σ capitalizedIdc (under the chosen IDC mode).
  // No WACC compounding — IDC build-up already embodies financing cost.
  const fvCapexCOD = totalNomCapital + totalCapitalisedIdc;

  return { pvOccSOC, pvFinancingSOC, pvCapexSOC, fvCapexCOD, totalSurchargedIdc };
}

// ---------------------------------------------------------------------------
// Core LCOE computation (single or double life).
//
// All inputs are PV-at-SOC consistent:
//   pvOccSOC, pvFinancingSOC = PV at SOC of construction components
//   df[] includes tcOffset=Tc, so operational PVs are also at SOC.
// ---------------------------------------------------------------------------
function computeCoreLcoe(
  inputs: LcoeInputs,
  pvOccSOC: number,
  pvFinancingSOC: number,
  totalSurchargedIdc: number,
  df: Float64Array,
  twoLives: boolean,
): LcoeResult {
  const { usefulLife, fuelCost, omCost, loadHours, decommissioningCost, inflationRate } = inputs;
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
    const totalPvCost = pvOccSOC + pvFinancingSOC + pvOm + pvFuel + pvDecom;
    return {
      totalLcoe: totalPvCost / pvEnergy,
      occLcoe: pvOccSOC / pvEnergy,
      financingLcoe: pvFinancingSOC / pvEnergy,
      fuelLcoe: pvFuel / pvEnergy,
      omLcoe: pvOm / pvEnergy,
      decommissioningLcoe: pvDecom / pvEnergy,
      surchargedIdcLcoe: totalSurchargedIdc > 0 ? totalSurchargedIdc / pvEnergy : 0,
    };
  }

  // ---------- 2-LIVES (PV-correct aggregation) ----------
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
    surchargedIdcLcoe: totalSurchargedIdc > 0 ? totalSurchargedIdc / pvEnergyTotal : 0,
    halfLcoe1,
    halfLcoe2,
  };
}

// ---------------------------------------------------------------------------
// Turnkey two-model structure.
//
// Developer model: builds the plant, sells at COD.
//   Required COD recovery = FV at COD of all construction outflows
//   compounded at WACC (fvCapexCOD). IDC is implicit in WACC compounding.
//   Payment in 3 mid-year tranches post-COD.
//
// Buyer model: t=0 = COD, pays 3 tranches then operates.
//   LCOE = PV(sale tranches + opex) / PV(MWh) from buyer's perspective.
//   OCC/Financing decomposition uses pvOccSOC/pvFinancingSOC ratio.
// ---------------------------------------------------------------------------
function computeTurnkeyLcoe(
  inputs: LcoeInputs,
  fvCapexCOD: number,
  pvOccSOC: number,
  pvFinancingSOC: number,
  pvCapexSOC: number,
  waccNom: number,
  declining: boolean,
): LcoeResult {
  const { usefulLife, fuelCost, omCost, loadHours, decommissioningCost, inflationRate } = inputs;
  const pi = inflationRate / 100;
  const TL = Math.max(Math.round(usefulLife), 0);
  const annualMwh = loadHours > 0 ? loadHours / 1000 : 0;
  const zero: LcoeResult = { totalLcoe: 0, occLcoe: 0, financingLcoe: 0, fuelLcoe: 0, omLcoe: 0, decommissioningLcoe: 0, surchargedIdcLcoe: 0 };
  if (annualMwh <= 0 || TL <= 0) return zero;

  // Developer sale price: developer requires fvCapexCOD at COD.
  // Paid in 3 mid-year tranches post-COD.
  // P_annual × Σ(1/(1+w)^(t-0.5), t=1..3) = fvCapexCOD
  const nTranches = Math.min(3, TL);
  let annuityFactor = 0;
  for (let t = 1; t <= nTranches; t++) annuityFactor += 1 / Math.pow(1 + waccNom, t - 0.5);
  const annualPayment = annuityFactor > 0 ? fvCapexCOD / annuityFactor : fvCapexCOD;
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

  // PV of sale tranches (buyer pays in years 1..nTranches, mid-year)
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

  // Decompose sale payments into OCC vs Financing using the PV-at-SOC ratio
  // from the construction phase (basis-consistent).
  const occRatio = pvCapexSOC > 0 ? pvOccSOC / pvCapexSOC : 1;
  const pvOcc = pvSaleTranches * occRatio;
  const pvFinancing = pvSaleTranches * (1 - occRatio);

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
  const { waccNomBlend } = calcNominalWacc(inputs);

  // --- Step-dependent modes ---
  const inflationMode: 'lump_sum' | 'dynamic' = step === 1 ? 'lump_sum' : 'dynamic';
  const idcMode: 'whole_wacc' | 'debt_only' = step === 1 ? 'whole_wacc' : 'debt_only';
  const rabFrac = (step === 3 && adv.rabEnabled) ? 1.0 : 0;
  const declining = step === 3 && adv.decliningWacc;
  const twoLives = step === 3 && adv.twoLives;
  const turnkey = step === 3 && adv.turnkey;

  // Valuation point: always SOC
  const tcOffset = Tc;

  // --- Construction phase ---
  const constr = precomputed ?? buildConstructionPhase(inputs, inflationMode, idcMode, rabFrac);

  // --- Discount factors ---
  const { costOfDebtNom } = calcNominalWacc(inputs);
  const costOfEquityReal = inputs.costOfEquity / 100;
  const gearingFrac = Math.min(Math.max(inputs.targetGearing, 0), 100) / 100;
  const piRate = inputs.inflationRate / 100;
  const df = precomputed?.df ?? buildDfArray(costOfEquityReal, costOfDebtNom, gearingFrac, piRate, TL, declining, tcOffset);

  // --- Turnkey mode ---
  if (turnkey) {
    return computeTurnkeyLcoe(
      inputs, constr.fvCapexCOD,
      constr.pvOccSOC, constr.pvFinancingSOC, constr.pvCapexSOC,
      waccNomBlend, declining,
    );
  }

  // --- Standard / 2-Lives computation ---
  return computeCoreLcoe(inputs, constr.pvOccSOC, constr.pvFinancingSOC, constr.totalSurchargedIdc, df, twoLives);
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