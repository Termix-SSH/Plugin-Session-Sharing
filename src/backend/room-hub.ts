import type { WebSocket } from "ws";
import type { CollabRuntimeStore } from "./runtime-store.js";

const PRESENCE_HEARTBEAT_MS = 15_000;

/**
 * A terminal socket, or a handle for one from another plugin process: a
 * stable key and a send function. A handle is copied on every call, so it is
 * matched by its key, not by identity.
 */
export type RoomSocket =
  WebSocket | { termixSocketKey: string; send: (data: string) => unknown };

function sameSocket(a: RoomSocket, b: RoomSocket): boolean {
  if (a === b) return true;
  const keyA = (a as { termixSocketKey?: unknown }).termixSocketKey;
  return (
    typeof keyA === "string" &&
    keyA === (b as { termixSocketKey?: unknown }).termixSocketKey
  );
}

export interface CollabRoomClient {
  ws: RoomSocket;
  userId: string;
  username: string;
}

/**
 * Local WebSocket fan-out plus the runtime store's pub/sub for room events and
 * presence across instances. The terminal socket feeds subscribe and
 * unsubscribe through the sessions.sharing service.
 */
export class CollabRoomHub {
  private rooms = new Map<string, Set<CollabRoomClient>>();
  private readonly heartbeat: NodeJS.Timeout;

  constructor(private readonly store: CollabRuntimeStore) {
    store.onEvent((roomId, message) => {
      if (
        "type" in message &&
        typeof message.type === "string" &&
        message.type.startsWith("collab_internal_")
      ) {
        return;
      }
      this.broadcastLocal(roomId, message);
    });
    this.heartbeat = setInterval(() => {
      for (const roomId of this.rooms.keys()) void this.refreshPresence(roomId);
    }, PRESENCE_HEARTBEAT_MS);
    this.heartbeat.unref();
  }

  subscribe(roomId: string, client: CollabRoomClient): void {
    let clients = this.rooms.get(roomId);
    if (!clients) {
      clients = new Set();
      this.rooms.set(roomId, clients);
    }
    for (const existing of clients) {
      if (sameSocket(existing.ws, client.ws)) return;
    }
    clients.add(client);
    void this.refreshPresence(roomId);
  }

  /** Drops the socket from one room, or from every room when roomId is omitted. */
  unsubscribe(ws: RoomSocket, roomId?: string): void {
    for (const [id, clients] of this.rooms) {
      if (roomId && id !== roomId) continue;
      let removed = false;
      for (const client of clients) {
        if (sameSocket(client.ws, ws)) {
          clients.delete(client);
          removed = true;
        }
      }
      if (clients.size === 0) this.rooms.delete(id);
      if (removed) void this.refreshPresence(id);
    }
  }

  broadcast(roomId: string, message: object): void {
    this.broadcastLocal(roomId, message);
    void this.store.publish(roomId, message);
  }

  async onlineUsers(
    roomId: string,
  ): Promise<Array<{ userId: string; username: string }>> {
    return this.store.onlineUsers(roomId, this.localOnlineUsers(roomId));
  }

  dispose(): void {
    clearInterval(this.heartbeat);
    this.rooms.clear();
  }

  private broadcastLocal(roomId: string, message: object): void {
    const clients = this.rooms.get(roomId);
    if (!clients) return;
    const payload = JSON.stringify(message);
    for (const client of clients) {
      const ws = client.ws as Partial<WebSocket> & {
        send: (data: string) => unknown;
      };
      // A handle has no readyState; its owner drops sends after a close.
      if (ws.readyState !== undefined && ws.readyState !== ws.OPEN) continue;
      try {
        const sent = ws.send(payload);
        if (sent instanceof Promise) sent.catch(() => {});
      } catch {
        /* keep broadcasting to the rest */
      }
    }
  }

  private localOnlineUsers(
    roomId: string,
  ): Array<{ userId: string; username: string }> {
    const clients = this.rooms.get(roomId);
    if (!clients) return [];
    const seen = new Map<string, string>();
    for (const client of clients) {
      seen.set(client.userId, client.username);
    }
    return Array.from(seen, ([userId, username]) => ({ userId, username }));
  }

  private async refreshPresence(roomId: string): Promise<void> {
    const localUsers = this.localOnlineUsers(roomId);
    await this.store.updatePresence(roomId, localUsers);
    this.broadcast(roomId, {
      type: "collab_online",
      roomId,
      users: await this.onlineUsers(roomId),
    });
  }
}
