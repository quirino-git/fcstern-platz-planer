"use client";

import { useEffect, useMemo, useRef, useState } from "react";
// We avoid route changes for "Start" (the user expects it to jump to the relevant day on this page)
import { supabase } from "@/lib/supabaseClient";

type Pitch = {
  id: string;
  name: string;
  surface: "KUNSTRASEN" | "RASEN";
  capacity_quarters: number;
  sort_order: number;
};

type Team = {
  id: string;
  name: string;
  sort_order?: number;
};

type TrainingSlot = {
  id: string;
  weekday: number; // 1=Mon..7=Sun
  label: string;
  start_time: string; // "HH:MM:SS"
  end_time: string;
  sort_order: number;
};

type BookingSeries = {
  id: string;
  start_date: string; // YYYY-MM-DD
  until_date: string; // YYYY-MM-DD
  interval_weeks: number;
  status: "ACTIVE" | "CANCELLED";
};

type Booking = {
  id: string;
  series_id: string | null;
  team_id: string;
  pitch_id: string;
  slot_id: string;
  booking_date: string; // YYYY-MM-DD
  quarters: number;
  status: "ACTIVE" | "CANCELLED";
  note: string | null;
  created_at: string;
  teams?: { name: string } | null;
  booking_series?: BookingSeries | null;
};

function toYMDLocal(d: Date) {
  const yy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

function addDaysYMD(ymd: string, delta: number) {
  const [y, m, d] = ymd.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + delta);
  return toYMDLocal(dt);
}

function weekday1to7(ymd: string) {
  const [y, m, d] = ymd.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  const js = dt.getDay();
  return js === 0 ? 7 : js; // 1..7
}

function weekdayNameDE(weekday: number) {
  return ["", "Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag", "Sonntag"][weekday] || "";
}

function fmtDateDE(ymd: string) {
  const [y, m, d] = ymd.split("-");
  return `${d}.${m}.${y}`;
}

function combineLocalISO(ymd: string, time: string) {
  const [y, m, d] = ymd.split("-").map(Number);
  const [hh, mm] = time.split(":").map((x) => Number(x));
  const dt = new Date(y, m - 1, d, hh, mm, 0, 0);
  return dt.toISOString();
}

function chunks<T>(arr: T[], size: number) {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// 2x2 grid indices
// 0 1
// 2 3
const SHAPES: Record<number, number[][]> = {
  4: [[0, 1, 2, 3]],
  3: [
    [0, 1, 2],
    [0, 1, 3],
    [0, 2, 3],
    [1, 2, 3],
  ],
  2: [
    [0, 1],
    [2, 3],
    [0, 2],
    [1, 3],
  ],
  1: [[0], [1], [2], [3]],
};

function idxToRC(idx: number) {
  return { r: idx < 2 ? 0 : 1, c: idx % 2 };
}
function rectCells(a: number, b: number) {
  const A = idxToRC(a);
  const B = idxToRC(b);
  const r0 = Math.min(A.r, B.r);
  const r1 = Math.max(A.r, B.r);
  const c0 = Math.min(A.c, B.c);
  const c1 = Math.max(A.c, B.c);
  const out: number[] = [];
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) out.push(r * 2 + c);
  }
  return out;
}
const CELLS_TAG_RE = /\[CELLS:([0-3](?:,[0-3])*)\]/;

function parseCellsTag(note: string | null | undefined): { cells: number[] | null; cleanNote: string | null } {
  const raw = String(note || "");
  const m = raw.match(CELLS_TAG_RE);
  if (!m) return { cells: null, cleanNote: (raw.trim() ? raw.trim() : null) };
  const cells = m[1]
    .split(",")
    .map((x) => Number(x.trim()))
    .filter((n) => Number.isFinite(n) && n >= 0 && n <= 3);
  // remove tag (and leftover whitespace/newlines)
  const cleaned = raw.replace(CELLS_TAG_RE, "").replace(/\n{3,}/g, "\n\n").trim();
  return { cells: cells.length ? cells : null, cleanNote: cleaned ? cleaned : null };
}

function withCellsTag(note: string | null | undefined, cells: number[] | null | undefined): string {
  const base = String(note || "").trim();
  const cleaned = base.replace(CELLS_TAG_RE, "").trim();
  const uniq = Array.from(new Set((cells || []).filter((n) => Number.isFinite(n) && n >= 0 && n <= 3))).sort((a, b) => a - b);
  if (!uniq.length) return cleaned;
  const tag = `[CELLS:${uniq.join(",")}]`;
  if (!cleaned) return tag;
  // keep user's note readable; store tag on its own line
  return `${cleaned}\n${tag}`;
}

function assignCells(bookings: Booking[]) {
  // If a booking note contains a [CELLS:x,y] tag, we treat it as the preferred exact cells
  // (makes drag-select deterministic and stable after reload).
  const enriched = bookings.map((b) => {
    const parsed = parseCellsTag(b.note);
    return { b, pref: parsed.cells, cleanNote: parsed.cleanNote };
  });

  const sorted = enriched
    .slice()
    .sort((A, B) => (B.b.quarters ?? 0) - (A.b.quarters ?? 0)); // large first (pack big ones first)

  const taken = new Map<number, string>(); // cell -> bookingId
  const byBooking: Record<string, number[]> = {};

  for (const item of sorted) {
    const b = item.b;
    const q = Math.max(1, Math.min(4, Number(b.quarters || 1)));

    // 1) If pref is present and matches requested quarters, try to place exactly those cells first.
    const pref = item.pref;
    if (pref && pref.length === q && pref.every((idx) => !taken.has(idx))) {
      byBooking[b.id] = pref;
      for (const idx of pref) taken.set(idx, b.id);
      continue;
    }

    // 2) Otherwise use standard shapes (deterministic packing).
    const shapes = SHAPES[q] || SHAPES[1];
    let picked: number[] | null = null;
    for (const s of shapes) {
      if (s.every((idx) => !taken.has(idx))) {
        picked = s;
        break;
      }
    }

    // 3) Fallback: take first free cells.
    if (!picked) {
      const free = [0, 1, 2, 3].filter((idx) => !taken.has(idx));
      picked = free.slice(0, q);
    }

    byBooking[b.id] = picked;
    for (const idx of picked) taken.set(idx, b.id);
  }

  const cellToBooking: (string | null)[] = [null, null, null, null];
  for (const [idx, bid] of taken.entries()) cellToBooking[idx] = bid;
  return { cellToBooking, byBooking };
}

function teamHueForId(id: string) {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return h % 360;
}

function teamColorsForId(id: string): { fill: string; solid: string } {
  const hue = teamHueForId(id);
  // solid = used for accents; fill = used as semi-transparent overlay so the pitch background/lines stay visible
  const solid = `hsl(${hue} 72% 42%)`;
  const fill = `hsl(${hue} 72% 42% / 0.45)`;
  return { fill, solid };
}

