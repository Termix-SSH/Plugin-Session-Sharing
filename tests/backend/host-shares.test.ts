import { describe, expect, it } from "vitest";
import type {
  PluginContext,
  PluginOperationContext,
} from "@termix-ssh/plugin-sdk/backend";
import { registerOperations } from "../../src/backend/operations.js";

describe("session-sharing.host-shares", () => {
  it("lists only the shares of the host", async () => {
    let handler: { run: (i: unknown, c: unknown) => Promise<unknown> } | null =
      null;
    const ctx = {
      currentActor: () => "user-1",
      operations: {
        register: (id: string, h: typeof handler) => {
          if (id === "session-sharing.host-shares") handler = h;
        },
      },
    } as unknown as PluginContext;
    const shares = {
      findActiveSharesForOwner: async () => [
        {
          id: "a",
          hostId: 3,
          protocol: "ssh",
          shareType: "link",
          permissionLevel: "view",
          expiresAt: null,
        },
        {
          id: "b",
          hostId: 4,
          protocol: "rdp",
          shareType: "link",
          permissionLevel: "view",
          expiresAt: null,
        },
      ],
    };
    registerOperations({ ctx, shares } as never);
    const result = (await handler!.run({}, {
      hostId: 3,
    } as PluginOperationContext)) as { data: { rows: { id: string }[] } };
    expect(result.data.rows.map((row) => row.id)).toEqual(["a"]);
  });
});
