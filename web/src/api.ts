import type { RunnerMode, RuntimeError, RuntimeState, RuntimeUpdate } from '@ccf/shared';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: RuntimeError,
  ) {
    super(body.reason ? `${body.error} ${body.reason}` : body.error);
  }
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json();
  if (!res.ok) throw new ApiError(res.status, json as RuntimeError);
  return json as T;
}

export const getRuntime = (refresh = false) =>
  request<RuntimeState>('GET', refresh ? '/api/runtime?refresh' : '/api/runtime');

export const putRuntime = (update: RuntimeUpdate) => request<RuntimeState>('PUT', '/api/runtime', update);

export const MODE_LABEL: Record<RunnerMode, string> = {
  subscription: 'Subscription: your Claude plan',
  api: 'API: metered billing',
};

/** One sentence on what a switch means for the bill. */
export const BILLING_CONSEQUENCE: Record<RunnerMode, string> = {
  subscription:
    'New runs will use your Claude plan through your signed-in claude CLI and count toward its usage limits, not your API account.',
  api: 'New runs will be billed to the ANTHROPIC_API_KEY account at metered API rates.',
};
