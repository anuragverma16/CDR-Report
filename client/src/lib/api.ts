export class ApiError extends Error {
  status: number;
  details?: string[];
  constructor(message: string, status: number, details?: string[]) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const init: RequestInit = { method, credentials: 'include', headers: {} };
  if (body instanceof FormData) init.body = body;
  else if (body !== undefined) {
    init.body = JSON.stringify(body);
    (init.headers as Record<string, string>)['Content-Type'] = 'application/json';
  }
  const res = await fetch(`/api${path}`, init);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && path !== '/auth/login' && path !== '/auth/me') window.dispatchEvent(new Event('tdr:unauthorized'));
    throw new ApiError(data.error || `Request failed (${res.status})`, res.status, data.details);
  }
  return data as T;
}

export const api = {
  get: <T>(p: string) => request<T>('GET', p),
  post: <T>(p: string, b?: unknown) => request<T>('POST', p, b ?? {}),
  put: <T>(p: string, b?: unknown) => request<T>('PUT', p, b ?? {}),
  del: <T>(p: string) => request<T>('DELETE', p),
};

/** Download a protected file via fetch (keeps cookie auth) and save it with the server-provided name. */
export async function downloadFile(path: string, fallbackName: string) {
  const res = await fetch(`/api${path}`, { credentials: 'include' });
  if (!res.ok) {
    const j = await res.json().catch(() => ({}));
    throw new ApiError(j.error || `Download failed (${res.status})`, res.status);
  }
  const blob = await res.blob();
  const cd = res.headers.get('Content-Disposition') || '';
  const name = /filename="?([^";]+)"?/.exec(cd)?.[1] || fallbackName;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function errMsg(e: unknown) {
  if (e instanceof ApiError) return e.details?.length ? `${e.message}: ${e.details.join('; ')}` : e.message;
  return e instanceof Error ? e.message : String(e);
}
