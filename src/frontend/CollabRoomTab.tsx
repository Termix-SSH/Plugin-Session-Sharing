import { useCallback, useEffect, useRef, useState } from "react";
import {
  hostProtocols,
  useHosts,
  useTranslation,
  type PluginHostRecord,
} from "@termix-ssh/plugin-sdk/frontend";
import { toast } from "sonner";
import {
  AlertCircle,
  Hand,
  Link2,
  Loader2,
  MonitorUp,
  Presentation,
  Square,
  Users,
} from "lucide-react";
import {
  Button,
  Checkbox,
  InlineView,
  Input,
  PluginComponent,
  useConfirm,
  FormFooter,
} from "@termix-ssh/plugin-sdk/ui";
import { CollabMembersSidebar } from "./CollabMembersSidebar";
import {
  RemoteDisplay,
  createRemoteSessionToken,
  getErrorMessage,
  wsTargetForPath,
} from "./shared";
import type { CollabRoomDetail, CollabStage, DirectoryRole } from "./api";
import { meetingGuestUrl, type MeetingBackend } from "./meeting-backend";

type SharedProtocol = "ssh" | "rdp" | "vnc" | "telnet";

function isSharedProtocol(value: string): value is SharedProtocol {
  return (
    value === "ssh" || value === "rdp" || value === "vnc" || value === "telnet"
  );
}

/** A host from the shell's list; the connection fields ride along by name. */
type SSHHostWithStatus = PluginHostRecord & {
  enableSsh?: boolean;
  connectionOrigin?: unknown;
};

const PING_INTERVAL_MS = 30000;
const POLL_FALLBACK_MS = 15000;

// The terminal socket the ssh-terminal plugin serves. Authentication rides on
// the jwt cookie the way every terminal WS connection does.
async function roomEventsWsUrl(roomId: string, backend: MeetingBackend) {
  const { eventsWsPath } = await backend.api.getCollabRoom(roomId);
  await backend.assertCurrent();
  return wsTargetForPath(eventsWsPath, backend.origin);
}

type PresentDraft =
  | { protocol: "ssh"; host: SSHHostWithStatus }
  | {
      protocol: "rdp" | "vnc" | "telnet";
      host: SSHHostWithStatus;
      token: string;
      guacamoleConnectionId: string;
    };

