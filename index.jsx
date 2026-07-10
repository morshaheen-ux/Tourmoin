import React, { useState, useEffect, useRef, useCallback } from "react";

/* ------------------------------------------------------------------ */
/*  Delivery Tour Tracker                                              */
/*  Driver side: start tour, tally deliveries, finish with returns.    */
/*  Dispatch side: live dashboard with GPS positions + email report.   */
/*  Data is stored in SHARED storage so dispatch can see every driver. */
/* ------------------------------------------------------------------ */

const FONT_CSS = `
@import url('https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@500;600;700&family=IBM+Plex+Sans:wght@400;500;600&display=swap');
.dtt-root { font-family:'IBM Plex Sans',system-ui,sans-serif; color:#1A2233; }
.dtt-display { font-family:'Barlow Condensed',sans-serif; letter-spacing:0.02em; }
.dtt-tapbtn:active { transform:scale(0.96); }
@media (prefers-reduced-motion: reduce){ .dtt-tapbtn:active{ transform:none; } }
`;

const C = {
  ink: "#1A2233",
  panel: "#FFFFFF",
  bg: "#EDF0F3",
  amber: "#F5A300",
  amberDark: "#C98600",
  green: "#2E9E6B",
  red: "#D64545",
  gray: "#8A93A3",
  line: "#D8DDE4",
};

/* ---------------- storage helpers (all shared) ---------------- */

async function loadTours() {
  try {
    const res = await window.storage.list("tour:", true);
    const keys = res?.keys || [];
    const tours = [];
    for (const k of keys) {
      try {
        const r = await window.storage.get(k, true);
        if (r?.value) tours.push(JSON.parse(r.value));
      } catch (e) {/* skip broken key */}
    }
    return tours.sort((a, b) => (b.startTime || "").localeCompare(a.startTime || ""));
  } catch (e) {
    return [];
  }
}

async function saveTour(tour) {
  try {
    await window.storage.set(tour.key, JSON.stringify(tour), true);
    return true;
  } catch (e) {
    return false;
  }
}

async function loadConfig() {
  try {
    const r = await window.storage.get("dispatch-config", true);
    return r?.value ? JSON.parse(r.value) : { email: "" };
  } catch (e) {
    return { email: "" };
  }
}

async function saveConfig(cfg) {
  try { await window.storage.set("dispatch-config", JSON.stringify(cfg), true); } catch (e) {}
}

/* ---------------- small utils ---------------- */

const fmtTime = (iso) => (iso ? new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "—");
const fmtDate = (iso) => (iso ? new Date(iso).toLocaleDateString() : "—");
const slug = (s) => s.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 24) || "driver";

function duration(startIso, endIso) {
  if (!startIso) return "—";
  const end = endIso ? new Date(endIso) : new Date();
  const mins = Math.max(0, Math.round((end - new Date(startIso)) / 60000));
  return `${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, "0")}m`;
}

function buildReportBody(t) {
  return [
    `DELIVERY TOUR REPORT`,
    ``,
    `Driver: ${t.driver}`,
    `Date: ${fmtDate(t.startTime)}`,
    `Tour started: ${fmtTime(t.startTime)}`,
    `Tour ended: ${fmtTime(t.endTime)}`,
    `Duration: ${duration(t.startTime, t.endTime)}`,
    ``,
    `Packets delivered: ${t.delivered}`,
    `Packets returned: ${t.returned ?? 0}`,
    ``,
    t.lastLat ? `Last GPS position: ${t.lastLat.toFixed(5)}, ${t.lastLng.toFixed(5)}` : `GPS: not available`,
    t.lastLat ? `Map: https://maps.google.com/?q=${t.lastLat},${t.lastLng}` : ``,
  ].join("\n");
}

/* ---------------- shared UI bits ---------------- */

