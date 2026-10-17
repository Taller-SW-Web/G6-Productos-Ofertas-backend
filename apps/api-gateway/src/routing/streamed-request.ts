import { PassThrough, Readable } from 'node:stream';
import type { Request } from 'express';

// Owners enforce file limits, including SPEC-011's 5 MB for brand logos.
// Stream the entire multipart framing unchanged, with bounded backpressure.
export function streamedRequest(req: Request): {
  body: ReadableStream<Uint8Array>;
  close(): void;
} {
  const stream = new PassThrough({ highWaterMark: 64 * 1024 });
  const fail = () => stream.destroy(new Error('Incoming request interrupted'));
  req.on('error', fail);
  req.on('aborted', fail);
  // A cancelled fetch can destroy this intermediate stream without destroying
  // the HTTP socket needed to return the provider's early 413 or a local error.
  stream.on('error', () => undefined);
  req.pipe(stream);
  return {
    body: Readable.toWeb(stream) as ReadableStream<Uint8Array>,
    close: () => {
      req.unpipe(stream);
      req.off('error', fail);
      req.off('aborted', fail);
      stream.destroy();
      if (!req.readableEnded && !req.destroyed) req.resume();
    },
  };
}
