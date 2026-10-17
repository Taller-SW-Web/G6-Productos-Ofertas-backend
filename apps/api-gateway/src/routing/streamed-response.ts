import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Response as HttpResponse } from 'express';

export async function streamFileResponse(
  response: Response,
  target: HttpResponse,
  signal: AbortSignal,
): Promise<void> {
  const reader = response.body?.getReader();
  if (!reader) {
    target.end();
    return;
  }
  const source = Readable.from(
    (async function* () {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          yield value;
        }
      } finally {
        await reader.cancel().catch(() => undefined);
      }
    })(),
  );
  await pipeline(source, target, { signal });
}
