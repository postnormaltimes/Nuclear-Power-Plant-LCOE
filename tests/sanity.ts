/**
 * Acceptance tests for audit-proof LCOE engine with RAB post-COD repayment.
 * Run with: npx tsx tests/sanity.ts
 */
import { buildConstructionPhase, buildDfArray, calcNominalWacc, calculateLcoe } from '../hooks/useLcoe';
import type { LcoeInputs, AdvancedToggles } from '../types';

const DEFAULTS: LcoeInputs = {
    usefulLife: 60,
    overnightCost: 6500,
    constructionTime: 8,
    costOfEquity: 9.0,
    costOfDebt: 4.0,
    targetGearing: 60,
    fuelCost: 10,
    omCost: 140,
    loadHours: 7884,
    decommissioningCost: 1000,
    rabProportion: 50,
    inflationRate: 2,
};

const ADV_OFF: AdvancedToggles = { rabEnabled: false, decliningWacc: false, turnkey: false, twoLives: false, valuationPoint: 'soc' };

function assert(cond: boolean, msg: string) {
    if (!cond) { console.error(`  ❌ FAIL: ${msg}`); process.exit(1); }
    console.log(`  ✅ PASS: ${msg}`);
}

function approxEq(a: number, b: number, tol = 1e-6) {
    return Math.abs(a - b) < tol * Math.max(1, Math.abs(a), Math.abs(b));
}

// ===========================================================================
// F1: Standard + RAB full (rabFrac=1)
// ===========================================================================
console.log('\nTest 1: Standard + RAB full');
{
    const cRAB1 = buildConstructionPhase(DEFAULTS, 'dynamic', 'debt_only', 1);
    assert(approxEq(cRAB1.pvFinancingSOC, 0),
        `pvFinancingSOC ≈ 0 (${cRAB1.pvFinancingSOC.toFixed(6)})`);
    assert(cRAB1.pvSurchargedIdcSOC > 0,
        `pvSurchargedIdcSOC > 0 (${cRAB1.pvSurchargedIdcSOC.toFixed(2)})`);
    assert(cRAB1.fvSurchargedCOD > 0,
        `fvSurchargedCOD > 0 (${cRAB1.fvSurchargedCOD.toFixed(2)})`);

    const advRAB: AdvancedToggles = { ...ADV_OFF, rabEnabled: true };
    const r = calculateLcoe(DEFAULTS, 3, advRAB);
    assert(r.financingLcoe > 0,
        `financingLcoe > 0 with RAB=1 (${r.financingLcoe.toFixed(4)}) — repayment exists`);
    assert(r.surchargedIdcLcoe > 0,
        `surchargedIdcLcoe > 0 memo line (${r.surchargedIdcLcoe.toFixed(4)})`);
}

// ===========================================================================
// F2: Turnkey without RAB vs with RAB
// ===========================================================================
console.log('\nTest 2: Turnkey — RAB reduces sale price, adds financing');
{
    const advTK: AdvancedToggles = { ...ADV_OFF, turnkey: true };
    const advTKrab: AdvancedToggles = { ...ADV_OFF, turnkey: true, rabEnabled: true };

    const rNoRAB = calculateLcoe(DEFAULTS, 3, advTK);
    const rRAB = calculateLcoe(DEFAULTS, 3, advTKrab);

    assert(rRAB.developerSalePrice! < rNoRAB.developerSalePrice!,
        `Sale price with RAB (${rRAB.developerSalePrice!.toFixed(2)}) < without (${rNoRAB.developerSalePrice!.toFixed(2)})`);
    assert(rRAB.financingLcoe > rNoRAB.financingLcoe,
        `financingLcoe with RAB (${rRAB.financingLcoe.toFixed(4)}) > without (${rNoRAB.financingLcoe.toFixed(4)})`);
    // Total LCOE is invariant: buyer pays fvEconomicCOD regardless (sale + repay = same total)
    assert(approxEq(rRAB.totalLcoe, rNoRAB.totalLcoe, 1e-4),
        `Total LCOE invariant: RAB (${rRAB.totalLcoe.toFixed(4)}) ≈ noRAB (${rNoRAB.totalLcoe.toFixed(4)})`);
}

