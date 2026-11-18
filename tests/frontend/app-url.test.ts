import { describe, expect, it } from "vitest";
import { appPageUrl } from "../../src/frontend/app-url";
import { guestViewUrl } from "../../src/frontend/meeting-backend";

describe("app page url", () => {
  it("points a framed plugin back at the Termix page", () => {
    expect(
      appPageUrl(
        "https://termix.example/plugin-assets/session-sharing/_frame/index.html#role=view",
      ),
    ).toBe("https://termix.example/");
    expect(
      appPageUrl(
        "https://example.com/termix/plugin-assets/session-sharing/_frame/index.html",
      ),
    ).toBe("https://example.com/termix/");
  });

  it("keeps the page url when not in a frame", () => {
    expect(appPageUrl("https://termix.example/?view=hosts")).toBe(
      "https://termix.example/?view=hosts",
    );
  });

  it("makes guest links on the app page from a frame", () => {
    const base = appPageUrl(
      "http://localhost:5173/plugin-assets/session-sharing/_frame/index.html",
    );
    expect(guestViewUrl(base, "shared", "tok")).toBe(
      "http://localhost:5173/?view=shared&token=tok",
    );
  });
});
