import React, { useCallback, useEffect, useState, useRef } from 'react';

// --- SliderInput Component ---
interface SliderInputProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  unit: string;
  onChange: (value: number) => void;
  formatter?: (value: number) => string;
}

export const SliderInput: React.FC<SliderInputProps> = ({
  label,
  value,
  min,
  max,
  step,
  unit,
  onChange,
  formatter = (val) => new Intl.NumberFormat().format(val),
}) => {
  const getPercent = useCallback((val: number) => {
    if (max === min) return 0;
    return ((val - min) / (max - min)) * 100;
  }, [min, max]);

  const percent = getPercent(value);

  return (
    <div className="space-y-2">
      <label className="text-sm font-medium text-slate-400" id={`${label}-label`}>{label}</label>
      <div className="relative h-8 flex items-center">
        <div className="relative w-full h-2">
          <div className="absolute w-full rounded h-1.5 bg-slate-700 z-10 top-1/2 -translate-y-1/2"></div>
          <div 
            className="absolute rounded h-1.5 bg-sky-400 z-20 top-1/2 -translate-y-1/2"
            style={{ width: `${percent}%` }}
          ></div>
           <input
            type="range"
            min={min}
            max={max}
            step={step}
            value={value}
            onChange={(event) => onChange(Number(event.target.value))}
            className="absolute w-full h-full appearance-none bg-transparent cursor-pointer z-30"
            style={{ margin: 0, padding: 0 }}
            aria-labelledby={`${label}-label`}
          />
        </div>
      </div>
      <div className="text-right">
        <span className="px-2 py-1 font-semibold text-sky-200 bg-sky-900/50 rounded-md text-sm">
          {formatter(value)} {unit}
        </span>
      </div>
       <style>{`
        input[type=range] {
            -webkit-appearance: none;
            width: 100%;
            background: transparent;
        }
        input[type=range]:focus {
            outline: none;
        }
        input[type=range]::-webkit-slider-thumb {
          -webkit-appearance: none;
          -webkit-tap-highlight-color: transparent;
          pointer-events: all;
          width: 20px;
          height: 20px;
          background-color: #1e293b;
          border-radius: 50%;
          border: 3px solid #38bdf8;
          cursor: pointer;
          margin-top: -7px;
        }
        input[type=range]::-moz-range-thumb {
          pointer-events: all;
          width: 20px;
          height: 20px;
          background-color: #1e293b;
          border-radius: 50%;
          border: 3px solid #38bdf8;
          cursor: pointer;
        }
        input[type=range]:focus::-webkit-slider-thumb {
            box-shadow: 0 0 0 3px rgba(56, 189, 248, 0.4);
        }
       `}</style>
    </div>
  );
};


// --- RangeSlider Component ---
interface RangeSliderProps {
  min: number;
  max: number;
  step: number;
  value: [number, number];
  onChange: (newValue: [number, number]) => void;
  formatter: (value: number) => string;
}

