import React, { useState, useMemo, useEffect } from 'react';
import { SliderInput, PieChart, LineChart, RangeSlider } from './components/UI';
import { useLcoe, calculateLcoe, buildConstructionPhase, buildDfArray, OPEX_ONLY_VARS, calcNominalWacc } from './hooks/useLcoe';
import type { LcoeInputs, LcoeStep, AdvancedToggles } from './types';

const formatCurrency = (value: number) => {
  if (!isFinite(value) || isNaN(value)) return '$0.00';
  return new Intl.NumberFormat('en-US', {
    style: 'currency', currency: 'USD',
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  }).format(value);
};

const formatNumber = (value: number, digits = 0) => {
  if (!isFinite(value) || isNaN(value)) return '0';
  return new Intl.NumberFormat('en-US', {
    minimumFractionDigits: digits, maximumFractionDigits: digits,
  }).format(value);
};

type ParamConfig = { label: string; min: number; max: number; step: number; unit: string; formatter: (v: number) => string; chartFormatter: (v: number) => string; };
const PARAM_CONFIGS: Record<keyof LcoeInputs, ParamConfig> = {
  usefulLife: { label: 'Useful Life', min: 20, max: 80, step: 5, unit: 'years', formatter: (v) => `${formatNumber(v)}`, chartFormatter: (v) => `${formatNumber(v)}` },
  overnightCost: { label: 'Overnight Construction Costs', min: 2000, max: 20000, step: 100, unit: '$/kW', formatter: (v) => formatCurrency(v).replace('.00', ''), chartFormatter: (v) => formatNumber(v) },
  constructionTime: { label: 'Construction Time', min: 5, max: 15, step: 1, unit: 'years', formatter: (v) => `${formatNumber(v)}`, chartFormatter: (v) => `${formatNumber(v)}` },
  costOfEquity: { label: 'Cost of Equity (real)', min: 3, max: 15, step: 0.5, unit: '%', formatter: (v) => `${v.toFixed(1)}%`, chartFormatter: (v) => `${v.toFixed(1)}%` },
  costOfDebt: { label: 'Cost of Debt (real)', min: 1, max: 10, step: 0.25, unit: '%', formatter: (v) => `${v.toFixed(2)}%`, chartFormatter: (v) => `${v.toFixed(2)}%` },
  targetGearing: { label: 'Target Gearing (D/EV)', min: 0, max: 90, step: 5, unit: '%', formatter: (v) => `${v}%`, chartFormatter: (v) => `${v}%` },
  fuelCost: { label: 'Fuel & Variable costs', min: 5, max: 15, step: 0.25, unit: '$/MWh', formatter: (v) => formatCurrency(v), chartFormatter: (v) => formatNumber(v, 2) },
  omCost: { label: 'Annual O&M Costs', min: 70, max: 170, step: 5, unit: '$/kW-year', formatter: (v) => formatCurrency(v).replace('.00', ''), chartFormatter: (v) => formatNumber(v) },
  loadHours: { label: 'Annual Full-Load Hours', min: 876, max: 8760, step: 87.6, unit: 'hours', formatter: (v) => `${formatNumber(v)} (${((v / 8760) * 100).toFixed(0)}%)`, chartFormatter: (v) => formatNumber(v) },
  decommissioningCost: { label: 'Decommissioning Costs', min: 300, max: 3000, step: 50, unit: '$/kW', formatter: (v) => formatCurrency(v).replace('.00', ''), chartFormatter: (v) => formatNumber(v) },
  rabProportion: { label: 'RAB Consumer Burden', min: 0, max: 100, step: 1, unit: '%', formatter: (v) => `${v}%`, chartFormatter: (v) => `${v}%` },
  inflationRate: { label: 'Inflation Rate', min: 0, max: 10, step: 0.1, unit: '%', formatter: (v) => `${v.toFixed(1)}%`, chartFormatter: (v) => `${v.toFixed(1)}%` },
};

