const express = require("express");
const fs = require("fs");
const path = require("path");
const AdmZip = require("adm-zip");
const { parse } = require("csv-parse/sync");
const GtfsRt = require("gtfs-realtime-bindings");
const helmet = require("helmet");
const cors = require("cors");
const rateLimit = require("express-rate-limit");

// Official TPBI open data (see mo-bi.ro -> Source Code and Open Data for terms of use)
const STATIC_URL = "https://gtfs.tpbi.ro/regional/BUCHAREST-REGION.zip";
const VEHICLES_URL = "https://gtfs.tpbi.ro/api/gtfs-rt/vehiclePositions";
const POLL_MS = 20_000;
const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, "data");
const LINES_FILE = path.join(DATA_DIR, "lines.json");
const ZIP_FILE = path.join(DATA_DIR, "gtfs.zip");
const ZIP_MAX_AGE = 12 * 60 * 60 * 1000;

let routes = {}; // route_id -> { name, long, type }
let byName = {}; // short name -> { id, name, long, type, paths }
let trips = Object.create(null); // trip_id -> { headsign, direction }
let stops = Object.create(null); // stop_id -> name
let vehicles = [];
let lastUpdate = null;
let lastError = null;

function categorize(routeType, name) {
  if (/^N\d/i.test(name)) return "night";
  const t = Number(routeType);
  if (t === 0 || (t >= 900 && t < 1000)) return "tram";
  if (t === 11 || t === 800) return "trolleybus";
  if (t === 1 || (t >= 400 && t < 500)) return "metro";
  if (t === 3 || (t >= 700 && t < 800)) return "bus";
  return "other";
}

