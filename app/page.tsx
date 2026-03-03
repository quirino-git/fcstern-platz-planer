import Link from "next/link";

export default function Home() {
  return (
    <main style={{ padding: 24 }}>
      <h1 style={{ fontSize: 24, fontWeight: 800, margin: 0 }}>Platz‑Planner</h1>
      <p style={{ opacity: 0.8, marginTop: 8 }}>
        Trainings‑Verteilung nach Feld, Zeit und Viertel‑Kapazität.
      </p>

      <div style={{ marginTop: 16 }}>
        <Link href="/plan" style={{ textDecoration: "underline" }}>
          → Zur Plan‑Ansicht
        </Link>
      </div>

      <div style={{ marginTop: 18, opacity: 0.75, fontSize: 13 }}>
        Tipp: Lege Teams in Supabase in der Tabelle <code>teams</code> an. Felder und Slots werden per SQL Seed erstellt.
      </div>
    </main>
  );
}
