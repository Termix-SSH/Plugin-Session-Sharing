import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "@termix-ssh/plugin-sdk/frontend";
import { toast } from "sonner";
import { Loader2, Presentation, RefreshCw } from "lucide-react";
import {
  AddButton,
  Button,
  Checkbox,
  EmptyState,
  FormFooter,
  InlineView,
  ListBadge,
  ListRow,
  PanelList,
  TextField,
} from "@termix-ssh/plugin-sdk/ui";
import type { CollabRoom } from "./api";
import type { MeetingBackend } from "./meeting-backend";
import { getErrorMessage } from "./shared";

export function CollabPanel({
  onOpenRoom,
  backend,
}: {
  onOpenRoom: (room: CollabRoom) => void;
  backend: MeetingBackend;
}) {
  const { t } = useTranslation();
  const { createCollabRoom, listCollabRooms } = backend.api;
  const [rooms, setRooms] = useState<CollabRoom[]>([]);
  const [loading, setLoading] = useState(true);
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState("");
  const [persistent, setPersistent] = useState(false);
  const [creating, setCreating] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const result = await listCollabRooms();
      setRooms(result.rooms ?? []);
    } catch {
      /* the list stays as-is */
    } finally {
      setLoading(false);
    }
  }, [backend]);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 30000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  async function handleCreate() {
    if (!name.trim()) return;
    setCreating(true);
    try {
      const { room } = await createCollabRoom(name.trim(), persistent);
      toast.success(t("collab.created"));
      setCreateOpen(false);
      setName("");
      setPersistent(false);
      await refresh();
      onOpenRoom(room);
    } catch (error) {
      toast.error(getErrorMessage(error));
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
        <span className="min-w-0 flex-1 truncate text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
          {t("collab.roomCount", { count: rooms.length })}
        </span>
        <Button
          variant="outline"
          size="icon"
          onClick={() => void refresh()}
          aria-label={t("common.refresh")}
          title={t("common.refresh")}
        >
          <RefreshCw className="size-3.5" />
        </Button>
        <AddButton
          label={t("collab.createRoom")}
          onClick={() => setCreateOpen(true)}
        />
      </div>

      <PanelList
        empty={
          loading ? (
            <div className="flex justify-center py-6">
              <Loader2 className="size-4 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <EmptyState icon={Presentation} title={t("collab.noRooms")} />
          )
        }
      >
        {!loading &&
          rooms.map((room, index) => (
            <ListRow
              key={room.id}
              stripe={index}
              tone={room.presenterUserId ? "destructive" : "brand"}
              icon={<Presentation />}
              title={room.name}
              onClick={() => onOpenRoom(room)}
              badges={
                <>
                  {room.presenterUserId && (
                    <ListBadge tone="destructive">
                      {t("collab.presenterBadge")}
                    </ListBadge>
                  )}
                  {room.persistent && (
                    <ListBadge>{t("collab.persistentRoom")}</ListBadge>
                  )}
                </>
              }
            />
          ))}
      </PanelList>

      <InlineView
        open={createOpen}
        onOpenChange={setCreateOpen}
        icon={<Presentation className="size-4" />}
        title={t("collab.createRoom")}
        footer={
          <FormFooter
            saving={creating}
            disabled={!name.trim()}
            onCancel={() => setCreateOpen(false)}
            onSave={() => void handleCreate()}
            saveLabel={t("common.create")}
          />
        }
      >
        <TextField
          label={t("collab.roomName")}
          value={name}
          onChange={setName}
          placeholder={t("collab.roomName")}
        />
        <label className="flex cursor-pointer items-start gap-2.5 border border-border p-2.5 text-xs">
          <Checkbox
            checked={persistent}
            onCheckedChange={(v) => setPersistent(v === true)}
            className="mt-0.5"
          />
          <span className="flex flex-col gap-0.5">
            <span className="font-medium">{t("collab.persistentRoom")}</span>
            <span className="text-muted-foreground">
              {t("collab.persistentRoomHint")}
            </span>
          </span>
        </label>
      </InlineView>
    </div>
  );
}
