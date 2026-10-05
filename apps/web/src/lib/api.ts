/**
 * The editor's one way to reach the API. Same origin — the API serves this bundle — so the session
 * cookie travels on its own: no CORS, no token in localStorage, nothing for a script to steal.
 */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers = new Headers();
  if (body !== undefined) headers.set('content-type', 'application/json');
  const res = await fetch(path, {
    method,
    headers,
    credentials: 'same-origin',
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  const parsed: unknown = text.length > 0 ? JSON.parse(text) : undefined;
  if (!res.ok) {
    const message =
      typeof parsed === 'object' && parsed !== null && 'error' in parsed
        ? String(parsed.error)
        : `request failed with ${String(res.status)}`;
    throw new ApiError(res.status, message, parsed);
  }
  return parsed as T;
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body ?? {}),
  put: <T>(path: string, body: unknown) => request<T>('PUT', path, body),
  del: (path: string) => request<undefined>('DELETE', path),
};

/** The first field error the server named, or its message. */
export function messageOf(error: unknown): string {
  if (error instanceof ApiError) {
    const fields = (error.body as { fields?: { path: string; message: string }[] } | undefined)?.fields;
    const first = fields?.[0];
    if (first !== undefined) return `${first.path === '' ? 'Value' : first.path}: ${first.message}`;
    return error.message.charAt(0).toUpperCase() + error.message.slice(1);
  }
  return 'Something went wrong. Try again.';
}

// ─── Session ───────────────────────────────────────────────────────────────

export interface Account {
  id: string;
  email: string;
  displayName: string;
  role: 'operator' | 'member';
}

export interface SignedIn {
  authenticated: true;
  account: Account;
  hasPassword: boolean;
  totpEnrolled: boolean;
  d3auth: { iss: string; email: string | null; linkedAt: string } | null;
  oidcAvailable: boolean;
}

export interface Anonymous {
  authenticated: false;
  oidcAvailable: boolean;
  setupRequired: boolean;
  /** Whether first-run setup asks for the server's SETUP_TOKEN. */
  setupTokenRequired: boolean;
}

export async function fetchSession(): Promise<SignedIn | Anonymous> {
  try {
    return await api.get<SignedIn>('/auth/session');
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      const body = error.body as Partial<Anonymous> | undefined;
      return {
        authenticated: false,
        oidcAvailable: body?.oidcAvailable ?? false,
        setupRequired: body?.setupRequired ?? false,
        setupTokenRequired: body?.setupTokenRequired ?? false,
      };
    }
    throw error;
  }
}

export type LoginResult = { status: 'signed_in' } | { status: 'totp_required' };

export function login(email: string, password: string, totpCode?: string): Promise<LoginResult> {
  return api.post<LoginResult>('/auth/login', {
    email,
    password,
    ...(totpCode === undefined || totpCode.length === 0 ? {} : { totpCode }),
  });
}

export async function logout(): Promise<void> {
  await api.post('/auth/logout');
}
