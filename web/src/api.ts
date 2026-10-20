import type {
  ApprovalDecision,
  AuthStatus,
  Message,
  NodeUpdate,
  NodeView,
  PairingCode,
  SecretName,
  SecretStatus,
  PostMessageBody,
  Project,
  ProjectUsage,
  RunnerMode,
  RuntimeError,
  RuntimeState,
  RuntimeUpdate,
  Thread,
  ThreadDetail,
} from '@ccf/shared';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: RuntimeError & Record<string, unknown>,
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
  const json = res.status === 204 ? {} : await res.json();
  if (res.status === 401 && (json as { error?: string }).error === 'login_required') onLoginRequired();
  if (!res.ok) throw new ApiError(res.status, json as RuntimeError & Record<string, unknown>);
  return json as T;
}

/** Another device's session expired or was signed out: the app shows the login screen. */
const loginListeners = new Set<() => void>();
function onLoginRequired() {
  loginListeners.forEach((l) => l());
}
export function subscribeLoginRequired(listener: () => void): () => void {
  loginListeners.add(listener);
  return () => loginListeners.delete(listener);
}

export const getRuntime = (refresh = false) =>
  request<RuntimeState>('GET', refresh ? '/api/runtime?refresh' : '/api/runtime');

export const putRuntime = (update: RuntimeUpdate) => request<RuntimeState>('PUT', '/api/runtime', update);

export const listProjects = () => request<Project[]>('GET', '/api/projects');
export const createProject = (body: { name: string; workspacePath?: string; repoUrl?: string; baseBranch?: string }) =>
  request<Project>('POST', '/api/projects', body);
export const listThreads = (projectId: string) => request<Thread[]>('GET', `/api/projects/${projectId}/threads`);
export const createThread = (projectId: string) => request<Thread>('POST', `/api/projects/${projectId}/threads`, {});
export const getThread = (id: string) => request<ThreadDetail>('GET', `/api/threads/${id}`);
export const postMessage = (id: string, body: PostMessageBody) =>
  request<Message>('POST', `/api/threads/${id}/messages`, body);
export const updateThreadSettings = (id: string, patch: { model?: string | null; thinking?: string | null }) =>
  request<Thread>('PATCH', `/api/threads/${id}`, patch);
export const interruptThread = (id: string) => request<{ ok: true }>('POST', `/api/threads/${id}/interrupt`);
export const getMemory = (projectId: string) => request<{ text: string }>('GET', `/api/projects/${projectId}/memory`);
export const putMemory = (projectId: string, text: string) =>
  request<{ text: string }>('PUT', `/api/projects/${projectId}/memory`, { text });
export const getUsage = (projectId: string) => request<ProjectUsage>('GET', `/api/projects/${projectId}/usage`);
export const resetCoordinator = (projectId: string) => request<Thread>('POST', `/api/projects/${projectId}/coordinator/reset`);
export const decideApproval = (id: string, decision: ApprovalDecision) =>
  request<{ ok: true }>('POST', `/api/approvals/${id}`, decision);

export const listNodes = () => request<NodeView[]>('GET', '/api/nodes');
export const updateNode = (id: string, update: NodeUpdate) => request<NodeView>('PATCH', `/api/nodes/${id}`, update);
export const removeNode = (id: string) => request<object>('DELETE', `/api/nodes/${id}`);
export const createPairing = () => request<PairingCode>('POST', '/api/nodes/pairing');

export const listSecrets = () => request<SecretStatus[]>('GET', '/api/secrets');
export const putSecret = (name: SecretName, value: string) => request<SecretStatus[]>('PUT', `/api/secrets/${name}`, { value });

export const getAuth = () => request<AuthStatus>('GET', '/api/auth/status');
export const login = (password: string) => request<AuthStatus>('POST', '/api/auth/login', { password });
export const logout = () => request<{ ok: true }>('POST', '/api/auth/logout');
export const setPassword = (password: string) => request<{ ok: true }>('PUT', '/api/auth/password', { password });

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
