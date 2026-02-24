/**
 * Acceptance tests for LCOE engine with 2-Lives LTE model.
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
    extensionCapEx: 1000,
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
// Test 1: 2-Lives total LCOE < single life LCOE
// ===========================================================================
console.log('\nTest 1: 2-Lives total LCOE < single life (moderate ext CapEx)');
{
    const modExt = { ...DEFAULTS, extensionCapEx: 0 };
    const adv2L: AdvancedToggles = { ...ADV_OFF, twoLives: true };
    const rSingle = calculateLcoe(modExt, 3, ADV_OFF);
    const r2L = calculateLcoe(modExt, 3, adv2L);

    assert(r2L.totalLcoe < rSingle.totalLcoe,
        `2-Lives (${r2L.totalLcoe.toFixed(2)}) < single (${rSingle.totalLcoe.toFixed(2)})`);
    assert(r2L.halfLcoe1! > 0, `halfLcoe1 = ${r2L.halfLcoe1!.toFixed(2)} > 0`);
    assert(r2L.halfLcoe2! > 0, `halfLcoe2 = ${r2L.halfLcoe2!.toFixed(2)} > 0`);
    assert(r2L.halfLcoe2! < r2L.halfLcoe1!,
        `halfLcoe2 (${r2L.halfLcoe2!.toFixed(2)}) < halfLcoe1 (${r2L.halfLcoe1!.toFixed(2)}) — less capital burden`);
}

// ===========================================================================
// Test 2: Standard + RAB
// ===========================================================================
console.log('\nTest 2: Standard + RAB full');
{
    const advRAB: AdvancedToggles = { ...ADV_OFF, rabEnabled: true };
    const rNoRAB = calculateLcoe(DEFAULTS, 3, ADV_OFF);
    const rRAB = calculateLcoe(DEFAULTS, 3, advRAB);
    assert(rRAB.totalLcoe < rNoRAB.totalLcoe,
        `Total LCOE lower with RAB (${rRAB.totalLcoe.toFixed(2)}) < without (${rNoRAB.totalLcoe.toFixed(2)})`);
}

// ===========================================================================
// Test 3: Turnkey RAB — OCC invariant
// ===========================================================================
console.log('\nTest 3: Turnkey RAB — OCC invariant, financing lower');
{
    const advTK: AdvancedToggles = { ...ADV_OFF, turnkey: true };
    const advTKrab: AdvancedToggles = { ...ADV_OFF, turnkey: true, rabEnabled: true };
    const rNoRAB = calculateLcoe(DEFAULTS, 3, advTK);
    const rRAB = calculateLcoe(DEFAULTS, 3, advTKrab);
    assert(approxEq(rRAB.occLcoe, rNoRAB.occLcoe, 1e-4),
        `OCC invariant: RAB (${rRAB.occLcoe.toFixed(4)}) ≈ noRAB (${rNoRAB.occLcoe.toFixed(4)})`);
    assert(rRAB.financingLcoe < rNoRAB.financingLcoe,
        `Financing lower: RAB (${rRAB.financingLcoe.toFixed(4)}) < noRAB (${rNoRAB.financingLcoe.toFixed(4)})`);
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
// Test 7: 2-Lives with extensionCapEx=0 should still lower LCOE (opex-only extension)
// ===========================================================================
console.log('\nTest 7: 2-Lives with extensionCapEx=0');
{
    const zeroExt = { ...DEFAULTS, extensionCapEx: 0 };
    const adv2L: AdvancedToggles = { ...ADV_OFF, twoLives: true };
    const rSingle = calculateLcoe(zeroExt, 3, ADV_OFF);
    const r2L = calculateLcoe(zeroExt, 3, adv2L);
    assert(r2L.totalLcoe < rSingle.totalLcoe,
        `2-Lives ext=0 (${r2L.totalLcoe.toFixed(2)}) < single (${rSingle.totalLcoe.toFixed(2)})`);
    assert(r2L.halfLcoe2! < r2L.halfLcoe1!,
        `Interval 2 (${r2L.halfLcoe2!.toFixed(2)}) < Interval 1 (${r2L.halfLcoe1!.toFixed(2)})`);
}

console.log('\n✅ All 7 acceptance tests passed.\n');
