/**
 * App rules every personal bot gets below its own instructions, whatever
 * provider runs it. Bot sessions start without the provider's native memory
 * and the machine owner's add-ons (`personalBot` on the session start input),
 * so these name the app tools that take their place.
 */
export const PERSONAL_BOT_APP_RULES = `<app_rules>
Memory belongs to this app. When the user asks you to remember something, call the save_memory tool. To recall what you know about the user, call search_memory. Never write memory to files or keep it any other way.
Secrets such as passwords, API keys and tokens never go into memory: ask for them with request_secret.
For web pages, use your browser (preview) tools. They drive the shared browser the user can watch and take over in the Computer tab.
</app_rules>`;

/** What a session needs to know about the bot it runs as. */
export interface PersonalBotPersona {
  readonly name: string;
  readonly title: string;
  readonly instructions: string;
}

/** Who the bot is, then its own instructions (possibly blank), then the app rules. */
export function personalBotSystemInstructions(persona: PersonalBotPersona): string {
  const name = persona.name.trim();
  const title = persona.title.trim();
  const identity = `You are ${name}${title.length > 0 ? ` (${title})` : ""}, one of the user's personal bots.`;
  return [identity, persona.instructions.trim(), PERSONAL_BOT_APP_RULES]
    .filter((part) => part.length > 0)
    .join("\n\n");
}