function asNum(v) {
  if (v == null || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v.toNumber === "function") {
    const n = v.toNumber();
    return Number.isFinite(n) ? n : null;
  }
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function hasField(msg, name) {
  return !!msg && Object.prototype.hasOwnProperty.call(msg, name);
}

function readCsv(zip, name) {
  const entry = zip.getEntry(name);
  if (!entry) throw new Error("Lipsește " + name + " din GTFS");
  return parse(entry.getData().toString("utf8"), { columns: true, skip_empty_lines: true, bom: true });
}

function simplify(points, eps) {
  if (points.length <= 2) return points;
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  const eps2 = eps * eps;
  while (stack.length) {
    const [a, b] = stack.pop();
    let maxD = 0;
    let idx = -1;
    const ax = points[a][0];
    const ay = points[a][1];
    const bx = points[b][0];
    const by = points[b][1];
    const dx = bx - ax;
    const dy = by - ay;
    const m = dx * dx + dy * dy;
    for (let i = a + 1; i < b; i++) {
      const px = points[i][0];
      const py = points[i][1];
      let d;
      if (m === 0) d = (px - ax) ** 2 + (py - ay) ** 2;
      else {
        let t = ((px - ax) * dx + (py - ay) * dy) / m;
        if (t < 0) t = 0;
        else if (t > 1) t = 1;
        const qx = ax + t * dx;
        const qy = ay + t * dy;
        d = (px - qx) ** 2 + (py - qy) ** 2;
      }
      if (d > maxD) {
        maxD = d;
        idx = i;
      }
    }
    if (idx !== -1 && maxD > eps2) {
      keep[idx] = 1;
      stack.push([a, idx], [idx, b]);
    }
  }
  const out = [];
  for (let i = 0; i < points.length; i++) if (keep[i]) out.push(points[i]);
  return out;
}

function roundPath(points) {
  let path = points.map((p) => [Math.round(p[0] * 1e5) / 1e5, Math.round(p[1] * 1e5) / 1e5]);
  path = path.filter((p, i) => i === 0 || p[0] !== path[i - 1][0] || p[1] !== path[i - 1][1]);
  if (path.length > 600) path = simplify(path, 0.00008);
  if (path.length > 900) path = simplify(path, 0.0002);
  return path;
}

function emptyLines() {
  return { tram: [], bus: [], trolleybus: [], night: [], metro: [], other: [] };
}

async function fetchZip() {
  const res = await fetch(STATIC_URL);
  if (!res.ok) throw new Error("Static GTFS HTTP " + res.status);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(ZIP_FILE, buf);
  return buf;
}

async function zipBuffer() {
  try {
    const st = fs.statSync(ZIP_FILE);
    if (Date.now() - st.mtimeMs < ZIP_MAX_AGE && st.size > 1000) return fs.readFileSync(ZIP_FILE);
  } catch { /* download below */ }
  return fetchZip();
}

function applyStatic(buf) {
  const zip = new AdmZip(buf);
  const routeRows = readCsv(zip, "routes.txt");
  const tripRows = readCsv(zip, "trips.txt");
  const stopRows = readCsv(zip, "stops.txt");
  const shapeRows = readCsv(zip, "shapes.txt");

  const nextRoutes = {};
  const nextByName = {};
  const lines = emptyLines();
  for (const r of routeRows) {
    const name = r.route_short_name || r.route_id;
    const type = categorize(r.route_type, name);
    const meta = { id: r.route_id, name, long: r.route_long_name || "", type, paths: [] };
    nextRoutes[r.route_id] = meta;
    nextByName[name] = meta;
    (lines[type] || lines.other).push({ id: r.route_id, name, long: meta.long });
  }
  for (const k of Object.keys(lines))
    lines[k].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));

  const nextTrips = Object.create(null);
  const votes = new Map();
  for (const t of tripRows) {
    const headsign = (t.trip_headsign || "").trim();
    const direction = t.direction_id === "1" ? 1 : 0;
    nextTrips[t.trip_id] = { headsign, direction };
    if (!t.shape_id || !nextRoutes[t.route_id]) continue;
    const key = t.route_id + "|" + direction;
    let bucket = votes.get(key);
    if (!bucket) votes.set(key, (bucket = new Map()));
    let rec = bucket.get(t.shape_id);
    if (!rec) bucket.set(t.shape_id, (rec = { n: 0, signs: new Map() }));
    rec.n++;
    if (headsign) rec.signs.set(headsign, (rec.signs.get(headsign) || 0) + 1);
  }

  const wanted = new Map();
  for (const [key, bucket] of votes) {
    let best = null;
    for (const [shapeId, rec] of bucket) if (!best || rec.n > best.n) best = { shapeId, ...rec };
    if (!best) continue;
    let headsign = "";
    let bestN = 0;
    for (const [sign, n] of best.signs) if (n > bestN) { bestN = n; headsign = sign; }
    const [routeId, direction] = key.split("|");
    wanted.set(best.shapeId, { routeId, direction: Number(direction), headsign });
  }

  const raw = new Map();
  for (const s of shapeRows) {
    const meta = wanted.get(s.shape_id);
    if (!meta) continue;
    let arr = raw.get(s.shape_id);
    if (!arr) raw.set(s.shape_id, (arr = []));
    arr.push([Number(s.shape_pt_sequence), Number(s.shape_pt_lon), Number(s.shape_pt_lat)]);
  }
  for (const [shapeId, meta] of wanted) {
    const pts = raw.get(shapeId);
    const route = nextRoutes[meta.routeId];
    if (!pts || !route) continue;
    pts.sort((a, b) => a[0] - b[0]);
    const coordinates = roundPath(pts.map((p) => [p[1], p[2]]));
    if (coordinates.length < 2) continue;
    route.paths.push({ direction: meta.direction, headsign: meta.headsign, coordinates });
  }
  for (const route of Object.values(nextRoutes))
    route.paths.sort((a, b) => a.direction - b.direction);

  const nextStops = Object.create(null);
  for (const s of stopRows) if (s.stop_id && s.stop_name) nextStops[s.stop_id] = s.stop_name;

  routes = nextRoutes;
  byName = nextByName;
  trips = nextTrips;
  stops = nextStops;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(LINES_FILE, JSON.stringify({ updated: new Date().toISOString(), lines }, null, 2));
  const shaped = Object.values(nextByName).filter((r) => r.paths.length).length;
  console.log(
    "Lines saved:",
    Object.entries(lines).map(([k, v]) => `${k}=${v.length}`).join(", "),
    `| shapes ${shaped}/${Object.keys(nextByName).length}`
  );
}

async function loadStatic() {
  try {
    const buf = await zipBuffer();
    try {
      applyStatic(buf);
    } catch (e) {
      console.error("Cached GTFS failed, downloading again:", e.message);
      applyStatic(await fetchZip());
    }
  } catch (e) {
    console.error("Could not load static GTFS:", e.message);
  }
}

const STOP_STATUS = { 0: "incoming", 1: "stopped", 2: "transit" };

