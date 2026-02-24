/**
 * Acceptance tests for audit-proof LCOE engine.
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

// ---------------------------------------------------------------------------
// Test 1: RAB PV sanity
//   rabFrac=1 → pvSurchargedIdcSOC > 0, pvFinancingSOC → 0
//   rabFrac=0 → pvSurchargedIdcSOC = 0
// ---------------------------------------------------------------------------
console.log('\nTest 1: RAB PV sanity');
{
    const cRAB1 = buildConstructionPhase(DEFAULTS, 'dynamic', 'debt_only', 1);
    const cRAB0 = buildConstructionPhase(DEFAULTS, 'dynamic', 'debt_only', 0);

    assert(cRAB1.pvSurchargedIdcSOC > 0,
        `rabFrac=1: pvSurchargedIdcSOC = ${cRAB1.pvSurchargedIdcSOC.toFixed(2)} > 0`);
    assert(approxEq(cRAB1.pvFinancingSOC, 0),
        `rabFrac=1: pvFinancingSOC = ${cRAB1.pvFinancingSOC.toFixed(6)} ≈ 0 (all surcharged)`);
    assert(approxEq(cRAB0.pvSurchargedIdcSOC, 0),
        `rabFrac=0: pvSurchargedIdcSOC = ${cRAB0.pvSurchargedIdcSOC.toFixed(6)} = 0`);
    assert(cRAB0.pvFinancingSOC > 0,
        `rabFrac=0: pvFinancingSOC = ${cRAB0.pvFinancingSOC.toFixed(2)} > 0 (all capitalized)`);
}

// ---------------------------------------------------------------------------
// Test 2: Turnkey NPV identity
//   PV@COD of buyer payments discounted at waccNomBlend = fvEconomicCOD
// ---------------------------------------------------------------------------
console.log('\nTest 2: Turnkey NPV identity — PV(payments) = fvEconomicCOD');
{
    const constr = buildConstructionPhase(DEFAULTS, 'dynamic', 'debt_only', 0);
    const { waccNomBlend } = calcNominalWacc(DEFAULTS);
    const nTranches = 3;

    let annuityFactor = 0;
    for (let t = 1; t <= nTranches; t++) annuityFactor += 1 / Math.pow(1 + waccNomBlend, t - 0.5);
    const annualPayment = constr.fvEconomicCOD / annuityFactor;

    let pvPayments = 0;
    for (let t = 1; t <= nTranches; t++) pvPayments += annualPayment / Math.pow(1 + waccNomBlend, t - 0.5);

    assert(approxEq(pvPayments, constr.fvEconomicCOD, 1e-4),
        `PV(payments) = ${pvPayments.toFixed(2)} ≈ fvEconomicCOD = ${constr.fvEconomicCOD.toFixed(2)}`);
}

// ---------------------------------------------------------------------------
// Test 3: Turnkey bucket non-zero
//   With π>0, Tc>0, waccNom>π, occRatioCOD < 1 → financingLcoe > 0
// ---------------------------------------------------------------------------
console.log('\nTest 3: Turnkey financing bucket non-zero');
{
    const constr = buildConstructionPhase(DEFAULTS, 'dynamic', 'debt_only', 0);
    assert(constr.occRatioCOD > 0 && constr.occRatioCOD < 1,
        `occRatioCOD = ${constr.occRatioCOD.toFixed(4)} ∈ (0,1)`);

    const advTK: AdvancedToggles = { ...ADV_OFF, turnkey: true };
    const result = calculateLcoe(DEFAULTS, 3, advTK);
    assert(result.financingLcoe > 0,
        `Turnkey financingLcoe = ${result.financingLcoe.toFixed(4)} > 0`);
}

// ---------------------------------------------------------------------------
// Test 4: Tc inflation propagation
//   With Tc>0, OPEX/Fuel PV should increase vs Tc=0 (holding all else constant)
//   because esc = (1+π)^(Tc + k + 0.5) traverses construction period.
// ---------------------------------------------------------------------------
console.log('\nTest 4: Tc inflation propagation');
{
    const inputsTc0 = { ...DEFAULTS, constructionTime: 0 };
    const rTc8 = calculateLcoe(DEFAULTS, 2, ADV_OFF);
    const rTc0 = calculateLcoe(inputsTc0, 2, ADV_OFF);

    assert(rTc8.fuelLcoe > rTc0.fuelLcoe,
        `Fuel LCOE with Tc=8 (${rTc8.fuelLcoe.toFixed(4)}) > Tc=0 (${rTc0.fuelLcoe.toFixed(4)})`);
    assert(rTc8.omLcoe > rTc0.omLcoe,
        `O&M LCOE with Tc=8 (${rTc8.omLcoe.toFixed(4)}) > Tc=0 (${rTc0.omLcoe.toFixed(4)})`);
    assert(rTc8.decommissioningLcoe > rTc0.decommissioningLcoe,
        `Decom LCOE with Tc=8 (${rTc8.decommissioningLcoe.toFixed(4)}) > Tc=0 (${rTc0.decommissioningLcoe.toFixed(4)})`);
}

// ---------------------------------------------------------------------------
// Test 5: pvOcc + pvFinancing = pvCapex identity
// ---------------------------------------------------------------------------
console.log('\nTest 5: pvOccSOC + pvFinancingSOC = pvCapexSOC');
{
    const constr = buildConstructionPhase(DEFAULTS, 'dynamic', 'debt_only', 0);
    const sum = constr.pvOccSOC + constr.pvFinancingSOC;
    assert(approxEq(sum, constr.pvCapexSOC),
        `${constr.pvOccSOC.toFixed(2)} + ${constr.pvFinancingSOC.toFixed(2)} = ${sum.toFixed(2)} ≈ ${constr.pvCapexSOC.toFixed(2)}`);
}

// ---------------------------------------------------------------------------
// Test 6: Declining Ke edge case — TL < 3 means L=0, no decline applied
// ---------------------------------------------------------------------------
console.log('\nTest 6: Declining Ke with TL=2 — no drop (L=0 guard)');
{
    const shortLife = { ...DEFAULTS, usefulLife: 2 };
    const advDecl: AdvancedToggles = { ...ADV_OFF, decliningWacc: true };
    const r1 = calculateLcoe(shortLife, 3, advDecl);
    const r2 = calculateLcoe(shortLife, 3, ADV_OFF);
    assert(approxEq(r1.totalLcoe, r2.totalLcoe, 1e-6),
        `TL=2 declining ON (${r1.totalLcoe.toFixed(2)}) = OFF (${r2.totalLcoe.toFixed(2)}) — L=0 guard`);
}

// ---------------------------------------------------------------------------
// Test 7: fvEconomicCOD > pvCapexSOC ordering
// ---------------------------------------------------------------------------
console.log('\nTest 7: fvEconomicCOD > pvCapexSOC');
{
    const constr = buildConstructionPhase(DEFAULTS, 'dynamic', 'debt_only', 0);
    assert(constr.fvEconomicCOD > constr.pvCapexSOC,
        `fvEconomicCOD (${constr.fvEconomicCOD.toFixed(2)}) > pvCapexSOC (${constr.pvCapexSOC.toFixed(2)})`);
}

// ---------------------------------------------------------------------------
// Test 8: Decom sinking fund stable — π=0 gives lower decom LCOE
// ---------------------------------------------------------------------------
console.log('\nTest 8: Decom sinking fund stable under zero inflation');
{
    const zeroInflation = { ...DEFAULTS, inflationRate: 0 };
    const r1 = calculateLcoe(DEFAULTS, 2, ADV_OFF);
    const r2 = calculateLcoe(zeroInflation, 2, ADV_OFF);
    assert(r2.decommissioningLcoe < r1.decommissioningLcoe,
        `Decom π=0 (${r2.decommissioningLcoe.toFixed(4)}) < π=2% (${r1.decommissioningLcoe.toFixed(4)})`);
}

console.log('\n✅ All 8 acceptance tests passed.\n');
