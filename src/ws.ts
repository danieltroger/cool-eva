import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'http';
import { snapshot } from './can/signals.ts';

// Broadcasts a full snapshot of the in-memory live state to the phone riding
// dashboard — on connect, and on a timer so steady values still look fresh.
// Message shape: { type:'snapshot', ts, signals: { key: {value, unit, group, ts} } }

export interface WsHandle {
  stop: () => void;
}

export function setupWs(server: Server, intervalMs = 1000): WsHandle {
  const wss = new WebSocketServer({ server });

  const payload = (): string =>
    JSON.stringify({ type: 'snapshot', ts: Date.now(), signals: snapshot() });

  wss.on('connection', (ws: WebSocket) => {
    ws.send(payload());
  });

  const timer = setInterval(() => {
    if (wss.clients.size === 0) return;
    const msg = payload();
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) client.send(msg);
    }
  }, intervalMs);

  return {
    stop: () => {
      clearInterval(timer);
      wss.close();
    },
  };
}
