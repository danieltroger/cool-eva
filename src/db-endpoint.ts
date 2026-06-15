import { createReadStream } from 'fs';
import { stat } from 'fs/promises';
import type { IncomingMessage, ServerResponse } from 'http';

export async function handleDbEndpoint(
  req: IncomingMessage,
  res: ServerResponse,
  dbPath: string,
): Promise<void> {
  const st = await stat(dbPath);

  res.writeHead(200, {
    'Content-Type': 'application/octet-stream',
    'Content-Disposition': 'attachment; filename="temperatures.db"',
    'Content-Length': st.size,
  });

  const stream = createReadStream(dbPath);
  stream.pipe(res);

  // If the stream errors after headers are sent, destroy the response cleanly
  stream.on('error', () => {
    res.destroy();
  });
}
