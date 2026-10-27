export function jsonResponse(
  value: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

export class FakeSocket {
  static instances: FakeSocket[] = [];
  readyState = 1;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  closed = false;

  readonly url: string;

  constructor(url: string) {
    this.url = url;
    FakeSocket.instances.push(this);
  }

  sendMessage(message: unknown): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.readyState = 3;
    this.onclose?.({ code: 1000 });
  }

  static reset(): void {
    FakeSocket.instances = [];
  }
}