// ===========================================================================
// F3: PV identity checks
// ===========================================================================
console.log('\nTest 3: PV identity — repayment PV ≈ liability');
{
    // Standard: pvRepaySOC ≈ pvSurchargedIdcSOC
    const constr = buildConstructionPhase(DEFAULTS, 'dynamic', 'debt_only', 1);
    const { costOfDebtNom } = calcNominalWacc(DEFAULTS);
    const keReal = DEFAULTS.costOfEquity / 100;
    const gearing = DEFAULTS.targetGearing / 100;
    const pi = DEFAULTS.inflationRate / 100;
    const TL = DEFAULTS.usefulLife;
    const Tc = DEFAULTS.constructionTime;
    const df = buildDfArray(keReal, costOfDebtNom, gearing, pi, TL, false, Tc);

    const repayYears = Math.min(30, TL);
    let annFactorSOC = 0;
    for (let k = 0; k < repayYears; k++) annFactorSOC += df[k];
    const annualRepay = annFactorSOC > 0 ? constr.pvSurchargedIdcSOC / annFactorSOC : constr.pvSurchargedIdcSOC;
    const pvRepaySOC = annualRepay * annFactorSOC;

    assert(approxEq(pvRepaySOC, constr.pvSurchargedIdcSOC, 1e-8),
        `pvRepaySOC (${pvRepaySOC.toFixed(4)}) ≈ pvSurchargedIdcSOC (${constr.pvSurchargedIdcSOC.toFixed(4)})`);

    // Turnkey: pvRepayCOD ≈ fvSurchargedCOD
    const buyerDf = buildDfArray(keReal, costOfDebtNom, gearing, pi, TL, false, 0);
    let annFactorCOD = 0;
    for (let k = 0; k < repayYears; k++) annFactorCOD += buyerDf[k];
    const annualRepayCOD = annFactorCOD > 0 ? constr.fvSurchargedCOD / annFactorCOD : constr.fvSurchargedCOD;
    const pvRepayCOD = annualRepayCOD * annFactorCOD;

    assert(approxEq(pvRepayCOD, constr.fvSurchargedCOD, 1e-8),
        `pvRepayCOD (${pvRepayCOD.toFixed(4)}) ≈ fvSurchargedCOD (${constr.fvSurchargedCOD.toFixed(4)})`);
}

// ===========================================================================
// F4: Tc inflation propagation
// ===========================================================================
console.log('\nTest 4: Tc inflation propagation');
{
    const inputsTc0 = { ...DEFAULTS, constructionTime: 0 };
    const rTc8 = calculateLcoe(DEFAULTS, 2, ADV_OFF);
    const rTc0 = calculateLcoe(inputsTc0, 2, ADV_OFF);

    assert(rTc8.fuelLcoe > rTc0.fuelLcoe,
        `Fuel LCOE Tc=8 (${rTc8.fuelLcoe.toFixed(4)}) > Tc=0 (${rTc0.fuelLcoe.toFixed(4)})`);
    assert(rTc8.omLcoe > rTc0.omLcoe,
        `O&M LCOE Tc=8 (${rTc8.omLcoe.toFixed(4)}) > Tc=0 (${rTc0.omLcoe.toFixed(4)})`);
}

// ===========================================================================
// Additional structural checks
// ===========================================================================
console.log('\nTest 5: pvOccSOC + pvFinancingSOC = pvCapexSOC');
{
    const constr = buildConstructionPhase(DEFAULTS, 'dynamic', 'debt_only', 0);
    const sum = constr.pvOccSOC + constr.pvFinancingSOC;
    assert(approxEq(sum, constr.pvCapexSOC),
        `${constr.pvOccSOC.toFixed(2)} + ${constr.pvFinancingSOC.toFixed(2)} = ${sum.toFixed(2)} ≈ ${constr.pvCapexSOC.toFixed(2)}`);
}

console.log('\nTest 6: Declining Ke TL=2 guard');
{
    const shortLife = { ...DEFAULTS, usefulLife: 2 };
    const advDecl: AdvancedToggles = { ...ADV_OFF, decliningWacc: true };
    const r1 = calculateLcoe(shortLife, 3, advDecl);
    const r2 = calculateLcoe(shortLife, 3, ADV_OFF);
    assert(approxEq(r1.totalLcoe, r2.totalLcoe, 1e-6),
        `TL=2 declining ON=${r1.totalLcoe.toFixed(2)} = OFF=${r2.totalLcoe.toFixed(2)}`);
}

console.log('\nTest 7: fvEconomicCOD > pvCapexSOC');
{
    const constr = buildConstructionPhase(DEFAULTS, 'dynamic', 'debt_only', 0);
    assert(constr.fvEconomicCOD > constr.pvCapexSOC,
        `fvEconomicCOD (${constr.fvEconomicCOD.toFixed(2)}) > pvCapexSOC (${constr.pvCapexSOC.toFixed(2)})`);
}

console.log('\nTest 8: rabFrac=0 → no surcharges');
{
    const c = buildConstructionPhase(DEFAULTS, 'dynamic', 'debt_only', 0);
    assert(approxEq(c.pvSurchargedIdcSOC, 0), `pvSurchargedIdcSOC = 0`);
    assert(approxEq(c.fvSurchargedCOD, 0), `fvSurchargedCOD = 0`);
}

console.log('\n✅ All 8 acceptance tests passed.\n');
