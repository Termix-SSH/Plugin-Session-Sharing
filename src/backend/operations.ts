import { actorOf, type SharingDeps } from "./deps.js";
import { revokeShare } from "./share-routes.js";

/** Active shares as actions, so a user can see and revoke them anywhere. */
export function registerOperations(deps: SharingDeps): void {
  const { ctx, shares } = deps;
  if (typeof ctx.operations?.register !== "function") return;

  ctx.operations.register("session-sharing.list-shares", {
    run: async () => {
      const rows = await shares.findActiveSharesForOwner(actorOf(ctx));
      return {
        summary: `${rows.length} active shares`,
        data: {
          rows: rows.map((share) => ({
            id: share.id,
            name: `${share.protocol} ${share.shareType}`,
            hostId: share.hostId,
            protocol: share.protocol,
            type: share.shareType,
            access: share.permissionLevel,
            expires: share.expiresAt,
          })),
          options: rows.map((share) => ({
            value: share.id,
            label: `${share.protocol} ${share.shareType} (${share.permissionLevel})`,
          })),
          value: rows.length,
          status: "ok",
          label: `${rows.length} active`,
        },
      };
    },
  });

  ctx.operations.register("session-sharing.host-shares", {
    run: async (_input, context) => {
      const rows = (await shares.findActiveSharesForOwner(actorOf(ctx))).filter(
        (share) => share.hostId === context.hostId,
      );
      return {
        summary: `${rows.length} active shares`,
        data: {
          rows: rows.map((share) => ({
            id: share.id,
            name: `${share.protocol} ${share.shareType}`,
            type: share.shareType,
            access: share.permissionLevel,
            expires: share.expiresAt,
          })),
        },
      };
    },
  });

  ctx.operations.register("session-sharing.revoke-share", {
    describe: (input) => `Would revoke share ${String(input.share)}`,
    run: async (input) => {
      const outcome = await revokeShare(
        deps,
        String(input.share ?? ""),
        actorOf(ctx),
      );
      if (outcome === "missing") throw new Error("Share not found");
      if (outcome === "denied") throw new Error("Not your share");
      return { summary: "Share revoked", changed: true };
    },
  });
}
