export async function fetchWinds(lat, lon) {
  try {
    const url =
      `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
      `&hourly=windspeed_700hPa,winddirection_700hPa,windspeed_500hPa,winddirection_500hPa&timezone=UTC`;

    const r = await fetch(url, { cache: "no-store" });
    if (!r.ok) return {};                // 429 / 5xx → return empty
    const j = await r.json();

    const n = (j.hourly?.time?.length ?? 0);
    if (!n) return {};
    const i = n - 1;
    return {
      wind500: j.hourly?.windspeed_500hPa?.[i],
      dir500:  j.hourly?.winddirection_500hPa?.[i],
      wind700: j.hourly?.windspeed_700hPa?.[i],
      dir700:  j.hourly?.winddirection_700hPa?.[i],
    };
  } catch {
    return {};                           // network/resource errors → empty
  }
}
