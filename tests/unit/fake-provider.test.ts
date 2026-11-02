import { expect, it } from 'vitest';
import { createFakeProvider } from '../helpers/fake-provider.js';

it('counts accepted loopback requests and holds each response until released', async () => {
  const fake = await createFakeProvider();
  try {
    let finished = false;
    const response = fetch(`${fake.url}/systemone`, { method: 'POST', body: '{"fixture":true}' }).then((value) => { finished = true; return value; });
    const request = await fake.nextRequest();
    expect(fake.accepted).toBe(1);
    expect(request.request.url).toBe('/systemone');
    expect(request.body).toBe('{"fixture":true}');
    expect(finished).toBe(false);
    request.respond(200, { 'content-type': 'text/event-stream' }, 'data: fixture\n\n');
    expect(await (await response).text()).toBe('data: fixture\n\n');
  } finally {
    await fake.close();
  }
});
