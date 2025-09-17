
import { useEffect, useRef, useState } from "react";
import {
  MapContainer,
  TileLayer,
  Marker,
  Popup,
  Polyline,
  useMapEvents,
  useMap,
} from "react-leaflet";
import "leaflet/dist/leaflet.css";

import { fetchLast24h } from "./api/windborne"; // returns { byId, stats }
import { fetchWinds } from "./api/openmeteo";
import { haversineMeters, bearingDeg } from "./lib/geo";
import { computeRisk } from "./lib/risk";

/** ---------- Config ---------- **/
const MAP_CENTER = [20, 0];
const REFRESH_MS = 5 * 60 * 1000;
const ENRICH_SUBSET = 50;
const ENRICH_BATCH = 25;
const TRACKS_ZOOM_VISIBLE = 4;
const WATCHLIST_LIMIT = 100;

// Playback
const DEFAULT_WINDOW_H = 24;
const PLAY_STEP_H = 1;
const PLAY_TICK_MS = 800;

// Stale / Gap heuristics
const STALE_SEC = 60 * 60;
const GAP_KM = 300;

/** ---------- Helpers ---------- **/
async function enrichInBatches(items, batchSize = ENRICH_BATCH) {
  const out = [];
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    const res = await Promise.allSettled(
      batch.map(async (tr) => {
        const last = tr.points.at(-1);
        if (!last) return [tr.id, {}];
        const winds = await fetchWinds(last.lat, last.lon); // {} on error/429
        const risk = computeRisk({ ...tr, ...winds });
        return [tr.id, { ...winds, risk }];
      })
    );
    out.push(...res);
  }
  return out;
}

function ZoomWatcher({ onChange }) {
  useMapEvents({
    zoomend(e) {
      onChange(e.target.getZoom());
    },
  });
  return null;
}

function sampleByZoom(tracks, zoom) {
  let limit = 0;
  if (zoom <= 2)       limit = 0;
  else if (zoom === 3) limit = 120;
  else if (zoom === 4) limit = 300;
  else if (zoom === 5) limit = 600;
  else                 limit = tracks.length;
  return tracks.slice(0, Math.min(limit, tracks.length));
}

