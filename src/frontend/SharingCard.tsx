import { useCallback, useEffect, useState } from "react";
import { Link2, Presentation, User, X } from "lucide-react";
import { toast } from "sonner";
import { useHosts, useTranslation } from "@termix-ssh/plugin-sdk/frontend";
import {
  ListBadge,
  ListRow,
  ListRowAction,
  PanelList,
} from "@termix-ssh/plugin-sdk/ui";
import {
  getAllActiveSessionShares,
  revokeSessionShare,
  type CollabRoom,
  type SessionShareRecord,
} from "./api";
import type { MeetingBackend } from "./meeting-backend";

const POLL_MS = 30_000;

/** Dashboard card: the caller's live shares and their meeting rooms. */
export function SharingCard({
  isVisible,
  backend,
  onOpenRoom,
}: {
  isVisible: boolean;
  backend: MeetingBackend;
  onOpenRoom: (room: CollabRoom) => void;
}) {
  const { t } = useTranslation();
  const { hosts } = useHosts();
  const [shares, setShares] = useState<SessionShareRecord[] | null>(null);
  const [rooms, setRooms] = useState<CollabRoom[]>([]);

  const load = useCallback(async () => {
    const [shareResult, roomResult] = await Promise.allSettled([
      getAllActiveSessionShares(),
      backend.api.listCollabRooms(),
    ]);
    setShares(
      shareResult.status === "fulfilled" ? shareResult.value.shares : [],
    );
    if (roomResult.status === "fulfilled") {
      setRooms((roomResult.value.rooms ?? []).filter((r) => !r.endedAt));
    }
  }, [backend]);

  useEffect(() => {
    if (!isVisible) return;
    void load();
    const timer = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(timer);
  }, [isVisible, load]);

  const revoke = async (share: SessionShareRecord) => {
    try {
      await revokeSessionShare(share.id);
      toast.success(t("sessionSharing.revoked"));
      await load();
    } catch {
      toast.error(t("sessionSharing.revokeFailed"));
    }
  };

  if (!shares) {
    return (
      <p className="p-3 text-xs text-muted-foreground">{t("card.loading")}</p>
    );
  }

  const hostName = (id: number) => {
    const host = hosts.find((h) => Number(h.id) === id);
    return host?.name || host?.ip || `#${id}`;
  };

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto">
      <span className="px-3 pt-2 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
        {t("sessionSharing.activeShares")}
      </span>
      <PanelList
        empty={
          <p className="px-3 py-2 text-xs text-muted-foreground">
            {t("sessionSharing.noActiveShares")}
          </p>
        }
      >
        {shares.map((share, index) => (
          <ListRow
            key={share.id}
            stripe={index}
            tone="brand"
            icon={
              share.shareType === "link" ? (
                <Link2 className="size-3.5" />
              ) : (
                <User className="size-3.5" />
              )
            }
            title={hostName(share.hostId)}
            badges={
              <ListBadge tone="muted">
                {t(
                  share.shareType === "link"
                    ? "sessionSharing.linkShareBadge"
                    : "sessionSharing.userShareBadge",
                )}
              </ListBadge>
            }
            meta={[
              share.protocol.toUpperCase(),
              t("sessionSharing.joinCount", { count: share.joinCount }),
              t("sessionSharing.expiresAt", {
                date: new Date(share.expiresAt).toLocaleString(),
              }),
            ].join(" | ")}
            actions={
              <ListRowAction
                label={t("sessionSharing.revoke")}
                tone="destructive"
                onClick={() => void revoke(share)}
              >
                <X />
              </ListRowAction>
            }
          />
        ))}
      </PanelList>
      <span className="px-3 pt-2 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
        {t("nav.collab")}
      </span>
      <PanelList
        empty={
          <p className="px-3 py-2 text-xs text-muted-foreground">
            {t("collab.noRooms")}
          </p>
        }
      >
        {rooms.map((room, index) => (
          <ListRow
            key={room.id}
            stripe={index}
            tone={room.presenterUserId ? "success" : "none"}
            icon={<Presentation className="size-3.5" />}
            title={room.name}
            badges={
              room.presenterUserId ? (
                <ListBadge tone="success">
                  {t("collab.presenterBadge")}
                </ListBadge>
              ) : undefined
            }
            onClick={() => onOpenRoom(room)}
          />
        ))}
      </PanelList>
    </div>
  );
}