async function pollVehicles() {
  try {
    const res = await fetch(VEHICLES_URL);
    if (!res.ok) throw new Error("Vehicle feed HTTP " + res.status);
    const feed = GtfsRt.transit_realtime.FeedMessage.decode(new Uint8Array(await res.arrayBuffer()));
    vehicles = feed.entity
      .filter((e) => e.vehicle && e.vehicle.position)
      .map((e) => {
        const v = e.vehicle;
        const route = routes[v.trip?.routeId] || {};
        const trip = (v.trip && trips[v.trip.tripId]) || {};
        const speed = hasField(v.position, "speed") ? asNum(v.position.speed) : null;
        const bearing = hasField(v.position, "bearing") ? asNum(v.position.bearing) : null;
        return {
          id: v.vehicle?.id || e.id,
          label: v.vehicle?.label || "",
          plate: v.vehicle?.licensePlate || "",
          routeId: v.trip?.routeId || "",
          line: route.name || v.trip?.routeId || "?",
          long: route.long || "",
          type: route.type || "bus",
          headsign: trip.headsign || "",
          direction: v.trip && hasField(v.trip, "directionId") ? asNum(v.trip.directionId) : trip.direction ?? null,
          lat: v.position.latitude,
          lng: v.position.longitude,
          bearing,
          speedKmh: speed != null && speed > 0.4 ? Math.round(speed * 3.6) : null,
          stop: v.stopId ? stops[v.stopId] || "" : "",
          status: STOP_STATUS[v.currentStatus] || "",
          ts: asNum(v.timestamp),
        };
      });
    lastUpdate = new Date().toISOString();
    lastError = null;
  } catch (e) {
    lastError = e.message;
    console.error("Vehicle poll failed:", e.message);
  }
}

const app = express();

// ─── SECURITY MIDDLEWARE ────────────────────────────────────────────

// 1. Trust the Render proxy so rate-limit sees real client IPs
app.set("trust proxy", 1);

// 2. Helmet – secure HTTP headers with CSP tailored to this app
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'", "https://unpkg.com"],
        styleSrc: [
          "'self'",
          "'unsafe-inline'",
          "https://fonts.googleapis.com",
          "https://unpkg.com",
        ],
        fontSrc: ["'self'", "https://fonts.gstatic.com"],
        imgSrc: ["'self'", "data:", "blob:"],
        connectSrc: [
          "'self'",
          "https://tiles.openfreemap.org",
          "https://*.openfreemap.org",
        ],
        manifestSrc: ["'self'"],
        workerSrc: ["'self'", "blob:"],
        childSrc: ["'self'", "blob:"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
      },
    },
    crossOriginEmbedderPolicy: false,   // maplibre needs cross-origin tile fetches
    crossOriginOpenerPolicy: { policy: "same-origin-allow-popups" },
  })
);

// 3. CORS – restrictive; only same-origin in production
const ALLOWED_ORIGINS = process.env.CORS_ORIGINS
  ? process.env.CORS_ORIGINS.split(",").map((o) => o.trim())
  : [];    // empty = same-origin only (no extra origins allowed)

app.use(
  cors({
    origin(origin, cb) {
      // Allow same-origin requests (origin is undefined) and whitelisted origins
      if (!origin || ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
      cb(new Error("Blocat de CORS"));
    },
    methods: ["GET"],
    optionsSuccessStatus: 200,
  })
);

// 4. Rate limiting – 120 req / min per IP for the API
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Prea multe cereri, reîncearcă mai târziu." },
});
app.use("/api/", apiLimiter);

// 5. Payload size limit (even though the app has no POST routes today)
app.use(express.json({ limit: "10kb" }));
app.use(express.urlencoded({ extended: false, limit: "10kb" }));

// ─── STATIC FILES ───────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, "public")));

// ─── API ROUTES ─────────────────────────────────────────────────────
app.get("/api/vehicles", (req, res) => {
  res.json({ updated: lastUpdate, error: lastError, count: vehicles.length, vehicles });
});
app.get("/api/lines", (req, res) => {
  try { res.json(JSON.parse(fs.readFileSync(LINES_FILE, "utf8"))); }
  catch { res.json({ updated: null, lines: emptyLines() }); }
});
app.get("/api/route/:name", (req, res) => {
  const route = byName[req.params.name];
  if (!route) return res.status(404).json({ error: "Linie necunoscută" });
  res.json({
    id: route.id,
    name: route.name,
    long: route.long,
    type: route.type,
    paths: route.paths,
  });
});

// ─── GLOBAL ERROR HANDLER (never leak stack traces) ─────────────────
app.use((err, _req, res, _next) => {
  console.error("Unhandled:", err.message);
  res.status(err.status || 500).json({ error: "Eroare internă" });
});

// ─── STARTUP ────────────────────────────────────────────────────────
(async () => {
  await loadStatic();
  await pollVehicles();
  setInterval(pollVehicles, POLL_MS);
  setInterval(loadStatic, ZIP_MAX_AGE);
  app.listen(PORT, "0.0.0.0", () => console.log(`Open http://localhost:${PORT}`));
})();
