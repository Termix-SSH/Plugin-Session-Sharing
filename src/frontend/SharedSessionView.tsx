import React, { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "@termix-ssh/plugin-sdk/frontend";
import { useXTerm } from "react-xtermjs";
import { FitAddon } from "@xterm/addon-fit";
import { Eye, Users } from "lucide-react";
import {
  resolveShareLink,
  type ResolvedShareLink,
  type ShareLinkErrorKind,
} from "./api";
import {
  Loader,
  RemoteDisplay,
  useTerminalViewProvider,
  wsUrlForPath,
} from "./shared";
import { ConnectionScreen } from "@termix-ssh/plugin-sdk/ui";
import { linkToken as readLinkToken } from "./link-token";

const PING_INTERVAL_MS = 30000;

interface TerminalWsMessage {
  type: string;
  data?: string;
  [key: string]: unknown;
}

// A shared session link always resolves against the desktop app's embedded
// local backend: joining a session on someone else's remote server is not
// supported from the desktop app.
async function resolveTerminalWsUrl(wsPath: string): Promise<string> {
  const url = await wsUrlForPath(wsPath);
  if (!url) throw new Error("No terminal endpoint is available");
  return url;
}

export interface SessionParticipantInfo {
  isOwner: boolean;
  permissionLevel: "read-write" | "read-only";
  label: string | null;
}

export function ParticipantsBadge({
  participants,
  ownerLabel,
}: {
  participants: SessionParticipantInfo[];
  ownerLabel: string;
}) {
  if (participants.length < 2) return null;
  const names = participants
    .map((participant) =>
      participant.isOwner ? ownerLabel : (participant.label ?? "?"),
    )
    .join(", ");
  return (
    <div
      className="absolute top-3 left-3 z-20 flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium"
      style={{
        backgroundColor: "var(--bg-elevated, rgba(0,0,0,0.6))",
        color: "var(--foreground)",
        border: "1px solid var(--border-base)",
      }}
      title={names}
    >
      <Users className="size-3.5" />
      {participants.length}
    </div>
  );
}

function ReadOnlyBadge({ label }: { label: string }) {
  return (
    <div
      className="absolute top-3 right-3 z-20 flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium"
      style={{
        backgroundColor: "var(--bg-elevated, rgba(0,0,0,0.6))",
        color: "var(--foreground)",
        border: "1px solid var(--border-base)",
      }}
    >
      <Eye className="size-3.5" />
      {label}
    </div>
  );
}

function CenteredMessage({ message }: { message: string }) {
  return <ConnectionScreen status="error" unavailable={{ title: message }} />;
}

interface GuestTerminalProps {
  share: Pick<ResolvedShareLink, "permissionLevel">;
  /** The socket path the backend handed out, query string included. */
  wsPath: string;
  /** Suppress the built-in overlay badges when the host page renders its own. */
  hideBadges?: boolean;
  onParticipantsChange?: (participants: SessionParticipantInfo[]) => void;
}

/**
 * The terminal plugin draws the shared terminal when it offers to: a view in
 * a frame can't open another plugin's socket. Older ones leave it to us.
 */
export function GuestTerminalView(props: GuestTerminalProps) {
  const Provider = useTerminalViewProvider();
  return Provider ? (
    <ProvidedGuestTerminal {...props} Provider={Provider} />
  ) : (
    <OwnGuestTerminal {...props} />
  );
}

function GuestTerminalChrome({
  share,
  hideBadges,
  participants,
  ended,
  bar = false,
  children,
}: {
  share: Pick<ResolvedShareLink, "permissionLevel">;
  hideBadges: boolean;
  participants: SessionParticipantInfo[];
  ended: string | null;
  /** Badges in a row above, for a terminal another plugin draws on top. */
  bar?: boolean;
  children: React.ReactNode;
}) {
  const { t } = useTranslation();
  if (bar) {
    const names = participants
      .map((participant) =>
        participant.isOwner
          ? t("sessionSharing.guestView.ownerLabel")
          : (participant.label ?? "?"),
      )
      .join(", ");
    const showBar =
      !hideBadges &&
      (participants.length > 1 || share.permissionLevel === "read-only");
    return (
      <div className="flex w-full h-full flex-col">
        {showBar && (
          <div className="flex shrink-0 items-center justify-end gap-3 border-b border-border px-3 py-1 text-xs text-muted-foreground">
            {participants.length > 1 && (
              <span className="flex items-center gap-1.5" title={names}>
                <Users className="size-3.5" />
                {participants.length}
              </span>
            )}
            {share.permissionLevel === "read-only" && (
              <span className="flex items-center gap-1.5">
                <Eye className="size-3.5" />
                {t("sessionSharing.guestView.readOnlyBadge")}
              </span>
            )}
          </div>
        )}
        <div className="relative min-h-0 flex-1">
          {ended ? <CenteredMessage message={ended} /> : children}
        </div>
      </div>
    );
  }
  return (
    <div className="relative w-full h-full">
      {!hideBadges && (
        <>
          <ParticipantsBadge
            participants={participants}
            ownerLabel={t("sessionSharing.guestView.ownerLabel")}
          />
          {share.permissionLevel === "read-only" && (
            <ReadOnlyBadge
              label={t("sessionSharing.guestView.readOnlyBadge")}
            />
          )}
        </>
      )}
      {ended && (
        <div
          className="absolute inset-0 z-30 flex items-center justify-center"
          style={{ backgroundColor: "var(--bg-base)" }}
        >
          <CenteredMessage message={ended} />
        </div>
      )}
      {children}
    </div>
  );
}

function ProvidedGuestTerminal({
  share,
  wsPath,
  hideBadges = false,
  onParticipantsChange,
  Provider,
}: GuestTerminalProps & {
  Provider: React.ComponentType<Record<string, unknown>>;
}) {
  const { t } = useTranslation();
  const [ended, setEnded] = useState<string | null>(null);
  const [participants, setParticipants] = useState<SessionParticipantInfo[]>(
    [],
  );
  const onParticipantsChangeRef = useRef(onParticipantsChange);
  onParticipantsChangeRef.current = onParticipantsChange;
  const onParticipants = useCallback((list: unknown) => {
    if (!Array.isArray(list)) return;
    const next = list as SessionParticipantInfo[];
    setParticipants(next);
    onParticipantsChangeRef.current?.(next);
  }, []);
  const onEnded = useCallback(
    () =>
      setEnded((prev) => prev ?? t("sessionSharing.guestView.sessionEnded")),
    [t],
  );
  return (
    <GuestTerminalChrome
      share={share}
      hideBadges={hideBadges}
      participants={participants}
      ended={ended}
      bar
    >
      <Provider
        query={wsPath.split("?", 2)[1] ?? ""}
        readWrite={share.permissionLevel === "read-write"}
        onParticipants={onParticipants}
        onEnded={onEnded}
      />
    </GuestTerminalChrome>
  );
}

function OwnGuestTerminal({
  share,
  wsPath,
  hideBadges = false,
  onParticipantsChange,
}: GuestTerminalProps) {
  const { t } = useTranslation();
  const { instance: terminal, ref: xtermRef } = useXTerm();
  const [ended, setEnded] = useState<string | null>(null);
  const [participants, setParticipants] = useState<SessionParticipantInfo[]>(
    [],
  );
  const wsRef = useRef<WebSocket | null>(null);
  const pingIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const onParticipantsChangeRef = useRef(onParticipantsChange);
  onParticipantsChangeRef.current = onParticipantsChange;

  useEffect(() => {
    if (!terminal || !xtermRef.current) return;

    terminal.options.theme = { background: "#0c0d0b" };

    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(xtermRef.current);
    fitAddon.fit();

    let sharedSize: { cols: number; rows: number } | null = null;
    const resizeObserver = new ResizeObserver(() => {
      if (sharedSize) terminal.resize(sharedSize.cols, sharedSize.rows);
      else fitAddon.fit();
    });
    resizeObserver.observe(xtermRef.current);

    let cancelled = false;
    let ws: WebSocket | null = null;

    // In a frame this fails: only the terminal plugin may open its socket,
    // and its view takes over once its part arrives.
    void resolveTerminalWsUrl(wsPath)
      .catch(() => null)
      .then((url) => {
        if (cancelled || !url) return;
        ws = new WebSocket(url);
        wsRef.current = ws;

        ws.onopen = () => {
          pingIntervalRef.current = setInterval(() => {
            if (ws && ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: "ping" }));
            }
          }, PING_INTERVAL_MS);
        };

        ws.onmessage = (event) => {
          let msg: TerminalWsMessage;
          try {
            msg = JSON.parse(event.data);
          } catch {
            return;
          }

          switch (msg.type) {
            case "resized": {
              const { cols, rows } = msg;
              if (
                typeof cols === "number" &&
                typeof rows === "number" &&
                Number.isInteger(cols) &&
                Number.isInteger(rows) &&
                cols > 0 &&
                rows > 0
              ) {
                sharedSize = { cols, rows };
                terminal.resize(cols, rows);
              }
              break;
            }
            case "data":
              if (typeof msg.data === "string") terminal.write(msg.data);
              break;
            case "participants":
              if (Array.isArray(msg.participants)) {
                const next = msg.participants as SessionParticipantInfo[];
                setParticipants(next);
                onParticipantsChangeRef.current?.(next);
              }
              break;
            case "sessionExpired":
            case "sessionTerminatedByOwner":
            case "session_ended":
              setEnded(t("sessionSharing.guestView.sessionEnded"));
              break;
            default:
              break;
          }
        };

        ws.onclose = () => {
          setEnded(
            (prev) => prev ?? t("sessionSharing.guestView.sessionEnded"),
          );
        };

        if (share.permissionLevel === "read-write") {
          terminal.onData((data) => {
            if (ws && ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: "input", data }));
            }
          });
        }
      });

    return () => {
      cancelled = true;
      resizeObserver.disconnect();
      if (pingIntervalRef.current) clearInterval(pingIntervalRef.current);
      ws?.close();
      wsRef.current = null;
    };
    // Deliberately runs once terminal mounts - share/token/permission are stable for the view's lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [terminal, wsPath]);

  return (
    <GuestTerminalChrome
      share={share}
      hideBadges={hideBadges}
      participants={participants}
      ended={ended}
    >
      <div ref={xtermRef} className="w-full h-full" />
    </GuestTerminalChrome>
  );
}

