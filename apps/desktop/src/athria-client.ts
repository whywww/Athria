export interface AthriaClient {
  request<T>(path: string, init?: RequestInit): Promise<T>;
}

interface ServiceInfo { baseUrl: string; token: string }
type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

export class HttpAthriaClient implements AthriaClient {
  constructor(
    private readonly serviceInfo: () => Promise<ServiceInfo>,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const service = await this.serviceInfo();
    const response = await this.fetcher(`${service.baseUrl}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${service.token}`, "Content-Type": "application/json", ...init.headers },
    });
    const payload = await response.json() as { error?: { message?: string } };
    if (!response.ok) throw new Error(payload.error?.message ?? `Request failed with HTTP ${response.status}`);
    return payload as T;
  }
}

export class TauriAthriaClient implements AthriaClient {
  constructor(private readonly invoke: Invoke, private readonly fallback: AthriaClient) {}

  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    // Backup inspection still belongs to the desktop filesystem adapter. It
    // remains on the compatibility transport until that adapter is ported.
    if (path === "/api/system/backup/preview") return this.fallback.request<T>(path, init);
    const body = typeof init.body === "string" && init.body.length > 0 ? JSON.parse(init.body) as unknown : undefined;
    try {
      return await this.invoke<T>("athria_request", { method: init.method ?? "GET", path, body });
    } catch (error) {
      throw error instanceof Error ? error : new Error(String(error));
    }
  }
}
