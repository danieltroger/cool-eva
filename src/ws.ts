import { WebSocketServer, WebSocket } from "ws";
import type { Server } from "http";
import { snapshot, onChange } from "./can/signals.ts";

// Event-driven push to the phone dashboard:
//   • full snapshot on connect
//   • a delta the instant a displayed value changes (per-signal deadbands already
//     rate-limit these, so there's nothing to throttle)
//   • a slow full-snapshot heartbeat purely for liveness (reconnect detection +
//     staleness) when the bike is sitting still and nothing is changing
// Messages: { type: 'snapshot' | 'patch', ts, signals: { key: {value,unit,group,ts} } }

export interface WsHandle {
  stop: () => void;
}

export function setupWs(server: Server, heartbeatMs = 5000): WsHandle {
  const wss = new WebSocketServer({ server });

  const broadcast = (obj: object): void => {
    if (wss.clients.size === 0) return;
    const msg = JSON.stringify(obj);
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) client.send(msg);
    }
  };

  wss.on("connection", (ws: WebSocket) => {
    ws.send(JSON.stringify({ type: "snapshot", ts: Date.now(), signals: snapshot() }));
  });

  // Push only what changed, the moment it changes.
  onChange(changed => broadcast({ type: "patch", ts: Date.now(), signals: changed }));

  // Liveness heartbeat — NOT the update path.
  const timer = setInterval(() => broadcast({ type: "snapshot", ts: Date.now(), signals: snapshot() }), heartbeatMs);

  return {
    stop: () => {
      clearInterval(timer);
      wss.close();
    },
  };
}
