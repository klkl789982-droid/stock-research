import { withAdminAccess } from "@/lib/admin-access";
import { authConfig, createRedisCommand, sameOriginMutation } from "@/lib/admin-auth.mjs";
import { normalizeStockCode } from "@/lib/stock-code.mjs";
import { getWatchlistMarket } from "@/lib/watchlist-market.mjs";
import { createWatchlistStore, WATCHLIST_LIMIT } from "@/lib/watchlist.mjs";

type Member = { code: string; name: string; market: string };
type Model = { rank: number | null; score: number | null };
type Row = Member & { date: string; close: number | null; closeChangePct: number | null; models: Record<string, Model> | null };
const fail = (status: number, message: string) => Response.json({ message }, { status });

async function handleGet(request: Request) {
  const params = new URL(request.url).searchParams;
  if ([...params.keys()].some(k => k !== "search") || params.getAll("search").length > 1) return fail(400, "지원하지 않는 조회 조건입니다.");
  try {
    if (params.has("search")) {
      const value = (params.get("search") ?? "").trim().toUpperCase();
      if (!value || value.length > 64) return fail(400, "종목명 또는 코드를 입력해 주세요.");
      const market: Map<string, Row> = await getWatchlistMarket();
      const matches = [...market.values()].filter(row => row.code.includes(value) || row.name.toUpperCase().includes(value))
        .sort((a, b) => Number(b.code === value || b.name.toUpperCase() === value) - Number(a.code === value || a.name.toUpperCase() === value) ||
          a.name.localeCompare(b.name, "ko") || a.code.localeCompare(b.code));
      return Response.json({ candidates: matches.slice(0, 15).map(({ code, name, market }) => ({ code, name, market })), total: matches.length });
    }
    const config = authConfig();
    const members: Member[] = await createWatchlistStore(config, createRedisCommand(config)).list();
    if (!members.length) return Response.json({ items: [], marketAvailable: true, limit: WATCHLIST_LIMIT });
    const market: Map<string, Row> | null = await getWatchlistMarket().catch(() => null);
    return Response.json({ items: members.map(member => market?.get(member.code) ?? { ...member, date: null, close: null, closeChangePct: null, models: null }),
      marketAvailable: market !== null, limit: WATCHLIST_LIMIT });
  } catch { return fail(503, "관심종목 자료를 불러올 수 없습니다. 잠시 후 다시 시도해 주세요."); }
}

async function changeMember(request: Request) {
  try {
    const config = authConfig();
    if (!sameOriginMutation(request, config)) return fail(403, "현재 사이트에서 다시 시도해 주세요.");
    if (new URL(request.url).search || !request.headers.get("content-type")?.startsWith("application/json")) return fail(400, "올바른 종목을 선택해 주세요.");
    const input = await request.json().catch(() => null);
    const code = normalizeStockCode(input?.code);
    if (!code || code !== input.code || Object.keys(input).length !== 1) return fail(400, "올바른 종목을 선택해 주세요.");
    const store = createWatchlistStore(config, createRedisCommand(config));
    if (request.method === "DELETE") {
      await store.remove(code);
      return Response.json({ code, saved: false });
    }
    const row = (await getWatchlistMarket()).get(code);
    if (!row) return fail(404, "현재 분석 대상에서 이 종목을 찾을 수 없습니다.");
    if (await store.add(row) === -1) return fail(409, `관심종목은 최대 ${WATCHLIST_LIMIT}개까지 저장할 수 있습니다.`);
    return Response.json({ code, saved: true });
  } catch { return fail(503, "관심종목을 저장할 수 없습니다. 목록을 다시 확인해 주세요."); }
}

export const GET = withAdminAccess(handleGet);
export const PUT = withAdminAccess(changeMember);
export const DELETE = withAdminAccess(changeMember);