export const RangeSlider: React.FC<RangeSliderProps> = ({ min, max, step, value, onChange, formatter }) => {
  const [minVal, maxVal] = value;

  const handleMinChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const newMinVal = Math.min(Number(event.target.value), maxVal - step);
    onChange([newMinVal, maxVal]);
  };

  const handleMaxChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const newMaxVal = Math.max(Number(event.target.value), minVal + step);
    onChange([minVal, newMaxVal]);
  };

  const getPercent = useCallback((val: number) => ((val - min) / (max - min)) * 100, [min, max]);
  const minPercent = getPercent(minVal);
  const maxPercent = getPercent(maxVal);

  return (
    <div className="space-y-2">
      <div className="relative h-6 flex items-center">
        <div className="absolute w-full h-1 bg-slate-700 rounded top-1/2 -translate-y-1/2"></div>
        <div
          className="absolute h-1 bg-sky-400 rounded top-1/2 -translate-y-1/2"
          style={{ left: `${minPercent}%`, right: `${100 - maxPercent}%` }}
        ></div>
        <input
          type="range" min={min} max={max} step={step} value={minVal}
          onChange={handleMinChange}
          className="absolute w-full h-full appearance-none bg-transparent pointer-events-none"
          style={{ zIndex: 3 }}
        />
        <input
          type="range" min={min} max={max} step={step} value={maxVal}
          onChange={handleMaxChange}
          className="absolute w-full h-full appearance-none bg-transparent pointer-events-none"
          style={{ zIndex: 4 }}
        />
         <style>{`
          .range-slider-thumb {
            -webkit-appearance: none;
            -webkit-tap-highlight-color: transparent;
            pointer-events: all;
            width: 16px;
            height: 16px;
            background-color: #1e293b;
            border-radius: 50%;
            border: 2px solid #38bdf8;
            cursor: pointer;
            margin-top: -7px;
          }
          .range-slider-thumb::-moz-range-thumb {
            pointer-events: all;
            width: 16px;
            height: 16px;
            background-color: #1e293b;
            border-radius: 50%;
            border: 2px solid #38bdf8;
            cursor: pointer;
          }
          input[type=range]::-webkit-slider-thumb {
             -webkit-appearance: none;
             pointer-events: all;
          }
          input[type=range]::-moz-range-thumb {
             pointer-events: all;
          }
          input[type=range] {
              -webkit-appearance: none;
              width: 100%;
              background: transparent;
          }
          input[type=range]:focus {
              outline: none;
          }
          input[type=range]::-webkit-slider-thumb {
            -webkit-appearance: none;
            -webkit-tap-highlight-color: transparent;
            pointer-events: all;
            width: 16px;
            height: 16px;
            background-color: #1e293b;
            border-radius: 50%;
            border: 2px solid #38bdf8;
            cursor: pointer;
            margin-top: -7px;
          }
          input[type=range]::-moz-range-thumb {
            pointer-events: all;
            width: 16px;
            height: 16px;
            background-color: #1e293b;
            border-radius: 50%;
            border: 2px solid #38bdf8;
            cursor: pointer;
          }
       `}</style>
      </div>
      <div className="flex justify-between text-xs text-slate-400">
        <span>{formatter(minVal)}</span>
        <span>{formatter(maxVal)}</span>
      </div>
    </div>
  );
};


// --- PieChart Component ---
interface PieChartProps {
  data: {
    value: number;
    color: string;
    label: string;
  }[];
}

const getCoordinatesForPercent = (percent: number, radius: number, cx: number, cy: number) => {
  const x = cx + radius * Math.cos(2 * Math.PI * percent);
  const y = cy + radius * Math.sin(2 * Math.PI * percent);
  return [x, y];
};

