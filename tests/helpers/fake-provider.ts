import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';

export type FakeProviderRequest = {
  request: IncomingMessage;
  body: string;
  respond(status: number, headers: Record<string, string>, body: string): void;
  disconnect(): void;
};

/** Loopback-only HTTP fixture. Every accepted request waits for an explicit response. */
export async function createFakeProvider() {
  const requests: FakeProviderRequest[] = [];
  const waiting: Array<(request: FakeProviderRequest) => void> = [];
  const pending = new Set<ServerResponse>();
  let accepted = 0;
  const server = createServer((request, response) => {
    accepted++;
    pending.add(response);
    response.once('close', () => pending.delete(response));
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => { body += chunk; });
    request.once('end', () => {
      const item: FakeProviderRequest = {
        request, body,
        respond(status, headers, content) { response.writeHead(status, headers); response.end(content); },
        disconnect() { response.destroy(); },
      };
      const next = waiting.shift();
      if (next) next(item); else requests.push(item);
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Unexpected fake provider address');
  return {
    url: `http://127.0.0.1:${address.port}`,
    get accepted() { return accepted; },
    nextRequest(): Promise<FakeProviderRequest> {
      const request = requests.shift();
      return request ? Promise.resolve(request) : new Promise((resolve) => { waiting.push(resolve); });
    },
    async close() {
      for (const response of pending) response.destroy();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}
