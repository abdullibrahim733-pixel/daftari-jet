import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readBoundedBody, route } from '@/server/http/route';

describe('readBoundedBody', () => {
  it('reads bodies within the configured limit', async () => {
    const request = new Request('https://example.test/upload', {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: new Blob([new Uint8Array([1, 2, 3])]),
    });

    assert.deepEqual([...await readBoundedBody(request, 3)], [1, 2, 3]);
  });

  it('rejects a body that exceeds the limit while streaming', async () => {
    const request = new Request('https://example.test/upload', {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: new Blob([new Uint8Array([1, 2, 3, 4])]),
    });

    await assert.rejects(
      () => readBoundedBody(request, 3),
      (error: unknown) => error instanceof Error && 'status' in error && error.status === 413,
    );
  });

  it('rejects oversized declared lengths before reading the body', async () => {
    const request = new Request('https://example.test/upload', {
      method: 'POST',
      headers: { 'content-length': '4' },
      body: new Uint8Array([1]),
    });

    await assert.rejects(
      () => readBoundedBody(request, 3),
      (error: unknown) => error instanceof Error && 'status' in error && error.status === 413,
    );
  });
});

describe('route error logging', () => {
  it('does not log exception messages', async () => {
    const lines: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => lines.push(args.map(String).join(' '));

    try {
      const handler = route(async () => {
        throw new Error('sensitive transcript content');
      });
      const response = await handler(new Request('https://example.test/api'), {
        params: Promise.resolve({}),
      });

      assert.equal(response.status, 500);
      assert.equal(lines.length, 1);
      assert.doesNotMatch(lines[0] ?? '', /sensitive transcript content/);
      assert.match(lines[0] ?? '', /http\.unhandled_error/);
    } finally {
      console.error = originalError;
    }
  });
});
