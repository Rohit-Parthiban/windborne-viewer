// Use upstream directly in production
// use the proxy path (works on Vercel + keeps your dev proxy working)
const BASE = "/api/windborne/treasure";


// Accepts object rows and array rows; synthesizes id/ts when missing
function normalizeRow(row, hourIndex, rowIndex) {
  if (row && typeof row === "object" && !Array.isArray(row)) {
    const id =
      row.id ?? row.balloon_id ?? row.identifier ?? row.name ?? row.ID ?? `b${rowIndex}`;
    const lat = Number(row.lat ?? row.latitude);
    const lon = Number(row.lon ?? row.lng ?? row.longitude);
    const tsRaw = row.ts ?? row.timestamp ?? row.time ?? null;
    const ts = Number.isFinite(Number(tsRaw))
      ? Number(tsRaw)
      : Math.floor(Date.now() / 1000) - hourIndex * 3600;
    if (Number.isFinite(lat) && Number.isFinite(lon)) {
      return { id: String(id), lat, lon, ts };
    }
    return null;
  }
  if (Array.isArray(row) && row.length >= 2) {
    const lat = Number(row[0]);
    const lon = Number(row[1]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    const ts = Math.floor(Date.now() / 1000) - hourIndex * 3600;
    const id = `b${rowIndex}`;
    return { id, lat, lon, ts };
  }
  return null;
}

export async function fetchLast24h() {
  const hours = Array.from({ length: 24 }, (_, i) => String(i).padStart(2, "0"));
  const results = await Promise.allSettled(
    hours.map((hh) =>
    fetch(`${BASE}/${hh}.json`, { cache: "no-store" })
{
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
    )
  );

  const byId = {};
  let totalRows = 0;
  let keptRows = 0;

  results.forEach((res, hourIdx) => {
    if (res.status !== "fulfilled" || !Array.isArray(res.value)) return;
    const arr = res.value;
    totalRows += arr.length;

    arr.forEach((raw, rowIdx) => {
      const n = normalizeRow(raw, hourIdx, rowIdx);
      if (!n) return;
      keptRows++;
      (byId[n.id] ||= []).push({ lat: n.lat, lon: n.lon, ts: n.ts });
    });
  });

  // sort/dedupe per id
  for (const id of Object.keys(byId)) {
    const seen = new Set();
    byId[id] = byId[id]
      .sort((a, b) => a.ts - b.ts)
      .filter((p) => {
        const k = `${p.ts}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
  }

  const stats = {
    raw: totalRows,
    kept: keptRows,
    balloons: Object.keys(byId).length,
  };

  return { byId, stats };
}