function Eyebrow({ children }) {
  return (
    <div className="dtt-display" style={{ fontSize: 13, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.14em", color: C.gray }}>
      {children}
    </div>
  );
}

function Card({ children, style }) {
  return (
    <div style={{ background: C.panel, border: `1px solid ${C.line}`, borderRadius: 14, padding: 18, ...style }}>
      {children}
    </div>
  );
}

function BigButton({ label, sub, color, onClick, disabled }) {
  return (
    <button
      className="dtt-tapbtn"
      onClick={onClick}
      disabled={disabled}
      style={{
        width: "100%", padding: "16px 18px", borderRadius: 12, border: "none",
        background: disabled ? C.line : color, color: color === C.amber ? C.ink : "#fff",
        cursor: disabled ? "default" : "pointer", textAlign: "center",
      }}
    >
      <div className="dtt-display" style={{ fontSize: 22, fontWeight: 700, textTransform: "uppercase" }}>{label}</div>
      {sub && <div style={{ fontSize: 13, opacity: 0.85, marginTop: 2 }}>{sub}</div>}
    </button>
  );
}

/* ---------------- Driver view ---------------- */

function DriverView({ config }) {
  const [phase, setPhase] = useState("login"); // login | active | finish | done
  const [name, setName] = useState("");
  const [tour, setTour] = useState(null);
  const [returned, setReturned] = useState("");
  const [gpsStatus, setGpsStatus] = useState("off"); // off | on | denied
  const [busy, setBusy] = useState(false);
  const posRef = useRef(null);
  const watchRef = useRef(null);
  const tourRef = useRef(null);
  tourRef.current = tour;

  /* GPS watch while a tour is active */
  useEffect(() => {
    if (phase !== "active") return;
    if (!navigator.geolocation) { setGpsStatus("denied"); return; }
    watchRef.current = navigator.geolocation.watchPosition(
      (p) => { posRef.current = { lat: p.coords.latitude, lng: p.coords.longitude, at: new Date().toISOString() }; setGpsStatus("on"); },
      () => setGpsStatus("denied"),
      { enableHighAccuracy: true, maximumAge: 15000, timeout: 20000 }
    );
    const iv = setInterval(() => pushPosition(), 45000);
    return () => {
      if (watchRef.current != null) navigator.geolocation.clearWatch(watchRef.current);
      clearInterval(iv);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  const pushPosition = useCallback(async () => {
    const t = tourRef.current, p = posRef.current;
    if (!t || !p) return;
    const trail = [...(t.trail || []), { lat: p.lat, lng: p.lng, at: p.at }].slice(-50);
    const upd = { ...t, lastLat: p.lat, lastLng: p.lng, lastGpsAt: p.at, trail, updatedAt: new Date().toISOString() };
    setTour(upd);
    await saveTour(upd);
  }, []);

  async function startTour() {
    if (!name.trim()) return;
    setBusy(true);
    // resume an active tour for this driver if one exists
    const all = await loadTours();
    const existing = all.find((t) => t.status === "active" && t.driver.toLowerCase() === name.trim().toLowerCase());
    if (existing) {
      setTour(existing);
      setPhase("active");
      setBusy(false);
      return;
    }
    const now = new Date();
    const t = {
      key: `tour:${now.getTime()}_${slug(name)}`,
      driver: name.trim(),
      startTime: now.toISOString(),
      endTime: null,
      delivered: 0,
      returned: null,
      status: "active",
      trail: [],
      updatedAt: now.toISOString(),
    };
    const ok = await saveTour(t);
    if (ok) { setTour(t); setPhase("active"); }
    setBusy(false);
  }

  async function bump(delta) {
    if (!tour) return;
    const p = posRef.current;
    const upd = {
      ...tour,
      delivered: Math.max(0, tour.delivered + delta),
      updatedAt: new Date().toISOString(),
      ...(p ? { lastLat: p.lat, lastLng: p.lng, lastGpsAt: p.at } : {}),
    };
    setTour(upd);
    await saveTour(upd);
  }

  async function finishTour() {
    const r = parseInt(returned, 10);
    const upd = {
      ...tour,
      returned: Number.isFinite(r) ? r : 0,
      endTime: new Date().toISOString(),
      status: "finished",
      updatedAt: new Date().toISOString(),
    };
    setTour(upd);
    await saveTour(upd);
    setPhase("done");
  }

  const mailto = tour
    ? `mailto:${encodeURIComponent(config.email || "")}?subject=${encodeURIComponent(`Tour report — ${tour.driver} — ${fmtDate(tour.startTime)}`)}&body=${encodeURIComponent(buildReportBody(tour))}`
    : "#";

  if (phase === "login") {
    return (
      <Card>
        <Eyebrow>Driver check-in</Eyebrow>
        <h2 className="dtt-display" style={{ fontSize: 34, fontWeight: 700, margin: "6px 0 4px", textTransform: "uppercase" }}>Start your tour</h2>
        <p style={{ fontSize: 14, color: C.gray, marginTop: 0 }}>
          Enter your name and press start. Your start time is recorded automatically and your position is shared with dispatch while the tour is running.
        </p>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Your name"
          style={{ width: "100%", boxSizing: "border-box", padding: "14px", fontSize: 17, borderRadius: 10, border: `1.5px solid ${C.line}`, marginBottom: 14 }}
        />
        <BigButton label={busy ? "Starting…" : "Start tour"} sub="Records start time · enables GPS" color={C.green} onClick={startTour} disabled={busy || !name.trim()} />
      </Card>
    );
  }

  if (phase === "active") {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <Card>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
            <div>
              <Eyebrow>On tour</Eyebrow>
              <div className="dtt-display" style={{ fontSize: 26, fontWeight: 700 }}>{tour.driver}</div>
            </div>
            <div style={{ textAlign: "right", fontSize: 13, color: C.gray }}>
              Started {fmtTime(tour.startTime)}<br />
              {duration(tour.startTime)} on the road<br />
              GPS: <span style={{ color: gpsStatus === "on" ? C.green : C.red, fontWeight: 600 }}>
                {gpsStatus === "on" ? "live" : gpsStatus === "denied" ? "blocked" : "starting…"}
              </span>
            </div>
          </div>
        </Card>

        {/* Signature element: the delivery stamp */}
        <button
          className="dtt-tapbtn"
          onClick={() => bump(1)}
          aria-label="Mark one packet delivered"
          style={{
            width: 230, height: 230, borderRadius: "50%", margin: "6px auto",
            background: C.amber, border: `6px solid ${C.amberDark}`, cursor: "pointer",
            boxShadow: "0 6px 0 " + C.amberDark, color: C.ink,
          }}
        >
          <div className="dtt-display" style={{ fontSize: 64, fontWeight: 700, lineHeight: 1 }}>{tour.delivered}</div>
          <div className="dtt-display" style={{ fontSize: 18, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.1em", marginTop: 4 }}>
            Delivered · tap +1
          </div>
        </button>

        <button
          onClick={() => bump(-1)}
          style={{ background: "none", border: "none", color: C.gray, fontSize: 14, cursor: "pointer", textDecoration: "underline" }}
        >
          Undo last delivery
        </button>

        <BigButton label="Finish tour" sub="Enter returned packets and record end time" color={C.ink} onClick={() => setPhase("finish")} />
      </div>
    );
  }

  if (phase === "finish") {
    return (
      <Card>
        <Eyebrow>Finish tour</Eyebrow>
        <h2 className="dtt-display" style={{ fontSize: 30, fontWeight: 700, margin: "6px 0", textTransform: "uppercase" }}>Returned packets</h2>
        <p style={{ fontSize: 14, color: C.gray, marginTop: 0 }}>
          You delivered <b style={{ color: C.ink }}>{tour.delivered}</b> packets. How many are you bringing back?
        </p>
        <input
          type="number" min="0" inputMode="numeric"
          value={returned}
          onChange={(e) => setReturned(e.target.value)}
          placeholder="0"
          style={{ width: "100%", boxSizing: "border-box", padding: "14px", fontSize: 24, borderRadius: 10, border: `1.5px solid ${C.line}`, marginBottom: 14, textAlign: "center" }}
        />
        <div style={{ display: "flex", gap: 10 }}>
          <button onClick={() => setPhase("active")} style={{ flex: 1, padding: 14, borderRadius: 12, border: `1.5px solid ${C.line}`, background: "#fff", cursor: "pointer", fontSize: 15 }}>
            Back
          </button>
          <div style={{ flex: 2 }}>
            <BigButton label="End tour" sub="Records end time" color={C.red} onClick={finishTour} />
          </div>
        </div>
      </Card>
    );
  }

  /* done */
  return (
    <Card>
      <Eyebrow>Tour complete</Eyebrow>
      <h2 className="dtt-display" style={{ fontSize: 30, fontWeight: 700, margin: "6px 0", textTransform: "uppercase" }}>Nice work, {tour.driver}</h2>
      <table style={{ width: "100%", fontSize: 15, borderCollapse: "collapse", margin: "10px 0 16px" }}>
        <tbody>
          {[
            ["Start", fmtTime(tour.startTime)],
            ["End", fmtTime(tour.endTime)],
            ["Duration", duration(tour.startTime, tour.endTime)],
            ["Delivered", tour.delivered],
            ["Returned", tour.returned ?? 0],
          ].map(([k, v]) => (
            <tr key={k} style={{ borderBottom: `1px solid ${C.line}` }}>
              <td style={{ padding: "8px 0", color: C.gray }}>{k}</td>
              <td style={{ padding: "8px 0", textAlign: "right", fontWeight: 600 }}>{v}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <a href={mailto} style={{ textDecoration: "none" }}>
        <BigButton label="Send report by email" sub={config.email ? `Opens your mail app → ${config.email}` : "Opens your mail app (dispatch email not set yet)"} color={C.green} />
      </a>
      <button
        onClick={() => { setPhase("login"); setTour(null); setName(""); setReturned(""); }}
        style={{ marginTop: 12, width: "100%", padding: 12, borderRadius: 12, border: `1.5px solid ${C.line}`, background: "#fff", cursor: "pointer", fontSize: 15 }}
      >
        Done — back to check-in
      </button>
    </Card>
  );
}

/* ---------------- Dashboard view ---------------- */

function TrailMap({ trail }) {
  if (!trail || trail.length < 2) return null;
  const lats = trail.map((p) => p.lat), lngs = trail.map((p) => p.lng);
  const minLa = Math.min(...lats), maxLa = Math.max(...lats);
  const minLo = Math.min(...lngs), maxLo = Math.max(...lngs);
  const W = 260, H = 90, pad = 8;
  const sx = (lo) => pad + ((lo - minLo) / (maxLo - minLo || 1)) * (W - 2 * pad);
  const sy = (la) => H - pad - ((la - minLa) / (maxLa - minLa || 1)) * (H - 2 * pad);
  const d = trail.map((p, i) => `${i ? "L" : "M"}${sx(p.lng).toFixed(1)},${sy(p.lat).toFixed(1)}`).join(" ");
  const last = trail[trail.length - 1];
  return (
    <svg width={W} height={H} style={{ background: "#F4F6F8", borderRadius: 8, border: `1px solid ${C.line}` }} aria-label="Route sketch">
      <path d={d} fill="none" stroke={C.gray} strokeWidth="2" strokeLinecap="round" />
      <circle cx={sx(last.lng)} cy={sy(last.lat)} r="5" fill={C.amber} stroke={C.ink} strokeWidth="1.5" />
    </svg>
  );
}

function DashboardView({ config, setConfig }) {
  const [tours, setTours] = useState([]);
  const [emailDraft, setEmailDraft] = useState(config.email || "");
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setTours(await loadTours());
    setLoading(false);
  }, []);

  useEffect(() => {
    refresh();
    const iv = setInterval(refresh, 30000);
    return () => clearInterval(iv);
  }, [refresh]);

  useEffect(() => setEmailDraft(config.email || ""), [config.email]);

  const active = tours.filter((t) => t.status === "active");
  const finished = tours.filter((t) => t.status === "finished");

  function TourRow({ t }) {
    const stale = t.lastGpsAt && Date.now() - new Date(t.lastGpsAt) > 5 * 60000;
    return (
      <Card style={{ marginBottom: 12 }}>
        <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 10 }}>
          <div>
            <div className="dtt-display" style={{ fontSize: 22, fontWeight: 700 }}>
              {t.driver}{" "}
              <span style={{ fontSize: 13, fontWeight: 600, color: t.status === "active" ? C.green : C.gray, textTransform: "uppercase", letterSpacing: "0.08em" }}>
                {t.status === "active" ? "● on tour" : "finished"}
              </span>
            </div>
            <div style={{ fontSize: 13, color: C.gray }}>
              {fmtDate(t.startTime)} · {fmtTime(t.startTime)} → {fmtTime(t.endTime)} · {duration(t.startTime, t.endTime)}
            </div>
            <div style={{ fontSize: 15, marginTop: 6 }}>
              Delivered <b>{t.delivered}</b>{t.returned != null && <> · Returned <b>{t.returned}</b></>}
            </div>
            {t.lastLat != null && (
              <div style={{ fontSize: 13, marginTop: 6 }}>
                <a href={`https://maps.google.com/?q=${t.lastLat},${t.lastLng}`} target="_blank" rel="noreferrer" style={{ color: C.ink, fontWeight: 600 }}>
                  Open position in Google Maps ↗
                </a>{" "}
                <span style={{ color: stale ? C.red : C.gray }}>
                  · GPS {fmtTime(t.lastGpsAt)}{stale ? " (stale)" : ""}
                </span>
              </div>
            )}
            {t.lastLat == null && <div style={{ fontSize: 13, color: C.gray, marginTop: 6 }}>No GPS signal received yet.</div>}
          </div>
          <TrailMap trail={t.trail} />
        </div>
        {t.status === "finished" && (
          <a
            href={`mailto:${encodeURIComponent(config.email || "")}?subject=${encodeURIComponent(`Tour report — ${t.driver} — ${fmtDate(t.startTime)}`)}&body=${encodeURIComponent(buildReportBody(t))}`}
            style={{ display: "inline-block", marginTop: 10, fontSize: 14, fontWeight: 600, color: C.green }}
          >
            Email this report ↗
          </a>
        )}
      </Card>
    );
  }

  return (
    <div>
      <Card style={{ marginBottom: 14 }}>
        <Eyebrow>Dispatch settings</Eyebrow>
        <div style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
          <input
            value={emailDraft}
            onChange={(e) => setEmailDraft(e.target.value)}
            placeholder="Reports email, e.g. dispatch@company.com"
            style={{ flex: "1 1 220px", padding: "10px 12px", fontSize: 14, borderRadius: 10, border: `1.5px solid ${C.line}` }}
          />
          <button
            onClick={async () => { const cfg = { email: emailDraft.trim() }; await saveConfig(cfg); setConfig(cfg); }}
            style={{ padding: "10px 16px", borderRadius: 10, border: "none", background: C.ink, color: "#fff", fontWeight: 600, cursor: "pointer" }}
          >
            Save
          </button>
          <button onClick={refresh} style={{ padding: "10px 16px", borderRadius: 10, border: `1.5px solid ${C.line}`, background: "#fff", cursor: "pointer" }}>
            Refresh now
          </button>
        </div>
        <div style={{ fontSize: 12, color: C.gray, marginTop: 8 }}>
          Auto-refreshes every 30 s. Driver reports open in the mail app addressed to this email.
        </div>
      </Card>

      <Eyebrow>Active tours ({active.length})</Eyebrow>
      <div style={{ margin: "8px 0 18px" }}>
        {loading && <div style={{ color: C.gray, fontSize: 14 }}>Loading…</div>}
        {!loading && active.length === 0 && <div style={{ color: C.gray, fontSize: 14 }}>No drivers on the road right now.</div>}
        {active.map((t) => <TourRow key={t.key} t={t} />)}
      </div>

      <Eyebrow>Finished tours ({finished.length})</Eyebrow>
      <div style={{ marginTop: 8 }}>
        {!loading && finished.length === 0 && <div style={{ color: C.gray, fontSize: 14 }}>No finished tours yet.</div>}
        {finished.map((t) => <TourRow key={t.key} t={t} />)}
      </div>
    </div>
  );
}

/* ---------------- App shell ---------------- */

export default function App() {
  const [tab, setTab] = useState("driver");
  const [config, setConfig] = useState({ email: "" });

  useEffect(() => { loadConfig().then(setConfig); }, []);

  return (
    <div className="dtt-root" style={{ minHeight: "100vh", background: C.bg }}>
      <style>{FONT_CSS}</style>
      <div style={{ maxWidth: 560, margin: "0 auto", padding: "18px 14px 40px" }}>
        <header style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
          <div className="dtt-display" style={{ fontSize: 24, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em" }}>
            <span style={{ background: C.amber, padding: "2px 8px", borderRadius: 6, marginRight: 8 }}>▮▮</span>
            Tour Tracker
          </div>
          <nav style={{ display: "flex", gap: 6, background: "#fff", border: `1px solid ${C.line}`, borderRadius: 10, padding: 4 }}>
            {["driver", "dashboard"].map((k) => (
              <button
                key={k}
                onClick={() => setTab(k)}
                style={{
                  padding: "8px 14px", borderRadius: 8, border: "none", cursor: "pointer",
                  background: tab === k ? C.ink : "transparent", color: tab === k ? "#fff" : C.ink,
                  fontWeight: 600, fontSize: 14, textTransform: "capitalize",
                }}
              >
                {k}
              </button>
            ))}
          </nav>
        </header>

        {tab === "driver" ? <DriverView config={config} /> : <DashboardView config={config} setConfig={setConfig} />}

        <footer style={{ marginTop: 26, fontSize: 12, color: C.gray, lineHeight: 1.5 }}>
          Tour data (driver name, times, counts, GPS position) is saved to shared storage so the dispatch dashboard can see it — everyone using this app can view it.
        </footer>
      </div>
    </div>
  );
}
