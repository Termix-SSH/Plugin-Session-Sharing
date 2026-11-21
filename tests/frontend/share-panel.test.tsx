import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { SharePanel } from "../../src/frontend/share-dialog";

vi.mock("../../src/frontend/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/frontend/api")>()),
  getActiveSessionShares: vi.fn(async () => []),
  getDirectory: vi.fn(async () => ({ users: [], roles: [] })),
}));

describe("SharePanel", () => {
  it("shows the share form inline and closes from its header", () => {
    const onClose = vi.fn();
    render(
      <SharePanel
        panelProps={{ hostId: 1, sessionId: "s1", protocol: "ssh" }}
        onClose={onClose}
      />,
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(
      screen.getByRole("button", { name: "sessionSharing.createLinkButton" }),
    ).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: "sessionSharing.close" }),
    );
    expect(onClose).toHaveBeenCalled();
  });

  it("draws nothing without a session to share", () => {
    const { container } = render(
      <SharePanel panelProps={{ hostId: 1 }} onClose={() => {}} />,
    );
    expect(container.innerHTML).toBe("");
  });
});
