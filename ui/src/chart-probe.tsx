import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'

export interface ProbePoint {
  label: string
  requests: number
}

export function ChartProbe({ points }: { points: ProbePoint[] }) {
  return (
    <figure className="space-y-5" aria-labelledby="probe-chart-title">
      <figcaption id="probe-chart-title" className="text-lg font-semibold">
        Chart compatibility sample
      </figcaption>
      <p className="text-ink-muted">Illustrative inputs only, not proxy activity.</p>
      <ResponsiveContainer width="100%" height={240} minWidth={0}>
        <LineChart data={points} accessibilityLayer={false}>
          <CartesianGrid stroke="var(--border)" vertical={false} />
          <XAxis dataKey="label" tick={{ fill: 'var(--ink-muted)' }} />
          <YAxis allowDecimals={false} tick={{ fill: 'var(--ink-muted)' }} width={32} />
          <Tooltip />
          <Line
            type="monotone"
            dataKey="requests"
            stroke="var(--completed)"
            strokeWidth={3}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
      <table className="w-full text-left text-sm">
        <caption className="pb-3 text-left text-ink-muted">Numeric equivalent of the sample chart</caption>
        <thead>
          <tr className="border-b border-border">
            <th scope="col" className="py-2">Sample</th>
            <th scope="col" className="py-2">Requests</th>
          </tr>
        </thead>
        <tbody>
          {points.map(point => (
            <tr key={point.label} className="border-b border-border">
              <th scope="row" className="py-2 font-normal">{point.label}</th>
              <td className="py-2">{point.requests}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  )
}
