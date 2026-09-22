export function searchApiErrorMessage(data, fallback) {
  if (!data || typeof data !== "object") return fallback;
  const error = data.error;
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && typeof error.message === "string") return error.message;
  return fallback;
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