// Step descriptions for pedagogical flow
const STEP_DESCRIPTIONS: Record<LcoeStep, { title: string; subtitle: string; body: string }> = {
  1: {
    title: '① Wrong LCOE',
    subtitle: 'Common errors in simplified approaches',
    body: `This step intentionally applies two common errors to illustrate their impact:\n\n• Lump-sum inflation: applies a single cumulative factor (1+π)^Tc to translate all overnight costs from SOC to COD, exaggerating inflation effects.\n\n• Interest on whole capital: IDC is computed on the entire capital base (debt + equity) using the blended WACC, rather than only on the debt tranche. Equity is double-counted — once through interest and again through discounting.`,
  },
  2: {
    title: '② Standard LCOE',
    subtitle: 'Corrected DCF baseline',
    body: `Corrects both errors from Step 1:\n\n• Dynamic inflation: each construction tranche is inflated year-by-year to its own period, matching standard JRC methodology. Converges with lump-sum when π = 0.\n\n• Debt-only IDC: interest accrues only on the outstanding debt balance at the nominal cost of debt. Equity earns its required return through discounting, not as capitalized interest. With gearing = 0%, IDC = 0.`,
  },
  3: {
    title: '③ Advanced LCOE',
    subtitle: 'Toggle-able financial model enhancements',
    body: `Starting from the correct Step 2 baseline, independently toggle advanced features to see their impact on LCOE.`,
  },
};

// Segmented toggle button component
const Toggle: React.FC<{
  label: string; options: { key: string; label: string }[];
  value: string; onChange: (key: string) => void; desc?: string;
}> = ({ label, options, value, onChange, desc }) => (
  <div>
    <label className="block text-sm font-medium text-slate-300 mb-2">{label}</label>
    <div className="flex items-center space-x-2 p-1 bg-slate-800 rounded-lg">
      {options.map(o => (
        <button key={o.key} onClick={() => onChange(o.key)}
          className={`flex-1 py-2 px-3 rounded-md text-sm font-medium transition-colors ${value === o.key ? 'bg-sky-500 text-white shadow' : 'text-slate-300 hover:bg-slate-700'}`}
        >{o.label}</button>
      ))}
    </div>
    {desc && <p className="text-xs text-slate-500 mt-2 px-1">{desc}</p>}
  </div>
);

