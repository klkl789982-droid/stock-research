"use client";
import { useState } from "react";
export default function AdminLogout() {
  const [pending, setPending] = useState(false), [failed, setFailed] = useState(false);
  async function logout() {
    setPending(true); setFailed(false);
    try {
      const response = await fetch("/api/auth/logout", { method: "POST", credentials: "same-origin", cache: "no-store" });
      if (!response.ok) throw new Error("LOGOUT_FAILED");
      window.location.replace("/login");
    } catch { setFailed(true); setPending(false); }
  }
  return <div className="ml-auto shrink-0 text-right"><button type="button" onClick={logout} disabled={pending} className="tb-focus rounded-lg border border-white/15 px-2.5 py-2 text-xs text-slate-200 hover:bg-white/10 disabled:opacity-50">{pending ? "로그아웃 중" : "로그아웃"}</button>{failed && <p role="alert" className="mt-1 text-[10px] text-orange-200">로그아웃 실패 · 다시 시도</p>}</div>;
}
