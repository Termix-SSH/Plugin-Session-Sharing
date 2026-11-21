/**
 * A guest link's token. The shell passes the page's query as `params`; read
 * from the address bar only on a core that doesn't, since a view in a frame
 * sees its frame's address there.
 */
export function linkToken(params?: URLSearchParams): string | null {
  return (
    params?.get("token") ??
    new URLSearchParams(window.location.search).get("token")
  );
}
