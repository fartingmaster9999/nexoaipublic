import { useEffect, useMemo, useState, type ReactElement } from 'react';
import { ChevronLeft, ChevronRight, ExternalLink } from 'lucide-react';
import { ResponsiveContainer, LineChart, Line, BarChart, Bar, ScatterChart, Scatter, PieChart, Pie, Cell, XAxis, YAxis, CartesianGrid, Tooltip } from 'recharts';
import type { ChartWidget } from '@/lib/interactive-widgets';
import './interactive.css';

const PALETTE = ['#61A9BD', '#CED14E', '#44986D', '#DD83C9', '#1F74AD', '#E98E2E'];
const KIND: Record<ChartWidget['provenance']['kind'], string> = {
  provided: 'Provided data', verified: 'Verified data', calculated: 'Calculated', illustrative: 'Illustrative only',
};

function useReducedMotion() {
  const [r, setR] = useState(() => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
  useEffect(() => {
    const m = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    if (!m) return;
    const f = () => setR(m.matches); m.addEventListener('change', f); return () => m.removeEventListener('change', f);
  }, []);
  return !!r;
}

const nf = new Intl.NumberFormat(undefined, { maximumSignificantDigits: 12 });
const compact = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 2 });
const cf = { format: (value: number) => value !== 0 && Math.abs(value) < .01 ? value.toExponential(1) : compact.format(value) };

