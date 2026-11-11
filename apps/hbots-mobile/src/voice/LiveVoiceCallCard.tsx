import { CallCardView } from "./CallCardView";
import { liveCardItem } from "./callViewModel";
import { useCallSession, useCallView } from "./VoiceCallProvider";

export function LiveVoiceCallCard({ threadId }: { readonly threadId: string }) {
  const session = useCallSession();
  const view = useCallView();
  const call = view.call;
  const status = view.snapshot.state.status;
  if (session === null || call === null || call.threadId !== threadId) return null;
  if (status !== "live" && status !== "reconnecting") return null;
  const card = liveCardItem(view, session.session()?.callId ?? "live");
  if (card === null) return null;
  return <CallCardView card={card} live onReturn={() => session.setMinimised(false)} />;
}