function downloadCSV(rows, filename = "balloons.csv") {
  const header = ["id","lat","lon","speed_kmh","bearing_deg","risk","stale"];
  const lines = rows.map((r) => {
    const last = (r._winPts?.length ? r._winPts.at(-1) : r.points.at(-1)) || {};
    const lat = last.lat ?? "";
    const lon = last.lon ?? "";
    const speed = r.driftKmh != null ? r.driftKmh.toFixed(1) : "";
    const bearing = r.headingDeg != null ? r.headingDeg.toFixed(1) : "";
    const risk = r.risk ?? "";
    const stale = r._stale ? "TRUE" : "FALSE";
    return [r.id, lat, lon, speed, bearing, risk, stale].join(",");
  });
  const csv = [header.join(","), ...lines].join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const a = document.createElement("a");
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  a.href = URL.createObjectURL(blob);
  a.download = `${filename.replace(/\.csv$/i,"")}-${ts}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(a.href);
}

function FlyTo({ center, zoom = 8 }) {
  const map = useMap();
  useEffect(() => {
    if (!center) return;
    map.flyTo(center, zoom, { duration: 0.7 });
  }, [center, zoom, map]);
  return null;
}

function fmtAge(sec) {
  if (sec == null) return "—";
  if (sec < 90) return `${Math.round(sec)}s`;
  const min = sec / 60;
  if (min < 90) return `${Math.round(min)}m`;
  return `${(min / 60).toFixed(1)}h`;
}

export default function App() {
  const [tracks, setTracks] = useState([]); // [{ id, points, driftKmh?, headingDeg?, risk?, _stale?, _ageSec, _ageLabel, _gapKm, _gap }]
  const [lastUpdated, setLastUpdated] = useState(null);
  const [zoom, setZoom] = useState(2);
  const [ingestStats, setIngestStats] = useState(null);
  const [pinnedId, setPinnedId] = useState(null);

  // Playback
  const [hoursBack, setHoursBack] = useState(DEFAULT_WINDOW_H);
  const [playing, setPlaying] = useState(false);
  const playTimerRef = useRef(null);

  const pinned = pinnedId ? tracks.find(t => t.id === pinnedId) : null;

  async function load() {
    // Phase 1: positions + stale/gap + stats
    const { byId, stats } = await fetchLast24h();
    const nowSec = Math.floor(Date.now() / 1000);

    const list = Object.entries(byId).map(([id, points]) => {
      let driftKmh, headingDeg;
      let ageSec = null, ageLabel = "—";
      let gapKm = 0, gap = false;

      if (points.length) {
        const last = points.at(-1);
        ageSec = Math.max(0, nowSec - last.ts);
        ageLabel = fmtAge(ageSec);
      }

      if (points.length >= 2) {
        const prev = points[points.length - 2];
        const last = points[points.length - 1];
        const distM = haversineMeters(
          { lat: prev.lat, lon: prev.lon },
          { lat: last.lat, lon: last.lon }
        );
        const dtH = Math.max((last.ts - prev.ts) / 3600, 1e-6);
        driftKmh = distM / 1000 / dtH;
        headingDeg = bearingDeg(
          { lat: prev.lat, lon: prev.lon },
          { lat: last.lat, lon: last.lon }
        );
        gapKm = distM / 1000;
        gap = gapKm > GAP_KM;
      }

      const stale = ageSec != null && ageSec > STALE_SEC;

      return {
        id, points, driftKmh, headingDeg,
        risk: undefined,
        _stale: stale, _ageSec: ageSec, _ageLabel: ageLabel, _gapKm: gapKm, _gap: gap
      };
    });

    setTracks(list);
    setLastUpdated(new Date().toUTCString());
    setIngestStats(stats);

    // Phase 2: wind enrichment (subset, batched)
    const sample = list.slice(0, ENRICH_SUBSET);
    const results = await enrichInBatches(sample, ENRICH_BATCH);
    const patch = Object.fromEntries(
      results.filter((r) => r.status === "fulfilled").map((r) => r.value)
    );
    setTracks((prev) => prev.map((tr) => ({ ...tr, ...(patch[tr.id] ?? {}) })));
  }

  useEffect(() => {
    load();
    const id = setInterval(load, REFRESH_MS);
    return () => clearInterval(id);
  }, []);

  // Playback timer
  useEffect(() => {
    if (!playing) {
      if (playTimerRef.current) {
        clearInterval(playTimerRef.current);
        playTimerRef.current = null;
      }
      return;
    }
    playTimerRef.current = setInterval(() => {
      setHoursBack((h) => (h > 1 ? h - PLAY_STEP_H : DEFAULT_WINDOW_H));
    }, PLAY_TICK_MS);
    return () => {
      if (playTimerRef.current) clearInterval(playTimerRef.current);
      playTimerRef.current = null;
    };
  }, [playing]);

  /** ---------- Windowed data ---------- **/
  const nowSec = Math.floor(Date.now() / 1000);
  const cutoff = nowSec - (hoursBack * 3600);

  const tracksWindowed = tracks.map((t) => {
    const winPts = t.points.filter(p => p.ts >= cutoff);
    return { ...t, _winPts: winPts };
  });

  // Use the *windowed* pinned object everywhere below
  const pinnedWindowed = pinned ? tracksWindowed.find(t => t.id === pinned.id) : null;

  // Adaptive sampling on windowed tracks for markers
  const baseMarkers = sampleByZoom(
    tracksWindowed.filter(t => t._winPts.length),
    zoom
  );

  const visibleMarkers =
    pinnedWindowed && pinnedWindowed._winPts.length &&
    !baseMarkers.some(t => t.id === pinnedWindowed.id)
      ? [...baseMarkers, pinnedWindowed]
      : baseMarkers;

  const pinnedLast = pinnedWindowed?._winPts?.length ? pinnedWindowed._winPts.at(-1) : null;

  /** ---------- UI ---------- **/
  return (
    <div style={{ height: "100vh", width: "100vw" }}>
      {/* Header (metrics + playback + export) */}
      <div
        style={{
          position: "absolute",
          zIndex: 9999,
          padding: 10,
          background: "black",
          color: "white",
          borderRadius: 10,
          margin: 12,
          minWidth: 280,
          boxShadow: "0 6px 20px rgba(0,0,0,0.25)",
        }}
      >
        <div style={{ fontWeight: 700 }}>WindBorne (last 24h)</div>
        <div style={{ fontSize: 12, opacity: 0.9 }}>
          Last updated: {lastUpdated || "—"}
        </div>
        <div style={{ fontSize: 12, opacity: 0.9, lineHeight: 1.4 }}>
          Balloons: {tracks.length} · Markers shown: {visibleMarkers.length}
          <br />
          Ingest: {ingestStats?.kept ?? "—"}/{ingestStats?.raw ?? "—"} rows · Enriched (sample): ~{ENRICH_SUBSET}
        </div>
        <div style={{ fontSize: 12, opacity: 0.9, marginTop: 2 }}>
          Stale: {tracks.filter(t => t._stale).length} · Gaps: {tracks.filter(t => t._gap).length}
        </div>

        {/* Playback controls */}
        <div style={{ marginTop: 8 }}>
          <div style={{ fontSize: 12, marginBottom: 4, opacity: 0.9 }}>
            Window: <b>{hoursBack}h</b>
          </div>
          <input
            type="range"
            min={1}
            max={24}
            value={hoursBack}
            onChange={(e) => setHoursBack(Number(e.target.value))}
            style={{ width: 200 }}
          />
          <div style={{ display: "inline-flex", gap: 8, marginLeft: 10 }}>
            <button
              onClick={() => setHoursBack(h => Math.min(24, Math.max(1, h + 1)))}
              title="+1 hour"
              style={{ padding: "4px 8px", borderRadius: 6, border: "1px solid #444", background: "#fff", color: "#000", cursor: "pointer" }}
            >
              +1h
            </button>
            <button
              onClick={() => setHoursBack(h => Math.min(24, Math.max(1, h - 1)))}
              title="-1 hour"
              style={{ padding: "4px 8px", borderRadius: 6, border: "1px solid #444", background: "#fff", color: "#000", cursor: "pointer" }}
            >
              −1h
            </button>
            <button
              onClick={() => setPlaying(p => !p)}
              title={playing ? "Pause" : "Play"}
              style={{ padding: "4px 8px", borderRadius: 6, border: "1px solid #444", background: "#fff", color: "#000", cursor: "pointer" }}
            >
              {playing ? "Pause" : "Play"}
            </button>
            <button
              onClick={() => setHoursBack(DEFAULT_WINDOW_H)}
              title="Reset to 24h"
              style={{ padding: "4px 8px", borderRadius: 6, border: "1px solid #444", background: "#fff", color: "#000", cursor: "pointer" }}
            >
              24h
            </button>
          </div>
        </div>

        <button
          onClick={() => downloadCSV(visibleMarkers)}
          style={{
            marginTop: 8,
            padding: "6px 10px",
            borderRadius: 6,
            border: "1px solid #444",
            background: "#fff",
            color: "#000",
            cursor: "pointer",
          }}
          title="Export the currently visible markers to CSV"
        >
          Export CSV (visible)
        </button>
      </div>

      {/* Watchlist (top 100 by risk, dark theme) */}
      <aside
        style={{
          position: "absolute",
          right: 12,
          top: 12,
          width: 320,
          maxHeight: "90vh",
          overflow: "auto",
          background: "#111",
          borderRadius: 12,
          padding: 10,
          zIndex: 9999,
          boxShadow: "0 6px 20px rgba(0,0,0,0.15)",
          color: "white",
        }}
        onWheel={(e) => e.stopPropagation()}
        onTouchMove={(e) => e.stopPropagation()}
      >
        <div style={{ fontWeight: 700, marginBottom: 6 }}>
          Sorted by risk <span style={{ color:"#888", fontWeight:400 }}>— top {WATCHLIST_LIMIT}</span>
        </div>

        {tracks
          .slice()
          .sort((a, b) => (b.risk ?? -1) - (a.risk ?? -1))
          .slice(0, WATCHLIST_LIMIT)
          .map((t) => {
            const normRisk = Math.max(0, Math.min(100, Math.round(t.risk ?? 0)));
            const riskColor =
              normRisk >= 80 ? "#d9534f" : normRisk >= 50 ? "#f0ad4e" : "#5cb85c";
            return (
              <div
                key={t.id}
                style={{
                  border: "1px solid #444",
                  borderRadius: 10,
                  padding: 10,
                  marginBottom: 8,
                  background: "#000",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <div>
                    <b>{t.id}</b>{" "}
                    <span style={{ color: riskColor }}>— Risk {normRisk}/100</span>
                  </div>
                  {t._stale && (
                    <span style={{ background:"#2a0000", color:"#ff5555", border:"1px solid #ff5555", borderRadius:8, padding:"2px 6px", fontSize:12 }}>
                      STALE
                    </span>
                  )}
                  {t._gap && (
                    <span style={{ background:"#2a1a00", color:"#ffb74d", border:"1px solid #ffb74d", borderRadius:8, padding:"2px 6px", fontSize:12 }}>
                      GAP {Math.round(t._gapKm)} km
                    </span>
                  )}
                  <span style={{ color:"#bbb", fontSize:12 }}>· Last {t._ageLabel}</span>
                </div>
                <div style={{ fontSize: 12, color: "#bbb" }}>
                  Drift {t.driftKmh?.toFixed?.(0) ?? "—"} km/h · Δheading vs wind shown in popup
                </div>
              </div>
            );
          })}
      </aside>

      {/* Map */}
      <MapContainer
        center={MAP_CENTER}
        zoom={2}
        style={{ height: "100%", width: "100%" }}
        worldCopyJump
      >
        <ZoomWatcher onChange={setZoom} />
        {pinnedLast && <FlyTo center={[pinnedLast.lat, pinnedLast.lon]} zoom={8} />}

        <TileLayer
          attribution="&copy; OpenStreetMap contributors"
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />

        {/* Windowed markers (ensure pinned is included) */}
        {visibleMarkers.map((tr) => {
          const pts = tr._winPts;
          if (!pts?.length) return null;
          const last = pts[pts.length - 1];

          let speed = tr.driftKmh, bearing = tr.headingDeg;
          if (pts.length >= 2) {
            const prev = pts[pts.length - 2];
            const distM = haversineMeters(
              { lat: prev.lat, lon: prev.lon },
              { lat: last.lat, lon: last.lon }
            );
            const dtH = Math.max((last.ts - prev.ts) / 3600, 1e-6);
            speed = distM / 1000 / dtH;
            bearing = bearingDeg(
              { lat: prev.lat, lon: prev.lon },
              { lat: last.lat, lon: last.lon }
            );
          }

          const normRisk = Math.max(0, Math.min(100, Math.round(tr.risk ?? 0)));

          return (
            <Marker key={tr.id} position={[last.lat, last.lon]}>
              <Popup>
                <div><b>ID:</b> {tr.id}</div>
                <div><b>Points (window):</b> {pts.length}</div>
                <div><b>Speed:</b> {speed?.toFixed?.(1) ?? "—"} km/h</div>
                <div><b>Bearing:</b> {bearing?.toFixed?.(1) ?? "—"}°</div>
                <div><b>Last seen:</b> {tr._ageLabel}</div>
                {tr._gapKm > 0 && (
                  <div><b>Last hop:</b> {tr._gapKm.toFixed(0)} km{tr._gap ? " · GAP" : ""}</div>
                )}
                {tr.risk !== undefined ? (
                  <>
                    <div><b>Wind 700hPa:</b> {tr.wind700?.toFixed?.(1) ?? "—"} m/s · dir {tr.dir700 ?? "—"}°</div>
                    <div><b>Wind 500hPa:</b> {tr.wind500?.toFixed?.(1) ?? "—"} m/s · dir {tr.dir500 ?? "—"}°</div>
                    <div><b>Risk:</b> {normRisk}/100</div>
                  </>
                ) : (
                  <div style={{ color: "#888" }}>Wind/risk not loaded</div>
                )}

                <div style={{ marginTop: 6 }}>
                  <button
                    onClick={() => setPinnedId(pinnedId === tr.id ? null : tr.id)}
                    style={{
                      padding: "6px 10px",
                      borderRadius: 6,
                      border: "1px solid #444",
                      background: pinnedId === tr.id ? "#eee" : "#fff",
                      color: "#000",
                      cursor: "pointer",
                    }}
                  >
                    {pinnedId === tr.id ? "Unpin" : "Pin"}
                  </button>
                </div>
              </Popup>
            </Marker>
          );
        })}

        {/* Non-pinned polylines (windowed) */}
        {tracksWindowed.map((tr) => {
          if (tr.id === pinnedId) return null;
          if (zoom < TRACKS_ZOOM_VISIBLE) return null;
          if (!tr._winPts.length) return null;
          const latlngs = tr._winPts.map((p) => [p.lat, p.lon]);
          return (
            <Polyline
              key={`line-${tr.id}`}
              positions={latlngs}
              opacity={0.25}
              weight={1.5}
              dashArray="4 6"
            />
          );
        })}

        {/* Pinned polyline — uses *windowed* points and draws on top */}
        {pinnedWindowed?._winPts?.length ? (
          <Polyline
            key={`line-${pinnedWindowed.id}`}
            positions={pinnedWindowed._winPts.map((p) => [p.lat, p.lon])}
            opacity={0.95}
            weight={5}
            color="#ff6b00"
            lineJoin="round"
            lineCap="round"
          />
        ) : null}
      </MapContainer>
    </div>
  );
}