export function CollabRoomTab({
  roomId,
  isVisible,
  backend,
}: {
  backend: MeetingBackend;
  roomId?: string;
  isVisible: boolean;
}) {
  const { t } = useTranslation();
  const {
    deleteCollabRoom,
    endCollabRoom,
    dismissCollabControlRequest,
    getCollabRoom,
    getCollabStage,
    inviteCollabMembers,
    presentCollabStage,
    requestCollabStageControl,
    removeCollabMember,
    removeCollabGuests,
    setCollabGuestLink,
    setCollabStageControl,
    stopCollabStage,
    getDirectory,
  } = backend.api;
  const [detail, setDetail] = useState<CollabRoomDetail | null>(null);
  const [stage, setStage] = useState<CollabStage | null>(null);
  const [ended, setEnded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draft, setDraft] = useState<PresentDraft | null>(null);
  const [presentOpen, setPresentOpen] = useState(false);
  const { loaded: hostsLoaded } = useHosts();
  const presentLoading = !hostsLoaded;
  const [inviteOpen, setInviteOpen] = useState(false);
  const [membersOpen, setMembersOpen] = useState(true);
  const confirm = useConfirm();
  const [deleting, setDeleting] = useState(false);
  const [guestLinkToken, setGuestLinkToken] = useState<string | null>(null);
  const [hostSearch, setHostSearch] = useState("");
  const [inviteSearch, setInviteSearch] = useState("");
  const { hosts: shellHosts } = useHosts();
  const hosts = shellHosts as SSHHostWithStatus[];
  const [users, setUsers] = useState<Array<{ id: string; username: string }>>(
    [],
  );
  const [inviteSelection, setInviteSelection] = useState<Set<string>>(
    new Set(),
  );
  const [roles, setRoles] = useState<DirectoryRole[]>([]);
  const [roleSelection, setRoleSelection] = useState<Set<number>>(new Set());
  const draftRef = useRef<PresentDraft | null>(null);
  draftRef.current = draft;
  const stageKeyRef = useRef<string | null>(null);
  const presenterRef = useRef<string | null>(null);
  const refreshSequence = useRef(0);

  const refresh = useCallback(async () => {
    if (!roomId) return;
    const sequence = ++refreshSequence.current;
    try {
      const nextDetail = await getCollabRoom(roomId);
      if (sequence !== refreshSequence.current) return;
      // Only discard a confirmed presentation that another member took over.
      if (
        presenterRef.current === nextDetail.me &&
        nextDetail.stage.presenterUserId !== nextDetail.me
      ) {
        setDraft(null);
      }
      presenterRef.current = nextDetail.stage.presenterUserId;
      setDetail(nextDetail);
      setLoadError(null);
      // Presenting locally? The local session is the stage - don't join it.
      if (
        nextDetail.stage.shareId &&
        nextDetail.stage.presenterUserId !== nextDetail.me
      ) {
        // A guac viewer reconnects whenever its token changes, so the stage
        // is only re-resolved when the share or my control actually changed.
        const stageKey = `${nextDetail.stage.shareId}:${
          nextDetail.controllerUserId === nextDetail.me
        }`;
        if (stageKeyRef.current !== stageKey) {
          stageKeyRef.current = stageKey;
          const { stage: resolved } = await getCollabStage(roomId);
          setStage(resolved);
        }
      } else if (!nextDetail.stage.shareId) {
        stageKeyRef.current = null;
        setStage(null);
        // The stage was cleared elsewhere; stop presenting locally too.
        if (draftRef.current) setDraft(null);
      }
    } catch (error) {
      if (sequence === refreshSequence.current) {
        setLoadError(getErrorMessage(error));
      }
    }
  }, [roomId, backend]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Live room events. Poll only while the socket is unavailable.
  useEffect(() => {
    if (!roomId) return;
    let ws: WebSocket | null = null;
    let pingTimer: ReturnType<typeof setInterval> | null = null;
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let reconnectAttempt = 0;
    let cancelled = false;

    const startPolling = () => {
      pollTimer ??= setInterval(() => void refresh(), POLL_FALLBACK_MS);
    };
    const stopPolling = () => {
      if (pollTimer) clearInterval(pollTimer);
      pollTimer = null;
    };
    const connect = async () => {
      if (cancelled) return;
      try {
        const url = await roomEventsWsUrl(roomId, backend);
        if (cancelled) return;
        if (!url) throw new Error("No terminal endpoint is available");
        ws = new WebSocket(url.url, url.protocols);
      } catch {
        startPolling();
        reconnectTimer = setTimeout(() => void connect(), 5000);
        return;
      }
      ws.onopen = () => {
        reconnectAttempt = 0;
        stopPolling();
        ws?.send(
          JSON.stringify({ type: "collab_subscribe", data: { roomId } }),
        );
        pingTimer = setInterval(() => {
          if (ws?.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "ping" }));
          }
        }, PING_INTERVAL_MS);
      };
      ws.onmessage = (event) => {
        if (cancelled) return;
        let msg: { type?: string; roomId?: string };
        try {
          msg = JSON.parse(event.data);
        } catch {
          return;
        }
        if (msg.roomId !== roomId) return;
        switch (msg.type) {
          case "collab_online":
          case "collab_members_changed":
          case "collab_stage_changed":
          case "collab_control_changed":
          case "collab_control_requested":
          case "collab_control_requests_changed":
            void refresh();
            break;
          case "collab_room_ended":
            setEnded(true);
            break;
          default:
            break;
        }
      };
      ws.onclose = () => {
        if (cancelled) return;
        if (pingTimer) clearInterval(pingTimer);
        pingTimer = null;
        startPolling();
        const delay = Math.min(1000 * 2 ** reconnectAttempt++, 15000);
        reconnectTimer = setTimeout(() => void connect(), delay);
      };
      ws.onerror = () => ws?.close();
    };

    void connect();
    return () => {
      cancelled = true;
      if (pingTimer) clearInterval(pingTimer);
      if (pollTimer) clearInterval(pollTimer);
      if (reconnectTimer) clearTimeout(reconnectTimer);
      ws?.close();
    };
  }, [roomId, refresh]);

  const me = detail?.me;
  const isHost = detail?.isHost ?? false;
  const controllerUserId = detail?.controllerUserId ?? null;
  const presenterUserId = detail?.stage.presenterUserId ?? null;
  const iAmPresenter = !!me && presenterUserId === me;
  const presenterName = detail?.members.find(
    (member) => member.userId === presenterUserId,
  )?.username;

  async function changeControl(targetId: string | null) {
    if (!roomId) return;
    try {
      await setCollabStageControl(roomId, targetId);
      await refresh();
    } catch (error) {
      toast.error(getErrorMessage(error));
    }
  }

  async function dismissControlRequest(targetId: string) {
    if (!roomId) return;
    try {
      await dismissCollabControlRequest(roomId, targetId);
      await refresh();
    } catch (error) {
      toast.error(getErrorMessage(error));
    }
  }

  async function removeGuests() {
    if (!roomId) return;
    try {
      await removeCollabGuests(roomId);
      await refresh();
    } catch (error) {
      toast.error(getErrorMessage(error));
    }
  }

  async function removeMember(targetId: string) {
    if (!roomId) return;
    try {
      await removeCollabMember(roomId, targetId);
      await refresh();
    } catch (error) {
      toast.error(getErrorMessage(error));
    }
  }

  async function toggleOwnControlRequest() {
    if (!roomId || !me) return;
    try {
      const existing = detail?.controlRequests.some(
        (request) => request.userId === me,
      );
      if (existing) await dismissCollabControlRequest(roomId, me);
      else await requestCollabStageControl(roomId);
      await refresh();
    } catch (error) {
      toast.error(getErrorMessage(error));
    }
  }

  function openPresentDialog() {
    setPresentOpen(true);
  }

  function choosePresent(
    host: SSHHostWithStatus,
    protocol: "ssh" | "rdp" | "vnc" | "telnet",
  ) {
    if (presenterUserId && !iAmPresenter) {
      setPresentOpen(false);
      void confirm({
        title: t("collab.takeOverConfirmTitle"),
        description: t("collab.takeOverDescription", { name: presenterName }),
        confirmLabel: t("collab.takeOver"),
        destructive: false,
      }).then((ok) => {
        if (ok) void startPresent(host, protocol);
      });
      return;
    }
    void startPresent(host, protocol);
  }

  async function startPresent(
    host: SSHHostWithStatus,
    protocol: "ssh" | "rdp" | "vnc" | "telnet",
  ) {
    if (!roomId) return;
    setPresentOpen(false);
    try {
      await backend.assertCurrent();
      if (backend.origin === "remote") {
        if (!host.syncId) throw new Error(t("collab.hostNotSynced"));
        const resolved = await backend.api.resolveHost(host.syncId);
        host = { ...host, id: String(resolved.id), connectionOrigin: "remote" };
      } else {
        host = { ...host, connectionOrigin: "local" };
      }
      if (protocol === "ssh") {
        setDraft({ protocol, host });
        return;
      }
      const response = await createRemoteSessionToken(
        Number(host.id),
        backend.origin,
        protocol,
      );
      if (!response?.connectionId) {
        toast.error(t("collab.stageLoading"));
        return;
      }
      setDraft({
        protocol,
        host,
        token: response.token,
        guacamoleConnectionId: response.connectionId,
      });
    } catch (error) {
      toast.error(getErrorMessage(error));
    }
  }

  async function registerStage(
    protocol: string,
    sessionId: string,
    hostId: number,
  ) {
    if (!roomId) return;
    try {
      await presentCollabStage(roomId, { protocol, sessionId, hostId });
      void refresh();
    } catch (error) {
      toast.error(getErrorMessage(error));
      setDraft(null);
    }
  }

  async function handleStop() {
    if (!roomId) return;
    try {
      await stopCollabStage(roomId);
      setDraft(null);
      void refresh();
    } catch (error) {
      toast.error(getErrorMessage(error));
    }
  }

  async function confirmGuestLink(action: "disable" | "rotate") {
    const rotate = action === "rotate";
    const ok = await confirm({
      title: t(
        rotate
          ? "collab.rotateLinkConfirmTitle"
          : "collab.disableLinkConfirmTitle",
      ),
      description: t(
        rotate
          ? "collab.rotateLinkDescription"
          : "collab.disableLinkDescription",
      ),
      confirmLabel: t(rotate ? "collab.rotateLink" : "collab.disableLink"),
      destructive: !rotate,
    });
    if (ok) void handleGuestLink(rotate);
  }

  async function handleEnd() {
    if (!roomId) return;
    try {
      await endCollabRoom(roomId);
      setDraft(null);
      if (!detail?.room.persistent) setEnded(true);
      void refresh();
    } catch (error) {
      toast.error(getErrorMessage(error));
    }
  }

  async function handleDelete() {
    if (!roomId) return;
    setDeleting(true);
    try {
      await deleteCollabRoom(roomId);
      setDraft(null);
      setEnded(true);
    } catch (error) {
      toast.error(getErrorMessage(error));
    } finally {
      setDeleting(false);
    }
  }

  async function openInviteDialog() {
    setInviteOpen(true);
    setInviteSelection(new Set());
    setRoleSelection(new Set());
    try {
      const directory = await getDirectory();
      setUsers(directory.users);
      setRoles(directory.roles);
    } catch (error) {
      toast.error(getErrorMessage(error));
    }
  }

  async function handleGuestLink(enabled: boolean) {
    if (!roomId) return;
    try {
      const result = await setCollabGuestLink(roomId, enabled);
      setGuestLinkToken(result.guestLinkToken);
      await refresh();
    } catch (error) {
      toast.error(getErrorMessage(error));
    }
  }

  async function copyGuestLink(token: string) {
    try {
      await backend.assertCurrent();
      const url = meetingGuestUrl(backend.publicUrl, token);
      if (!url) throw new Error(t("collab.linkRequiresServer"));
      await navigator.clipboard.writeText(url);
      toast.success(t("collab.linkCopied"));
    } catch (error) {
      toast.error(getErrorMessage(error));
    }
  }

  async function handleInvite() {
    if (!roomId || (inviteSelection.size === 0 && roleSelection.size === 0))
      return;
    try {
      await inviteCollabMembers(roomId, {
        userIds: Array.from(inviteSelection),
        roleIds: Array.from(roleSelection),
      });
      toast.success(t("collab.invited"));
      setInviteOpen(false);
      void refresh();
    } catch (error) {
      toast.error(getErrorMessage(error));
    }
  }

  if (!roomId) {
    return (
      <div className="flex flex-1 h-full items-center justify-center">
        <div className="flex flex-col items-center gap-2 text-muted-foreground">
          <Presentation className="size-8" />
          <p className="text-sm">{t("collab.reopenFromPanel")}</p>
        </div>
      </div>
    );
  }

  if (ended) {
    return (
      <div className="flex flex-1 h-full items-center justify-center">
        <div className="flex flex-col items-center gap-2 text-muted-foreground">
          <AlertCircle className="size-8" />
          <p className="text-sm">{t("collab.roomEnded")}</p>
        </div>
      </div>
    );
  }

  if (!detail && loadError) {
    return (
      <div className="flex flex-1 h-full items-center justify-center">
        <div className="flex flex-col items-center gap-3 text-muted-foreground">
          <AlertCircle className="size-8" />
          <p className="max-w-sm text-center text-sm">{loadError}</p>
          <Button variant="outline" onClick={() => void refresh()}>
            {t("collab.retry")}
          </Button>
        </div>
      </div>
    );
  }

  const memberIds = new Set(detail?.members.map((member) => member.userId));
  const normalizedInviteSearch = inviteSearch.trim().toLocaleLowerCase();
  const invitableUsers = users.filter(
    (user) =>
      !memberIds.has(user.id) &&
      user.username.toLocaleLowerCase().includes(normalizedInviteSearch),
  );
  const normalizedHostSearch = hostSearch.trim().toLocaleLowerCase();
  const filteredHosts = hosts.filter((host) =>
    host.name.toLocaleLowerCase().includes(normalizedHostSearch),
  );

  return (
    <div className="flex flex-col h-full min-h-0">
      {loadError && (
        <div
          className="flex items-center gap-2 border-b border-destructive/40 bg-destructive/10 px-3 py-2 text-xs"
          role="alert"
        >
          <AlertCircle className="size-4 shrink-0 text-destructive" />
          <span className="flex-1 truncate">{loadError}</span>
          <Button size="sm" variant="outline" onClick={() => void refresh()}>
            {t("collab.retry")}
          </Button>
        </div>
      )}
      {/* Header: room identity + primary controls */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border flex-wrap">
        <Presentation className="size-4 text-muted-foreground shrink-0" />
        <span className="text-sm font-semibold truncate">
          {detail?.room.name}
        </span>
        <div className="flex-1" />
        <div className="flex items-center gap-1.5 shrink-0">
          {!!detail?.stage.shareId &&
            detail.stage.protocol === "ssh" &&
            !iAmPresenter &&
            !draft && (
              <Button
                size="sm"
                variant={controllerUserId === me ? "default" : "outline"}
                className="h-8 text-xs"
                onClick={() =>
                  controllerUserId === me
                    ? void changeControl(null)
                    : void toggleOwnControlRequest()
                }
              >
                <Hand className="size-3.5 mr-1" />
                {controllerUserId === me
                  ? t("collab.releaseControl")
                  : detail.controlRequests.some(
                        (request) => request.userId === me,
                      )
                    ? t("collab.cancelControlRequest")
                    : t("collab.requestControl")}
              </Button>
            )}
          {(iAmPresenter || draft || (isHost && presenterUserId)) && (
            <Button
              size="sm"
              variant="outline"
              className="h-8 text-xs"
              onClick={() => void handleStop()}
            >
              <Square className="size-3.5 mr-1" />
              {t("collab.stopPresenting")}
            </Button>
          )}
          <Button
            size="sm"
            variant={membersOpen ? "default" : "outline"}
            className="h-8 text-xs"
            aria-controls="collab-members-sidebar"
            aria-expanded={membersOpen}
            onClick={() => setMembersOpen((open) => !open)}
          >
            <Users className="mr-1 size-3.5" />
            {(detail?.members.length ?? 0) + (detail?.guests?.length ?? 0)}
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-8 text-xs border-accent-brand/40 text-accent-brand hover:bg-accent-brand/10 hover:text-accent-brand dark:border-accent-brand/40 dark:bg-transparent dark:hover:bg-accent-brand/10"
            onClick={() => void openPresentDialog()}
          >
            <MonitorUp className="size-3.5 mr-1" />
            {presenterUserId && !iAmPresenter
              ? t("collab.takeOver")
              : t("collab.present")}
          </Button>
          {isHost && (
            <Button
              size="sm"
              variant="destructive"
              className="h-8 text-xs"
              onClick={() =>
                void confirm({
                  title: t("collab.endConfirmTitle"),
                  description: t(
                    detail?.room.persistent
                      ? "collab.endPersistentDescription"
                      : "collab.endDescription",
                    { name: detail?.room.name },
                  ),
                  confirmLabel: t("collab.endRoom"),
                }).then((ok) => {
                  if (ok) void handleEnd();
                })
              }
            >
              {t("collab.endRoom")}
            </Button>
          )}
          {isHost && detail?.room.persistent && (
            <Button
              size="sm"
              variant="destructive"
              className="h-8 text-xs"
              disabled={deleting}
              onClick={() =>
                void confirm({
                  title: t("collab.deleteConfirmTitle"),
                  description: t("collab.deleteDescription", {
                    name: detail?.room.name,
                  }),
                  confirmLabel: t("collab.deleteRoom"),
                }).then((ok) => {
                  if (ok) void handleDelete();
                })
              }
            >
              {t("collab.deleteRoom")}
            </Button>
          )}
        </div>
      </div>

      {isHost && (
        <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border text-xs text-muted-foreground">
          <Link2 className="size-3.5" />
          <span className="flex-1 truncate">
            {detail?.room.guestLinkEnabled
              ? t("collab.guestLinkOn")
              : t("collab.guestLinkOff")}
          </span>
          {guestLinkToken && (
            <Button
              size="sm"
              variant="outline"
              className="h-8 text-xs"
              onClick={() => {
                void copyGuestLink(guestLinkToken);
              }}
            >
              {t("collab.copyLink")}
            </Button>
          )}
          {detail?.room.guestLinkEnabled && !guestLinkToken && (
            <Button
              size="sm"
              variant="outline"
              className="h-8 text-xs"
              onClick={() => void confirmGuestLink("rotate")}
            >
              {t("collab.rotateLink")}
            </Button>
          )}
          <Button
            size="sm"
            variant={detail?.room.guestLinkEnabled ? "destructive" : "outline"}
            className="h-8 text-xs"
            onClick={() =>
              detail?.room.guestLinkEnabled
                ? void confirmGuestLink("disable")
                : void handleGuestLink(true)
            }
          >
            {t("collab.guestLink")}:{" "}
            {detail?.room.guestLinkEnabled ? "ON" : "OFF"}
          </Button>
        </div>
      )}

      <div className="relative flex flex-1 min-h-0">
        {/* Stage */}
        <div className="relative flex-1 min-w-0 min-h-0">
          {draft ? (
            draft.protocol === "ssh" ? (
              <PluginComponent
                id="terminal.view"
                hostConfig={{
                  ...draft.host,
                  id: Number(draft.host.id),
                  ip: draft.host.ip,
                  port: draft.host.port,
                  username: draft.host.username,
                  instanceId: `collab-present-${roomId}`,
                }}
                isVisible={isVisible}
                disableAutoFocus={false}
                onSessionReady={(sessionId) =>
                  void registerStage("ssh", sessionId, Number(draft.host.id))
                }
              />
            ) : (
              <RemoteDisplay
                connectionOrigin={backend.origin}
                token={draft.token}
                protocol={draft.protocol}
                isVisible={isVisible}
                onConnect={() =>
                  void registerStage(
                    draft.protocol,
                    draft.guacamoleConnectionId,
                    Number(draft.host.id),
                  )
                }
                onError={(err) => {
                  toast.error(err);
                  setDraft(null);
                }}
              />
            )
          ) : stage && stage.protocol && !iAmPresenter ? (
            <>
              {presenterName && (
                <div className="absolute top-2 left-2 z-20 rounded px-2 py-0.5 text-[10px] bg-background/80 border border-border">
                  {t("collab.presenterLabel", { name: presenterName })}
                </div>
              )}
              {stage.protocol === "ssh" ? (
                <PluginComponent
                  id="terminal.view"
                  hostConfig={{
                    id: stage.hostId ?? undefined,
                    connectionOrigin: backend.origin,
                    name: detail?.room.name ?? "stage",
                    ip: "",
                    port: 0,
                    username: "",
                    authType: "none",
                    instanceId: `collab-view-${roomId}-${stage.shareId}`,
                    joinShareId: stage.shareId,
                    joinSharedSessionId: stage.sessionId ?? null,
                  }}
                  isVisible={isVisible}
                  disableAutoFocus
                />
              ) : stage.connectParams?.token ? (
                <RemoteDisplay
                  connectionOrigin={backend.origin}
                  key={stage.connectParams.token}
                  token={stage.connectParams.token}
                  protocol={stage.protocol}
                  isVisible={isVisible}
                />
              ) : (
                <CenteredNote text={t("collab.stageLoading")} />
              )}
            </>
          ) : iAmPresenter && !draft ? (
            <CenteredNote text={t("collab.youArePresenting")} />
          ) : (
            <CenteredNote text={t("collab.emptyStage")} />
          )}
        </div>
        {membersOpen && detail && (
          <CollabMembersSidebar
            detail={detail}
            onClose={() => setMembersOpen(false)}
            onInvite={() => void openInviteDialog()}
            onControl={changeControl}
            onDismissRequest={dismissControlRequest}
            onRemoveMember={removeMember}
            onRemoveGuests={removeGuests}
          />
        )}
      </div>

      {/* Present dialog */}

      <InlineView
        open={presentOpen}
        onOpenChange={setPresentOpen}
        title={t("collab.presentTitle")}
      >
        <Input
          aria-label={t("collab.searchHosts")}
          placeholder={t("collab.searchHosts")}
          value={hostSearch}
          onChange={(event) => setHostSearch(event.target.value)}
        />
        <div className="flex flex-col gap-1">
          {presentLoading && (
            <div className="flex justify-center py-4">
              <Loader2 className="size-4 animate-spin text-muted-foreground" />
            </div>
          )}
          {!presentLoading && filteredHosts.length === 0 && (
            <CenteredNote text={t("collab.noHostsFound")} />
          )}
          {filteredHosts.map((host) => {
            const protocols = hostProtocols(
              host as unknown as PluginHostRecord,
            ).filter(isSharedProtocol);
            if (protocols.length === 0) return null;
            return (
              <div
                key={host.id}
                className="flex items-center gap-2 px-2 py-1.5 border border-border"
              >
                <span className="flex-1 text-xs truncate">{host.name}</span>
                {protocols.map((protocol) => (
                  <Button
                    key={protocol}
                    size="sm"
                    variant="outline"
                    className="h-8 text-xs uppercase"
                    onClick={() => choosePresent(host, protocol)}
                  >
                    {protocol}
                  </Button>
                ))}
              </div>
            );
          })}
        </div>
      </InlineView>

      {/* Invite dialog */}

      <InlineView
        open={inviteOpen}
        onOpenChange={setInviteOpen}
        title={t("collab.inviteTitle")}
        footer={
          <FormFooter
            onCancel={() => setInviteOpen(false)}
            onSave={() => void handleInvite()}
            saveLabel={t("collab.invite")}
            disabled={inviteSelection.size === 0 && roleSelection.size === 0}
          />
        }
      >
        <Input
          aria-label={t("collab.searchUsers")}
          placeholder={t("collab.searchUsers")}
          value={inviteSearch}
          onChange={(event) => setInviteSearch(event.target.value)}
        />
        <div className="flex flex-col gap-1">
          {roles.length > 0 && (
            <span className="text-[9px] font-semibold uppercase tracking-widest text-muted-foreground">
              {t("collab.roles")}
            </span>
          )}
          {roles.map((role) => (
            <label
              key={role.id}
              className="flex cursor-pointer items-center gap-2 border border-border px-2 py-1.5 text-xs hover:bg-muted/40"
            >
              <Checkbox
                checked={roleSelection.has(role.id)}
                onCheckedChange={(checked) => {
                  setRoleSelection((prev) => {
                    const next = new Set(prev);
                    if (checked === true) next.add(role.id);
                    else next.delete(role.id);
                    return next;
                  });
                }}
              />
              {role.displayName || role.name}
            </label>
          ))}
          <span className="text-[9px] font-semibold uppercase tracking-widest text-muted-foreground">
            {t("collab.users")}
          </span>
          {invitableUsers.map((user) => (
            <label
              key={user.id}
              className="flex cursor-pointer items-center gap-2 border border-border px-2 py-1.5 text-xs hover:bg-muted/40"
            >
              <Checkbox
                checked={inviteSelection.has(user.id)}
                onCheckedChange={(checked) => {
                  setInviteSelection((prev) => {
                    const next = new Set(prev);
                    if (checked === true) next.add(user.id);
                    else next.delete(user.id);
                    return next;
                  });
                }}
              />
              {user.username}
            </label>
          ))}
        </div>
      </InlineView>
    </div>
  );
}

function CenteredNote({ text }: { text: string }) {
  return (
    <div className="flex h-full items-center justify-center">
      <p className="text-sm text-muted-foreground">{text}</p>
    </div>
  );
}