function parseHexColor(hex: string): { r: number; g: number; b: number } | null {
  const h = hex.trim();
  const m3 = /^#([0-9a-f]{3})$/i.exec(h);
  const m6 = /^#([0-9a-f]{6})$/i.exec(h);
  if (m3) {
    const x = m3[1];
    const r = parseInt(x[0] + x[0], 16);
    const g = parseInt(x[1] + x[1], 16);
    const b = parseInt(x[2] + x[2], 16);
    return { r, g, b };
  }
  if (m6) {
    const x = m6[1];
    const r = parseInt(x.slice(0, 2), 16);
    const g = parseInt(x.slice(2, 4), 16);
    const b = parseInt(x.slice(4, 6), 16);
    return { r, g, b };
  }
  return null;
}

function teamColors(teamId: string, customColor?: string | null): { fill: string; solid: string } {
  const cc = String(customColor || "").trim();
  if (cc) {
    // We only guarantee correct alpha for hex values. For anything else we fall back to deterministic HSL.
    const rgb = parseHexColor(cc);
    if (rgb) {
      const solid = `rgb(${rgb.r} ${rgb.g} ${rgb.b})`;
      const fill = `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.45)`;
      return { fill, solid };
    }
  }
  return teamColorsForId(teamId);
}

export default function PlanPage() {
  // If you previously used a different Supabase project (or had a partial session stored),
  // Supabase can throw "Invalid Refresh Token: Refresh Token Not Found" in dev.
  // This makes sure broken session entries don't block data loading.
  useEffect(() => {
    (async () => {
      // 1) Remove obviously broken auth entries (e.g. missing refresh_token)
      try {
        for (const k of Object.keys(localStorage)) {
          if (!k.startsWith("sb-") || !k.endsWith("-auth-token")) continue;
          const raw = localStorage.getItem(k);
          if (!raw) continue;
          let parsed: any = null;
          try {
            parsed = JSON.parse(raw);
          } catch {
            continue;
          }
          const rt =
            parsed?.refresh_token ??
            parsed?.currentSession?.refresh_token ??
            parsed?.session?.refresh_token ??
            parsed?.data?.refresh_token;
          if (!rt) localStorage.removeItem(k);
        }
      } catch {
        // ignore
      }

      // 2) If Supabase tells us the refresh token is invalid, force a clean re-login.
      // This can happen after switching projects or rotating keys.
      try {
        const { error } = await supabase.auth.getSession();
        if (error && /invalid refresh token|refresh token not found/i.test(String(error.message || ""))) {
          try {
            for (const k of Object.keys(localStorage)) {
              if (k.startsWith("sb-") && k.endsWith("-auth-token")) localStorage.removeItem(k);
            }
          } catch {}
          try {
            await supabase.auth.signOut();
          } catch {}
          window.location.href = "/login";
        }
      } catch {
        // ignore
      }
    })();
  }, []);


  const today = useMemo(() => toYMDLocal(new Date()), []);
  const [selectedDate, setSelectedDate] = useState<string>(today);
  const weekday = useMemo(() => weekday1to7(selectedDate), [selectedDate]);

  const [pitches, setPitches] = useState<Pitch[]>([]);
  const [teams, setTeams] = useState<Team[]>([]);
  const [slots, setSlots] = useState<TrainingSlot[]>([]);
  const [bookings, setBookings] = useState<Booking[]>([]);

  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  // Avoid double-loading when we change selectedDate programmatically on initial load
  const skipReloadRef = useRef(false);

  // Add form
  const [teamId, setTeamId] = useState<string>("");
  const [pitchId, setPitchId] = useState<string>("");
  const [slotId, setSlotId] = useState<string>("");
  const [quarters, setQuarters] = useState<number>(1);
  const [repeatWeeks, setRepeatWeeks] = useState<number>(0); // 0=einmalig, sonst 1..4
  const [untilDate, setUntilDate] = useState<string>(() => {
    const now = new Date();
    const year = now.getMonth() >= 6 ? now.getFullYear() + 1 : now.getFullYear();
    return `${year}-06-30`;
  });
  const [note, setNote] = useState<string>("");

  // Cancel dialog
  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelBooking, setCancelBooking] = useState<Booking | null>(null);
  const [cancelMode, setCancelMode] = useState<"ONE" | "SERIES_FROM" | "SERIES_ALL">("ONE");

  // Quick-book popup opened by dragging across the 1/4 cells of a pitch
  const [bookOpen, setBookOpen] = useState(false);
  const [bookPitchId, setBookPitchId] = useState<string>("");
  const [bookSlotId, setBookSlotId] = useState<string>("");
  const [bookTeamId, setBookTeamId] = useState<string>("");
  const [bookQuarters, setBookQuarters] = useState<number>(1);
  const [bookRepeatWeeks, setBookRepeatWeeks] = useState<number>(0); // 0=einmalig, sonst 1..4
  const [bookUntilDate, setBookUntilDate] = useState<string>(() => {
    const now = new Date();
    const year = now.getMonth() >= 6 ? now.getFullYear() + 1 : now.getFullYear();
    return `${year}-06-30`;
  });
  const [bookNote, setBookNote] = useState<string>("");
  const [bookCells, setBookCells] = useState<number[] | null>(null);
  const [dragSel, setDragSel] = useState<{ pitchId: string; slotId: string; start: number; current: number } | null>(null);

  const daySlots = useMemo(
    () => slots.filter((s) => s.weekday === weekday).sort((a, b) => a.sort_order - b.sort_order),
    [slots, weekday]
  );

  const teamColorsMap = useMemo(() => {
    const m = new Map<string, { fill: string; solid: string }>();
    for (const t of teams) {
      m.set(t.id, teamColorsForId(t.id));
    }
    return m;
  }, [teams]);

  // Wenn der aktuelle Tag keine Slots hat (z.B. Montag), springe automatisch
  // zum nächsten Trainingstag (basierend auf den in training_slots gepflegten weekdays).
  useEffect(() => {
    if (loading) return;
    if (!slots.length) return;

    const wanted = weekday1to7(selectedDate);
    const available = Array.from(new Set(slots.map((s) => s.weekday))).sort((a, b) => a - b);
    if (!available.length) return;

    if (available.includes(wanted)) return; // ok

    // Find next date within 14 days that matches an available weekday.
    for (let i = 1; i <= 14; i++) {
      const cand = addDaysYMD(selectedDate, i);
      if (available.includes(weekday1to7(cand))) {
        setSelectedDate(cand);
        break;
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, slots.length]);

  const bookingsByPitchSlot = useMemo(() => {
    const map = new Map<string, Booking[]>();
    for (const b of bookings) {
      if (b.status === "CANCELLED") continue;
      const key = `${b.pitch_id}__${b.slot_id}`;
      const arr = map.get(key) || [];
      arr.push(b);
      map.set(key, arr);
    }
    return map;
  }, [bookings]);

  
async function loadStatic() {
  setError(null);
  setInfo(null);

  const [pRes, sRes] = await Promise.all([
    supabase.from("pitches").select("id,name,surface,capacity_quarters,sort_order").order("sort_order"),
    supabase
      .from("training_slots")
      .select("id,weekday,label,start_time,end_time,sort_order")
      .order("weekday")
      .order("sort_order"),
  ]);

  if (pRes.error) throw pRes.error;
  if (sRes.error) throw sRes.error;

  // Teams: In diesem Projekt spielt das Alter keine Rolle.
// Wir erwarten minimal: id + name (optional sort_order).
let tRes: any = await supabase.from("teams").select("id,name,sort_order").order("sort_order").order("name");
if (tRes.error) {
  const msg = String(tRes.error.message || "");
  if (/sort_order/i.test(msg) || /column/i.test(msg)) {
    const tRes2: any = await supabase.from("teams").select("id,name").order("name");
    if (!tRes2.error) tRes = tRes2;
    else throw tRes2.error;
  } else {
    throw tRes.error;
  }
}

  const pData = (pRes.data || []) as any;
  const tData = (tRes.data || []) as any;
  const sData = (sRes.data || []) as any;

  setPitches(pData);
  setTeams(tData);
  setSlots(sData);

// Helpful hint if data is empty (often wrong Supabase project or RLS policies)
  if (!tData.length || !pData.length || !sData.length) {
    const missing: string[] = [];
    if (!tData.length) missing.push("Teams");
    if (!pData.length) missing.push("Plätze");
    if (!sData.length) missing.push("Slots");
    setInfo(`Keine ${missing.join(", ")} gefunden. Prüfe: (1) .env.local zeigt auf das richtige Supabase-Projekt, (2) RLS/Policies erlauben SELECT auf teams/pitches/training_slots.`);
  }

  const firstTeam = tData[0];
  const firstPitch = pData[0];
  setTeamId(firstTeam?.id || "");
  setPitchId(firstPitch?.id || "");
}

async function loadBookingsForDate(ymd: string) {
    setError(null);
    const res = await supabase
      .from("bookings")
      .select(
        "id,series_id,team_id,pitch_id,slot_id,booking_date,quarters,status,note,created_at,teams:team_id(name),booking_series:series_id(start_date,until_date,interval_weeks,status)"
      )
      .eq("booking_date", ymd)
      .neq("status", "CANCELLED");
    if (res.error) throw res.error;
    setBookings((res.data || []) as any);
  }


  async function findNextBookingDate(fromYmd: string) {
    // Find the next day (>= fromYmd) that has at least one active booking
    const res = await supabase
      .from("bookings")
      .select("booking_date")
      .gte("booking_date", fromYmd)
      .neq("status", "CANCELLED")
      .order("booking_date", { ascending: true })
      .limit(1);
    if (res.error) return null;
    return (res.data && (res.data as any[])[0]?.booking_date) ? String((res.data as any[])[0].booking_date) : null;
  }

  async function goStart() {
    // Keep the user on this page: jump to the next day with an existing plan (old behavior)
    // starting from today. If nothing exists, just jump to today.
    setError(null);
    setInfo(null);
    try {
      setBusy(true);
      const base = today;
      const nextWithBooking = await findNextBookingDate(base);
      const target = nextWithBooking || base;
      setSelectedDate(target);
      // bookings load via selectedDate effect
      try {
        window.scrollTo({ top: 0, behavior: "smooth" });
      } catch {}
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        setLoading(true);
        await loadStatic();

        // Auto-show the next upcoming plan: if there are no bookings on the initial date,
        // jump to the next date that has bookings (keeps the old "sofort Plan" behavior).
        const nextWithBooking = await findNextBookingDate(selectedDate);
        if (nextWithBooking && nextWithBooking !== selectedDate) {
          skipReloadRef.current = true;
          setSelectedDate(nextWithBooking);
          await loadBookingsForDate(nextWithBooking);
        } else {
          await loadBookingsForDate(selectedDate);
        }
      } catch (e: any) {
        if (!alive) return;
        setError(e?.message || String(e));
      } finally {
        if (!alive) return;
        setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (loading) return;
    (async () => {
      try {
        setBusy(true);
        await loadBookingsForDate(selectedDate);
      } catch (e: any) {
        setError(e?.message || String(e));
      } finally {
        setBusy(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedDate]);

  function occurrenceDates(): string[] {
    if (!repeatWeeks) return [selectedDate];
    const start = selectedDate;
    const end = untilDate;
    if (!end || end < start) return [start];
    const out: string[] = [];
    let cur = start;
    while (cur <= end) {
      out.push(cur);
      cur = addDaysYMD(cur, repeatWeeks * 7);
    }
    return out;
  }

  async function checkConflicts(dates: string[], pitchIdX: string, slotIdX: string, quartersX: number) {
    const slot = slots.find((s) => s.id === slotIdX);
    if (!slot) return { ok: false, msg: "Bitte Slot wählen." };
    if (!pitchIdX) return { ok: false, msg: "Bitte Feld wählen." };
    if (dates.length === 0) return { ok: false, msg: "Keine Termine." };

    const minD = dates[0];
    const maxD = dates[dates.length - 1];

    const res = await supabase
      .from("bookings")
      .select("id,series_id,team_id,booking_date,quarters,teams:team_id(name)")
      .eq("pitch_id", pitchIdX)
      .eq("slot_id", slotIdX)
      .gte("booking_date", minD)
      .lte("booking_date", maxD)
      .neq("status", "CANCELLED");
    if (res.error) return { ok: false, msg: res.error.message };
    const existing = (res.data || []) as any[];

    const byDate = new Map<string, any[]>();
    for (const b of existing) {
      const arr = byDate.get(b.booking_date) || [];
      arr.push(b);
      byDate.set(b.booking_date, arr);
    }

    const conflicts: string[] = [];
    for (const d of dates) {
      const arr = byDate.get(d) || [];
      const used = arr.reduce((s, x) => s + Number(x.quarters || 0), 0);
      if (used + quartersX > 4) {
        const samples = arr
          .slice(0, 3)
          .map((x) => {
            const kind = x.series_id ? "Serienbuchung" : "Einzelbuchung";
            const tn = x?.teams?.name || "(Team)";
            return `${kind} ${tn} (${x.quarters}/4)`;
          })
          .join("; ");
        conflicts.push(`${fmtDateDE(d)}: bereits ${used}/4 belegt → kollidiert mit ${samples || "bestehender Buchung"}`);
      }
    }

    if (conflicts.length) {
      return {
        ok: false,
        msg:
          "Buchung kollidiert mit bestehenden Terminen:\n" +
          conflicts.slice(0, 8).map((x) => `• ${x}`).join("\n") +
          (conflicts.length > 8 ? `\n… (${conflicts.length - 8} weitere)` : ""),
      };
    }
    return { ok: true, msg: "" };
  }

async function createBooking(params: {
  teamId: string;
  pitchId: string;
  slotId: string;
  quarters: number;
  repeatWeeks: number; // 0=einmalig
  untilDate: string;
  note: string;
  // Optional: exact 2x2 quarter cells selected via drag (0..3). If provided we persist it
  // in the note as a [CELLS:..] tag so the UI can render the exact chosen quarters.
  cells?: number[] | null;
}) {
  const teamIdX = params.teamId;
  const pitchIdX = params.pitchId;
  const slotIdX = params.slotId;
  const quartersX = params.quarters;
  const repeatWeeksX = params.repeatWeeks;
  const untilDateX = params.untilDate;
  const noteX = params.note;

  const slot = slots.find((s) => s.id === slotIdX);
  if (!slot) throw new Error("Bitte Slot wählen.");
  if (!pitchIdX) throw new Error("Bitte Feld wählen.");
  if (!teamIdX) throw new Error("Bitte Team wählen.");
  if (slot.weekday !== weekday) throw new Error("Slot passt nicht zum ausgewählten Datum.");

  const makeDates = () => {
    if (!repeatWeeksX) return [selectedDate];
    const start = selectedDate;
    const end = untilDateX;
    if (!end || end < start) return [start];
    const out: string[] = [];
    let cur = start;
    while (cur <= end) {
      out.push(cur);
      cur = addDaysYMD(cur, repeatWeeksX * 7);
    }
    return out;
  };

  const dates = makeDates();
  const conf = await checkConflicts(dates, pitchIdX, slotIdX, quartersX);
  if (!conf.ok) throw new Error(conf.msg);

  const noteVal = withCellsTag(noteX, params.cells || null);

  if (!repeatWeeksX) {
    const row = {
      series_id: null,
      team_id: teamIdX,
      pitch_id: pitchIdX,
      slot_id: slotIdX,
      booking_date: selectedDate,
      start_at: combineLocalISO(selectedDate, slot.start_time.slice(0, 5)),
      end_at: combineLocalISO(selectedDate, slot.end_time.slice(0, 5)),
      quarters: quartersX,
      note: noteVal,
      status: "ACTIVE",
    };
    const ins = await supabase.from("bookings").insert(row);
    if (ins.error) throw ins.error;
    return "Einzelbuchung angelegt.";
  } else {
    const sRow = {
      team_id: teamIdX,
      pitch_id: pitchIdX,
      slot_id: slotIdX,
      weekday,
      start_date: selectedDate,
      until_date: untilDateX,
      interval_weeks: repeatWeeksX,
      quarters: quartersX,
      note: noteVal,
      status: "ACTIVE",
    };
    const sIns = await supabase.from("booking_series").insert(sRow).select("id").single();
    if (sIns.error) throw sIns.error;
    const seriesId = (sIns.data as any).id as string;

    const rows = dates.map((d) => ({
      series_id: seriesId,
      team_id: teamIdX,
      pitch_id: pitchIdX,
      slot_id: slotIdX,
      booking_date: d,
      start_at: combineLocalISO(d, slot.start_time.slice(0, 5)),
      end_at: combineLocalISO(d, slot.end_time.slice(0, 5)),
      quarters: quartersX,
      note: noteVal,
      status: "ACTIVE",
    }));
    for (const chunk of chunks(rows, 250)) {
      const ins = await supabase.from("bookings").insert(chunk);
      if (ins.error) throw ins.error;
    }
    return `Serie angelegt (${dates.length} Termine).`;
  }
}

async function addBooking() {
  setError(null);
  setInfo(null);
  try {
    setBusy(true);
    const msg = await createBooking({
      teamId,
      pitchId,
      slotId,
      quarters,
      repeatWeeks,
      untilDate,
      note,
      cells: null,
    });
    setInfo(msg);
    await loadBookingsForDate(selectedDate);
  } catch (e: any) {
    const msg = e?.message || String(e);
    // common hint when RLS blocks inserts/updates
    if (/permission denied|row-level security|not authorized/i.test(msg)) {
      setError(
        msg +
          "\n\nHinweis: Das sieht nach RLS/Policy aus. In Supabase müssen INSERT/UPDATE Policies für bookings/booking_series erlaubt sein (oder RLS temporär deaktivieren)."
      );
    } else {
      setError(msg);
    }
  } finally {
    setBusy(false);
  }
}

function openCancel(b: Booking) {
    setCancelBooking(b);
    setCancelMode("ONE");
    setCancelOpen(true);
  }

  function openBook(pitchIdX: string, slotIdX: string, cells: number[]) {
  setError(null);
  setInfo(null);
  setBookPitchId(pitchIdX);
  setBookSlotId(slotIdX);
  setBookQuarters(Math.max(1, Math.min(4, cells.length || 1)));
  setBookCells(cells.length ? cells : null);
  setBookTeamId(teamId || teams[0]?.id || "");
  setBookRepeatWeeks(0);
  setBookUntilDate(untilDate);
  setBookNote("");
  setBookOpen(true);
}

async function confirmBook() {
  setError(null);
  setInfo(null);
  try {
    setBusy(true);
    const msg = await createBooking({
      teamId: bookTeamId || teamId,
      pitchId: bookPitchId,
      slotId: bookSlotId,
      quarters: bookQuarters,
      repeatWeeks: bookRepeatWeeks,
      untilDate: bookUntilDate,
      // Keep the user's note clean; store exact cells separately via cells param.
      note: bookNote ?? "",
      cells: bookCells,
    });
    setInfo(msg);
    setBookOpen(false);
    setDragSel(null);
    await loadBookingsForDate(selectedDate);
  } catch (e: any) {
    const msg = e?.message || String(e);
    if (/permission denied|row-level security|not authorized/i.test(msg)) {
      setError(
        msg +
          "\n\nHinweis: Das sieht nach RLS/Policy aus. In Supabase müssen INSERT/UPDATE Policies für bookings/booking_series erlaubt sein (oder RLS temporär deaktivieren)."
      );
    } else {
      setError(msg);
    }
  } finally {
    setBusy(false);
  }
}

async function doCancel() {
    if (!cancelBooking) return;
    setError(null);
    setInfo(null);
    try {
      setBusy(true);

      if (cancelMode === "ONE" || !cancelBooking.series_id) {
        const up = await supabase.from("bookings").update({ status: "CANCELLED" }).eq("id", cancelBooking.id);
        if (up.error) throw up.error;
        setInfo("Termin storniert.");
      } else if (cancelMode === "SERIES_ALL") {
        const sid = cancelBooking.series_id;
        const u1 = await supabase.from("booking_series").update({ status: "CANCELLED" }).eq("id", sid);
        if (u1.error) throw u1.error;
        const u2 = await supabase.from("bookings").update({ status: "CANCELLED" }).eq("series_id", sid);
        if (u2.error) throw u2.error;
        setInfo("Serie komplett storniert.");
      } else if (cancelMode === "SERIES_FROM") {
        const sid = cancelBooking.series_id;
        const dayBefore = addDaysYMD(cancelBooking.booking_date, -1);
        const u1 = await supabase.from("booking_series").update({ until_date: dayBefore }).eq("id", sid);
        if (u1.error) throw u1.error;
        const u2 = await supabase
          .from("bookings")
          .update({ status: "CANCELLED" })
          .eq("series_id", sid)
          .gte("booking_date", cancelBooking.booking_date);
        if (u2.error) throw u2.error;
        setInfo("Serie ab diesem Termin beendet.");
      }

      setCancelOpen(false);
      setCancelBooking(null);
      await loadBookingsForDate(selectedDate);
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setBusy(false);
    }
  }

  const totals = useMemo(() => {
    return {
      pitches: pitches.length,
      slots: daySlots.length,
      bookings: bookings.filter((b) => b.status !== "CANCELLED").length,
    };
  }, [pitches.length, daySlots.length, bookings]);

  const previewCount = useMemo(() => {
    if (!repeatWeeks) return 1;
    return occurrenceDates().length;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repeatWeeks, selectedDate, untilDate]);

  if (loading) {
    return (
      <main style={{ padding: 24 }}>
        <div style={{ fontWeight: 800 }}>Lade…</div>
      </main>
    );
  }

  return (
    <main style={{ padding: 18, maxWidth: 1400, margin: "0 auto" }}>
      <style jsx global>{`
        .card {
          background: rgba(255,255,255,0.04);
          border: 1px solid rgba(255,255,255,0.10);
          border-radius: 16px;
        }
        .row { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
        .label { opacity: 0.8; font-size: 13px; }
        .btn {
          padding: 9px 12px;
          border-radius: 12px;
          border: 1px solid rgba(255,255,255,0.16);
          background: rgba(255,255,255,0.06);
          font-weight: 800;
        }
        .btn:disabled { opacity: 0.55; cursor: not-allowed; }
        .select, .input {
          padding: 9px 10px;
          border-radius: 12px;
          border: 1px solid rgba(255,255,255,0.16);
          background: rgba(0,0,0,0.35);
          color: #fff;
        }
        .grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(320px, 1fr));
  gap: 14px;
  align-items: start;
}
@media (max-width: 1180px) {
  .grid { grid-template-columns: repeat(2, minmax(280px, 1fr)); }
}
@media (max-width: 820px) {
  .grid { grid-template-columns: 1fr; }
}
.spacer {
  height: 0;
  padding: 0;
  margin: 0;
  border: 0;
  visibility: hidden;
}
        .pitch { padding: 12px; }
        .pitchHead { display: flex; justify-content: space-between; align-items: center; gap: 10px; }
        .badge {
          font-size: 12px;
          padding: 5px 10px;
          border-radius: 999px;
          border: 1px solid rgba(255,255,255,0.16);
          background: rgba(255,255,255,0.06);
          font-weight: 800;
        }
        .field {
  margin-top: 10px;
  border-radius: 18px;
  padding: 10px;
  background:
    radial-gradient(120% 120% at 50% 0%, rgba(255,255,255,0.10), rgba(0,0,0,0.35)),
    linear-gradient(90deg, rgba(255,255,255,0.06) 0%, rgba(255,255,255,0.00) 18%, rgba(255,255,255,0.06) 36%, rgba(255,255,255,0.00) 54%, rgba(255,255,255,0.06) 72%, rgba(255,255,255,0.00) 90%),
    linear-gradient(180deg, rgba(0,0,0,0.20), rgba(0,0,0,0.45)),
    #0b5a2a;
  border: 1px solid rgba(255,255,255,0.12);
  position: relative;
  overflow: hidden;
}
.fieldLines {
  position: absolute;
  inset: 10px;
  width: calc(100% - 20px);
  height: calc(100% - 20px);
  pointer-events: none;
  stroke: rgba(255,255,255,0.48);
  stroke-width: 0.95;
  fill: none;
  opacity: 0.82;
  z-index: 4;
}
        .fieldGrid {
          position: relative;
          z-index: 2;
          display: grid;
          grid-template-columns: 1fr 1fr;
          grid-template-rows: 1fr 1fr;
          gap: 0px;
          height: 180px;
          border-radius: 14px;
          overflow: hidden;
          border: 1px solid rgba(255,255,255,0.12);
          touch-action: none;
        }
@media (max-width: 820px) {
  .fieldGrid { height: 150px; }
}
        .cell {
  border-radius: 0px;
  border: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 10px;
  text-align: center;
  font-size: 12px;
  position: relative;
  overflow: hidden;
  user-select: none;
  box-shadow: inset 0 0 0 1px rgba(255,255,255,0.10);
}
.cell.free {
  background: rgba(0,0,0,0.10);
  cursor: grab;
}
.cell.booked {
  background-color: var(--team-fill);
  background-image:
    repeating-linear-gradient(135deg, rgba(255,255,255,0.12) 0 12px, rgba(255,255,255,0.00) 12px 24px);
  cursor: pointer;
}
.cell.sel {
  outline: 3px solid rgba(90,200,255,0.75);
  outline-offset: -3px;
}
.freeText {
  opacity: 0.55;
  font-weight: 800;
  letter-spacing: 0.2px;
}
.cellLabel {
  font-weight: 900;
  line-height: 1.15;
  text-shadow: 0 1px 1px rgba(0,0,0,0.55);
}

.labelLayer {
  position: absolute;
  inset: 0;
  z-index: 3; /* above booked fills, below field lines */
  display: grid;
  grid-template-columns: 1fr 1fr;
  grid-template-rows: 1fr 1fr;
  pointer-events: none;
}
.groupLabel {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 10px;
  text-align: center;
}
.groupPill {
  display: inline-block;
  padding: 8px 12px;
  border-radius: 999px;
  background: rgba(0,0,0,0.28);
  border: 1px solid rgba(255,255,255,0.20);
  box-shadow: 0 8px 18px rgba(0,0,0,0.45);
  font-weight: 950;
  line-height: 1.15;
  text-shadow: 0 1px 1px rgba(0,0,0,0.55);
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
}

        .cell .del {
          position: absolute;
          top: 6px;
          right: 6px;
          font-size: 11px;
          padding: 2px 8px;
          border-radius: 999px;
          border: 1px solid rgba(255,255,255,0.20);
          background: rgba(0,0,0,0.40);
          opacity: 0;
          transition: opacity 120ms ease;
        }
        .cell:hover .del { opacity: 1; }
        .slotRow {
          margin-top: 14px;
        }

        /* Time label sits in the "empty" grid spot above the first card of the 2nd row */
        .timeCard {
          display: flex;
          align-items: flex-start;
          justify-content: flex-start;
          font-weight: 900;
          opacity: 0.9;
          padding-top: 52px;
          padding-left: 2px;
          font-size: 16px;
        }
        @media (max-width: 880px) {
          .timeCard {
            padding-top: 0;
            font-size: 15px;
          }
        }
      

/* ---------- Print ---------- */
.print-only { display: none; }

@page { margin: 10mm 10mm 12mm 10mm; }

@media print {
  html, body {
    background: #fff !important;
    color: #000 !important;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }

  /* Print ONLY the plan area */
  body * { visibility: hidden !important; }
  .print-area, .print-area * { visibility: visible !important; }
  .print-area {
    position: absolute;
    left: 0;
    top: 0;
    width: 100%;
  }

  .print-only { display: block !important; }

  .printHeader { margin: 0 0 6mm 0; }
  .printHeaderTop {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 10mm;
  }
  .printTitle { font-size: 14pt; font-weight: 950; }
  .printMeta { font-size: 9pt; opacity: 0.75; white-space: nowrap; }
  .printDay { margin-top: 2mm; font-size: 16pt; font-weight: 950; }

  /* One slot per page */
  .slotRow {
    break-after: page;
    page-break-after: always;
    margin-top: 0 !important;
  }
  .slotRow:last-child {
    break-after: auto;
    page-break-after: auto;
  }

  /* Slot grid layout:
     1) time column (spans 2 rows)
     2) bottom-left pitch (2nd row only)
     3) top+bottom middle pitch
     4) top+bottom right pitch
  */
  .slotRow .grid {
    display: grid !important;
    grid-template-columns: 28mm 54mm 48mm 48mm !important;
    grid-template-rows: auto auto !important;
    gap: 4mm !important;
    align-items: start !important;
  }

  /* Children: [1]=time, [2]=pitch1, [3]=pitch2, [4]=pitch3, [5]=pitch4, [6]=pitch5 */
  .slotRow .grid > :nth-child(1) { grid-column: 1; grid-row: 1 / span 2; }
  .slotRow .grid > :nth-child(2) { grid-column: 3; grid-row: 1; }
  .slotRow .grid > :nth-child(3) { grid-column: 4; grid-row: 1; }
  .slotRow .grid > :nth-child(4) { grid-column: 2; grid-row: 2; }
  .slotRow .grid > :nth-child(5) { grid-column: 3; grid-row: 2; }
  .slotRow .grid > :nth-child(6) { grid-column: 4; grid-row: 2; }

  .timeCard {
    padding-top: 0 !important;
    padding-left: 0 !important;
    font-size: 18pt !important;
    font-weight: 950 !important;
    opacity: 1 !important;
  }

  /* Light theme for cards + pitch */
  main { background: #fff !important; }
  .card {
    background: #fff !important;
    color: #000 !important;
    border: 1px solid #999 !important;
    box-shadow: none !important;
  }
  .badge {
    border: 1px solid #999 !important;
    background: #fff !important;
    color: #000 !important;
  }
  .pitch { padding: 6px !important; }
  .pitchHead { gap: 6px !important; }
  .pitchHead > div > div:first-child { font-size: 10pt !important; }
  .pitchHead > div > div:last-child { font-size: 8pt !important; opacity: 0.75 !important; }

  .field {
    background: #fff !important;
    border: 1px solid #999 !important;
  }
  .fieldLines {
    stroke: rgba(0,0,0,0.55) !important;
    opacity: 1 !important;
  }
  .fieldGrid {
    height: 34mm !important;
    border: 1px solid #bdbdbd !important;
  }

  .cell {
    box-shadow: inset 0 0 0 1px #c8c8c8 !important;
    font-size: 8pt !important;
    color: #000 !important;
    text-shadow: none !important;
  }
  .cell.free { background: #fff !important; }
  .freeText { opacity: 0.55 !important; color: #000 !important; }
  .cell.booked {
    background-color: #e6e6e6 !important;
    background-image: repeating-linear-gradient(
      135deg,
      rgba(0,0,0,0.10) 0 10px,
      rgba(0,0,0,0.00) 10px 20px
    ) !important;
  }
  .cell .del { display: none !important; }

  .groupPill {
    background: rgba(255,255,255,0.92) !important;
    border: 1px solid #999 !important;
    box-shadow: none !important;
    color: #000 !important;
    text-shadow: none !important;
    font-size: 8pt !important;
  }
}

`}</style>

      <div className="row no-print" style={{ justifyContent: "space-between", marginBottom: 10 }}>
        <div style={{ fontSize: 26, fontWeight: 950 }}>Trainings‑Verteilung</div>
        <div style={{ opacity: 0.8, fontSize: 13 }}>
          {totals.pitches} Felder • {totals.slots} Slots • {totals.bookings} Belegungen
        </div>
      </div>

      <div className="card no-print" style={{ padding: 14 }}>
        <div className="row" style={{ justifyContent: "space-between" }}>
          <div className="row">
            <button className="btn" disabled={busy} onClick={() => setSelectedDate((d) => addDaysYMD(d, -1))}>
              ←
            </button>
            <input
              className="input"
              type="date"
              value={selectedDate}
              onChange={(e) => setSelectedDate(e.target.value)}
              style={{ minWidth: 160 }}
            />
            <button className="btn" disabled={busy} onClick={() => setSelectedDate((d) => addDaysYMD(d, +1))}>
              →
            </button>
            <span className="badge">{weekdayNameDE(weekday)}</span>
          </div>

          <div className="row" style={{ gap: 8 }}>
            <button className="btn" disabled={busy} onClick={goStart}>
              Start
            </button>
          </div>
        </div>

        {(error || info) && (
          <div style={{ marginTop: 12, whiteSpace: "pre-wrap" }}>
            {error && <div style={{ color: "#ff6b6b", fontWeight: 800 }}>{error}</div>}
            {info && <div style={{ color: "#7CFFB2", fontWeight: 800 }}>{info}</div>}
          </div>
        )}
      </div>

      <div className="card no-print" style={{ padding: 14, marginTop: 12 }}>
        <div style={{ fontWeight: 900, marginBottom: 10 }}>Belegung hinzufügen</div>
        <div className="row">
          <div className="row">
            <span className="label">Team</span>
            <select className="select" value={teamId} onChange={(e) => setTeamId(e.target.value)}>
              {teams.length ? (
                teams.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))
              ) : (
                <option value="">(keine Teams gefunden)</option>
              )}
            </select>
          </div>
          <div className="row">
            <span className="label">Feld</span>
            <select className="select" value={pitchId} onChange={(e) => setPitchId(e.target.value)}>
              {pitches.length ? (
                pitches
                  .slice()
                  .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
                  .map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} ({p.surface === "KUNSTRASEN" ? "K" : "R"})
                    </option>
                  ))
              ) : (
                <option value="">(keine Plätze gefunden)</option>
              )}
            </select>
          </div>

          <div className="row">
            <span className="label">Slot</span>
            <select className="select" value={slotId} onChange={(e) => setSlotId(e.target.value)}>
              <option value="">Slot wählen…</option>
              {daySlots.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </select>
          </div>

          <div className="row">
            <span className="label">Bedarf</span>
            <select className="select" value={quarters} onChange={(e) => setQuarters(Number(e.target.value))}>
              <option value={1}>1/4</option>
              <option value={2}>2/4</option>
              <option value={3}>3/4</option>
              <option value={4}>4/4</option>
            </select>
          </div>

          <div className="row">
            <span className="label">Wiederholung</span>
            <select className="select" value={repeatWeeks} onChange={(e) => setRepeatWeeks(Number(e.target.value))}>
              <option value={0}>Einmalig (nur {fmtDateDE(selectedDate)})</option>
              <option value={1}>Jede Woche</option>
              <option value={2}>Jeden 2. {weekdayNameDE(weekday)}</option>
              <option value={3}>Alle 3 Wochen</option>
              <option value={4}>Alle 4 Wochen</option>
            </select>
          </div>

          {repeatWeeks !== 0 && (
            <div className="row">
              <span className="label">bis</span>
              <input className="input" type="date" value={untilDate} onChange={(e) => setUntilDate(e.target.value)} />
            </div>
          )}

          <button className="btn" disabled={busy || !slotId} onClick={addBooking}>
            Hinzufügen
          </button>

          {repeatWeeks !== 0 && <div style={{ opacity: 0.75, fontSize: 12 }}>Vorschau: {previewCount} Termine</div>}
        </div>

        <div className="row" style={{ marginTop: 10 }}>
          <span className="label">Notiz</span>
          <input
            className="input"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="optional (z.B. Trainer / Hinweis)"
            style={{ minWidth: 320, flex: "1 1 320px" }}
          />
        </div>
      </div>

      <div className="print-area">


        <div className="print-only printHeader">


          <div className="printHeaderTop">


            <div className="printTitle">Trainings‑Verteilung</div>


            <div className="printMeta">{totals.pitches} Felder • {totals.slots} Slots • {totals.bookings} Belegungen</div>


          </div>


          <div className="printDay">{weekdayNameDE(weekday)} – Übersicht ({fmtDateDE(selectedDate)})</div>


        </div>



        <div className="no-print" style={{ marginTop: 14, opacity: 0.85, fontWeight: 900 }}>


          {weekdayNameDE(weekday)} – Übersicht ({fmtDateDE(selectedDate)})


        </div>



        {daySlots.length === 0 ? (
        <div style={{ marginTop: 10, opacity: 0.8 }}>
          Für diesen Wochentag sind keine Slots in <code>training_slots</code> gepflegt.
        </div>
      ) : (
        daySlots.map((slot) => (
          <div key={slot.id} className="slotRow">
            <div className="grid">
              {(() => {
                const sortedPitches = pitches.slice().sort((a, b) => a.sort_order - b.sort_order);
                // Insert a "time label" cell as the first grid item so the 5 pitches render as 2 + 3,
                // with the time sitting above the first card of the 2nd row (like in the old layout).
                const items: any[] = [{ __time: true }, ...sortedPitches];
                return items.map((p: any) => {
                  if (p && p.__time) {
                    return (
                      <div key={`time-${slot.id}`} className="timeCard">
                        {slot.label}
                      </div>
                    );
                  }

                  const key = `${p.id}__${slot.id}`;
                  const list = bookingsByPitchSlot.get(key) || [];
                  const used = list.reduce((s, b) => s + b.quarters, 0);
                  const { cellToBooking, byBooking } = assignCells(list);
                  const bookingMap = new Map(list.map((b) => [b.id, b] as const));

                  const selectingHere = !!dragSel && dragSel.pitchId === p.id && dragSel.slotId === slot.id;
                  const dragCells = selectingHere ? rectCells(dragSel.start, dragSel.current) : [];


                  return (
                    <div key={p.id} className="card pitch">
                      <div className="pitchHead">
                        <div>
                          <div style={{ fontWeight: 950, fontSize: 16 }}>{p.name}</div>
                          <div style={{ opacity: 0.75, fontSize: 12 }}>
                            {p.surface === "KUNSTRASEN" ? "Kunstrasen" : "Rasen"} • Kapazität {used}/{p.capacity_quarters}
                          </div>
                        </div>
                        <div className="badge">{used}/{p.capacity_quarters}</div>
                      </div>

                      <div className="field">
                        <svg className="fieldLines" viewBox="0 0 100 60" preserveAspectRatio="none" aria-hidden="true">
                          {/* Outer border aligned to the edge so bookings never appear "outside" the line */}
                          <rect x="0.8" y="0.8" width="98.4" height="58.4" rx="2" ry="2" />
                          <line x1="50" y1="2" x2="50" y2="58" />
                          <circle cx="50" cy="30" r="7" />
                          <circle cx="50" cy="30" r="0.8" fill="rgba(255,255,255,0.55)" stroke="none" />
                          <rect x="2" y="18" width="12" height="24" />
                          <rect x="86" y="18" width="12" height="24" />
                          <rect x="2" y="24" width="4" height="12" />
                          <rect x="94" y="24" width="4" height="12" />
                        </svg>

                        <div
                          className="fieldGrid"
                          onPointerMove={(e) => {
                            if (!selectingHere) return;
                            const el = (document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null)?.closest?.(
                              "[data-cell-idx]"
                            ) as HTMLElement | null;
                            if (!el) return;
                            const idxStr = (el.dataset as any).cellIdx;
                            const nextIdx = Number(idxStr);
                            if (!Number.isFinite(nextIdx)) return;
                            setDragSel((prev) => {
                              if (!prev) return prev;
                              if (prev.pitchId !== p.id || prev.slotId !== slot.id) return prev;
                              if (prev.current === nextIdx) return prev;
                              return { ...prev, current: nextIdx };
                            });
                          }}
                          onPointerUp={(e) => {
                            if (!selectingHere) return;
                            e.preventDefault();
                            const cells = dragCells;
                            const anyBusy = cells.some((i) => !!cellToBooking[i]);
                            if (anyBusy) {
                              setError("Der ausgewählte Bereich enthält bereits belegte Viertel.");
                              setDragSel(null);
                              return;
                            }
                            openBook(p.id, slot.id, cells);
                            setDragSel(null);
                          }}
                          onPointerCancel={() => {
                            if (selectingHere) setDragSel(null);
                          }}
                        >
                          <div className="labelLayer" aria-hidden="true">
                            {list.map((b) => {
                              const cells = byBooking[b.id] || [];
                              if (cells.length <= 1) return null;
                              const rc = cells.map((i) => idxToRC(i));
                              const r0 = Math.min(...rc.map((x) => x.r));
                              const r1 = Math.max(...rc.map((x) => x.r));
                              const c0 = Math.min(...rc.map((x) => x.c));
                              const c1 = Math.max(...rc.map((x) => x.c));
                              const lbl = `${b?.teams?.name || "Team"} (${b.quarters}/4)`;
                              return (
                                <div
                                  key={`lbl-${b.id}`}
                                  className="groupLabel"
                                  style={{
                                    gridRow: `${r0 + 1} / ${r1 + 2}`,
                                    gridColumn: `${c0 + 1} / ${c1 + 2}`,
                                  }}
                                >
                                  <span className="groupPill">{lbl}</span>
                                </div>
                              );
                            })}
                          </div>

                          {[0, 1, 2, 3].map((idx) => {
                            const bid = cellToBooking[idx];
                            const isSel = dragCells.includes(idx);

                            if (!bid) {
                              return (
                                <div
                                  key={idx}
                                  className={`cell free ${isSel ? "sel" : ""}`}
                                  data-cell-idx={idx}
                                  onPointerDown={(e) => {
                                    if (busy) return;
                                    // No pointer capture: we want hover/move events to hit other cells so drag-select works.
                                    setDragSel({ pitchId: p.id, slotId: slot.id, start: idx, current: idx });
                                  }}
                                >
                                  <span className="freeText">(Frei)</span>
                                </div>
                              );
                            }

                            const b = bookingMap.get(bid)!;
                            const cells = byBooking[bid] || [idx];
                            const isPrimary = cells[0] === idx;
                            const label = `${b?.teams?.name || "Team"} (${b.quarters}/4)`;
                            const tc = teamColorsMap.get(b.team_id) || teamColorsForId(b.team_id);

                            return (
                              <div
                                key={idx}
                                className={`cell booked ${isSel ? "sel" : ""}`}
                                data-cell-idx={idx}
                                style={{ ["--team-fill" as any]: tc.fill, ["--team-solid" as any]: tc.solid } as any}
                                title={b.series_id ? "Serienbuchung" : "Einzelbuchung"}
                                onClick={() => openCancel(b)}
                              >
                                {isPrimary ? (
                                  <>
                                    <span className="del">löschen</span>
                                    {cells.length === 1 && <div className="cellLabel">{label}</div>}
                                  </>
                                ) : (
                                  <div style={{ opacity: 0.0 }}>{label}</div>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    </div>
                  );
                });
              })()}
            </div>
          </div>
        ))
      )}

      </div>

      {cancelOpen && cancelBooking && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.65)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 16,
            zIndex: 50,
          }}
          onClick={() => {
            if (!busy) setCancelOpen(false);
          }}
        >
          <div className="card" style={{ width: "min(560px, 100%)", padding: 14 }} onClick={(e) => e.stopPropagation()}>
            <div style={{ fontSize: 18, fontWeight: 950 }}>Stornieren</div>
            <div style={{ opacity: 0.85, marginTop: 6 }}>
              {cancelBooking?.teams?.name || "Team"} • {fmtDateDE(cancelBooking.booking_date)} • {cancelBooking.quarters}/4
              {cancelBooking.series_id ? " • Serie" : " • Einzel"}
            </div>

            <div style={{ marginTop: 12 }}>
              <label style={{ display: "flex", gap: 10, alignItems: "center", cursor: "pointer" }}>
                <input type="radio" name="cmode" checked={cancelMode === "ONE"} onChange={() => setCancelMode("ONE")} />
                <div>
                  <div style={{ fontWeight: 900 }}>Nur diesen Termin</div>
                  <div style={{ opacity: 0.75, fontSize: 12 }}>Storniert genau diesen Tag.</div>
                </div>
              </label>

              {cancelBooking.series_id && (
                <>
                  <div style={{ height: 10 }} />
                  <label style={{ display: "flex", gap: 10, alignItems: "center", cursor: "pointer" }}>
                    <input
                      type="radio"
                      name="cmode"
                      checked={cancelMode === "SERIES_FROM"}
                      onChange={() => setCancelMode("SERIES_FROM")}
                    />
                    <div>
                      <div style={{ fontWeight: 900 }}>Serie ab diesem Termin beenden</div>
                      <div style={{ opacity: 0.75, fontSize: 12 }}>
                        Verkürzt die Serie (bis {fmtDateDE(addDaysYMD(cancelBooking.booking_date, -1))}) und storniert alle
                        zukünftigen Termine.
                      </div>
                    </div>
                  </label>
                  <div style={{ height: 10 }} />
                  <label style={{ display: "flex", gap: 10, alignItems: "center", cursor: "pointer" }}>
                    <input
                      type="radio"
                      name="cmode"
                      checked={cancelMode === "SERIES_ALL"}
                      onChange={() => setCancelMode("SERIES_ALL")}
                    />
                    <div>
                      <div style={{ fontWeight: 900 }}>Serie komplett stornieren</div>
                      <div style={{ opacity: 0.75, fontSize: 12 }}>Alle Termine der Serie werden storniert.</div>
                    </div>
                  </label>
                </>
              )}
            </div>

            <div className="row" style={{ justifyContent: "flex-end", marginTop: 14 }}>
              <button className="btn" disabled={busy} onClick={() => setCancelOpen(false)}>
                Abbrechen
              </button>
              <button className="btn" disabled={busy} onClick={doCancel} style={{ background: "rgba(255,107,107,0.18)" }}>
                Stornieren
              </button>
            </div>
          </div>
        </div>
      )}

      
{bookOpen && (
  <div
    style={{
      position: "fixed",
      inset: 0,
      background: "rgba(0,0,0,0.65)",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      padding: 16,
      zIndex: 60,
    }}
    onClick={() => {
      if (!busy) setBookOpen(false);
    }}
  >
    <div className="card" style={{ width: "min(620px, 100%)", padding: 14 }} onClick={(e) => e.stopPropagation()}>
      <div style={{ fontSize: 18, fontWeight: 950 }}>Buchen</div>
      <div style={{ opacity: 0.85, marginTop: 6 }}>
        {(pitches.find((x) => x.id === bookPitchId)?.name || "Feld")} • {(slots.find((s) => s.id === bookSlotId)?.label || "Slot")} • {fmtDateDE(selectedDate)} • {bookQuarters}/4
        {bookRepeatWeeks ? " • Serie" : ""}
      </div>

      <div style={{ marginTop: 12 }} className="row">
        <span className="label">Team</span>
        <select className="select" value={bookTeamId} onChange={(e) => setBookTeamId(e.target.value)}>
          {teams.length ? (
            teams.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))
          ) : (
            <option value="">(keine Teams gefunden)</option>
          )}
        </select>

        <span className="label">Bedarf</span>
        <select className="select" value={bookQuarters} onChange={(e) => setBookQuarters(Number(e.target.value))}>
          <option value={1}>1/4</option>
          <option value={2}>2/4</option>
          <option value={3}>3/4</option>
          <option value={4}>4/4</option>
        </select>
      </div>

      <div className="row" style={{ marginTop: 10 }}>
        <span className="label">Wiederholung</span>
        <select className="select" value={bookRepeatWeeks} onChange={(e) => setBookRepeatWeeks(Number(e.target.value))}>
          <option value={0}>Einmalig (nur {fmtDateDE(selectedDate)})</option>
          <option value={1}>Jede Woche</option>
          <option value={2}>Jeden 2. {weekdayNameDE(weekday)}</option>
          <option value={3}>Alle 3 Wochen</option>
          <option value={4}>Alle 4 Wochen</option>
        </select>

        {bookRepeatWeeks !== 0 && (
          <>
            <span className="label">bis</span>
            <input className="input" type="date" value={bookUntilDate} onChange={(e) => setBookUntilDate(e.target.value)} />
          </>
        )}
      </div>

      <div className="row" style={{ marginTop: 10 }}>
        <span className="label">Notiz</span>
        <input className="input" value={bookNote} onChange={(e) => setBookNote(e.target.value)} placeholder="optional (z.B. Trainer / Hinweis)" style={{ flex: "1 1 320px", minWidth: 320 }} />
      </div>

      <div className="row" style={{ justifyContent: "flex-end", marginTop: 14 }}>
        <button className="btn" disabled={busy} onClick={() => setBookOpen(false)}>
          Abbrechen
        </button>
        <button className="btn" disabled={busy || !bookTeamId} onClick={confirmBook} style={{ background: "rgba(120,255,178,0.16)" }}>
          Buchen
        </button>
      </div>
    </div>
  </div>
)}
      <div className="no-print" style={{ marginTop: 14, opacity: 0.75, fontSize: 12 }}>
        Hinweis: Serienbuchungen erzeugen echte Termine in <code>bookings</code>. Einzeltermine aus einer Serie können separat
        storniert werden (Status <code>CANCELLED</code>), ohne die Serie zu löschen.
      </div>
    </main>
  );
}
