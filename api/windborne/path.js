export default async function handler(req, res) {
  try {
    // Join any nested segments after /api/windborne/**
    const path = Array.isArray(req.query.path) ? req.query.path.join("/") : "";
    const upstream = `https://a.windbornesystems.com/${path}`;

    const r = await fetch(upstream, {
      cache: "no-store",
      headers: { "User-Agent": "windborne-viewer" },
    });

    // Stream result back
    const buf = Buffer.from(await r.arrayBuffer());
    res.status(r.status);
    res.setHeader(
      "Content-Type",
      r.headers.get("content-type") || "application/json; charset=utf-8"
    );
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Access-Control-Allow-Origin", "*");
    return res.send(buf);
  } catch (e) {
    return res
      .status(502)
      .json({ error: "proxy_upstream_failed", message: String(e) });
  }
}
