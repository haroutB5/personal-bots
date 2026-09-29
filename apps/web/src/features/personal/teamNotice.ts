/** What the Team screen says the moment a team has been made, and which team to bring into view. */
export interface TeamNotice {
  readonly message: string;
  readonly team: string;
}

/**
 * Handed from the New team screen to the Team screen in memory and taken
 * exactly once. A router state key would ride through history (and through
 * the Bots back-stack rewrites), so a reload or Back would announce it again.
 */
let pendingNotice: TeamNotice | null = null;

export function setTeamNotice(notice: TeamNotice): void {
  pendingNotice = notice;
}

export function takeTeamNotice(): TeamNotice | null {
  const notice = pendingNotice;
  pendingNotice = null;
  return notice;
}
