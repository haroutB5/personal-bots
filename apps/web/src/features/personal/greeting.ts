/** Default display timezone for the personal shell; instants stay UTC. */
export const PERSONAL_TIME_ZONE = "Europe/London";

export type Greeting = "Morning" | "Afternoon" | "Evening";

/** Wall-clock hour (0-23) of `date` in `timeZone`. */
export function hourInTimeZone(date: Date, timeZone: string = PERSONAL_TIME_ZONE): number {
  const hour = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    hourCycle: "h23",
  })
    .formatToParts(date)
    .find((part) => part.type === "hour")?.value;
  return Number(hour ?? "0") % 24;
}

/** Greeting word by local time: Morning <12, Afternoon <18, Evening otherwise. */
export function greetingFor(date: Date, timeZone: string = PERSONAL_TIME_ZONE): Greeting {
  const hour = hourInTimeZone(date, timeZone);
  if (hour < 12) return "Morning";
  if (hour < 18) return "Afternoon";
  return "Evening";
}

/** "Evening, Harout", or just "Evening" while no display name is set. */
export function greetingLine(
  date: Date,
  displayName: string,
  timeZone: string = PERSONAL_TIME_ZONE,
): string {
  const name = displayName.trim();
  const word = greetingFor(date, timeZone);
  return name.length > 0 ? `${word}, ${name}` : word;
}

/**
 * Subtitle under the greeting. Reflects real state only: work running beats
 * items waiting for review, which beats idle.
 */
export function teamStatusLine(input: {
  readonly botCount: number;
  readonly runningCount: number;
  readonly reviewCount: number;
}): string {
  if (input.botCount === 0) return "Let's set up your team.";
  if (input.runningCount > 0) return "Your team is on it.";
  if (input.reviewCount > 0) return "Something needs your review.";
  return "All quiet.";
}
