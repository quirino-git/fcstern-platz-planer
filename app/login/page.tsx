"use client";

import { useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import { useRouter } from "next/navigation";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [pw, setPw] = useState("");
  const [msg, setMsg] = useState<string | null>(null);

  async function signIn() {
    setMsg(null);
    const { error } = await supabase.auth.signInWithPassword({ email, password: pw });
    if (error) return setMsg(error.message);
    router.push("/plan");
  }

  async function signUp() {
    setMsg(null);
    const { error } = await supabase.auth.signUp({ email, password: pw });
    if (error) return setMsg(error.message);
    setMsg("Account erstellt. Falls Email-Bestätigung aktiv ist: bitte Mail bestätigen.");
  }

  return (
    <main style={{ padding: 20, maxWidth: 420 }}>
      <h1>Login</h1>

      <input
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        placeholder="E-Mail"
        style={{ width: "100%", marginBottom: 8 }}
      />
      <input
        value={pw}
        onChange={(e) => setPw(e.target.value)}
        placeholder="Passwort"
        type="password"
        style={{ width: "100%", marginBottom: 12 }}
      />

      <div style={{ display: "flex", gap: 8 }}>
        <button onClick={signIn}>Anmelden</button>
        <button onClick={signUp}>Registrieren</button>
      </div>

      {msg ? <p style={{ marginTop: 12 }}>{msg}</p> : null}
    </main>
  );
}
