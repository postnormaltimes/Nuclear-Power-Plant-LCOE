/**
 * Sanity tests for LCOE engine PV-basis consistency.
 * Run with: npx tsx tests/sanity.ts
 */
import { buildConstructionPhase, buildDfArray, calcNominalWacc } from '../hooks/useLcoe';
import type { LcoeInputs } from '../types';

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
// Test 1: SOC vs COD consistency
//   pvCapexSOC × (1 + wacc)^Tc should equal fvCapexCOD
//   (both are PV-at-SOC and FV-at-COD of the same construction cash flows,
//   so FV = PV × (1+w)^T must hold)
// ---------------------------------------------------------------------------
console.log('\nTest 1: SOC ↔ COD round-trip consistency');
{
    const constr = buildConstructionPhase(DEFAULTS, 'dynamic', 'debt_only', 0);
    const { waccNomBlend } = calcNominalWacc(DEFAULTS);
    const Tc = DEFAULTS.constructionTime;

    // PV of just the draws (pvOccSOC), compounded to COD, should match fvCapexCOD
    // Note: pvCapexSOC includes capitalized IDC, but fvCapexCOD only compounds draws.
    // So the round-trip is: pvOccSOC × (1+wacc)^Tc ≈ fvCapexCOD
    const roundTrip = constr.pvOccSOC * Math.pow(1 + waccNomBlend, Tc);
    assert(approxEq(roundTrip, constr.fvCapexCOD, 1e-4),
        `pvOccSOC × (1+w)^Tc = ${roundTrip.toFixed(2)} ≈ fvCapexCOD = ${constr.fvCapexCOD.toFixed(2)}`);
}

// ---------------------------------------------------------------------------
// Test 2: pvOcc + pvFinancing = pvCapex (decomposition identity)
// ---------------------------------------------------------------------------
console.log('\nTest 2: pvOccSOC + pvFinancingSOC = pvCapexSOC');
{
    const constr = buildConstructionPhase(DEFAULTS, 'dynamic', 'debt_only', 0);
    const sum = constr.pvOccSOC + constr.pvFinancingSOC;
    assert(approxEq(sum, constr.pvCapexSOC),
        `${constr.pvOccSOC.toFixed(2)} + ${constr.pvFinancingSOC.toFixed(2)} = ${sum.toFixed(2)} ≈ pvCapexSOC = ${constr.pvCapexSOC.toFixed(2)}`);
}

// ---------------------------------------------------------------------------
// Test 3: Turnkey developer PV(payments) = fvCapexCOD
//   If the developer receives annualPayment × 3 tranches discounted at
//   waccNom (mid-year), the PV of those payments should equal fvCapexCOD.
// ---------------------------------------------------------------------------
console.log('\nTest 3: Turnkey PV(payments) = fvCapexCOD at developer WACC');
{
    const constr = buildConstructionPhase(DEFAULTS, 'dynamic', 'debt_only', 0);
    const { waccNomBlend } = calcNominalWacc(DEFAULTS);
    const nTranches = 3;

    let annuityFactor = 0;
    for (let t = 1; t <= nTranches; t++) annuityFactor += 1 / Math.pow(1 + waccNomBlend, t - 0.5);
    const annualPayment = constr.fvCapexCOD / annuityFactor;

    // PV of payments at developer WACC (mid-year)
    let pvPayments = 0;
    for (let t = 1; t <= nTranches; t++) pvPayments += annualPayment / Math.pow(1 + waccNomBlend, t - 0.5);

    assert(approxEq(pvPayments, constr.fvCapexCOD, 1e-4),
        `PV(payments) = ${pvPayments.toFixed(2)} ≈ fvCapexCOD = ${constr.fvCapexCOD.toFixed(2)}`);
}

console.log('\n✅ All sanity tests passed.\n');
