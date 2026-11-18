import { describe, expect, it, vi } from "vitest";
import { act, render } from "@testing-library/react";

vi.mock("@termix-ssh/plugin-sdk/frontend", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@termix-ssh/plugin-sdk/frontend")>()),
  useTranslation: () => ({ t: (key: string) => key }),
}));

import { ParticipantsOverlay } from "../../src/frontend/ParticipantsOverlay";

describe("ParticipantsOverlay", () => {
  it("unsubscribes when subscribe answers right away", async () => {
    const unsubscribe = vi.fn();
    const { unmount } = render(
      <ParticipantsOverlay subscribe={() => unsubscribe} />,
    );
    unmount();
    await act(async () => {});
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("unsubscribes when subscribe answers with a Promise, as it does in a frame", async () => {
    const unsubscribe = vi.fn();
    const { unmount } = render(
      <ParticipantsOverlay subscribe={async () => unsubscribe} />,
    );
    expect(() => unmount()).not.toThrow();
    await act(async () => {});
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});
