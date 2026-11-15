import { useEffect, useState } from "react";
import { useTranslation } from "@termix-ssh/plugin-sdk/frontend";
import {
  ParticipantsBadge,
  type SessionParticipantInfo,
} from "./SharedSessionView";

export interface ParticipantsOverlayProps {
  // In a frame this call crosses to the shell, so it answers with a Promise.
  subscribe: (
    listener: (message: { type: string; [key: string]: unknown }) => void,
  ) => (() => void) | Promise<() => void>;
}

export function ParticipantsOverlay({ subscribe }: ParticipantsOverlayProps) {
  const { t } = useTranslation();
  const [participants, setParticipants] = useState<SessionParticipantInfo[]>(
    [],
  );

  useEffect(() => {
    const subscribed = subscribe((message) => {
      if (
        message.type === "participants" &&
        Array.isArray(message.participants)
      ) {
        setParticipants(message.participants as SessionParticipantInfo[]);
      } else if (message.type === "session_closed") {
        setParticipants([]);
      }
    });
    return () => {
      if (typeof subscribed === "function") {
        subscribed();
        return;
      }
      void Promise.resolve(subscribed)
        .then((unsubscribe) => {
          if (typeof unsubscribe === "function") unsubscribe();
        })
        .catch(() => {});
    };
  }, [subscribe]);

  return (
    <ParticipantsBadge
      participants={participants}
      ownerLabel={t("sessionSharing.guestView.ownerLabel")}
    />
  );
}
