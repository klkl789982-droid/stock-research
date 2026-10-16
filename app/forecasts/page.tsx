import type { Metadata } from "next";
import Link from "next/link";
import BrandMark from "../../components/BrandMark";
import AdminLogout from "../../components/AdminLogout";
import ForecastSwingPanel from "../../components/ForecastSwingPanel";

export const metadata: Metadata = {
  title: "5거래일 스윙 | Tight Budget",
  description: "저장 관측과 5거래일 스윙 예측의 준비 상태를 확인합니다.",
};

// The existing proxy protects this page. Data is fetched only from the guarded API.
export default function ForecastsPage() {
  return (
    <main className="min-h-screen bg-[#eceae4] text-[var(--tb-text)]">
      <header className="tb-brand-shell border-b border-white/10 text-white">
        <div className="mx-auto flex max-w-7xl items-center gap-4 px-4 py-3 sm:px-7">
          <Link href="/" prefetch={false} aria-label="Tight Budget 홈으로" className="rounded-lg"><BrandMark inverse /></Link>
          <span className="ml-auto hidden text-xs text-slate-300 sm:inline">리서치 워크스페이스</span>
          <AdminLogout />
        </div>
      </header>
      <div className="mx-auto max-w-7xl px-4 pb-14 pt-6 sm:px-7 sm:pt-8">
        <nav aria-label="현재 위치" className="mb-7 flex items-center gap-3 text-xs text-slate-500">
          <Link href="/" prefetch={false} className="rounded hover:text-slate-900">홈</Link>
          <span aria-hidden="true">/</span><span aria-current="page" className="text-slate-700">스윙 예측</span>
        </nav>
        <ForecastSwingPanel />
      </div>
    </main>
  );
}
