"use client";
import { useEffect, useState } from "react";

type Model = { model: string; modelVersion: string; collectionStartedAt?: string; collectionCompletedAt?: string; records: { ticker: string; companyName: string; rank: number; score: number }[] };
type Relay = { status: string; source: string; servedAt: string; freshnessStatus?: string; deliveryHash?: string; delivery: { signalDate?: string; exportedAt?: string; deliveryHash?: string; models: Model[] } | null };
const time = (value?: string) => value && Number.isFinite(Date.parse(value)) ? new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", dateStyle: "short", timeStyle: "medium" }).format(new Date(value)) + " KST" : "확인 불가";

export function PrivateLiveDeliveryView({ data, failed = false, disabled = false }: { data: Relay | null; failed?: boolean; disabled?: boolean }) {
  const [probe, setProbe] = useState("idle");
  if (disabled) return null;
  const fixture = data?.source === "privateRelayFixture", delivery = data?.delivery;
  async function verifyReader() {
    setProbe("checking");
    try {
      const response = await fetch("/api/private-live-delivery", { method: "POST", cache: "no-store", headers: { "Content-Type": "application/json" }, body: '{"action":"verify-read-only"}' });
      const result = await response.json();
      setProbe(response.ok && result.permissionStatus === "READ_OK_WRITE_DENIED" && result.writeDenied === true ? "verified" : "failed");
    } catch { setProbe("failed"); }
  }
  return <section className="tb-card min-w-0 p-4" aria-label="비공개 저장소 전달 결과">
    <h2 className="text-base font-semibold">{fixture ? "합성 자료 · 비공개 연결 검증" : "비공개 LIVE 저장 순위 · 14:00"}</h2>
    {!delivery ? <p role="status" className="mt-2 text-sm text-slate-600">{failed ? "비공개 결과 조회 실패 · 마지막 결과와 최신 상태를 확인할 수 없습니다." : data ? "아직 전달된 14:00 관측 결과가 없습니다. 운영 연결·관측 대기 중입니다." : "인증된 저장 결과 확인 중"}</p> : <>
      <p className="mt-1 text-xs text-slate-600">{fixture ? "실제 시세·모델 순위·14:00 관측이 아닙니다. 공식 EOD와 성과 계산에 사용하지 않습니다." : `관측 기준일 ${delivery.signalDate} · ${data?.freshnessStatus === "HISTORICAL" ? "이전 날짜 저장 기록 · 현재 거래일의 정상 관측으로 표시하지 않습니다." : "저장된 관측 결과 · 거래일 최신성은 별도 확인이 필요합니다."}`}</p>
      {!fixture && <dl className="mt-2 grid gap-1 text-xs text-slate-600 sm:grid-cols-2"><div><dt>분석 기준</dt><dd>{delivery.signalDate} 14:00 KST</dd></div><div><dt>실제 관측 구간</dt><dd>{time(delivery.models[0]?.collectionStartedAt)} ~ {time(delivery.models[0]?.collectionCompletedAt)}</dd></div><div><dt>전달 파일 생성</dt><dd>{time(delivery.exportedAt)}</dd></div><div><dt>사이트 조회</dt><dd>{time(data?.servedAt)}</dd></div></dl>}
      <div className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">{delivery.models.map(model => <article key={model.model} className="min-w-0 rounded-lg bg-[#f7f3eb] p-3"><h3 className="text-sm font-semibold">{model.model} · TOP5</h3><ol className="mt-2 space-y-2 text-xs">{model.records.map(row => <li key={row.ticker} className="flex justify-between gap-2"><span className="min-w-0 break-words">{row.rank}. {row.companyName}<span className="block text-slate-500">{row.ticker}</span></span><span className="tabular-nums">{row.score.toFixed(2)}</span></li>)}</ol></article>)}</div>
      <details className="mt-3 text-xs text-slate-600"><summary className="tb-focus cursor-pointer rounded">전달 무결성 확인</summary><p className="mt-2 break-all">SHA256 {data?.deliveryHash ?? delivery.deliveryHash}</p><p>인증 API 조회 시각 {time(data?.servedAt)} · 관측 시각과 다름</p></details>
      {fixture && <div className="mt-3 text-xs"><button type="button" disabled={probe === "checking" || probe === "verified"} onClick={() => void verifyReader()} className="tb-focus rounded border px-3 py-2 disabled:opacity-60">읽기 전용 권한 검증</button><p role="status" className="mt-1 text-slate-600">{probe === "verified" ? "원격 읽기·해시 일치 / 테스트 쓰기 403 차단 확인" : probe === "checking" ? "테스트 경로에서만 권한 확인 중" : probe === "failed" ? "읽기 전용 권한 미검증 · 설정 확인 필요" : "합성 테스트 경로에 1회 생성 요청을 보내 쓰기 거부를 확인합니다. 운영 경로는 변경하지 않습니다."}</p></div>}
    </>}
  </section>;
}

export default function PrivateLiveDeliveryPanel() {
  const [state, setState] = useState<{ data: Relay | null; failed: boolean; disabled: boolean }>({ data: null, failed: false, disabled: false });
  useEffect(() => {
    const controller = new AbortController(); let busy = false;
    async function load() {
      if (busy) return; busy = true;
      try {
        const response = await fetch("/api/private-live-delivery", { cache: "no-store", signal: controller.signal });
        if (!response.ok) { if (!controller.signal.aborted) setState({ data: null, failed: response.status !== 404, disabled: response.status === 404 }); return; }
        const data = await response.json();
        if (!controller.signal.aborted) setState({ data, failed: false, disabled: false });
      } catch { if (!controller.signal.aborted) setState({ data: null, failed: true, disabled: false }); }
      finally { busy = false; }
    }
    void load(); const timer = setInterval(() => void load(), 60000);
    return () => { controller.abort(); clearInterval(timer); };
  }, []);
  return <PrivateLiveDeliveryView {...state} />;
}