export default function ChartView({ widget }: { widget: ChartWidget }) {
  const reduced = useReducedMotion();
  const { chartType, x, y, provenance } = widget;
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [cursor, setCursor] = useState(0);
  const series = widget.series;
  const color = (i: number) => PALETTE[i % PALETTE.length];
  const unitY = y.unit ? ` ${y.unit}` : '';
  const fmtY = (v: number | null | undefined) => (v == null ? 'no value' : `${nf.format(v)}${unitY}`);
  const timeFmt = useMemo(() => {
    if (x.type !== 'time') return null;
    const all = series.flatMap((s) => s.points.map((p) => Number(p.x)));
    const span = Math.max(...all) - Math.min(...all);
    const hasTime = series.some((s) => s.points.some((p) => Number(p.x) % 86400000 !== 0));
    return new Intl.DateTimeFormat(undefined, span > 3 * 365 * 864e5 ? { year: 'numeric', month: 'short', timeZone: 'UTC' } : hasTime && span < 3 * 864e5 ? { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' } : { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });
  }, [series, x.type]);
  const fmtX = (v: string | number) => (x.type === 'time' ? timeFmt!.format(new Date(Number(v))) : x.type === 'number' ? `${nf.format(Number(v))}${x.unit ? ` ${x.unit}` : ''}` : String(v));
  const tickX = (v: string | number) => (x.type === 'time' ? timeFmt!.format(new Date(Number(v))) : x.type === 'number' ? cf.format(Number(v)) : String(v));

  // Merged rows keyed by x, preserving category order or numeric sort.
  const rows = useMemo(() => {
    if (chartType === 'scatter') return series.flatMap((s) => s.points.map((p) => ({ __x: p.x, [s.id]: p.y } as Record<string, string | number | null>)))
      .sort((a, b) => Number(a.__x) - Number(b.__x));
    const map = new Map<string, Record<string, string | number | null>>();
    series.forEach((s) => s.points.forEach((p) => {
      const k = String(p.x);
      if (!map.has(k)) map.set(k, { __x: p.x });
      map.get(k)![s.id] = p.y;
    }));
    const list = [...map.values()];
    if (x.type !== 'category') list.sort((a, b) => Number(a.__x) - Number(b.__x));
    return list;
  }, [series, x.type, chartType]);

  const visible = series.filter((s) => !hidden.has(s.id));
  const toggle = (sid: string) => setHidden((h) => {
    const n = new Set(h);
    if (n.has(sid)) n.delete(sid); else if (series.length - n.size > 1) n.add(sid);
    return n;
  });
  const at = Math.min(cursor, rows.length - 1);
  const row = rows[at];
  const numericX = x.type !== 'category';
  const anim = !reduced;
  const xAxisLabel = `${x.label}${x.unit ? ` (${x.unit})` : ''}`;
  const yAxisLabel = `${y.label}${y.unit ? ` (${y.unit})` : ''}`;
  const axisTick = { fill: 'hsl(var(--muted-foreground))', fontSize: 11 };
  const horizontalBars = chartType === 'bar' && x.type === 'category' && (rows.length > 10 || rows.some((row) => String(row.__x).length > 12));

  const tip = ({ active, payload, label }: { active?: boolean; payload?: { name?: string; value?: unknown; color?: string; payload?: Record<string, unknown> }[]; label?: string | number }) => {
    if (!active || !payload?.length) return null;
    if (chartType === 'scatter') {
      const point = payload[0].payload;
      if (typeof point?.x !== 'number' || typeof point?.y !== 'number') return null;
      return <div className="nx-chart-tip"><div className="nx-tip-x">{x.label}: {fmtX(point.x)}</div><div>{y.label}: {fmtY(point.y)}</div></div>;
    }
    const lx = label ?? (payload[0].payload?.__x as string | number | undefined) ?? (payload[0].payload?.x as string | number | undefined);
    return (
      <div className="nx-chart-tip">
        {lx !== undefined && chartType !== 'donut' && <div className="nx-tip-x">{fmtX(lx)}</div>}
        {payload.map((p, i) => (
          <div key={i} className="nx-tip-row"><i style={{ background: p.color ?? (p.payload?.fill as string) }} /><span>{String(p.name ?? '')}</span><b>{fmtY(typeof p.value === 'number' ? p.value : null)}</b></div>
        ))}
      </div>
    );
  };

  const xAxis = horizontalBars ? <XAxis type="number" tickFormatter={(v) => cf.format(v)} tick={axisTick} domain={[(m: number) => Math.min(0, m), (m: number) => Math.max(0, m)]} />
    : numericX
    ? <XAxis dataKey={chartType === 'scatter' ? 'x' : '__x'} type="number" domain={['dataMin', 'dataMax']} scale={x.type === 'time' ? 'time' : 'linear'} tickFormatter={tickX} tick={axisTick} stroke="hsl(var(--foreground) / .2)" allowDuplicatedCategory={false} padding={chartType === 'bar' ? { left: 24, right: 24 } : undefined} />
    : <XAxis dataKey="__x" type="category" tick={axisTick} stroke="hsl(var(--foreground) / .2)" interval="preserveStartEnd" />;
  const yAxis = horizontalBars ? <YAxis dataKey="__x" type="category" width={120} tick={axisTick} interval="preserveStartEnd" />
    : <YAxis type="number" tickFormatter={(v) => cf.format(v)} tick={axisTick} stroke="hsl(var(--foreground) / .2)" width={48}
    domain={chartType === 'bar' ? [(m: number) => Math.min(0, m), (m: number) => Math.max(0, m)] : ['auto', 'auto']} />;
  const grid = <CartesianGrid stroke="hsl(var(--foreground) / .07)" vertical={false} />;
  const tooltip = <Tooltip content={tip} cursor={{ stroke: 'hsl(var(--foreground) / .25)', fill: 'hsl(var(--foreground) / .05)' }} />;
  const margin = { top: 8, right: 12, bottom: 4, left: 0 };
  const sparse = (n: number) => n < 10;

  let chart: ReactElement;
  if (chartType === 'donut') {
    const s = series[0];
    const data = s.points.map((p, i) => ({ name: String(p.x), value: p.y ?? 0, fill: color(i) })).filter((d) => !hidden.has(d.name));
    chart = (
      <PieChart>
        <Pie data={data} dataKey="value" nameKey="name" innerRadius="58%" outerRadius="88%" paddingAngle={1} stroke="hsl(var(--card))" isAnimationActive={anim}>
          {data.map((d) => <Cell key={d.name} fill={d.fill} />)}
        </Pie>
        {tooltip}
      </PieChart>
    );
  } else if (chartType === 'scatter') {
    chart = (
      <ScatterChart margin={margin}>
        {grid}{xAxis}<YAxis dataKey="y" type="number" domain={['auto', 'auto']} tickFormatter={(v) => cf.format(v)} tick={axisTick} stroke="hsl(var(--foreground) / .2)" width={48} />{tooltip}
        {series.map((s, i) => hidden.has(s.id) ? null : <Scatter key={s.id} name={s.name} data={s.points.filter((p) => p.y !== null)} fill={color(i)} isAnimationActive={anim} />)}
      </ScatterChart>
    );
  } else if (chartType === 'bar') {
    chart = (
      <BarChart data={rows} margin={margin} barCategoryGap="22%" layout={horizontalBars ? 'vertical' : 'horizontal'}>
        {grid}{xAxis}{yAxis}{tooltip}
        {series.map((s, i) => hidden.has(s.id) ? null : <Bar key={s.id} dataKey={s.id} name={s.name} fill={color(i)} radius={[3, 3, 0, 0]} maxBarSize={44} isAnimationActive={anim} />)}
      </BarChart>
    );
  } else {
    chart = (
      <LineChart data={rows} margin={margin}>
        {grid}{xAxis}{yAxis}{tooltip}
        {series.map((s, i) => hidden.has(s.id) ? null : <Line key={s.id} dataKey={s.id} name={s.name} stroke={color(i)} strokeWidth={2} type="linear" connectNulls={false} dot={sparse(s.points.length) ? { r: 3, fill: color(i), strokeWidth: 0 } : false} activeDot={{ r: 4 }} isAnimationActive={anim} />)}
      </LineChart>
    );
  }

  const legendItems = chartType === 'donut'
    ? series[0].points.map((p, i) => ({ id: String(p.x), name: String(p.x), c: color(i) }))
    : series.map((s, i) => ({ id: s.id, name: s.name, c: color(i) }));
  const donutTotal = chartType === 'donut' ? series[0].points.reduce((a, p) => a + (p.y ?? 0), 0) : 0;
  const visibleDonutTotal = chartType === 'donut' ? series[0].points.reduce((sum, point) => sum + (hidden.has(String(point.x)) ? 0 : point.y ?? 0), 0) : 0;
  const toggleDonut = (sid: string) => setHidden((h) => { const n = new Set(h); if (n.has(sid)) n.delete(sid); else if (legendItems.length - n.size > 1) n.add(sid); return n; });

  return (
    <figure className="nx-widget nx-chart" aria-label={`Chart: ${widget.title}`} data-testid={`chart-${widget.id}`}>
      <header className="nx-w-head">
        <span className="nx-w-kicker">{chartType === 'donut' ? 'Composition' : `${chartType} chart`}</span>
        <h3 className="nx-w-title">{widget.title}</h3>
        {widget.description && <p className="nx-w-desc">{widget.description}</p>}
      </header>

      {legendItems.length > 1 && (
        <div className="nx-legend" role="group" aria-label="Show or hide series">
          {legendItems.map((l) => {
            const on = !hidden.has(l.id);
            return (
              <button key={l.id} type="button" aria-pressed={on} className={`nx-legend-item ${on ? '' : 'is-off'}`} onClick={() => (chartType === 'donut' ? toggleDonut(l.id) : toggle(l.id))} data-testid={`button-legend-${l.id}`}>
                <i style={{ background: l.c }} />{l.name}
              </button>
            );
          })}
        </div>
      )}

      <div className="nx-chart-frame" aria-hidden="true">
        {chartType !== 'donut' && <div className="nx-axis-y">{yAxisLabel}</div>}
        <div className={`nx-chart-plot ${chartType === 'donut' ? 'is-donut' : ''}`}>
          <ResponsiveContainer width="100%" height="100%">{chart}</ResponsiveContainer>
          {chartType === 'donut' && <div className="nx-donut-center"><b>{cf.format(visibleDonutTotal)}</b><span>{hidden.size ? 'visible ' : ''}{y.unit || 'total'}</span></div>}
        </div>
        {chartType !== 'donut' && <div className="nx-axis-x">{xAxisLabel}</div>}
      </div>

      {row && (
        <div className="nx-inspect" data-testid="inspect-chart">
          <button type="button" className="nx-icon" aria-label="Previous point" disabled={at <= 0} onClick={() => setCursor(Math.max(0, at - 1))} data-testid="button-inspect-prev"><ChevronLeft size={15} /></button>
          <div className="nx-inspect-body" tabIndex={0} role="group" aria-roledescription="value inspector" aria-label="Inspect values; use left and right arrow keys"
            onKeyDown={(e) => {
              if (e.key === 'ArrowRight') { e.preventDefault(); setCursor(Math.min(rows.length - 1, at + 1)); }
              else if (e.key === 'ArrowLeft') { e.preventDefault(); setCursor(Math.max(0, at - 1)); }
              else if (e.key === 'Home') { e.preventDefault(); setCursor(0); }
              else if (e.key === 'End') { e.preventDefault(); setCursor(rows.length - 1); }
            }}>
            <div aria-live="polite" aria-atomic="true">
              <span className="nx-inspect-x">{fmtX(row.__x as string | number)}</span>
              {(chartType === 'donut' ? series : visible).map((s) => {
                const v = row[s.id] as number | null | undefined;
                return <span key={s.id} className="nx-inspect-v"><i style={{ background: color(series.indexOf(s)) }} />{chartType === 'donut' ? '' : `${s.name}: `}{fmtY(v)}{chartType === 'donut' && v != null ? ` (${nf.format(Math.round((v / donutTotal) * 1000) / 10)}% of total)` : ''}</span>;
              })}
            </div>
          </div>
          <span className="nx-inspect-pos">{at + 1}/{rows.length}</span>
          <button type="button" className="nx-icon" aria-label="Next point" disabled={at >= rows.length - 1} onClick={() => setCursor(Math.min(rows.length - 1, at + 1))} data-testid="button-inspect-next"><ChevronRight size={15} /></button>
        </div>
      )}

      <figcaption className={`nx-prov is-${provenance.kind}`} data-testid="text-chart-provenance">
        <span className="nx-prov-kind">{KIND[provenance.kind]}</span>
        <span className="nx-prov-detail">{provenance.detail}</span>
        {provenance.kind === 'calculated' && (
          <ul className="nx-prov-calculations" data-testid="list-chart-calculations">
            {series.map((s) => s.calculation && (
              <li key={s.id}>
                <span>{s.name}: y = {s.calculation.expression}</span>
                <span>x ∈ [{nf.format(s.calculation.min)}, {nf.format(s.calculation.max)}], {s.calculation.samples} samples; computed locally</span>
              </li>
            ))}
          </ul>
        )}
        {provenance.sources.length > 0 && (
          <ul className="nx-prov-sources">
            {provenance.sources.map((s, i) => (
              <li key={i}><a href={s.url} target="_blank" rel="noopener noreferrer nofollow" data-testid={`link-source-${i}`}>{s.title}<ExternalLink size={11} aria-hidden /></a></li>
            ))}
          </ul>
        )}
      </figcaption>

      <details className="nx-table-wrap">
        <summary data-testid="button-chart-table">Data table ({rows.length} {rows.length === 1 ? 'row' : 'rows'})</summary>
        <div className="nx-table-scroll">
          <table>
            <caption className="sr-only">{widget.title}: values by {x.label}</caption>
            <thead><tr><th scope="col">{xAxisLabel}</th>{series.map((s) => <th key={s.id} scope="col">{chartType === 'donut' ? yAxisLabel : `${s.name}${y.unit ? ` (${y.unit})` : ''}`}</th>)}</tr></thead>
            <tbody>{rows.map((r, i) => (
              <tr key={i}><th scope="row">{fmtX(r.__x as string | number)}</th>{series.map((s) => <td key={s.id}>{r[s.id] == null ? '—' : nf.format(r[s.id] as number)}</td>)}</tr>
            ))}</tbody>
          </table>
        </div>
      </details>
    </figure>
  );
}
