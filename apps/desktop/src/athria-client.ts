export interface AthriaClient {
  request<T>(path: string, init?: RequestInit): Promise<T>;
}

type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

export class TauriAthriaClient implements AthriaClient {
  constructor(private readonly invoke: Invoke) {}

  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const body = typeof init.body === "string" && init.body.length > 0 ? JSON.parse(init.body) as unknown : undefined;
    try {
      return await this.invoke<T>("athria_request", { method: init.method ?? "GET", path, body });
    } catch (error) {
      throw error instanceof Error ? error : new Error(String(error));
    }
  }
}
