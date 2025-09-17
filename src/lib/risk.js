export function angleDelta(a, b) {
  if (a == null || b == null) return undefined;
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

// Simple risk: combine drift speed, wind mismatch, and shear → 0..100
export function computeRisk({ driftKmh, headingDeg, dir700, dir500, wind700, wind500 }) {
  if (driftKmh == null) return undefined;

  const useDir = dir700 ?? dir500;
  const mismatch = angleDelta(headingDeg, useDir);         // degrees
  const shear = (wind700 != null && wind500 != null) ? Math.abs(wind700 - wind500) : undefined; // m/s

  const d = Math.min(driftKmh / 100, 1); // cap 100 km/h
  const m = mismatch != null ? Math.min(mismatch / 90, 1) : 0; // cap 90°
  const s = shear != null ? Math.min(shear / 30, 1) : 0;        // cap 30 m/s

  return Math.round((0.4 * d + 0.4 * m + 0.2 * s) * 100);
}
