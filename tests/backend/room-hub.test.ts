import { describe, expect, it, vi } from "vitest";
import { CollabRoomHub } from "../../src/backend/room-hub.js";
import type { CollabRuntimeStore } from "../../src/backend/runtime-store.js";

function fakeStore() {
  return {
    onEvent: vi.fn(),
    publish: vi.fn(async () => {}),
    onlineUsers: vi.fn(async (_roomId: string, local: unknown) => local),
    updatePresence: vi.fn(async () => {}),
  } as unknown as CollabRuntimeStore;
}

describe("room hub", () => {
  it("matches a socket handle from another process by its key", async () => {
    const hub = new CollabRoomHub(fakeStore());
    const sent: string[] = [];
    // Each service call brings a fresh copy of the handle.
    const handle = () => ({
      termixSocketKey: "k1",
      send: async (data: string) => {
        sent.push(data);
      },
    });
    hub.subscribe("room", { ws: handle(), userId: "u1", username: "a" });
    hub.subscribe("room", { ws: handle(), userId: "u1", username: "a" });
    hub.broadcast("room", { type: "hello" });
    expect(sent).toEqual([JSON.stringify({ type: "hello" })]);

    hub.unsubscribe(handle(), "room");
    hub.broadcast("room", { type: "after" });
    expect(sent).toHaveLength(1);
    hub.dispose();
  });

  it("still skips a real socket that is not open", () => {
    const hub = new CollabRoomHub(fakeStore());
    const send = vi.fn();
    const ws = { readyState: 3, OPEN: 1, send } as never;
    hub.subscribe("room", { ws, userId: "u1", username: "a" });
    hub.broadcast("room", { type: "x" });
    expect(send).not.toHaveBeenCalled();
    hub.dispose();
  });
});
