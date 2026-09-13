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

/** A bot's own instructions (possibly blank) followed by the app rules. */
export function personalBotSystemInstructions(botInstructions: string): string {
  const own = botInstructions.trim();
  return own.length > 0 ? `${own}\n\n${PERSONAL_BOT_APP_RULES}` : PERSONAL_BOT_APP_RULES;
}
