import { useMemo } from 'react';
import type { LcoeInputs, LcoeResult } from '../types';

export const calculateLcoe = (
  inputs: LcoeInputs, 
  isRabEnabled: boolean, 
  t0Timing: 'soc' | 'cod',
  waccProfile: 'constant' | 'declining'
): LcoeResult => {
  const {
    usefulLife,
    overnightCost,
    constructionTime,
    wacc,
    fuelCost,
    omCost,
    loadHours,
    decommissioningCost,
  } = inputs;

  const annualMwh = loadHours > 0 ? loadHours / 1000 : 0;
  if (annualMwh <= 0 || usefulLife <= 0) {
    return { totalLcoe: 0, occLcoe: 0, financingLcoe: 0, fuelLcoe: 0, omLcoe: 0, decommissioningLcoe: 0 };
  }

  // --- 1. WACC Profile Setup ---
  const initialWacc = wacc / 100;
  const getWacc = (t: number): number => { // `t` is years from Start of Construction (SOC)
    if (waccProfile === 'constant' || t <= 0) {
      return initialWacc;
    }
    const totalProjectPeriod = constructionTime + usefulLife;
    const p1_len = Math.floor(totalProjectPeriod / 3);
    const p3_len = Math.ceil(totalProjectPeriod / 3);
    const p2_len = totalProjectPeriod - p1_len - p3_len;

    const w1 = initialWacc;
    const w3 = w1 / 3;
    const w2 = (w1 + w3) / 2;

    if (t <= p1_len) return w1;
    if (t <= p1_len + p2_len) return w2;
    return w3;
  };

  // --- 2. Build discount denominators from SOC, and define COD helpers ---
  const discountDenominators: number[] = [1.0]; // D[0] = 1 at SOC
  let lastDenominator = 1.0;
  const maxYear = constructionTime + usefulLife;
  for (let t = 1; t <= maxYear; t++) {
    const r = getWacc(t);
    lastDenominator *= (1 + r);
    discountDenominators.push(lastDenominator); // D[t] = ∏_{τ=1..t}(1+r_τ) from SOC
  }
  const D = (t: number) => discountDenominators[t] || 1;

  // Construction discount factor K = product of (1+r) over construction years
  const K = constructionTime > 0 ? D(constructionTime) : 1.0;

  // For COD base, remove the construction factor from operational discounting
  const denomAt = (opYear: number) => {
    // opYear in 1..usefulLife
    const sdcIndex = constructionTime + opYear;
    if (t0Timing === 'soc') return D(sdcIndex);        // includes construction discount
    return D(sdcIndex) / K;                            // COD base: remove construction discount
  };

  // --- 3. PV of Capital (principal) and construction interest per financing model ---
  let pvTci: number;                 // PV of Total Capital Investment (principal incl. any capitalized IDC) at chosen t0
  let pvConstructionInterest = 0;    // PV of simple, non-capitalized interest (RAB) during construction
  let tciAtCod: number;              // Total Capital Investment at COD (principal at COD)
  const annualConstructionSpending = constructionTime > 0 ? overnightCost / constructionTime : 0;

  if (isRabEnabled) {
    // RAB: interest is not capitalized. Principal at COD equals the overnight cost.
    tciAtCod = overnightCost;

    // Construction interest is paid yearly based on cumulative spending.
    // We only account for it in the SOC case (owner-operator bears it).
    if (t0Timing === 'soc' && constructionTime > 0) {
      let cumulativeSpending = 0;
      for (let t = 1; t <= constructionTime; t++) {
        cumulativeSpending += annualConstructionSpending;
        const r = getWacc(t);
        const interestPayment = cumulativeSpending * r;
        pvConstructionInterest += interestPayment / D(t); // Discount back to t=0
      }
    }
  } else {
    // Standard: capitalize Interest During Construction (IDC) based on cumulative spending and interest.
    if (constructionTime > 0) {
      let totalAccruedInterest = 0;
      let cumulativeSpending = 0;
      for (let t = 1; t <= constructionTime; t++) {
        cumulativeSpending += annualConstructionSpending;
        const r = getWacc(t);
        const interestBase = cumulativeSpending + totalAccruedInterest;
        const yearlyInterest = interestBase * r;
        totalAccruedInterest += yearlyInterest;
      }
      tciAtCod = overnightCost + totalAccruedInterest;
    } else {
      tciAtCod = overnightCost;
    }
  }

  // Discount TCI principal to chosen t0
  if (t0Timing === 'soc') {
    pvTci = tciAtCod / K; // bring principal from COD back to SOC (removes construction factor)
  } else { // COD base
    pvTci = tciAtCod;
  }

  // 3.2. PV of O&M, Fuel, and Decommissioning (operational streams only)
  const annualOmCost = omCost;                 // $/kW-yr
  const annualFuelCost = fuelCost * annualMwh; // $/MWh * MWh/kW-yr = $/kW-yr
  const decomFundGrowthRate = 0.01;
  const annualDecommissioningPayment = decomFundGrowthRate > 0 && usefulLife > 0
    ? decommissioningCost * (decomFundGrowthRate / (Math.pow(1 + decomFundGrowthRate, usefulLife) - 1))
    : (usefulLife > 0 ? decommissioningCost / usefulLife : 0);

  let pvOm = 0;
  let pvFuel = 0;
  let pvDecom = 0;
  let pvEnergy = 0;

  for (let y = 1; y <= usefulLife; y++) {
    const denom = denomAt(y); // correct base: SOC includes K; COD removes K

    pvOm   += annualOmCost / denom;
    pvFuel += annualFuelCost / denom;
    pvDecom+= annualDecommissioningPayment / denom;
    pvEnergy += annualMwh / denom;
  }

  if (pvEnergy <= 0) {
    return { totalLcoe: 0, occLcoe: 0, financingLcoe: 0, fuelLcoe: 0, omLcoe: 0, decommissioningLcoe: 0 };
  }

  // --- 4. Decompose capital into OCC (principal) and Financing (IDC/interest) ---
  // OCC PV is simply the overnight principal valued at the chosen base
  const pvOcc = (t0Timing === 'soc') ? (overnightCost / K) : overnightCost;

  // Financing = (PV of principal incl. IDC) + (PV of construction interest if RAB) - PV of OCC
  // Standard: pvConstructionInterest = 0, so financing = (TCI - OC) at chosen base (identical across SOC/COD)
  // RAB: pvTci = OC at chosen base; financing = yearly interest (SOC only) or 0 (COD)
  const pvFinancing = pvTci + pvConstructionInterest - pvOcc;

  // --- 5. LCOE and components ---
  const totalPvCost = pvOcc + pvFinancing + pvOm + pvFuel + pvDecom;
  const totalLcoe = totalPvCost / pvEnergy;
  const occLcoe = pvOcc / pvEnergy;
  const financingLcoe = pvFinancing / pvEnergy;
  const omLcoe = pvOm / pvEnergy;
  const fuelLcoe = pvFuel / pvEnergy;
  const decommissioningLcoe = pvDecom / pvEnergy;

  return { totalLcoe, occLcoe, financingLcoe, fuelLcoe, omLcoe, decommissioningLcoe };
};


export const useLcoe = (
  inputs: LcoeInputs, 
  isRabEnabled: boolean,
  t0Timing: 'soc' | 'cod',
  waccProfile: 'constant' | 'declining'
): LcoeResult => {
  return useMemo(
    () => calculateLcoe(inputs, isRabEnabled, t0Timing, waccProfile),
    [inputs, isRabEnabled, t0Timing, waccProfile]
  );
};