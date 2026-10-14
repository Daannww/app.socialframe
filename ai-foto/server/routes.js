// Routes voor het sporttegeltje: GPX inlezen, vereenvoudigen en afstand berekenen.
function haversine(a, b) {
  const R = 6371, rad = Math.PI / 180;
  const dLat = (b[1] - a[1]) * rad, dLng = (b[0] - a[0]) * rad;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * rad) * Math.cos(b[1] * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}
function distanceKm(pts) { let d = 0; for (let i = 1; i < pts.length; i++) d += haversine(pts[i - 1], pts[i]); return d; }

// Punten [lng, lat] uit een GPX (track- of routepunten). Meerdere segmenten worden achter elkaar gezet.
function parseGpx(xml) {
  const s = String(xml || '');
  const re = /<(?:trkpt|rtept)\b[^>]*>/g;
  const pts = []; let m;
  while ((m = re.exec(s))) {
    const lat = /\blat\s*=\s*["']([-\d.eE+]+)["']/.exec(m[0]), lon = /\blon\s*=\s*["']([-\d.eE+]+)["']/.exec(m[0]);
    if (!lat || !lon) continue;
    const la = parseFloat(lat[1]), lo = parseFloat(lon[1]);
    if (Number.isFinite(la) && Number.isFinite(lo) && Math.abs(la) <= 90 && Math.abs(lo) <= 180) pts.push([lo, la]);
  }
  return pts;
}

// Douglas-Peucker (iteratief) met een tolerantie in meters; daarna max. maxPts punten.
function simplify(pts, tolM = 3, maxPts = 2500) {
  if (pts.length <= 2) return pts.slice();
  const lat0 = pts[0][1] * Math.PI / 180, kx = 111320 * Math.cos(lat0), ky = 110540;
  const P = pts.map((p) => [p[0] * kx, p[1] * ky]);
  const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop(); let max = 0, idx = -1;
    const ax = P[a][0], ay = P[a][1], bx = P[b][0], by = P[b][1], dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
    for (let i = a + 1; i < b; i++) {
      let t = len2 ? ((P[i][0] - ax) * dx + (P[i][1] - ay) * dy) / len2 : 0; t = Math.max(0, Math.min(1, t));
      const d = Math.hypot(P[i][0] - (ax + t * dx), P[i][1] - (ay + t * dy));
      if (d > max) { max = d; idx = i; }
    }
    if (max > tolM && idx > 0) { keep[idx] = 1; stack.push([a, idx], [idx, b]); }
  }
  let out = pts.filter((_, i) => keep[i]);
  if (out.length > maxPts) { const step = out.length / maxPts; out = Array.from({ length: maxPts }, (_, i) => out[Math.min(out.length - 1, Math.round(i * step))]); out[out.length - 1] = pts[pts.length - 1]; }
  return out.map((p) => [Math.round(p[0] * 1e5) / 1e5, Math.round(p[1] * 1e5) / 1e5]);
}

module.exports = { parseGpx, simplify, distanceKm };
