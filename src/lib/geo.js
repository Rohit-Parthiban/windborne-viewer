export const toRad = (deg) => (deg * Math.PI) / 180;

// Haversine distance in meters
export function haversineMeters(a, b) {
  const R = 6371e3; // Earth radius
  const φ1 = toRad(a.lat),
    φ2 = toRad(b.lat);
  const Δφ = toRad(b.lat - a.lat);
  const Δλ = toRad(b.lon - a.lon);

  const x =
    Math.sin(Δφ / 2) ** 2 +
    Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
  const d = 2 * R * Math.asin(Math.sqrt(x));
  return d;
}

// Bearing in degrees (0-360)
export function bearingDeg(a, b) {
  const φ1 = toRad(a.lat),
    φ2 = toRad(b.lat);
  const λ1 = toRad(a.lon),
    λ2 = toRad(b.lon);

  const y = Math.sin(λ2 - λ1) * Math.cos(φ2);
  const x =
    Math.cos(φ1) * Math.sin(φ2) -
    Math.sin(φ1) * Math.cos(φ2) * Math.cos(λ2 - λ1);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}
