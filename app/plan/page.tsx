"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import { useRouter } from "next/navigation";

type Pitch = {
  id: string;
  name: string;
  surface: "KUNSTRASEN" | "RASEN";
  capacity_quarters: number;
  sort_order: number;
};

type Slot = {
  id: string;
  weekday: number; // 1=Mon ... 7=Sun
  label: string;
  start_time: string; // "16:30:00"
  end_time: string; // "18:00:00"
  sort_order: number;
};

type Team = {
  id: string;
  name: string;
  sort_order: number;
};

type Allocation = {
  id: string;
  team_id: string;
  pitch_id: string;
  weekday: number;
  start_time: string;
  end_time: string;
  quarters: number;
  notes: string | null;
  created_at?: string;
};

function wdLabel(wd: number) {
  return wd === 3 ? "Mittwoch" : wd === 5 ? "Freitag" : `Wochentag ${wd}`;
}

function shortTime(t: string) {
  return (t || "").slice(0, 5);
}

function slotKey(s: Pick<Slot, "weekday" | "start_time" | "end_time">) {
  return `${s.weekday}|${s.start_time}|${s.end_time}`;
}

function clampInt(n: number, min: number, max: number) {
  const x = Number.isFinite(n) ? Math.floor(n) : min;
  return Math.max(min, Math.min(max, x));
}

// Maximal 4/4 → 4 klar unterscheidbare Farben pro Kachel (nach Einfügereihenfolge)
const BOOKING_COLORS = [
  { base: "rgba(0, 200, 0, 0.30)", stripe: "rgba(255,255,255,0.10)" }, // 1: grün
  { base: "rgba(0, 160, 255, 0.28)", stripe: "rgba(255,255,255,0.10)" }, // 2: blau
  { base: "rgba(255, 190, 0, 0.26)", stripe: "rgba(255,255,255,0.10)" }, // 3: amber
  { base: "rgba(180, 90, 255, 0.26)", stripe: "rgba(255,255,255,0.10)" }, // 4: lila
] as const;

type Color = (typeof BOOKING_COLORS)[number];

type QuadrantCell = {
  alloc?: Allocation;
  teamName?: string;
  color?: Color;
};

type Placement = {
  alloc: Allocation;
  teamName: string;
  color: Color;
  quadrants: number[]; // indices 0..3 in 2x2 grid
  leftPct: number;
  topPct: number;
  widthPct: number;
  heightPct: number;
};

function qToRC(q: number) {
  // 0=TL, 1=TR, 2=BL, 3=BR
  const r = q >= 2 ? 1 : 0;
  const c = q % 2;
  return { r, c };
}

function bboxForQuadrants(quads: number[]) {
  const rcs = quads.map(qToRC);
  const rMin = Math.min(...rcs.map((x) => x.r));
  const rMax = Math.max(...rcs.map((x) => x.r));
  const cMin = Math.min(...rcs.map((x) => x.c));
  const cMax = Math.max(...rcs.map((x) => x.c));

  const leftPct = cMin * 50;
  const topPct = rMin * 50;
  const widthPct = (cMax - cMin + 1) * 50;
  const heightPct = (rMax - rMin + 1) * 50;

  return { leftPct, topPct, widthPct, heightPct };
}

function parseNotesQuads(notes: string | null): number[] | null {
  if (!notes) return null;

  // JSON: {"quads":[0,1]}
  try {
    const obj = JSON.parse(notes);
    if (obj && Array.isArray(obj.quads)) {
      const arr = obj.quads
        .map((x: any) => Number(x))
        .filter((n: number) => Number.isInteger(n) && n >= 0 && n <= 3);
      if (arr.length >= 1 && arr.length <= 4) return Array.from(new Set(arr));
    }
  } catch {
    // ignore
  }

  // legacy simple "quads:0,1"
  const m = notes.match(/quads?\s*:\s*([0-3](?:\s*,\s*[0-3])*)/i);
  if (m?.[1]) {
    const arr = m[1]
      .split(",")
      .map((x) => Number(x.trim()))
      .filter((n) => Number.isInteger(n) && n >= 0 && n <= 3);
    if (arr.length >= 1 && arr.length <= 4) return Array.from(new Set(arr));
  }

  return null;
}

function pickQuads(available: Set<number>, q: number): number[] {
  // Prefer intuitive packing:
  // q=2: left half (0+2), right half (1+3), top half (0+1), bottom half (2+3)
  // q=3: L-shapes
  // q=1: TL->TR->BL->BR
  const has = (...xs: number[]) => xs.every((x) => available.has(x));
  const take = (...xs: number[]) => {
    xs.forEach((x) => available.delete(x));
    return xs;
  };

  if (q >= 4 && available.size === 4) return take(0, 1, 2, 3);

  if (q === 3) {
    const patterns = [
      [0, 1, 2],
      [0, 1, 3],
      [0, 2, 3],
      [1, 2, 3],
    ];
    for (const p of patterns) if (has(...p)) return take(...p);
    const arr = [...available].slice(0, 3);
    return take(...arr);
  }

  if (q === 2) {
    const patterns = [
      [0, 2], // left half
      [1, 3], // right half
      [0, 1], // top half
      [2, 3], // bottom half
    ];
    for (const p of patterns) if (has(...p)) return take(...p);
    const arr = [...available].slice(0, 2);
    return take(...arr);
  }

  // q === 1
  for (const x of [0, 1, 2, 3]) {
    if (available.has(x)) return take(x);
  }
  return [];
}

