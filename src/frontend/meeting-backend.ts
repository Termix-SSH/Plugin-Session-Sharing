import type { TermixApp } from "@termix-ssh/plugin-sdk/frontend";
import { createMeetingApi } from "./meeting-api";

export type MeetingBackend = Awaited<ReturnType<typeof connectMeetings>>;

/** A room, its hosts and its sockets must all belong to the same backend. */
export async function connectMeetings(app: TermixApp) {
  const remoteUrl = app.desktop.available
    ? await app.desktop.remoteServerUrl()
    : null;
  const key = remoteUrl?.replace(/\/+$/, "") || "local";
  const origin = remoteUrl ? ("remote" as const) : ("local" as const);
  const publicUrl =
    (await configuredPublicUrl(app, origin)) ||
    remoteUrl ||
    (!app.desktop.available ? window.location.href : null);
  const assertCurrent = async () => {
    const current = app.desktop.available
      ? await app.desktop.remoteServerUrl()
      : null;
    if ((current?.replace(/\/+$/, "") || "local") !== key) {
      throw new Error(app.t("collab.serverChanged"));
    }
  };
  return {
    key,
    origin,
    publicUrl,
    assertCurrent,
    api: createMeetingApi(app.apiFor(origin), assertCurrent),
  };
}

export function meetingGuestUrl(
  publicUrl: string | null,
  token: string,
): string | null {
  return guestViewUrl(publicUrl, "collab-guest", token);
}

/** A guest link on a server others can open, never a file:// desktop page. */
export function guestViewUrl(
  publicUrl: string | null,
  view: string,
  token: string,
): string | null {
  if (!publicUrl) return null;
  const url = new URL(publicUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  url.search = "";
  url.hash = "";
  url.searchParams.set("view", view);
  url.searchParams.set("token", token);
  return url.toString();
}

/** The admin's public URL for guest links on that backend, if set. */
async function configuredPublicUrl(
  app: TermixApp,
  origin: "local" | "remote" | undefined,
): Promise<string | null> {
  try {
    const { data } = await app
      .apiFor(origin ?? "local")
      .get<{ url: string | null }>("/public-url");
    return typeof data?.url === "string" && data.url ? data.url : null;
  } catch {
    return null;
  }
}

/** Where guests reach a session that runs on the given backend. */
export async function sessionPublicUrl(
  app: TermixApp,
  origin: "local" | "remote" | undefined,
): Promise<string | null> {
  if (!app.desktop.available) {
    return (await configuredPublicUrl(app, origin)) || window.location.href;
  }
  if (origin !== "remote") return null;
  return (
    (await configuredPublicUrl(app, origin)) ||
    (await app.desktop.remoteServerUrl()) ||
    null
  );
}
