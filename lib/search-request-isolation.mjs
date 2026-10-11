export function searchApiErrorMessage(data, fallback) {
  if (!data || typeof data !== "object") return fallback;
  const error = data.error;
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && typeof error.message === "string") return error.message;
  return fallback;
}

export function selectVerifiedStock(items, selection, searchTerm) {
  const rows = Array.isArray(items) ? items : items ? [items] : [];
  const codeOf = (item) => String(item.srtnCd ?? "").replace(/^A(?=[0-9A-Z]{6}$)/u, "");
  if (selection) {
    if (!/^[0-9A-Z]{6}$/u.test(selection.code)) throw new Error("종목코드가 올바르지 않습니다.");
    const row = rows.find((item) => codeOf(item) === selection.code);
    if (!row) throw new Error("요청한 종목코드와 검색 결과가 일치하지 않습니다.");
    if (selection.name && row.itmsNm !== selection.name) throw new Error("선택한 종목명과 공식 종목정보가 다릅니다. 종목코드로 다시 확인해 주세요.");
    if (selection.market && selection.market !== "정보 없음" && row.mrktCtg !== selection.market) throw new Error("선택한 시장과 공식 종목정보가 일치하지 않습니다.");
    return row;
  }
  if (/^[0-9A-Z]{6}$/u.test(searchTerm)) return rows.find((item) => codeOf(item) === searchTerm) ?? null;
  return rows.find((item) => item.itmsNm === searchTerm) ?? rows[0] ?? null;
}

export async function settleSearchRequest(request, fallbackMessage) {
  try {
    const response = await request;
    let data;
    try {
      data = await response.json();
    } catch {
      return { status: "error", data: null, httpStatus: response.status, errorMessage: `${fallbackMessage} 응답을 해석하지 못했습니다.` };
    }
    if (!response.ok) {
      return {
        status: response.status === 404 ? "missing" : "error",
        data,
        httpStatus: response.status,
        errorMessage: searchApiErrorMessage(data, fallbackMessage),
      };
    }
    return { status: "success", data, httpStatus: response.status, errorMessage: null };
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    return { status: "unavailable", data: null, httpStatus: null, errorMessage: fallbackMessage };
  }
}
