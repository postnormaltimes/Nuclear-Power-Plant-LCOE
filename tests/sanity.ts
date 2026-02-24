/**
 * Acceptance tests for audit-proof LCOE engine with RAB model.
 * RAB permanently reduces financing (no post-COD repayment).
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
// Test 1: Standard + RAB=1 — financing=0, total lower
// ===========================================================================
console.log('\nTest 1: Standard + RAB full');
{
    const advRAB: AdvancedToggles = { ...ADV_OFF, rabEnabled: true };
    const rNoRAB = calculateLcoe(DEFAULTS, 3, ADV_OFF);
    const rRAB = calculateLcoe(DEFAULTS, 3, advRAB);

    assert(approxEq(rRAB.financingLcoe, 0, 1e-6),
        `financingLcoe = 0 with RAB=1 (${rRAB.financingLcoe.toFixed(6)})`);
    assert(rRAB.surchargedIdcLcoe > 0,
        `surchargedIdcLcoe > 0 memo line (${rRAB.surchargedIdcLcoe.toFixed(4)})`);
    assert(rRAB.totalLcoe < rNoRAB.totalLcoe,
        `Total LCOE lower with RAB (${rRAB.totalLcoe.toFixed(2)}) < without (${rNoRAB.totalLcoe.toFixed(2)})`);
}

// ===========================================================================
// Test 2: Turnkey — RAB: OCC invariant, financing lower, total lower
// ===========================================================================
console.log('\nTest 2: Turnkey RAB — OCC invariant, financing lower');
{
    const advTK: AdvancedToggles = { ...ADV_OFF, turnkey: true };
    const advTKrab: AdvancedToggles = { ...ADV_OFF, turnkey: true, rabEnabled: true };

    const rNoRAB = calculateLcoe(DEFAULTS, 3, advTK);
    const rRAB = calculateLcoe(DEFAULTS, 3, advTKrab);

    // OCC stays the same
    assert(approxEq(rRAB.occLcoe, rNoRAB.occLcoe, 1e-4),
        `OCC invariant: RAB (${rRAB.occLcoe.toFixed(4)}) ≈ noRAB (${rNoRAB.occLcoe.toFixed(4)})`);
    // Financing decreases
    assert(rRAB.financingLcoe < rNoRAB.financingLcoe,
        `Financing lower: RAB (${rRAB.financingLcoe.toFixed(4)}) < noRAB (${rNoRAB.financingLcoe.toFixed(4)})`);
    // Total LCOE decreases
    assert(rRAB.totalLcoe < rNoRAB.totalLcoe,
        `Total LCOE lower: RAB (${rRAB.totalLcoe.toFixed(2)}) < noRAB (${rNoRAB.totalLcoe.toFixed(2)})`);
    // Sale price decreases (developer received surcharges)
    assert(rRAB.developerSalePrice! < rNoRAB.developerSalePrice!,
        `Sale price: RAB (${rRAB.developerSalePrice!.toFixed(2)}) < noRAB (${rNoRAB.developerSalePrice!.toFixed(2)})`);
}

// ===========================================================================
// Test 3: fvSurchargedCOD consistency
// ===========================================================================
console.log('\nTest 3: fvSurchargedCOD > 0 with RAB, = 0 without');
{
    const cRAB = buildConstructionPhase(DEFAULTS, 'dynamic', 'debt_only', 1);
    const cNoRAB = buildConstructionPhase(DEFAULTS, 'dynamic', 'debt_only', 0);
    assert(cRAB.fvSurchargedCOD > 0, `fvSurchargedCOD > 0 (${cRAB.fvSurchargedCOD.toFixed(2)})`);
    assert(approxEq(cNoRAB.fvSurchargedCOD, 0), `fvSurchargedCOD = 0 without RAB`);
    assert(approxEq(cRAB.pvFinancingSOC, 0), `pvFinancingSOC ≈ 0 with RAB=1`);
}

// ===========================================================================
// Test 4: Tc inflation propagation
// ===========================================================================
console.log('\nTest 4: Tc inflation propagation');
{
    const inputsTc0 = { ...DEFAULTS, constructionTime: 0 };
    const rTc8 = calculateLcoe(DEFAULTS, 2, ADV_OFF);
    const rTc0 = calculateLcoe(inputsTc0, 2, ADV_OFF);
    assert(rTc8.fuelLcoe > rTc0.fuelLcoe,
        `Fuel Tc=8 (${rTc8.fuelLcoe.toFixed(4)}) > Tc=0 (${rTc0.fuelLcoe.toFixed(4)})`);
    assert(rTc8.omLcoe > rTc0.omLcoe,
        `O&M Tc=8 (${rTc8.omLcoe.toFixed(4)}) > Tc=0 (${rTc0.omLcoe.toFixed(4)})`);
}

// ===========================================================================
// Test 5: pvOcc + pvFin = pvCapex
// ===========================================================================
console.log('\nTest 5: pvOccSOC + pvFinancingSOC = pvCapexSOC');
{
    const c = buildConstructionPhase(DEFAULTS, 'dynamic', 'debt_only', 0);
    assert(approxEq(c.pvOccSOC + c.pvFinancingSOC, c.pvCapexSOC),
        `${c.pvOccSOC.toFixed(2)} + ${c.pvFinancingSOC.toFixed(2)} ≈ ${c.pvCapexSOC.toFixed(2)}`);
}

// ===========================================================================
// Test 6: Declining Ke TL=2 guard
// ===========================================================================
console.log('\nTest 6: Declining Ke TL=2 guard');
{
    const shortLife = { ...DEFAULTS, usefulLife: 2 };
    const r1 = calculateLcoe(shortLife, 3, { ...ADV_OFF, decliningWacc: true });
    const r2 = calculateLcoe(shortLife, 3, ADV_OFF);
    assert(approxEq(r1.totalLcoe, r2.totalLcoe, 1e-6),
        `TL=2 declining ON=${r1.totalLcoe.toFixed(2)} = OFF=${r2.totalLcoe.toFixed(2)}`);
}

// ===========================================================================
// Test 7: fvEconomicCOD > pvCapexSOC
// ===========================================================================
console.log('\nTest 7: fvEconomicCOD > pvCapexSOC');
{
    const c = buildConstructionPhase(DEFAULTS, 'dynamic', 'debt_only', 0);
    assert(c.fvEconomicCOD > c.pvCapexSOC,
        `fvEconomicCOD (${c.fvEconomicCOD.toFixed(2)}) > pvCapexSOC (${c.pvCapexSOC.toFixed(2)})`);
}

console.log('\n✅ All 7 acceptance tests passed.\n');
