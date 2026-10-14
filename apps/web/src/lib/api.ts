import type { ApiError } from '@hlcc/shared';

let csrfToken = '';
export const setCsrfToken = (t: string | undefined) => {
  csrfToken = t ?? '';
};

export class ApiRequestError extends Error {
  readonly status: number;
  readonly code: string;
  readonly issues: { path: string; message: string }[];

  constructor(
    status: number,
    code: string,
    message: string,
    issues: { path: string; message: string }[] = [],
  ) {
    super(message);
    this.status = status;
    this.code = code;
    this.issues = issues;
  }
}

export async function api<T>(
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<T> {
  const method = init.method ?? 'GET';
  let res: Response;
  try {
    res = await fetch(`/api/v1${path}`, {
      method,
      credentials: 'same-origin',
      headers: {
        ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(method !== 'GET' ? { 'x-csrf-token': csrfToken } : {}),
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    });
  } catch {
    throw new ApiRequestError(0, 'network', 'Cannot reach the API');
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as ApiError | null;
    throw new ApiRequestError(
      res.status,
      body?.error.code ?? 'http_error',
      body?.error.message ?? `Request failed (${res.status})`,
      body?.error.issues,
    );
  }
  return (await res.json()) as T;
}
