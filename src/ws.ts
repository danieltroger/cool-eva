import { WebSocketServer, WebSocket } from "ws";
import type { Server } from "http";
import { snapshot, onChange, type LiveValue } from "./can/signals.ts";

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

/**
 * The wire shape sent to the dashboard. `public/index.html` is plain JS with no
 * build step, so it cannot import this — the two can drift silently. Change one,
 * change the other.
 */
export interface DashboardMessage {
  type: "snapshot" | "patch";
  ts: number;
  signals: Record<string, LiveValue>;
}

export function setupWs(server: Server, heartbeatMs = 5000): WsHandle {
  const wss = new WebSocketServer({ server });

  const broadcast = (message: DashboardMessage): void => {
    if (wss.clients.size === 0) return;
    const msg = JSON.stringify(message);
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
