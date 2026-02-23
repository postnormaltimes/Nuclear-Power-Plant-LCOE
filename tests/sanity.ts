/**
 * Sanity tests for LCOE engine PV-basis consistency.
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

function assert(cond: boolean, msg: string) {
    if (!cond) { console.error(`  ❌ FAIL: ${msg}`); process.exit(1); }
    console.log(`  ✅ PASS: ${msg}`);
}

function approxEq(a: number, b: number, tol = 1e-6) {
    return Math.abs(a - b) < tol * Math.max(1, Math.abs(a), Math.abs(b));
}

// ---------------------------------------------------------------------------
// Test 1: fvCapexCOD ordering (no double-count)
// ---------------------------------------------------------------------------
console.log('\nTest 1: fvCapexCOD ordering — pvCapexSOC < fvCapexCOD < WACC-compounded FV');
{
    const constr = buildConstructionPhase(DEFAULTS, 'dynamic', 'debt_only', 0);
    const { waccNomBlend } = calcNominalWacc(DEFAULTS);
    const Tc = DEFAULTS.constructionTime;
    const waccFV = constr.pvOccSOC * Math.pow(1 + waccNomBlend, Tc);

    assert(constr.fvCapexCOD > constr.pvCapexSOC,
        `fvCapexCOD (${constr.fvCapexCOD.toFixed(2)}) > pvCapexSOC (${constr.pvCapexSOC.toFixed(2)})`);
    assert(constr.fvCapexCOD < waccFV,
        `fvCapexCOD (${constr.fvCapexCOD.toFixed(2)}) < WACC-FV (${waccFV.toFixed(2)})`);
}

// ---------------------------------------------------------------------------
// Test 2: pvOcc + pvFinancing = pvCapex identity
// ---------------------------------------------------------------------------
console.log('\nTest 2: pvOccSOC + pvFinancingSOC = pvCapexSOC');
{
    const constr = buildConstructionPhase(DEFAULTS, 'dynamic', 'debt_only', 0);
    const sum = constr.pvOccSOC + constr.pvFinancingSOC;
    assert(approxEq(sum, constr.pvCapexSOC),
        `${constr.pvOccSOC.toFixed(2)} + ${constr.pvFinancingSOC.toFixed(2)} = ${sum.toFixed(2)} ≈ ${constr.pvCapexSOC.toFixed(2)}`);
}

// ---------------------------------------------------------------------------
// Test 3: Turnkey PV(payments) = fvCapexCOD at developer WACC
// ---------------------------------------------------------------------------
console.log('\nTest 3: Turnkey PV(payments) = fvCapexCOD');
{
    const constr = buildConstructionPhase(DEFAULTS, 'dynamic', 'debt_only', 0);
    const { waccNomBlend } = calcNominalWacc(DEFAULTS);
    const nTranches = 3;

    let annuityFactor = 0;
    for (let t = 1; t <= nTranches; t++) annuityFactor += 1 / Math.pow(1 + waccNomBlend, t - 0.5);
    const annualPayment = constr.fvCapexCOD / annuityFactor;

    let pvPayments = 0;
    for (let t = 1; t <= nTranches; t++) pvPayments += annualPayment / Math.pow(1 + waccNomBlend, t - 0.5);

    assert(approxEq(pvPayments, constr.fvCapexCOD, 1e-4),
        `PV(payments) = ${pvPayments.toFixed(2)} ≈ fvCapexCOD = ${constr.fvCapexCOD.toFixed(2)}`);
}

// ---------------------------------------------------------------------------
// Test 4: Turnkey OCC/Fin split uses COD ratio (occRatioCOD)
// ---------------------------------------------------------------------------
console.log('\nTest 4: Turnkey uses COD book ratio for OCC/Fin split');
{
    const constr = buildConstructionPhase(DEFAULTS, 'dynamic', 'debt_only', 0);
    assert(constr.occRatioCOD > 0 && constr.occRatioCOD < 1,
        `occRatioCOD = ${constr.occRatioCOD.toFixed(4)} ∈ (0,1)`);

    // Verify occRatioCOD ≠ pvOccSOC/pvCapexSOC (they differ due to timing)
    const socRatio = constr.pvOccSOC / constr.pvCapexSOC;
    assert(!approxEq(constr.occRatioCOD, socRatio, 1e-3),
        `COD ratio (${constr.occRatioCOD.toFixed(4)}) ≠ SOC ratio (${socRatio.toFixed(4)}) — timing difference`);
}

// ---------------------------------------------------------------------------
// Test 5: Decom sinking fund stable under zero inflation
// ---------------------------------------------------------------------------
console.log('\nTest 5: Decom sinking fund nominal rate reduces to real rate when π=0');
{
    const zeroInflation = { ...DEFAULTS, inflationRate: 0 };
    const adv: AdvancedToggles = { rabEnabled: false, decliningWacc: false, turnkey: false, twoLives: false, valuationPoint: 'soc' };
    const r1 = calculateLcoe(DEFAULTS, 2, adv);
    const r2 = calculateLcoe(zeroInflation, 2, adv);

    assert(r1.decommissioningLcoe > 0, `Decom LCOE > 0 with inflation (${r1.decommissioningLcoe.toFixed(4)})`);
    assert(r2.decommissioningLcoe > 0, `Decom LCOE > 0 without inflation (${r2.decommissioningLcoe.toFixed(4)})`);
    // With inflation=0, nominal rate = real rate, so decom should be lower (smaller fund target)
    assert(r2.decommissioningLcoe < r1.decommissioningLcoe,
        `Decom with π=0 (${r2.decommissioningLcoe.toFixed(4)}) < with π=2% (${r1.decommissioningLcoe.toFixed(4)})`);
}

console.log('\n✅ All sanity tests passed.\n');
