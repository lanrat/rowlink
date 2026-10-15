// Garmin Training Center (TCX) export. Older format, but widely accepted.
// TCX has no rowing sport, so Sport="Other"; cadence carries strokes per minute.

const esc = (s) => String(s).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]);
const iso = (ms) => new Date(ms).toISOString();
const num = (x, digits = 1) => (x == null || !isFinite(x) ? null : Number(x.toFixed(digits)));

export function encodeTcx(session, data) {
  const s = session.summary;
  const start = session.startedAt;
  const points = data.samples.map((p) => {
    const speed = !p.z && p.p ? 500 / p.p : 0;
    const parts = [`<Time>${iso(start + p.t * 1000)}</Time>`];
    if (p.d != null) parts.push(`<DistanceMeters>${num(p.d)}</DistanceMeters>`);
    if (p.r != null && !p.z) parts.push(`<Cadence>${Math.min(254, Math.round(p.r))}</Cadence>`);
    const tpx = [`<ns3:Speed>${num(speed, 3)}</ns3:Speed>`];
    if (p.w != null && !p.z) tpx.push(`<ns3:Watts>${Math.round(p.w)}</ns3:Watts>`);
    parts.push(`<Extensions><ns3:TPX>${tpx.join('')}</ns3:TPX></Extensions>`);
    return `<Trackpoint>${parts.join('')}</Trackpoint>`;
  });
  const lapExt = s.avgPowerW != null ? `<Extensions><ns3:LX><ns3:AvgWatts>${s.avgPowerW}</ns3:AvgWatts></ns3:LX></Extensions>` : '';
  return `<?xml version="1.0" encoding="UTF-8"?>
<TrainingCenterDatabase xmlns="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2" xmlns:ns3="http://www.garmin.com/xmlschemas/ActivityExtension/v2">
<Activities>
<Activity Sport="Other">
<Id>${iso(start)}</Id>
<Lap StartTime="${iso(start)}">
<TotalTimeSeconds>${num(s.movingS)}</TotalTimeSeconds>
<DistanceMeters>${num(s.distanceM)}</DistanceMeters>
<Calories>${Math.round(s.kcal ?? 0)}</Calories>
<Intensity>Active</Intensity>
${s.avgSpm != null ? `<Cadence>${Math.round(s.avgSpm)}</Cadence>\n` : ''}<TriggerMethod>Manual</TriggerMethod>
<Track>
${points.join('\n')}
</Track>
${lapExt}
</Lap>
<Notes>${esc(`Indoor rowing${session.device ? ` on ${session.device}` : ''}`)}</Notes>
</Activity>
</Activities>
</TrainingCenterDatabase>
`;
}