function buildFieldLayout(list: Allocation[], teamById: Map<string, Team>) {
  const quads: QuadrantCell[] = Array.from({ length: 4 }, () => ({}));
  const placements: Placement[] = [];

  const sorted = [...list].sort((a, b) => {
    const ca = a.created_at ?? "";
    const cb = b.created_at ?? "";
    if (ca !== cb) return ca.localeCompare(cb);
    return a.id.localeCompare(b.id);
  });

  const available = new Set<number>([0, 1, 2, 3]);

  for (let i = 0; i < sorted.length && available.size > 0; i++) {
    const a = sorted[i];
    const qWanted = clampInt(a.quarters || 1, 1, 4);
    const teamName = teamById.get(a.team_id)?.name ?? "Team?";
    const color = BOOKING_COLORS[Math.min(i, BOOKING_COLORS.length - 1)];

    // prefer stored quadrants from notes (so user selection stays stable across reload)
    const noteQuads = parseNotesQuads(a.notes);
    let picked: number[] = [];

    if (noteQuads && noteQuads.length) {
      const valid = noteQuads.filter((x) => available.has(x));
      const need = clampInt(noteQuads.length, 1, 4);
      if (valid.length === need) {
        picked = valid;
        valid.forEach((x) => available.delete(x));
      }
    }

    if (!picked.length) {
      picked = pickQuads(available, qWanted);
    }

    if (!picked.length) continue;

    // paint quadrants
    for (const quad of picked) {
      quads[quad] = { alloc: a, teamName, color };
    }

    const bb = bboxForQuadrants(picked);
    placements.push({ alloc: a, teamName, color, quadrants: picked, ...bb });
  }

  return { quads, placements };
}

// ---- Facility layout (physical arrangement) ----
// You can adjust names here; matching is fuzzy (ß == ss, spaces ignored).
const FACILITY_LAYOUT: Array<{ name: string; gridColumn: string; gridRow: string }> = [
  // Back pitches: sit above "Mitte" and "Kompakt Rechts"
  { name: "Großrasenplatz Hinten Links", gridColumn: "2", gridRow: "1" },
  { name: "Großrasenplatz Hinten Rechts", gridColumn: "3", gridRow: "1" },

  // Front pitches
  { name: "Grosskunstrasen Links", gridColumn: "1", gridRow: "2" },
  { name: "Grosskunstrasen Mitte", gridColumn: "2", gridRow: "2" },
  { name: "Kompaktkunstrasen Rechts", gridColumn: "3", gridRow: "2" },
];

function normName(s: string) {
  return (s || "")
    .toLowerCase()
    .replace(/ß/g, "ss")
    .replace(/ä/g, "ae")
    .replace(/ö/g, "oe")
    .replace(/ü/g, "ue")
    .replace(/[^a-z0-9]/g, "");
}

