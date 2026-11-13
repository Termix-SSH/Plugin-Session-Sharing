/**
 * The Termix page this plugin runs in. Inside a plugin frame the location is
 * the frame page under /plugin-assets/, so guest links would point there.
 */
export function appPageUrl(href: string = window.location.href): string {
  const url = new URL(href);
  const at = url.pathname.indexOf("/plugin-assets/");
  if (at >= 0) {
    url.pathname = url.pathname.slice(0, at + 1);
    url.search = "";
    url.hash = "";
  }
  return url.toString();
}