function GuestGuacamoleView({ share }: { share: ResolvedShareLink }) {
  const { t } = useTranslation();
  const [connectionError, setConnectionError] = useState<string | null>(null);

  if (!share.connectParams?.token) {
    return (
      <CenteredMessage message={t("sessionSharing.guestView.linkInvalid")} />
    );
  }

  return (
    <div className="relative w-full h-full">
      {share.permissionLevel === "read-only" && (
        <ReadOnlyBadge label={t("sessionSharing.guestView.readOnlyBadge")} />
      )}
      {connectionError && (
        <div
          className="absolute inset-0 z-30 flex items-center justify-center"
          style={{ backgroundColor: "var(--bg-base)" }}
        >
          <CenteredMessage message={connectionError} />
        </div>
      )}
      <RemoteDisplay
        token={share.connectParams.token}
        protocol={share.protocol}
        isVisible={true}
        onError={(err) => setConnectionError(err)}
      />
    </div>
  );
}

export default function SharedSessionView({
  params,
}: {
  params?: URLSearchParams;
}) {
  const { t } = useTranslation();
  const [share, setShare] = useState<ResolvedShareLink | null>(null);
  const [linkToken, setLinkToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const token = readLinkToken(params);

  useEffect(() => {
    if (!token) {
      setError(t("sessionSharing.guestView.linkInvalid"));
      setLoading(false);
      return;
    }
    setLinkToken(token);

    resolveShareLink(token)
      .then((resolved) => setShare(resolved))
      .catch((err) => {
        const kind = (err as { kind?: ShareLinkErrorKind })?.kind;
        if (kind === "rate-limited") {
          setError(t("sessionSharing.guestView.rateLimited"));
        } else {
          setError(t("sessionSharing.guestView.linkInvalid"));
        }
      })
      .finally(() => setLoading(false));
  }, [t, token]);

  return (
    <div
      className="fixed inset-0 flex flex-col"
      style={{ backgroundColor: "var(--bg-base)" }}
    >
      <div className="relative flex-1 min-h-0">
        {loading && <Loader message={t("sessionSharing.guestView.loading")} />}
        {!loading && error && <CenteredMessage message={error} />}
        {!loading &&
          !error &&
          share &&
          linkToken &&
          (share.protocol === "ssh" ? (
            <GuestTerminalView share={share} wsPath={share.wsPath} />
          ) : (
            <GuestGuacamoleView share={share} />
          ))}
      </div>
    </div>
  );
}
