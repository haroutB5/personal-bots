/** "chip" marks a switch between chats of one bot: no page slide, the transcript rises instead. */
export type ChatEntry = "chip";

export function chatStackAnimation(entry: ChatEntry | undefined): "none" | "ios_from_right" {
  return entry === "chip" ? "none" : "ios_from_right";
}
