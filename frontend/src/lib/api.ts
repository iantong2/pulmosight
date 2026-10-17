// Base URL for the FastAPI backend.
//
// When VITE_API_BASE_URL is set (e.g. http://127.0.0.1:8000) it is used as-is.
// When it is not set — the common local dev case — requests go to the same
// origin: Vite proxies /api to the backend during `npm run dev`, and in
// production the frontend and backend are served from the same instance.
// Leaving the base empty is important: interpolating an undefined env var used
// to produce "undefined/api/..." which the dev server answered with a 404.
const configuredBase = (import.meta.env.VITE_API_BASE_URL ?? "").trim();

export const API_BASE_URL = configuredBase.replace(/\/+$/, "");

export const apiUrl = (path: string): string =>
  `${API_BASE_URL}${path.startsWith("/") ? path : `/${path}`}`;

/**
 * Extract a readable error message from a failed response. FastAPI returns
 * `{"detail": "..."}`, but proxies and dev servers may return HTML, which we
 * turn into a short message instead of dumping markup into the UI.
 */
export const readErrorMessage = async (
  res: Response,
  fallback: string,
): Promise<string> => {
  const body = (await res.text().catch(() => "")).trim();
  if (!body) return `${fallback} (HTTP ${res.status})`;

  try {
    const parsed = JSON.parse(body) as {
      detail?: unknown;
      error?: unknown;
      message?: unknown;
    };
    const detail = parsed.detail ?? parsed.error ?? parsed.message;
    if (typeof detail === "string" && detail.trim()) return detail.trim();
  } catch {
    // Not JSON — fall through.
  }

  if (body.startsWith("<") || body.length > 300) {
    return `${fallback} (HTTP ${res.status})`;
  }

  return body;
};
