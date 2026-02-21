import React, { useState, useMemo, useEffect } from 'react';
import { SliderInput, PieChart, LineChart, RangeSlider } from './components/UI';
import { useLcoe, calculateLcoe } from './hooks/useLcoe';
import type { LcoeInputs } from './types';

const formatCurrency = (value: number) => {
  if (!isFinite(value) || isNaN(value)) return '$0.00';
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
};

const formatNumber = (value: number, digits = 0) => {
  if (!isFinite(value) || isNaN(value)) return '0';
  return new Intl.NumberFormat('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value);
};

const PARAM_CONFIGS: Record<keyof LcoeInputs, { label: string; min: number; max: number; step: number; unit: string; formatter: (v: number) => string; chartFormatter: (v: number) => string; }> = {
  usefulLife: { label: 'Useful Life', min: 20, max: 80, step: 5, unit: 'years', formatter: (v) => `${formatNumber(v)}`, chartFormatter: (v) => `${formatNumber(v)}` },
  overnightCost: { label: 'Overnight Construction Costs', min: 2000, max: 20000, step: 100, unit: '$/kW', formatter: (v) => formatCurrency(v).replace('.00', ''), chartFormatter: (v) => formatNumber(v) },
  constructionTime: { label: 'Construction Time', min: 5, max: 15, step: 1, unit: 'years', formatter: (v) => `${formatNumber(v)}`, chartFormatter: (v) => `${formatNumber(v)}` },
  wacc: { label: 'WACC', min: 2, max: 12, step: 0.5, unit: '%', formatter: (v) => `${v.toFixed(1)}%`, chartFormatter: (v) => `${v.toFixed(1)}%` },
  fuelCost: { label: 'Fuel & Variable costs', min: 5, max: 15, step: 0.25, unit: '$/MWh', formatter: (v) => formatCurrency(v), chartFormatter: (v) => formatNumber(v, 2) },
  omCost: { label: 'Annual O&M Costs', min: 70, max: 170, step: 5, unit: '$/kW-year', formatter: (v) => formatCurrency(v).replace('.00', ''), chartFormatter: (v) => formatNumber(v) },
  loadHours: { label: 'Annual Full-Load Hours', min: 876, max: 8760, step: 87.6, unit: 'hours', formatter: (v) => `${formatNumber(v)} (${((v / 8760) * 100).toFixed(0)}%)`, chartFormatter: (v) => formatNumber(v) },
  decommissioningCost: { label: 'Decommissioning Costs', min: 300, max: 3000, step: 50, unit: '$/kW', formatter: (v) => formatCurrency(v).replace('.00', ''), chartFormatter: (v) => formatNumber(v) },
};

const App: React.FC = () => {
  const [inputs, setInputs] = useState<LcoeInputs>({
    usefulLife: 60,
    overnightCost: 6500,
    constructionTime: 8,
    wacc: 7.5,
    fuelCost: 10,
    omCost: 140,
    loadHours: 7884, // 90% capacity factor
    decommissioningCost: 1000,
  });
  
  const [isRabEnabled, setIsRabEnabled] = useState(false);
  const [t0Timing, setT0Timing] = useState<'soc' | 'cod'>('cod');
  const [waccProfile, setWaccProfile] = useState<'constant' | 'declining'>('constant');

  const [sensitivityVar, setSensitivityVar] = useState<keyof LcoeInputs>('overnightCost');
  const [sensitivityVar2, setSensitivityVar2] = useState<keyof LcoeInputs>('wacc');
  const [sensitivityVar2Range, setSensitivityVar2Range] = useState<[number, number]>([PARAM_CONFIGS.wacc.min, PARAM_CONFIGS.wacc.max]);

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

  const lcoeResult = useLcoe(inputs, isRabEnabled, t0Timing, waccProfile);
  
  const pieChartData = useMemo(() => [
    { valueKey: 'occLcoe', color: '#0ea5e9', label: 'Overnight Cost' },    // sky-500
    { valueKey: 'financingLcoe', color: '#818cf8', label: 'Financing' },     // indigo-400
    { valueKey: 'fuelLcoe', color: '#facc15', label: 'Fuel' },            // yellow-400
    { valueKey: 'omLcoe', color: '#4ade80', label: 'O&M' },               // green-400
    { valueKey: 'decommissioningLcoe', color: '#fb923c', label: 'Decommissioning' }, // orange-400
  ].map(d => ({...d, value: lcoeResult[d.valueKey as keyof typeof lcoeResult]})), [lcoeResult]);

  const sensitivityChartData = useMemo(() => {
    const config = PARAM_CONFIGS[sensitivityVar];
    const { min, max, step } = config;
    
    const baselineSeries: { x: number; y: number }[] = [];
    const minSeries: { x: number; y: number }[] = [];
    const maxSeries: { x: number; y: number }[] = [];
    
    for (let i = min; i <= max; i += step) {
      const xVal = parseFloat(i.toFixed(5)); // Handle floating point inaccuracies
      const baselineResult = calculateLcoe({ ...inputs, [sensitivityVar]: xVal }, isRabEnabled, t0Timing, waccProfile);
      const minResult = calculateLcoe({ ...inputs, [sensitivityVar]: xVal, [sensitivityVar2]: sensitivityVar2Range[0] }, isRabEnabled, t0Timing, waccProfile);
      const maxResult = calculateLcoe({ ...inputs, [sensitivityVar]: xVal, [sensitivityVar2]: sensitivityVar2Range[1] }, isRabEnabled, t0Timing, waccProfile);
      
      baselineSeries.push({ x: xVal, y: baselineResult.totalLcoe });
      minSeries.push({ x: xVal, y: minResult.totalLcoe });
      maxSeries.push({ x: xVal, y: maxResult.totalLcoe });
    }

     // Ensure the max value is included if step doesn't land on it perfectly
    if (baselineSeries.length > 0 && baselineSeries[baselineSeries.length - 1].x < max) {
        const xVal = max;
        const baselineResult = calculateLcoe({ ...inputs, [sensitivityVar]: xVal }, isRabEnabled, t0Timing, waccProfile);
        const minResult = calculateLcoe({ ...inputs, [sensitivityVar]: xVal, [sensitivityVar2]: sensitivityVar2Range[0] }, isRabEnabled, t0Timing, waccProfile);
        const maxResult = calculateLcoe({ ...inputs, [sensitivityVar]: xVal, [sensitivityVar2]: sensitivityVar2Range[1] }, isRabEnabled, t0Timing, waccProfile);
        
        baselineSeries.push({ x: xVal, y: baselineResult.totalLcoe });
        minSeries.push({ x: xVal, y: minResult.totalLcoe });
        maxSeries.push({ x: xVal, y: maxResult.totalLcoe });
    }
    
    return {
      series: [
        { name: `Low: ${PARAM_CONFIGS[sensitivityVar2].chartFormatter(sensitivityVar2Range[0])}`, color: '#f472b6', points: minSeries, strokeWidth: 1.5 }, // pink-400
        { name: 'Baseline', color: '#38bdf8', points: baselineSeries, strokeWidth: 3 }, // sky-400
        { name: `High: ${PARAM_CONFIGS[sensitivityVar2].chartFormatter(sensitivityVar2Range[1])}`, color: '#a78bfa', points: maxSeries, strokeWidth: 1.5 }, // violet-400
      ],
      xAccessor: (d: {x:number, y:number}) => d.x,
      yAccessor: (d: {x:number, y:number}) => d.y,
      xLabel: `${config.label} (${config.unit})`,
      yLabel: 'LCOE ($/MWh)',
      // FIX: formatCurrency was called with an extra argument.
      yFormatter: (v) => formatCurrency(v).replace('$', ''),
      xFormatter: config.chartFormatter,
    };
  }, [sensitivityVar, sensitivityVar2, sensitivityVar2Range, inputs, isRabEnabled, t0Timing, waccProfile]);


  return (
    <div className="min-h-screen bg-slate-900 text-slate-300 p-4 sm:p-6 md:p-8">
      <div className="max-w-7xl mx-auto">
        <header className="text-center mb-8">
          <h1 className="text-4xl font-bold text-slate-100">Nuclear LCOE Calculator</h1>
          <p className="mt-2 text-lg text-slate-400">Interactively model the Levelized Cost of Electricity for a nuclear power plant.</p>
        </header>

        <main className="grid grid-cols-1 lg:grid-cols-5 gap-8">
          <div className="lg:col-span-2 bg-slate-800 p-6 rounded-2xl shadow-lg border border-slate-700 space-y-6">
            <h2 className="text-2xl font-semibold border-b border-slate-700 pb-4 text-slate-200">Input Parameters</h2>
            {Object.entries(PARAM_CONFIGS).map(([key, config]) => (
              <SliderInput
                key={key}
                label={config.label}
                value={inputs[key as keyof LcoeInputs]}
                min={config.min} max={config.max} step={config.step} unit={config.unit}
                onChange={handleInputChange(key as keyof LcoeInputs)}
                formatter={config.formatter}
              />
            ))}
          </div>
          
          <div className="lg:col-span-3 bg-slate-800 p-6 rounded-2xl shadow-lg border border-slate-700">
             <div className="mb-6">
                <h3 className="text-lg font-semibold text-slate-200 mb-3">Financing Model</h3>
                <div className="space-y-4 p-4 border border-slate-700 rounded-lg bg-slate-900/50">
                    {/* RAB Selector */}
                    <div>
                        <label className="block text-sm font-medium text-slate-300 mb-2">Interest During Construction</label>
                        <div className="flex items-center space-x-2 p-1 bg-slate-800 rounded-lg">
                            <button
                                onClick={() => setIsRabEnabled(false)}
                                className={`flex-1 py-2 px-4 rounded-md text-sm font-medium transition-colors ${!isRabEnabled ? 'bg-sky-500 text-white shadow' : 'text-slate-300 hover:bg-slate-700'}`}
                            > Standard (Capitalized)</button>
                            <button
                                onClick={() => setIsRabEnabled(true)}
                                className={`flex-1 py-2 px-4 rounded-md text-sm font-medium transition-colors ${isRabEnabled ? 'bg-sky-500 text-white shadow' : 'text-slate-300 hover:bg-slate-700'}`}
                            > RAB Model</button>
                        </div>
                        <p className="text-xs text-slate-500 mt-2 px-1">
                          The RAB mechanism lowers LCOE as consumers or taxpayers cover (part of) interest payments during the construction phase, preventing (or reducing the extent of) capitalization. All else equal, this reduces financing costs.
                        </p>
                    </div>

                    {/* T=0 Selector */}
                    <div>
                        <label className="block text-sm font-medium text-slate-300 mb-2">Valuation Point (T=0)</label>
                        <div className="flex items-center space-x-2 p-1 bg-slate-800 rounded-lg">
                            <button
                                onClick={() => setT0Timing('soc')}
                                className={`flex-1 py-2 px-4 rounded-md text-sm font-medium transition-colors ${t0Timing === 'soc' ? 'bg-sky-500 text-white shadow' : 'text-slate-300 hover:bg-slate-700'}`}
                            > Start of Construction</button>
                            <button
                                onClick={() => setT0Timing('cod')}
                                className={`flex-1 py-2 px-4 rounded-md text-sm font-medium transition-colors ${t0Timing === 'cod' ? 'bg-sky-500 text-white shadow' : 'text-slate-300 hover:bg-slate-700'}`}
                            > Commercial Operation</button>
                        </div>
                        <p className="text-xs text-slate-500 mt-2 px-1">
                            "Time zero" for discounting affects the time value of money, especially for long construction periods. "SOC" can be thought as reflecting a project in which the developer is also the owner & operator, "COD" a turneky contract.
                        </p>
                    </div>

                    {/* WACC Profile Selector */}
                    <div>
                        <label className="block text-sm font-medium text-slate-300 mb-2">WACC Profile</label>
                        <div className="flex items-center space-x-2 p-1 bg-slate-800 rounded-lg">
                            <button
                                onClick={() => setWaccProfile('constant')}
                                className={`flex-1 py-2 px-4 rounded-md text-sm font-medium transition-colors ${waccProfile === 'constant' ? 'bg-sky-500 text-white shadow' : 'text-slate-300 hover:bg-slate-700'}`}
                            > Constant</button>
                            <button
                                onClick={() => setWaccProfile('declining')}
                                className={`flex-1 py-2 px-4 rounded-md text-sm font-medium transition-colors ${waccProfile === 'declining' ? 'bg-sky-500 text-white shadow' : 'text-slate-300 hover:bg-slate-700'}`}
                            > Declining</button>
                        </div>
                         <p className="text-xs text-slate-500 mt-2 px-1">
                            When forecast periods are long and uncertainty is high, research suggests a declining WACC to evaluate investements in long-lived assets. In this model, a gradual decline for every third of useful life is applied.
                        </p>
                    </div>
                </div>
            </div>

            <div className="border-b border-slate-700">
              <nav className="-mb-px flex space-x-6" aria-label="Tabs">
                {(['summary', 'sensitivity'] as const).map(tab => (
                  <button key={tab} onClick={() => setActiveTab(tab)} className={`whitespace-nowrap py-4 px-1 border-b-2 font-medium text-sm capitalize ${activeTab === tab ? 'border-sky-400 text-sky-400' : 'border-transparent text-slate-400 hover:text-slate-200 hover:border-slate-500'}`}
                    aria-current={activeTab === tab ? 'page' : undefined}
                  >
                    {tab}
                  </button>
                ))}
              </nav>
            </div>
            
            <div className="mt-6">
              {activeTab === 'summary' && (
                <div className="flex flex-col items-center" role="tabpanel">
                  <div className="text-center mb-8">
                     <p className="text-slate-400 font-medium">Total LCOE</p>
                     <p className="text-4xl md:text-5xl font-bold text-sky-400 my-2">
                        {formatCurrency(lcoeResult.totalLcoe)}
                     </p>
                     <p className="text-slate-400 font-medium">per MWh</p>
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
                        <span className="w-3 h-3 rounded-full mr-2" style={{backgroundColor: s.color}}></span>
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