export default function PlanPage() {
  const router = useRouter();
  const [authChecked, setAuthChecked] = useState(false);
  const [session, setSession] = useState<any>(null);

  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  // --- Auth guard (redirect to /login if not signed in) ---
  useEffect(() => {
    let mounted = true;

    supabase.auth.getSession().then(({ data }) => {
      if (!mounted) return;
      setSession(data.session);
      if (!data.session) router.replace("/login");
      setAuthChecked(true);
    });

    const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => {
      setSession(s);
      if (!s) router.replace("/login");
    });

    return () => {
      mounted = false;
      sub.subscription.unsubscribe();
    };
  }, [router]);


  const [pitches, setPitches] = useState<Pitch[]>([]);
  const [slots, setSlots] = useState<Slot[]>([]);
  const [teams, setTeams] = useState<Team[]>([]);
  const [allocs, setAllocs] = useState<Allocation[]>([]);
  const [weekday, setWeekday] = useState<number>(3); // Mi

  // add form (Pitch über Name + Slot über Key)
  const [teamId, setTeamId] = useState<string>("");
  const [pitchName, setPitchName] = useState<string>("");
  const [slotK, setSlotK] = useState<string>("");
  const [quarters, setQuarters] = useState<number>(2);

  // Quick-selection state (drag/select quarters in the field)
  const [sel, setSel] = useState<{ active: boolean; pitchName: string; slotK: string; quads: number[] }>({
    active: false,
    pitchName: "",
    slotK: "",
    quads: [],
  });

  const selRef = useRef(sel);
  useEffect(() => {
    selRef.current = sel;
  }, [sel]);

  const [menu, setMenu] = useState<{
    open: boolean;
    x: number;
    y: number;
    pitchName: string;
    slotK: string;
    quads: number[];
    teamId: string;
  }>({ open: false, x: 0, y: 0, pitchName: "", slotK: "", quads: [], teamId: "" });

  const teamById = useMemo(() => new Map(teams.map((t) => [t.id, t])), [teams]);

  // Pitch-Gruppen (falls Felder doppelt in DB sind, zeigen wir sie nur 1× links)
  const pitchIdsByName = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const p of pitches) {
      const arr = m.get(p.name) ?? [];
      arr.push(p.id);
      m.set(p.name, arr);
    }
    return m;
  }, [pitches]);

  const pitchDisplay = useMemo(() => {
    const byName = new Map<string, Pitch>();
    for (const p of pitches) {
      const cur = byName.get(p.name);
      if (!cur || p.sort_order < cur.sort_order) byName.set(p.name, p);
    }
    return [...byName.values()].sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name));
  }, [pitches]);

  const pitchByNorm = useMemo(() => {
    const m = new Map<string, Pitch>();
    for (const p of pitchDisplay) m.set(normName(p.name), p);
    return m;
  }, [pitchDisplay]);

  const resolvePitchByName = (name: string): Pitch | undefined => {
    const n = normName(name);
    const exact = pitchByNorm.get(n);
    if (exact) return exact;

    // fuzzy: includes
    const found = pitchDisplay.find((p) => {
      const pn = normName(p.name);
      return pn.includes(n) || n.includes(pn);
    });
    return found;
  };

  // Slots für den Tag (falls Slots doppelt in DB sind, zeigen wir je Zeit nur 1×)
  const slotsForDay = useMemo(() => slots.filter((s) => s.weekday === weekday), [slots, weekday]);

  const slotsForDayDisplay = useMemo(() => {
    const byKey = new Map<string, Slot>();
    for (const s of slotsForDay) {
      const k = slotKey(s);
      const cur = byKey.get(k);
      if (!cur || s.sort_order < cur.sort_order) byKey.set(k, s);
    }
    return [...byKey.values()].sort((a, b) => a.sort_order - b.sort_order);
  }, [slotsForDay]);

  const slotByKey = useMemo(() => {
    const m = new Map<string, Slot>();
    for (const s of slotsForDayDisplay) m.set(slotKey(s), s);
    return m;
  }, [slotsForDayDisplay]);

  // global mouseup: finish selection & open menu
  useEffect(() => {
    const onUp = (ev: MouseEvent) => {
      if (!selRef.current.active) return;
      finishSelection(ev.clientX, ev.clientY);
    };
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") {
        clearSelection();
        setMenu((m) => ({ ...m, open: false }));
      }
    };
    window.addEventListener("mouseup", onUp);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mouseup", onUp);
      window.removeEventListener("keydown", onKey);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [teams, teamId]);

  useEffect(() => {
    let alive = true;
    (async () => {
      setLoading(true);
      setErr(null);

      try {
        const [pRes, sRes, tRes, aRes] = await Promise.all([
          supabase.from("pitches").select("*").order("sort_order", { ascending: true }),
          supabase
            .from("training_slots")
            .select("*")
            .order("weekday", { ascending: true })
            .order("sort_order", { ascending: true }),
          supabase.from("teams").select("*").order("sort_order", { ascending: true }).order("name", { ascending: true }),
          supabase.from("allocations").select("*").order("created_at", { ascending: true }),
        ]);

        if (!alive) return;

        if (pRes.error) throw pRes.error;
        if (sRes.error) throw sRes.error;
        if (tRes.error) throw tRes.error;
        if (aRes.error) throw aRes.error;

        setPitches((pRes.data as Pitch[]) || []);
        setSlots((sRes.data as Slot[]) || []);
        setTeams((tRes.data as Team[]) || []);
        setAllocs((aRes.data as Allocation[]) || []);
      } catch (e: any) {
        setErr(e?.message ?? String(e));
      } finally {
        if (alive) setLoading(false);
      }
    })();

    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (!teamId && teams.length) setTeamId(teams[0].id);
    if (!pitchName && pitchDisplay.length) setPitchName(pitchDisplay[0].name);
    if (!slotK && slotsForDayDisplay.length) setSlotK(slotKey(slotsForDayDisplay[0]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [teams.length, pitchDisplay.length, slotsForDayDisplay.length]);

  function allocsInCell(pName: string, s: Slot) {
    const ids = pitchIdsByName.get(pName) ?? [];
    return allocs.filter(
      (a) => ids.includes(a.pitch_id) && a.weekday === s.weekday && a.start_time === s.start_time && a.end_time === s.end_time
    );
  }

  function usedQuarters(pName: string, s: Slot) {
    return allocsInCell(pName, s).reduce((sum, a) => sum + (a.quarters || 0), 0);
  }

  async function refreshAllocations() {
    const { data, error } = await supabase.from("allocations").select("*").order("created_at", { ascending: true });
    if (error) throw error;
    setAllocs((data as Allocation[]) || []);
  }

  async function addAllocation() {
    const s = slotByKey.get(slotK);
    if (!s) return;

    const canonicalPitchId = pitchDisplay.find((p) => p.name === pitchName)?.id;
    if (!canonicalPitchId) return;

    const alreadyUsed = usedQuarters(pitchName, s);
    const newTotal = alreadyUsed + quarters;

    if (newTotal > 4) {
      alert(`Nicht möglich: ${alreadyUsed}/4 belegt, du willst +${quarters}/4 → ${newTotal}/4 (über 4/4).`);
      return;
    }

    const { error } = await supabase.from("allocations").insert({
      team_id: teamId,
      pitch_id: canonicalPitchId,
      weekday: s.weekday,
      start_time: s.start_time,
      end_time: s.end_time,
      quarters,
      notes: null,
    });

    if (error) {
      alert(error.message);
      return;
    }

    await refreshAllocations();
  }

  async function addAllocationWithSelection(pName: string, s: Slot, selectedTeamId: string, quads: number[]) {
    const canonicalPitchId = pitchDisplay.find((p) => p.name === pName)?.id;
    if (!canonicalPitchId) return;

    const q = clampInt(quads.length, 1, 4);
    const alreadyUsed = usedQuarters(pName, s);
    const newTotal = alreadyUsed + q;

    if (newTotal > 4) {
      alert(`Nicht möglich: ${alreadyUsed}/4 belegt, du willst +${q}/4 → ${newTotal}/4 (über 4/4).`);
      return;
    }

    // ensure selected quads are really free (as currently displayed)
    const layout = buildFieldLayout(allocsInCell(pName, s), teamById);
    const blocked = quads.filter((x) => layout.quads[x]?.alloc);
    if (blocked.length) {
      alert("Mindestens ein gewähltes Viertel ist bereits belegt. Bitte wähle freie Viertel.");
      return;
    }

    const { error } = await supabase.from("allocations").insert({
      team_id: selectedTeamId,
      pitch_id: canonicalPitchId,
      weekday: s.weekday,
      start_time: s.start_time,
      end_time: s.end_time,
      quarters: q,
      notes: JSON.stringify({ quads }),
    });

    if (error) {
      alert(error.message);
      return;
    }

    await refreshAllocations();
  }

  async function deleteAllocation(id: string) {
    const ok = confirm("Diese Belegung löschen?");
    if (!ok) return;

    const { error } = await supabase.from("allocations").delete().eq("id", id);
    if (error) {
      alert(error.message);
      return;
    }
    await refreshAllocations();
  }

  function clearSelection() {
    setSel({ active: false, pitchName: "", slotK: "", quads: [] });
  }

  function startSelection(e: React.MouseEvent, pName: string, s: Slot, quad: number) {
    e.preventDefault();
    e.stopPropagation();

    const k = slotKey(s);
    setSel({ active: true, pitchName: pName, slotK: k, quads: [quad] });

    // keep form in sync (nice UX)
    setPitchName(pName);
    setSlotK(k);
    setQuarters(1);
  }

  function extendSelection(quad: number) {
    const cur = selRef.current;
    if (!cur.active) return;

    if (cur.quads.includes(quad)) return;
    const next = [...cur.quads, quad].slice(0, 4);
    setSel({ ...cur, quads: next });
    setQuarters(next.length);
  }

  function finishSelection(clientX: number, clientY: number) {
    const cur = selRef.current;
    if (!cur.active) return;

    const quads = [...cur.quads].sort((a, b) => a - b);
    const q = quads.length;
    setSel({ ...cur, active: false, quads });

    if (q < 1) {
      clearSelection();
      return;
    }

    const w = 340;
    const h = 190;
    const x = Math.max(12, Math.min(clientX, window.innerWidth - w - 12));
    const y = Math.max(12, Math.min(clientY, window.innerHeight - h - 12));

    setMenu({
      open: true,
      x,
      y,
      pitchName: cur.pitchName,
      slotK: cur.slotK,
      quads,
      teamId: teamId || teams[0]?.id || "",
    });
  }

  async function bookFromMenu() {
    const m = menu;
    const s = slotByKey.get(m.slotK);
    if (!s) {
      alert("Slot nicht gefunden.");
      return;
    }
    if (!m.teamId) {
      alert("Bitte Team wählen.");
      return;
    }

    await addAllocationWithSelection(m.pitchName, s, m.teamId, m.quads);
    setMenu((x) => ({ ...x, open: false }));
    clearSelection();
  }

  const pitchGrassStyle: React.CSSProperties = {
    position: "absolute",
    inset: 0,
    backgroundImage:
      "repeating-linear-gradient(90deg, rgba(16, 120, 32, 0.35) 0 14px, rgba(16, 100, 30, 0.35) 14px 28px)",
  };

  const pitchLinesStyle: React.CSSProperties = {
    position: "absolute",
    inset: 0,
    border: "2px solid rgba(255,255,255,0.35)",
    borderRadius: 12,
    pointerEvents: "none",
  };

  // Build the ordered pitch list according to the facility arrangement.
  const arrangedPitches = useMemo(() => {
    const placed: Array<{ pitch: Pitch | undefined; name: string; gridColumn: string; gridRow: string }> = FACILITY_LAYOUT.map((x) => ({
      pitch: resolvePitchByName(x.name),
      name: x.name,
      gridColumn: x.gridColumn,
      gridRow: x.gridRow,
    }));

    const usedIds = new Set<string>();
    for (const p of placed) if (p.pitch?.id) usedIds.add(p.pitch.id);

    const remaining = pitchDisplay.filter((p) => !usedIds.has(p.id));
    return { placed, remaining };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pitchDisplay, pitchByNorm]);

  if (!authChecked) {
    return <main style={{ padding: 16 }}>Prüfe Login…</main>;
  }

  return (
    <main style={{ padding: 16 }}>
      <style jsx global>{`
        @media print {
          @page { margin: 12mm; }
          html, body {
            background: #fff !important;
            color: #000 !important;
          }

          body * {
            box-shadow: none !important;
            text-shadow: none !important;
          }

          /* Hide controls / interactive bits */
          .no-print,
          button,
          select,
          option {
            display: none !important;
          }

          /* Make cards paper-friendly */
          .pitch-card {
            background: #fff !important;
            border-color: #bbb !important;
          }

          /* Football pitch: make it light */
          .pitch-surface {
            background: #fff !important;
            border-color: #bbb !important;
          }
          .pitch-grass {
            background: #f6f6f6 !important;
            background-image: none !important;
          }
          .pitch-lines {
            border-color: #888 !important;
          }

          /* Occupancy still visible but not too dark */
          .alloc-overlay {
            opacity: 0.35 !important;
          }

          /* Force readable text */
          * {
            color: #000 !important;
          }
        }
      `}</style>

      {/* Quick menu */}
      {menu.open ? (
        <div className="no-print"
          style={{
            position: "fixed",
            left: menu.x,
            top: menu.y,
            zIndex: 9999,
            width: 340,
            padding: 12,
            borderRadius: 12,
            border: "1px solid rgba(255,255,255,0.18)",
            background: "rgba(0,0,0,0.92)",
            boxShadow: "0 12px 40px rgba(0,0,0,0.55)",
          }}
        >
          <div style={{ fontWeight: 900, fontSize: 14 }}>Buchen</div>
          <div style={{ marginTop: 6, opacity: 0.8, fontSize: 12 }}>
            <span style={{ fontWeight: 800 }}>{menu.pitchName}</span> <span style={{ opacity: 0.8 }}>•</span>{" "}
            <span style={{ fontWeight: 700 }}>{slotByKey.get(menu.slotK)?.label ?? menu.slotK}</span>{" "}
            <span style={{ opacity: 0.8 }}>•</span> <span style={{ fontWeight: 900 }}>{menu.quads.length}/4</span>
          </div>

          <div style={{ marginTop: 10, display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ opacity: 0.85 }}>Team:</span>
            <select value={menu.teamId} onChange={(e) => setMenu((m) => ({ ...m, teamId: e.target.value }))} style={{ flex: 1 }}>
              {teams.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </div>

          <div style={{ marginTop: 12, display: "flex", justifyContent: "flex-end", gap: 8 }}>
            <button
              onClick={() => {
                setMenu((m) => ({ ...m, open: false }));
                clearSelection();
              }}
              style={{ padding: "6px 10px", borderRadius: 10, opacity: 0.9 }}
            >
              Abbrechen
            </button>
            <button onClick={bookFromMenu} style={{ padding: "6px 10px", borderRadius: 10, fontWeight: 900 }}>
              Buchen
            </button>
          </div>

          <div style={{ marginTop: 10, fontSize: 12, opacity: 0.7 }}>Tipp: Viertel per Drag auswählen, dann Team wählen.</div>
        </div>
      ) : null}

      <div style={{ display: "flex", gap: 12, alignItems: "baseline", flexWrap: "wrap" }}>
        <h1 style={{ fontSize: 22, fontWeight: 800, margin: 0 }}>Trainings-Verteilung</h1>

        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <span style={{ opacity: 0.8 }}>Tag:</span>
          <select
            value={weekday}
            onChange={(e) => {
              setWeekday(Number(e.target.value));
              setSlotK("");
              clearSelection();
              setMenu((m) => ({ ...m, open: false }));
            }}
          >
            <option value={3}>Mittwoch</option>
            <option value={5}>Freitag</option>
          </select>
        </div>

        <div style={{ marginLeft: "auto", display: "flex", gap: 12, alignItems: "center" }}>
          <div style={{ opacity: 0.75, fontSize: 13 }}>
            {loading ? "Lade Daten…" : `${pitchDisplay.length} Felder • ${slotsForDayDisplay.length} Slots • ${allocs.length} Belegungen`}
          </div>
          {session ? (
            <button
              className="no-print"
              onClick={() => supabase.auth.signOut()}
              style={{ padding: "6px 10px", borderRadius: 10 }}
            >
              Logout
            </button>
          ) : null}
        </div>
      </div>

      {err ? (
        <div style={{ marginTop: 12, padding: 12, border: "1px solid #ff6b6b", borderRadius: 10 }}>
          <div style={{ fontWeight: 700, color: "#ff6b6b" }}>Fehler</div>
          <div style={{ marginTop: 6, opacity: 0.9 }}>{err}</div>
        </div>
      ) : null}

      <section className="no-print" style={{ marginTop: 14, padding: 12, border: "1px solid #333", borderRadius: 10 }}>
        <div style={{ fontWeight: 700, marginBottom: 8 }}>Belegung hinzufügen</div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center" }}>
          <label>
            Team{" "}
            <select value={teamId} onChange={(e) => setTeamId(e.target.value)}>
              {teams.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </label>

          <label>
            Feld{" "}
            <select value={pitchName} onChange={(e) => setPitchName(e.target.value)}>
              {pitchDisplay.map((p) => (
                <option key={p.id} value={p.name}>
                  {p.name} ({p.surface === "KUNSTRASEN" ? "KR" : "R"})
                </option>
              ))}
            </select>
          </label>

          <label>
            Slot{" "}
            <select value={slotK} onChange={(e) => setSlotK(e.target.value)}>
              {slotsForDayDisplay.map((s) => (
                <option key={slotKey(s)} value={slotKey(s)}>
                  {s.label} ({shortTime(s.start_time)}–{shortTime(s.end_time)})
                </option>
              ))}
            </select>
          </label>

          <label>
            Bedarf{" "}
            <select value={quarters} onChange={(e) => setQuarters(Number(e.target.value))}>
              <option value={1}>1/4</option>
              <option value={2}>2/4</option>
              <option value={3}>3/4</option>
              <option value={4}>4/4</option>
            </select>
          </label>

          <button onClick={addAllocation} style={{ padding: "6px 10px", borderRadius: 10 }}>
            Hinzufügen
          </button>
        </div>
      </section>

      {/* Übersicht: Zeit links, Anlage rechts in physischer Anordnung */}
      <section style={{ marginTop: 16 }}>
        <h2 style={{ fontSize: 16, margin: "10px 0" }}>{wdLabel(weekday)} – Übersicht</h2>

        {slotsForDayDisplay.length === 0 ? (
          <div style={{ opacity: 0.7, marginTop: 10 }}>Keine Slots für diesen Tag. (Supabase: training_slots.weekday prüfen)</div>
        ) : null}

        <div style={{ display: "flex", flexDirection: "column", gap: 26 }}>
          {slotsForDayDisplay.map((s) => {
            const cellK = slotKey(s);

            return (
              <div
                key={cellK}
                style={{
                  display: "block",
                }}
              >

                {/* facility grid */}
                <div style={{ overflowX: "auto" }}>
                  <div
                    style={{
                      minWidth: 1120,
                      display: "grid",
                      gridTemplateColumns: "repeat(3, minmax(360px, 1fr))",
                      gap: 12,
                    }}
                  >
                                        {/* Zeit-Kachel im freien Platz (oben links über Grosskunstrasen Links) */}
                    <div
                      style={{
                        gridColumn: "1",
                        gridRow: "1",
                        padding: 12,
                        border: "none",
                        borderRadius: 0,
                        background: "transparent",
                      }}
                    >
                      <div style={{ fontWeight: 900, fontSize: 14 }}>{s.label}</div>
                      <div style={{ opacity: 0.7, fontSize: 12 }}>
                        {shortTime(s.start_time)}–{shortTime(s.end_time)}
                      </div>
                    </div>

{/* placed cards according to facility */}
                    {arrangedPitches.placed.map((it, idx) => {
                      const p = it.pitch;
                      const pName = p?.name ?? it.name;
                      const list = allocsInCell(pName, s);
                      const used = usedQuarters(pName, s);
                      const over = used > 4;
                      const { quads, placements } = buildFieldLayout(list, teamById);
                      const selOnThisCell = sel.pitchName === pName && sel.slotK === cellK;

                      return (
                        <div
                          key={`${it.name}-${idx}`}
                          className="pitch-card"
                          style={{
                            gridColumn: it.gridColumn,
                            gridRow: it.gridRow,
                            border: "1px solid #222",
                            borderRadius: 14,
                            padding: 12,
                            background: "#000",
                          }}
                        >
                          <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "baseline" }}>
                            <div style={{ minWidth: 0 }}>
                              <div style={{ fontWeight: 900, fontSize: 16, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                                {pName}
                              </div>
                              <div style={{ opacity: 0.7, fontSize: 12 }}>
                                {(p?.surface ?? "RASEN") === "KUNSTRASEN" ? "Kunstrasen" : "Rasen"} • Kapazität 4/4
                              </div>
                            </div>
                            <span
                              style={{
                                fontSize: 12,
                                fontWeight: 900,
                                padding: "2px 8px",
                                borderRadius: 999,
                                border: "1px solid #333",
                                color: over ? "rgb(255, 120, 120)" : "rgba(255,255,255,0.9)",
                                background: "rgba(0,0,0,0.25)",
                                flex: "0 0 auto",
                              }}
                            >
                              {used}/4
                            </span>
                          </div>

                          <div
                            style={{
                              marginTop: 10,
                              position: "relative",
                              height: 140,
                              borderRadius: 12,
                              overflow: "hidden",
                              border: "1px solid rgba(255,255,255,0.10)",
                              background: "rgba(0,0,0,0.20)",
                              userSelect: "none",
                            }}
                          >
                            <div className="pitch-grass" style={pitchGrassStyle} />

                            {/* Quarter overlays (2x2) */}
                            <div
                              style={{
                                position: "absolute",
                                inset: 0,
                                display: "grid",
                                gridTemplateColumns: "repeat(2, 1fr)",
                                gridTemplateRows: "repeat(2, 1fr)",
                              }}
                            >
                              {[0, 1, 2, 3].map((q) => {
                                const qc = quads[q];
                                const bg = qc.alloc ? qc.color?.base ?? "rgba(0,200,0,0.22)" : "transparent";
                                const stripe = qc.alloc
                                  ? `repeating-linear-gradient(135deg, ${qc.color?.stripe ?? "rgba(255,255,255,0.10)"} 0 6px, rgba(255,255,255,0) 6px 12px)`
                                  : "none";

                                const isSelected = selOnThisCell && sel.quads.includes(q);
                                const isFree = !qc.alloc;

                                return (
                                  <div
                                    key={q}
                                    onMouseDown={(e) => {
                                      if (!isFree) return;
                                      startSelection(e, pName, s, q);
                                    }}
                                    onMouseEnter={() => {
                                      if (!isFree) return;
                                      const cur = selRef.current;
                                      if (!cur.active) return;
                                      if (cur.pitchName !== pName || cur.slotK !== cellK) return;
                                      extendSelection(q);
                                    }}
                                    style={{
                                      position: "relative",
                                      background: bg,
                                      outline: isSelected ? "2px solid rgba(255,255,255,0.55)" : "none",
                                      outlineOffset: -2,
                                      cursor: isFree ? "crosshair" : "not-allowed",
                                    }}
                                  >
                                    {qc.alloc ? (
                                      <div className="alloc-overlay" style={{ position: "absolute", inset: 0, backgroundImage: stripe, opacity: 0.85, pointerEvents: "none" }} />
                                    ) : (
                                      <div
                                        style={{
                                          position: "absolute",
                                          inset: 0,
                                          display: "flex",
                                          alignItems: "center",
                                          justifyContent: "center",
                                          fontSize: 12,
                                          fontWeight: 800,
                                          opacity: 0.35,
                                          color: "rgba(255,255,255,0.9)",
                                          textShadow: "0 1px 2px rgba(0,0,0,0.75)",
                                          pointerEvents: "none",
                                        }}
                                      >
                                        (Frei)
                                      </div>
                                    )}
                                  </div>
                                );
                              })}
                            </div>

                            <div className="pitch-lines" style={pitchLinesStyle} />

                            {/* Quarter divider (horizontal) */}
                            <div
                              style={{
                                position: "absolute",
                                left: 0,
                                right: 0,
                                top: "50%",
                                height: 2,
                                background: "rgba(255,255,255,0.18)",
                                transform: "translateY(-1px)",
                                pointerEvents: "none",
                              }}
                            />

                            {/* Center line */}
                            <div
                              style={{
                                position: "absolute",
                                left: "50%",
                                top: 0,
                                bottom: 0,
                                width: 2,
                                background: "rgba(255,255,255,0.35)",
                                transform: "translateX(-1px)",
                                pointerEvents: "none",
                              }}
                            />

                            {/* Center circle */}
                            <div
                              style={{
                                position: "absolute",
                                left: "50%",
                                top: "50%",
                                width: 38,
                                height: 38,
                                borderRadius: 999,
                                border: "2px solid rgba(255,255,255,0.35)",
                                transform: "translate(-50%, -50%)",
                                pointerEvents: "none",
                              }}
                            />

                            {/* Penalty boxes - married to goal line */}
                            <div
                              style={{
                                position: "absolute",
                                left: 0,
                                top: "22%",
                                width: "16%",
                                height: "56%",
                                border: "2px solid rgba(255,255,255,0.38)",
                                borderLeft: "none",
                                pointerEvents: "none",
                              }}
                            />
                            <div
                              style={{
                                position: "absolute",
                                right: 0,
                                top: "22%",
                                width: "16%",
                                height: "56%",
                                border: "2px solid rgba(255,255,255,0.38)",
                                borderRight: "none",
                                pointerEvents: "none",
                              }}
                            />

                            {/* Labels + delete */}
                            {placements.map((pl) => (
                              <div
                                key={pl.alloc.id}
                                style={{
                                  position: "absolute",
                                  left: `${pl.leftPct}%`,
                                  top: `${pl.topPct}%`,
                                  width: `${pl.widthPct}%`,
                                  height: `${pl.heightPct}%`,
                                  pointerEvents: "none",
                                }}
                              >
                                <button
                                  onClick={() => deleteAllocation(pl.alloc.id)}
                                  style={{
                                    position: "absolute",
                                    right: 6,
                                    top: 6,
                                    fontSize: 12,
                                    padding: 0,
                                    border: "none",
                                    background: "transparent",
                                    color: "rgba(255,255,255,0.95)",
                                    textDecoration: "underline",
                                    cursor: "pointer",
                                    opacity: 0.95,
                                    textShadow: "0 1px 2px rgba(0,0,0,0.85)",
                                    pointerEvents: "auto",
                                  }}
                                  title="Belegung löschen"
                                >
                                  löschen
                                </button>

                                <div
                                  style={{
                                    position: "absolute",
                                    inset: 0,
                                    display: "flex",
                                    alignItems: "center",
                                    justifyContent: "center",
                                    padding: 6,
                                  }}
                                >
                                  <div
                                    style={{
                                      maxWidth: "100%",
                                      display: "inline-flex",
                                      alignItems: "center",
                                      gap: 8,
                                      padding: "4px 10px",
                                      borderRadius: 999,
                                      background: "rgba(0,0,0,0.35)",
                                      border: "1px solid rgba(255,255,255,0.14)",
                                      fontWeight: 900,
                                      fontSize: 12,
                                      textShadow: "0 1px 2px rgba(0,0,0,0.85)",
                                    }}
                                  >
                                    <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                                      {pl.teamName} ({pl.alloc.quarters}/4)
                                    </span>
                                  </div>
                                </div>
                              </div>
                            ))}

                            {over ? (
                              <div style={{ position: "absolute", inset: 0, background: "rgba(255, 80, 80, 0.16)", pointerEvents: "none" }} />
                            ) : null}
                          </div>
                        </div>
                      );
                    })}

                    {/* remaining pitches (auto-placed below) */}
                    {arrangedPitches.remaining.map((p, rIdx) => {
                      const pName = p.name;
                      const list = allocsInCell(pName, s);
                      const used = usedQuarters(pName, s);
                      const over = used > 4;
                      const { quads, placements } = buildFieldLayout(list, teamById);
                      const selOnThisCell = sel.pitchName === pName && sel.slotK === cellK;

                      return (
                        <div
                          key={`rest-${p.id}-${cellK}`}
                          style={{
                            gridColumn: `${(rIdx % 3) + 1}`,
                            gridRow: `${3 + Math.floor(rIdx / 3)}`,
                            border: "1px solid #222",
                            borderRadius: 14,
                            padding: 12,
                            background: "#000",
                          }}
                        >
                          <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "baseline" }}>
                            <div style={{ minWidth: 0 }}>
                              <div style={{ fontWeight: 900, fontSize: 16, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                                {pName}
                              </div>
                              <div style={{ opacity: 0.7, fontSize: 12 }}>
                                {p.surface === "KUNSTRASEN" ? "Kunstrasen" : "Rasen"} • Kapazität 4/4
                              </div>
                            </div>
                            <span
                              style={{
                                fontSize: 12,
                                fontWeight: 900,
                                padding: "2px 8px",
                                borderRadius: 999,
                                border: "1px solid #333",
                                color: over ? "rgb(255, 120, 120)" : "rgba(255,255,255,0.9)",
                                background: "rgba(0,0,0,0.25)",
                                flex: "0 0 auto",
                              }}
                            >
                              {used}/4
                            </span>
                          </div>

                          <div
                            style={{
                              marginTop: 10,
                              position: "relative",
                              height: 140,
                              borderRadius: 12,
                              overflow: "hidden",
                              border: "1px solid rgba(255,255,255,0.10)",
                              background: "rgba(0,0,0,0.20)",
                              userSelect: "none",
                            }}
                          >
                            <div className="pitch-grass" style={pitchGrassStyle} />

                            <div
                              style={{
                                position: "absolute",
                                inset: 0,
                                display: "grid",
                                gridTemplateColumns: "repeat(2, 1fr)",
                                gridTemplateRows: "repeat(2, 1fr)",
                              }}
                            >
                              {[0, 1, 2, 3].map((q) => {
                                const qc = quads[q];
                                const bg = qc.alloc ? qc.color?.base ?? "rgba(0,200,0,0.22)" : "transparent";
                                const stripe = qc.alloc
                                  ? `repeating-linear-gradient(135deg, ${qc.color?.stripe ?? "rgba(255,255,255,0.10)"} 0 6px, rgba(255,255,255,0) 6px 12px)`
                                  : "none";
                                const isSelected = selOnThisCell && sel.quads.includes(q);
                                const isFree = !qc.alloc;

                                return (
                                  <div
                                    key={q}
                                    onMouseDown={(e) => {
                                      if (!isFree) return;
                                      startSelection(e, pName, s, q);
                                    }}
                                    onMouseEnter={() => {
                                      if (!isFree) return;
                                      const cur = selRef.current;
                                      if (!cur.active) return;
                                      if (cur.pitchName !== pName || cur.slotK !== cellK) return;
                                      extendSelection(q);
                                    }}
                                    style={{
                                      position: "relative",
                                      background: bg,
                                      outline: isSelected ? "2px solid rgba(255,255,255,0.55)" : "none",
                                      outlineOffset: -2,
                                      cursor: isFree ? "crosshair" : "not-allowed",
                                    }}
                                  >
                                    {qc.alloc ? (
                                      <div className="alloc-overlay" style={{ position: "absolute", inset: 0, backgroundImage: stripe, opacity: 0.85, pointerEvents: "none" }} />
                                    ) : (
                                      <div
                                        style={{
                                          position: "absolute",
                                          inset: 0,
                                          display: "flex",
                                          alignItems: "center",
                                          justifyContent: "center",
                                          fontSize: 12,
                                          fontWeight: 800,
                                          opacity: 0.35,
                                          color: "rgba(255,255,255,0.9)",
                                          textShadow: "0 1px 2px rgba(0,0,0,0.75)",
                                          pointerEvents: "none",
                                        }}
                                      >
                                        (Frei)
                                      </div>
                                    )}
                                  </div>
                                );
                              })}
                            </div>

                            <div className="pitch-lines" style={pitchLinesStyle} />
                            <div
                              style={{
                                position: "absolute",
                                left: 0,
                                right: 0,
                                top: "50%",
                                height: 2,
                                background: "rgba(255,255,255,0.18)",
                                transform: "translateY(-1px)",
                                pointerEvents: "none",
                              }}
                            />
                            <div
                              style={{
                                position: "absolute",
                                left: "50%",
                                top: 0,
                                bottom: 0,
                                width: 2,
                                background: "rgba(255,255,255,0.35)",
                                transform: "translateX(-1px)",
                                pointerEvents: "none",
                              }}
                            />
                            <div
                              style={{
                                position: "absolute",
                                left: "50%",
                                top: "50%",
                                width: 38,
                                height: 38,
                                borderRadius: 999,
                                border: "2px solid rgba(255,255,255,0.35)",
                                transform: "translate(-50%, -50%)",
                                pointerEvents: "none",
                              }}
                            />
                            <div
                              style={{
                                position: "absolute",
                                left: 0,
                                top: "22%",
                                width: "16%",
                                height: "56%",
                                border: "2px solid rgba(255,255,255,0.38)",
                                borderLeft: "none",
                                pointerEvents: "none",
                              }}
                            />
                            <div
                              style={{
                                position: "absolute",
                                right: 0,
                                top: "22%",
                                width: "16%",
                                height: "56%",
                                border: "2px solid rgba(255,255,255,0.38)",
                                borderRight: "none",
                                pointerEvents: "none",
                              }}
                            />

                            {placements.map((pl) => (
                              <div
                                key={pl.alloc.id}
                                style={{
                                  position: "absolute",
                                  left: `${pl.leftPct}%`,
                                  top: `${pl.topPct}%`,
                                  width: `${pl.widthPct}%`,
                                  height: `${pl.heightPct}%`,
                                  pointerEvents: "none",
                                }}
                              >
                                <button
                                  onClick={() => deleteAllocation(pl.alloc.id)}
                                  style={{
                                    position: "absolute",
                                    right: 6,
                                    top: 6,
                                    fontSize: 12,
                                    padding: 0,
                                    border: "none",
                                    background: "transparent",
                                    color: "rgba(255,255,255,0.95)",
                                    textDecoration: "underline",
                                    cursor: "pointer",
                                    opacity: 0.95,
                                    textShadow: "0 1px 2px rgba(0,0,0,0.85)",
                                    pointerEvents: "auto",
                                  }}
                                  title="Belegung löschen"
                                >
                                  löschen
                                </button>

                                <div
                                  style={{
                                    position: "absolute",
                                    inset: 0,
                                    display: "flex",
                                    alignItems: "center",
                                    justifyContent: "center",
                                    padding: 6,
                                  }}
                                >
                                  <div
                                    style={{
                                      maxWidth: "100%",
                                      display: "inline-flex",
                                      alignItems: "center",
                                      gap: 8,
                                      padding: "4px 10px",
                                      borderRadius: 999,
                                      background: "rgba(0,0,0,0.35)",
                                      border: "1px solid rgba(255,255,255,0.14)",
                                      fontWeight: 900,
                                      fontSize: 12,
                                      textShadow: "0 1px 2px rgba(0,0,0,0.85)",
                                    }}
                                  >
                                    <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                                      {pl.teamName} ({pl.alloc.quarters}/4)
                                    </span>
                                  </div>
                                </div>
                              </div>
                            ))}

                            {over ? (
                              <div style={{ position: "absolute", inset: 0, background: "rgba(255, 80, 80, 0.16)", pointerEvents: "none" }} />
                            ) : null}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </section>
    </main>
  );
}