const App: React.FC = () => {
  const [inputs, setInputs] = useState<LcoeInputs>({
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
  });

  // 3-step state
  const [step, setStep] = useState<LcoeStep>(2);
  const [adv, setAdv] = useState<AdvancedToggles>({
    rabEnabled: false,
    decliningWacc: false,
    turnkey: false,
    twoLives: false,
    valuationPoint: 'cod',
  });

  const [sensitivityVar, setSensitivityVar] = useState<keyof LcoeInputs>('overnightCost');
  const [sensitivityVar2, setSensitivityVar2] = useState<keyof LcoeInputs>('costOfEquity');
  const [sensitivityVar2Range, setSensitivityVar2Range] = useState<[number, number]>([PARAM_CONFIGS.costOfEquity.min, PARAM_CONFIGS.costOfEquity.max]);
  const [activeTab, setActiveTab] = useState('summary');

  useEffect(() => {
    if (sensitivityVar === sensitivityVar2) {
      const alternative = Object.keys(PARAM_CONFIGS).find(k => k !== sensitivityVar) as keyof LcoeInputs;
      setSensitivityVar2(alternative);
    }
  }, [sensitivityVar, sensitivityVar2]);

  useEffect(() => {
    const config = PARAM_CONFIGS[sensitivityVar2];
    setSensitivityVar2Range([config.min, config.max]);
  }, [sensitivityVar2]);

  const handleInputChange = (field: keyof LcoeInputs) => (value: number) => {
    setInputs(prev => ({ ...prev, [field]: value }));
  };

  const advToggle = (key: keyof AdvancedToggles) => (val: string) => {
    if (key === 'valuationPoint') {
      setAdv(prev => ({ ...prev, valuationPoint: val as 'soc' | 'cod' }));
    } else {
      setAdv(prev => ({ ...prev, [key]: val === 'on' }));
    }
  };

  const lcoeResult = useLcoe(inputs, step, adv);
  const stepInfo = STEP_DESCRIPTIONS[step];

  const pieChartData = useMemo(() => [
    { valueKey: 'occLcoe', color: '#0ea5e9', label: adv.turnkey && step === 3 ? 'Sale Payments' : 'Overnight Cost' },
    { valueKey: 'financingLcoe', color: '#818cf8', label: 'Financing' },
    { valueKey: 'fuelLcoe', color: '#facc15', label: 'Fuel' },
    { valueKey: 'omLcoe', color: '#4ade80', label: 'O&M' },
    { valueKey: 'decommissioningLcoe', color: '#fb923c', label: 'Decommissioning' },
  ].map(d => ({ ...d, value: lcoeResult[d.valueKey as keyof typeof lcoeResult] })), [lcoeResult, step, adv.turnkey]);

  // Sensitivity analysis
  const sensitivityChartData = useMemo(() => {
    const config = PARAM_CONFIGS[sensitivityVar];
    const { min, max, step: s } = config;

    const isOpexOnly = OPEX_ONLY_VARS.has(sensitivityVar);
    const { waccNomBlend } = calcNominalWacc(inputs);
    const Tc = Math.max(Math.round(inputs.constructionTime), 0);
    const TL = Math.max(Math.round(inputs.usefulLife), 0);
    const inflationMode = step === 1 ? 'lump_sum' : 'dynamic';
    const idcMode = step === 1 ? 'whole_wacc' : 'debt_only';
    const rabFrac = (step === 3 && adv.rabEnabled) ? Math.min(Math.max(inputs.rabProportion, 0), 100) / 100 : 0;
    const declining = step === 3 && adv.decliningWacc;
    const valPoint = step === 1 ? 'soc' : adv.valuationPoint;
    const tcOffset = valPoint === 'soc' ? Tc : 0;

    const cachedConstruction = isOpexOnly
      ? buildConstructionPhase(inputs, inflationMode, idcMode, rabFrac)
      : null;
    const cachedDf = isOpexOnly
      ? buildDfArray(waccNomBlend, TL, declining, tcOffset)
      : null;
    const precomputed = (cachedConstruction && cachedDf)
      ? { ...cachedConstruction, df: cachedDf }
      : undefined;

    const baselineSeries: { x: number; y: number }[] = [];
    const minSeries: { x: number; y: number }[] = [];
    const maxSeries: { x: number; y: number }[] = [];

    for (let i = min; i <= max; i += s) {
      const xVal = parseFloat(i.toFixed(5));
      const bl = calculateLcoe({ ...inputs, [sensitivityVar]: xVal }, step, adv, precomputed);
      const mn = calculateLcoe({ ...inputs, [sensitivityVar]: xVal, [sensitivityVar2]: sensitivityVar2Range[0] }, step, adv, precomputed);
      const mx = calculateLcoe({ ...inputs, [sensitivityVar]: xVal, [sensitivityVar2]: sensitivityVar2Range[1] }, step, adv, precomputed);
      baselineSeries.push({ x: xVal, y: bl.totalLcoe });
      minSeries.push({ x: xVal, y: mn.totalLcoe });
      maxSeries.push({ x: xVal, y: mx.totalLcoe });
    }

    if (baselineSeries.length > 0 && baselineSeries[baselineSeries.length - 1].x < max) {
      const xVal = max;
      const bl = calculateLcoe({ ...inputs, [sensitivityVar]: xVal }, step, adv, precomputed);
      const mn = calculateLcoe({ ...inputs, [sensitivityVar]: xVal, [sensitivityVar2]: sensitivityVar2Range[0] }, step, adv, precomputed);
      const mx = calculateLcoe({ ...inputs, [sensitivityVar]: xVal, [sensitivityVar2]: sensitivityVar2Range[1] }, step, adv, precomputed);
      baselineSeries.push({ x: xVal, y: bl.totalLcoe });
      minSeries.push({ x: xVal, y: mn.totalLcoe });
      maxSeries.push({ x: xVal, y: mx.totalLcoe });
    }

    return {
      series: [
        { name: `Low: ${PARAM_CONFIGS[sensitivityVar2].chartFormatter(sensitivityVar2Range[0])}`, color: '#f472b6', points: minSeries, strokeWidth: 1.5 },
        { name: 'Baseline', color: '#38bdf8', points: baselineSeries, strokeWidth: 3 },
        { name: `High: ${PARAM_CONFIGS[sensitivityVar2].chartFormatter(sensitivityVar2Range[1])}`, color: '#a78bfa', points: maxSeries, strokeWidth: 1.5 },
      ],
      xAccessor: (d: { x: number; y: number }) => d.x,
      yAccessor: (d: { x: number; y: number }) => d.y,
      xLabel: `${config.label} (${config.unit})`,
      yLabel: 'LCOE ($/MWh)',
      yFormatter: (v: number) => formatCurrency(v).replace('$', ''),
      xFormatter: config.chartFormatter,
    };
  }, [sensitivityVar, sensitivityVar2, sensitivityVar2Range, inputs, step, adv]);


  return (
    <div className="min-h-screen bg-slate-900 text-slate-300 p-4 sm:p-6 md:p-8">
      <div className="max-w-7xl mx-auto">
        <header className="text-center mb-8">
          <h1 className="text-4xl font-bold text-slate-100">NPP LCOE Financial Model</h1>
          <p className="mt-2 text-lg text-slate-400">3-step pedagogical tool: Wrong → Standard → Advanced</p>
        </header>

        <main className="grid grid-cols-1 lg:grid-cols-5 gap-8">
          {/* LEFT PANEL: Input Parameters */}
          <div className="lg:col-span-2 bg-slate-800 p-6 rounded-2xl shadow-lg border border-slate-700 space-y-6">
            <h2 className="text-2xl font-semibold border-b border-slate-700 pb-4 text-slate-200">Input Parameters</h2>
            {Object.entries(PARAM_CONFIGS).map(([key, config]) => {
              // RAB Consumer Burden slider only visible when RAB model is active in Step 3
              if (key === 'rabProportion' && !(step === 3 && adv.rabEnabled)) return null;
              return (
                <SliderInput key={key}
                  label={config.label}
                  value={inputs[key as keyof LcoeInputs]}
                  min={config.min} max={config.max} step={config.step} unit={config.unit}
                  onChange={handleInputChange(key as keyof LcoeInputs)}
                  formatter={config.formatter}
                />
              );
            })}
          </div>

          {/* RIGHT PANEL: Financing Model + Results */}
          <div className="lg:col-span-3 bg-slate-800 p-6 rounded-2xl shadow-lg border border-slate-700">

            {/* 3-STEP SELECTOR */}
            <div className="mb-6">
              <h3 className="text-lg font-semibold text-slate-200 mb-3">LCOE Methodology Steps</h3>

              {/* Step buttons */}
              <div className="flex items-center space-x-2 p-1 bg-slate-900 rounded-lg mb-4">
                {([1, 2, 3] as LcoeStep[]).map(s => (
                  <button key={s} onClick={() => setStep(s)}
                    className={`flex-1 py-2.5 px-3 rounded-md text-sm font-semibold transition-colors ${step === s
                      ? s === 1 ? 'bg-red-500/80 text-white shadow' : s === 2 ? 'bg-sky-500 text-white shadow' : 'bg-emerald-500 text-white shadow'
                      : 'text-slate-400 hover:bg-slate-700'
                      }`}
                  >{s === 1 ? '① Wrong' : s === 2 ? '② Standard' : '③ Advanced'}</button>
                ))}
              </div>

              {/* Step explanation panel */}
              <div className={`p-4 border rounded-lg ${step === 1 ? 'border-red-500/40 bg-red-950/20' : step === 2 ? 'border-sky-500/40 bg-sky-950/20' : 'border-emerald-500/40 bg-emerald-950/20'}`}>
                <h4 className="font-semibold text-slate-200 text-sm">{stepInfo.title}</h4>
                <p className="text-xs text-slate-400 mb-2">{stepInfo.subtitle}</p>
                <p className="text-xs text-slate-500 whitespace-pre-line leading-relaxed">{stepInfo.body}</p>
              </div>

              {/* Step 3 advanced toggles */}
              {step === 3 && (
                <div className="space-y-4 mt-4 p-4 border border-slate-700 rounded-lg bg-slate-900/50">
                  <Toggle label="Interest During Construction"
                    options={[{ key: 'off', label: 'Standard (Capitalized)' }, { key: 'on', label: 'RAB Model' }]}
                    value={adv.rabEnabled ? 'on' : 'off'} onChange={advToggle('rabEnabled')}
                    desc="RAB: consumers cover part of construction financing costs, reducing capitalized IDC."
                  />
                  <Toggle label="WACC Profile"
                    options={[{ key: 'off', label: 'Constant' }, { key: 'on', label: 'Declining' }]}
                    value={adv.decliningWacc ? 'on' : 'off'} onChange={advToggle('decliningWacc')}
                    desc="Declining WACC applies a 3-tranche schedule, reducing the discount rate for later operational years."
                  />
                  <Toggle label="Financing Structure"
                    options={[{ key: 'off', label: 'Developer & Operator' }, { key: 'on', label: 'Turnkey' }]}
                    value={adv.turnkey ? 'on' : 'off'} onChange={advToggle('turnkey')}
                    desc="Turnkey: developer sells at COD (NPV=0 sale), buyer pays in 3 annual tranches. Shows buyer LCOE."
                  />
                  <Toggle label="Asset Life Treatment"
                    options={[{ key: 'off', label: 'Single Life' }, { key: 'on', label: '2-Lives' }]}
                    value={adv.twoLives ? 'on' : 'off'} onChange={advToggle('twoLives')}
                    desc="2-Lives: CAPEX recovered in first half. Second half fully depreciated. Final LCOE = simple average."
                  />
                </div>
              )}


            </div>

            {/* TABS */}
            <div className="border-b border-slate-700">
              <nav className="-mb-px flex space-x-6" aria-label="Tabs">
                {(['summary', 'sensitivity'] as const).map(tab => (
                  <button key={tab} onClick={() => setActiveTab(tab)} className={`whitespace-nowrap py-4 px-1 border-b-2 font-medium text-sm capitalize ${activeTab === tab ? 'border-sky-400 text-sky-400' : 'border-transparent text-slate-400 hover:text-slate-200 hover:border-slate-500'}`}
                    aria-current={activeTab === tab ? 'page' : undefined}
                  >{tab}</button>
                ))}
              </nav>
            </div>

            {/* TAB CONTENT */}
            <div className="mt-6">
              {activeTab === 'summary' && (
                <div className="flex flex-col items-center" role="tabpanel">
                  <div className="text-center mb-8">
                    <p className="text-slate-400 font-medium">
                      {step === 1 ? 'Wrong' : step === 2 ? 'Standard' : 'Advanced'} LCOE
                    </p>
                    <p className={`text-4xl md:text-5xl font-bold my-2 ${step === 1 ? 'text-red-400' : step === 2 ? 'text-sky-400' : 'text-emerald-400'}`}>
                      {formatCurrency(lcoeResult.totalLcoe)}
                    </p>
                    <p className="text-slate-400 font-medium">per MWh</p>

                    {/* Half LCOEs for 2-Lives */}
                    {step === 3 && adv.twoLives && lcoeResult.halfLcoe1 != null && lcoeResult.halfLcoe2 != null && (
                      <p className="text-sm text-slate-400 mt-2">
                        Half 1: <span className="font-semibold text-slate-200">{formatCurrency(lcoeResult.halfLcoe1)}</span>
                        {' | '}
                        Half 2: <span className="font-semibold text-slate-200">{formatCurrency(lcoeResult.halfLcoe2)}</span>
                      </p>
                    )}

                    {/* Developer sale price for Turnkey */}
                    {step === 3 && adv.turnkey && lcoeResult.developerSalePrice != null && (
                      <p className="text-sm text-slate-400 mt-2">
                        Developer sale price: <span className="font-semibold text-slate-200">{formatCurrency(lcoeResult.developerSalePrice)}/kW</span>
                      </p>
                    )}
                  </div>
                  <div className="w-full max-w-sm text-center">
                    <h3 className="font-semibold text-slate-200 mb-2">LCOE Breakdown</h3>
                    <div className="w-48 h-48 mx-auto"><PieChart data={pieChartData} /></div>
                    <div className="mt-4 space-y-2">
                      {pieChartData.map(item => (<div key={item.label} className="flex justify-between items-center text-sm">
                        <div className="flex items-center"><span className="w-3 h-3 rounded-full mr-2" style={{ backgroundColor: item.color }} aria-hidden="true"></span><span className="text-slate-300">{item.label}</span></div>
                        <span className="font-semibold text-slate-200">{formatCurrency(item.value)}</span>
                      </div>))}
                    </div>
                  </div>
                </div>
              )}
              {activeTab === 'sensitivity' && (
                <div role="tabpanel">
                  <h3 className="text-xl font-semibold text-slate-200 mb-4">Sensitivity Analysis</h3>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-6 p-4 border border-slate-700 rounded-lg bg-slate-900/50 mb-6">
                    <div>
                      <label htmlFor="sensitivity-var-1" className="block text-sm font-medium text-slate-300 mb-1">Independent variable</label>
                      <select id="sensitivity-var-1" value={sensitivityVar} onChange={e => setSensitivityVar(e.target.value as keyof LcoeInputs)} className="w-full p-2 border bg-slate-700 border-slate-600 rounded-md shadow-sm text-sm text-slate-200 focus:ring-sky-500 focus:border-sky-500">
                        {Object.entries(PARAM_CONFIGS).map(([key, config]) => <option key={key} value={key}>{config.label}</option>)}
                      </select>
                    </div>
                    <div>
                      <label htmlFor="sensitivity-var-2" className="block text-sm font-medium text-slate-300 mb-1">Scenario variable</label>
                      <select id="sensitivity-var-2" value={sensitivityVar2} onChange={e => setSensitivityVar2(e.target.value as keyof LcoeInputs)} className="w-full p-2 border bg-slate-700 border-slate-600 rounded-md shadow-sm text-sm text-slate-200 focus:ring-sky-500 focus:border-sky-500">
                        {Object.entries(PARAM_CONFIGS).filter(([key]) => key !== sensitivityVar).map(([key, config]) => <option key={key} value={key}>{config.label}</option>)}
                      </select>
                      <div className="mt-2">
                        <RangeSlider
                          min={PARAM_CONFIGS[sensitivityVar2].min}
                          max={PARAM_CONFIGS[sensitivityVar2].max}
                          step={PARAM_CONFIGS[sensitivityVar2].step}
                          value={sensitivityVar2Range}
                          onChange={setSensitivityVar2Range}
                          formatter={PARAM_CONFIGS[sensitivityVar2].chartFormatter}
                        />
                      </div>
                    </div>
                  </div>
                  <LineChart data={sensitivityChartData} />
                  <div className="flex justify-center mt-4 space-x-4 text-sm">
                    {sensitivityChartData.series.map(s => (
                      <div key={s.name} className="flex items-center">
                        <span className="w-3 h-3 rounded-full mr-2" style={{ backgroundColor: s.color }}></span>
                        <span className="text-slate-300">{s.name.split(':')[0]}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        </main>
      </div>
    </div>
  );
};

export default App;