export const PieChart: React.FC<PieChartProps> = ({ data }) => {
  const [hoveredSlice, setHoveredSlice] = useState<string | null>(null);
  const total = data.reduce((acc, slice) => acc + slice.value, 0);
  if (total === 0) return null;

  const hoveredData = data.find(d => d.label === hoveredSlice);
  let cumulativePercent = 0;

  return (
    <div className="relative w-full h-full">
      <svg viewBox="0 0 100 100" className="w-full h-full transform -rotate-90">
        {data.map((slice, index) => {
          if (slice.value <= 0) return null;

          const radius = 48;
          const [startX, startY] = getCoordinatesForPercent(cumulativePercent, radius, 50, 50);
          const slicePercent = slice.value / total;
          cumulativePercent += slicePercent;
          const [endX, endY] = getCoordinatesForPercent(cumulativePercent, radius, 50, 50);
          const largeArcFlag = slicePercent > 0.5 ? 1 : 0;

          const pathData = [
            `M 50 50`,
            `L ${startX} ${startY}`,
            `A ${radius} ${radius} 0 ${largeArcFlag} 1 ${endX} ${endY}`,
            'Z'
          ].join(' ');

          return (
            <path
              key={index}
              d={pathData}
              fill={slice.color}
              stroke={slice.label === hoveredSlice ? '#f8fafc' : slice.color}
              strokeWidth={slice.label === hoveredSlice ? 2 : 1}
              onMouseEnter={() => setHoveredSlice(slice.label)}
              onMouseLeave={() => setHoveredSlice(null)}
              style={{ transition: 'all 0.2s ease', cursor: 'pointer' }}
            />
          );
        })}
      </svg>
      <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
        <div 
          className="text-center transition-opacity duration-200 bg-slate-800/80 backdrop-blur-sm rounded-lg p-3 shadow-lg" 
          style={{opacity: hoveredData ? 1 : 0}}
        >
          {hoveredData && (
            <>
              <div className="text-sm font-medium text-slate-300">{hoveredData.label}</div>
              <div className="text-xl font-bold text-slate-100">
                {((hoveredData.value / total) * 100).toFixed(1)}%
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
};

// --- Chart Tooltip ---
const ChartTooltip: React.FC<{
  points: ({ color: string; value: string })[];
}> = ({ points }) => {
  if (!points.length) return null;
  return (
    <div
      className="bg-slate-800 border border-slate-600 shadow-lg rounded-lg p-4 text-base space-y-2"
    >
      {points.map((p, i) => (
        <div key={i} className="flex items-center text-slate-300 whitespace-nowrap">
          <span className="w-3 h-3 rounded-full mr-2" style={{ backgroundColor: p.color }}></span>
          <span>{p.value}</span>
        </div>
      ))}
    </div>
  );
};

// --- LineChart Component ---
interface LineChartProps<T> {
  data: {
    series: { name: string; color: string; points: T[]; strokeWidth?: number }[];
    xAccessor: (d: T) => number;
    yAccessor: (d: T) => number;
    xLabel: string;
    yLabel: string;
    xFormatter?: (d: number) => string;
    yFormatter?: (d: number) => string;
  };
}

export function LineChart<T>({ data }: LineChartProps<T>) {
  const { series, xAccessor, yAccessor, xLabel, yLabel, xFormatter = d => d.toString(), yFormatter = d => d.toString() } = data;
  const svgRef = useRef<SVGSVGElement>(null);
  const [tooltip, setTooltip] = useState<{ x: number; y: number; content: JSX.Element; points: { cy: number; color: string; r: number }[]; } | null>(null);

  const padding = { top: 20, right: 20, bottom: 50, left: 80 };
  const width = 500;
  const height = 300;

  const allPoints = series.flatMap(s => s.points);
  if (allPoints.length === 0) return null;
  
  const xDomain = [Math.min(...allPoints.map(xAccessor)), Math.max(...allPoints.map(xAccessor))];
  const yDomain = [0, Math.max(...allPoints.map(yAccessor))];

  const xScale = (val: number) => padding.left + ((val - xDomain[0]) / (xDomain[1] - xDomain[0])) * (width - padding.left - padding.right);
  const yScale = (val: number) => height - padding.bottom - ((val - yDomain[0]) / (yDomain[1] - yDomain[0])) * (height - padding.top - padding.bottom);

  const handleMouseMove = (e: React.MouseEvent<SVGSVGElement>) => {
    if (!svgRef.current || !allPoints.length) return;
    const svgRect = svgRef.current.getBoundingClientRect();
    const mouseX = e.clientX - svgRect.left;

    const xVal = xDomain[0] + ((mouseX - padding.left) / (width - padding.left - padding.right)) * (xDomain[1] - xDomain[0]);
    
    let closestPoint: T | null = null;
    let minDistance = Infinity;
    allPoints.forEach(p => {
        const dist = Math.abs(xAccessor(p) - xVal);
        if(dist < minDistance) {
            minDistance = dist;
            closestPoint = p;
        }
    });

    if(closestPoint) {
        const tooltipPoints = series.map(s => {
            const pointInSeries = s.points.find(p => xAccessor(p) === xAccessor(closestPoint!));
            return {
                color: s.color,
                value: pointInSeries ? `${s.name}: ${yFormatter(yAccessor(pointInSeries))}` : ''
            }
        }).filter(p => p.value);

        if(tooltipPoints.length > 0) {
            const hoverPoints: { cy: number; color: string; r: number }[] = [];
            let baselineY: number | undefined;
    
            series.forEach(s => {
                const pointInSeries = s.points.find(p => xAccessor(p) === xAccessor(closestPoint!));
                if (pointInSeries) {
                    const cy = yScale(yAccessor(pointInSeries));
                    const isBaseline = s.name === 'Baseline';
                    hoverPoints.push({
                        cy,
                        color: s.color,
                        r: isBaseline ? 4 : 3,
                    });
                    if (isBaseline) {
                        baselineY = cy;
                    }
                }
            });

            const tooltipY = baselineY ?? (hoverPoints.reduce((sum, p) => sum + p.cy, 0) / hoverPoints.length);

            setTooltip({
                x: xScale(xAccessor(closestPoint!)),
                y: tooltipY,
                content: <ChartTooltip points={tooltipPoints} />,
                points: hoverPoints,
            });
        }
    }
  };

  const handleMouseLeave = () => setTooltip(null);
  
  const yTicks = 5;
  const yTickValues = Array.from({length: yTicks + 1}, (_, i) => yDomain[0] + i * ((yDomain[1] - yDomain[0]) / yTicks));
  
  const xTicks = 5;
  const xTickValues = Array.from({length: xTicks + 1}, (_, i) => xDomain[0] + i * ((xDomain[1] - xDomain[0]) / xTicks));

  const lowSeries = series.find(s => s.name.startsWith('Low'));
  const highSeries = series.find(s => s.name.startsWith('High'));
  let areaPath = '';

  if (lowSeries && highSeries && lowSeries.points.length > 0 && highSeries.points.length > 0) {
      const lowPoints = lowSeries.points.map(p => `${xScale(xAccessor(p))},${yScale(yAccessor(p))}`).join(' L ');
      const highPointsReversed = highSeries.points.slice().reverse().map(p => `${xScale(xAccessor(p))},${yScale(yAccessor(p))}`).join(' L ');
      areaPath = `M ${lowPoints} L ${highPointsReversed} Z`;
  }

  return (
    <div className="relative">
      <svg ref={svgRef} viewBox={`0 0 ${width} ${height}`} onMouseMove={handleMouseMove} onMouseLeave={handleMouseLeave}>
        {/* Y-axis */}
        {yTickValues.map(tick => (
            <g key={tick} transform={`translate(0, ${yScale(tick)})`}>
                <line x1={padding.left} x2={width - padding.right} stroke="#475569" strokeDasharray="2,2" />
                <text x={padding.left - 8} y="4" textAnchor="end" fontSize="10" fill="#94a3b8">{yFormatter(tick)}</text>
            </g>
        ))}
        <text transform={`translate(${padding.left / 3}, ${height / 2}) rotate(-90)`} textAnchor="middle" fontSize="12" fill="#d1d5db" fontWeight="medium">{yLabel}</text>
        
        {/* X-axis */}
        <line x1={padding.left} y1={height - padding.bottom} x2={width-padding.right} y2={height - padding.bottom} stroke="#64748b"/>
        {xTickValues.map(tick => (
            <g key={tick} transform={`translate(${xScale(tick)}, ${height - padding.bottom})`}>
                <line y2="5" stroke="#64748b" />
                <text y="20" textAnchor="middle" fontSize="10" fill="#94a3b8">{xFormatter(tick)}</text>
            </g>
        ))}
        <text x={width/2} y={height - 10} textAnchor="middle" fontSize="12" fill="#d1d5db" fontWeight="medium">{xLabel}</text>

        {/* Shaded Area */}
        {areaPath && <path d={areaPath} fill="#38bdf8" opacity="0.1" />}

        {/* Lines */}
        {series.map(s => (
          <path
            key={s.name}
            d={`M ${s.points.map(p => `${xScale(xAccessor(p))},${yScale(yAccessor(p))}`).join(' L ')}`}
            fill="none"
            stroke={s.color}
            strokeWidth={s.strokeWidth || 2}
          />
        ))}

        {/* Hover points */}
        {tooltip && tooltip.points.map((point, index) => (
            <circle
                key={index}
                cx={tooltip.x}
                cy={point.cy}
                r={point.r}
                fill="#1e293b"
                stroke={point.color}
                strokeWidth="2"
            />
        ))}
      </svg>
      {tooltip && <div style={{position: 'absolute', top: tooltip.y, left: tooltip.x, transform: 'translate(-50%, -110%)', pointerEvents: 'none', transition: 'top 0.1s, left 0.1s'}}>{tooltip.content}</div>}
    </div>
  );
}

// --- AreaChart Component ---
interface AreaChartProps<T> {
  data: {
    points: T[];
    xAccessor: (d: T) => number;
    yAccessor: (d: T) => number;
    xLabel: string;
    yLabel: string;
    xFormatter?: (d: number) => string;
    yFormatter?: (d: number) => string;
  };
}

export function AreaChart<T>({ data }: AreaChartProps<T>) {
  const { points, xAccessor, yAccessor, xLabel, yLabel, xFormatter = d => d.toString(), yFormatter = d => d.toString() } = data;
  const padding = { top: 20, right: 20, bottom: 40, left: 60 };
  const width = 500;
  const height = 300;

  const xDomain = [Math.min(...points.map(xAccessor)), Math.max(...points.map(xAccessor))];
  const yMin = Math.min(...points.map(yAccessor));
  const yMax = Math.max(...points.map(yAccessor));
  const yDomain = [yMin < 0 ? yMin : 0, yMax];

  const xScale = (val: number) => padding.left + ((val - xDomain[0]) / (xDomain[1] - xDomain[0])) * (width - padding.left - padding.right);
  const yScale = (val: number) => height - padding.bottom - ((val - yDomain[0]) / (yDomain[1] - yDomain[0])) * (height - padding.top - padding.bottom);
  
  const yTicks = 5;
  const yTickValues = Array.from({length: yTicks + 1}, (_, i) => yDomain[0] + i * ((yDomain[1] - yDomain[0]) / yTicks));
  const zeroLine = yScale(0);

  const areaPath = `M ${points.map(p => `${xScale(xAccessor(p))},${yScale(yAccessor(p))}`).join(' L ')} L ${xScale(xDomain[1])},${zeroLine} L ${xScale(xDomain[0])},${zeroLine} Z`;

  return (
    <svg viewBox={`0 0 ${width} ${height}`}>
      <defs>
        <linearGradient id="areaGradient" x1="0" x2="0" y1="0" y2="1">
          <stop offset={`${(yScale(yDomain[1]) / zeroLine) * 100}%`} stopColor="#10b981" stopOpacity="0.4" />
          <stop offset={`${(zeroLine / yScale(yDomain[0])) * 100}%`} stopColor="#10b981" stopOpacity="0.4" />
          <stop offset={`${(zeroLine / yScale(yDomain[0])) * 100}%`} stopColor="#ef4444" stopOpacity="0.4" />
        </linearGradient>
         <mask id="areaMask">
            <path d={areaPath} fill="white"/>
        </mask>
      </defs>
      
      {/* Y-axis */}
      {yTickValues.map(tick => (
        <g key={tick} transform={`translate(0, ${yScale(tick)})`}>
            <line x1={padding.left} x2={width - padding.right} stroke="#e2e8f0" strokeDasharray="2,2" />
            <text x={padding.left - 8} y="4" textAnchor="end" fontSize="10" fill="#64748b">{yFormatter(tick)}</text>
        </g>
      ))}
      <line x1={padding.left} y1={zeroLine} x2={width - padding.right} stroke="#64748b" strokeWidth="1" />
      <text transform={`translate(${padding.left / 2}, ${height / 2}) rotate(-90)`} textAnchor="middle" fontSize="12" fill="#334155" fontWeight="medium">{yLabel}</text>
      
      {/* X-axis */}
      <line x1={padding.left} y1={height - padding.bottom} x2={width - padding.right} y2={height - padding.bottom} stroke="#94a3b8"/>
      <text x={width / 2} y={height - 5} textAnchor="middle" fontSize="12" fill="#334155" fontWeight="medium">{xLabel}</text>

      {/* Area */}
      <rect x="0" y="0" width={width} height={height} fill="url(#areaGradient)" mask="url(#areaMask)"/>

      {/* Line on top of area */}
       <path
          d={`M ${points.map(p => `${xScale(xAccessor(p))},${yScale(yAccessor(p))}`).join(' L ')}`}
          fill="none"
          stroke={yScale(yAccessor(points[points.length - 1])) < zeroLine ? "#10b981" : "#ef4444"}
          strokeWidth="2"
        />
    </svg>
  );
}