"use client";

import { cls } from "@/lib/client";

export interface Series {
  label: string;
  color: string;
  points: number[];
  fill?: boolean;
}

/** Multi-series area/line chart rendered as inline SVG (no chart dependency). */
export function AreaChart({
  series,
  height = 132,
  max,
  min = 0,
  formatValue,
  bands,
}: {
  series: Series[];
  height?: number;
  max?: number;
  min?: number;
  formatValue?: (value: number) => string;
  bands?: { value: number; label: string; color: string }[];
}) {
  const width = 640;
  const length = Math.max(...series.map((entry) => entry.points.length), 1);
  const peak = max ?? Math.max(1, ...series.flatMap((entry) => entry.points), ...(bands ?? []).map((band) => band.value));
  const step = width / Math.max(1, length - 1);
  const y = (value: number) => height - ((value - min) / (peak - min)) * height;

  return (
    <div className="w-full">
      <div className="relative">
        <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" className="w-full" style={{ height }}>
          {[0.25, 0.5, 0.75].map((fraction) => (
            <line key={fraction} x1={0} x2={width} y1={height * fraction} y2={height * fraction} stroke="#1e293b" strokeWidth="1" strokeDasharray="3 5" />
          ))}
          {(bands ?? []).map((band) => (
            <g key={band.label}>
              <line x1={0} x2={width} y1={y(band.value)} y2={y(band.value)} stroke={band.color} strokeWidth="1" strokeDasharray="6 4" opacity="0.7" />
            </g>
          ))}
          {series.map((entry) => {
            if (!entry.points.length) return null;
            const path = entry.points.map((value, index) => `${index === 0 ? "M" : "L"}${(index * step).toFixed(1)},${y(value).toFixed(1)}`).join(" ");
            return (
              <g key={entry.label}>
                {entry.fill ? (
                  <path d={`${path} L${((entry.points.length - 1) * step).toFixed(1)},${height} L0,${height} Z`} fill={entry.color} opacity="0.12" />
                ) : null}
                <path d={path} fill="none" stroke={entry.color} strokeWidth="1.6" vectorEffect="non-scaling-stroke" />
              </g>
            );
          })}
        </svg>
        <div className="pointer-events-none absolute right-0 top-0 text-[10px] text-slate-500">
          {formatValue ? formatValue(peak) : peak.toFixed(1)}
        </div>
        <div className="pointer-events-none absolute bottom-0 right-0 text-[10px] text-slate-600">{formatValue ? formatValue(min) : min}</div>
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-3 text-[10px]">
        {series.map((entry) => {
          const last = entry.points[entry.points.length - 1] ?? 0;
          return (
            <span key={entry.label} className="flex items-center gap-1 text-slate-400">
              <span className="h-1.5 w-3 rounded-full" style={{ background: entry.color }} />
              {entry.label}
              <span className="mono text-slate-200">{formatValue ? formatValue(last) : last.toFixed(1)}</span>
            </span>
          );
        })}
        {bands?.map((band) => (
          <span key={`band-${band.label}`} className="flex items-center gap-1 text-slate-500">
            <span className="h-0 w-3 border-t border-dashed" style={{ borderColor: band.color }} />
            {band.label}
          </span>
        ))}
      </div>
    </div>
  );
}

/** Donut gauge for a single utilisation value. */
export function DonutGauge({
  value,
  label,
  sub,
  color = "#38bdf8",
  size = 132,
}: {
  value: number;
  label: string;
  sub?: string;
  color?: string;
  size?: number;
}) {
  const radius = size / 2 - 10;
  const circumference = 2 * Math.PI * radius;
  const pct = Math.max(0, Math.min(100, value));
  return (
    <div className="flex items-center gap-3">
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke="#1e293b" strokeWidth="9" />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={color}
          strokeWidth="9"
          strokeLinecap="round"
          strokeDasharray={`${(pct / 100) * circumference} ${circumference}`}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
        <text x="50%" y="47%" textAnchor="middle" fill="#e2e8f0" fontSize="17" fontFamily="ui-monospace, monospace">
          {pct.toFixed(1)}%
        </text>
        <text x="50%" y="62%" textAnchor="middle" fill="#64748b" fontSize="9">
          {label}
        </text>
      </svg>
      {sub ? <div className="text-[11px] leading-relaxed text-slate-400">{sub}</div> : null}
    </div>
  );
}

/** Horizontal stacked bar used for heap regions. */
export function StackedBar({ segments, total }: { segments: { label: string; value: number; color: string }[]; total: number }) {
  const safeTotal = Math.max(1, total);
  return (
    <div>
      <div className="flex h-4 w-full overflow-hidden rounded-md border border-slate-800 bg-slate-950">
        {segments.map((segment) => (
          <div
            key={segment.label}
            className="h-full transition-all"
            style={{ width: `${(segment.value / safeTotal) * 100}%`, background: segment.color }}
            title={`${segment.label}: ${segment.value.toFixed(1)} MB`}
          />
        ))}
      </div>
      <div className="mt-1 flex flex-wrap gap-3 text-[10px]">
        {segments.map((segment) => (
          <span key={segment.label} className="flex items-center gap-1 text-slate-400">
            <span className="h-1.5 w-1.5 rounded-full" style={{ background: segment.color }} />
            {segment.label}
            <span className="mono text-slate-200">{segment.value.toFixed(1)} MB</span>
          </span>
        ))}
      </div>
    </div>
  );
}

export function StatTile({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: "good" | "warn" | "bad" | "idle" | "info";
}) {
  const tones: Record<string, string> = {
    good: "text-emerald-300",
    warn: "text-amber-300",
    bad: "text-rose-300",
    idle: "text-slate-300",
    info: "text-sky-300",
  };
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-950/40 px-2.5 py-2">
      <div className="text-[10px] uppercase tracking-wide text-slate-500">{label}</div>
      <div className={cls("mono mt-0.5 truncate text-[13px]", tones[tone ?? "idle"])}>{value}</div>
      {hint ? <div className="truncate text-[10px] text-slate-500">{hint}</div> : null}
    </div>
  );
}
