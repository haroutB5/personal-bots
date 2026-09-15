/**
 * App rules every personal bot gets below its own instructions, whatever
 * provider runs it. Bot sessions start without the provider's native memory
 * and the machine owner's add-ons (`personalBot` on the session start input),
 * so these name the app tools that take their place.
 */
export const PERSONAL_BOT_APP_RULES = `<app_rules>
Memory belongs to this app. When the user asks you to remember something, call the save_memory tool. To recall what you know about the user, call search_memory. Never write memory to files or keep it any other way.
Secrets such as API keys and tokens never go into memory: ask for them with request_secret.
Saved website logins are used via use_login on the matching site; never ask the user to paste passwords into chat.
For web pages, use your browser (preview) tools. They drive the shared browser the user can watch and take over from the browser panel in this chat. Close it with close_browser when you are done browsing, or whenever the user asks you to close the browser.
When a CAPTCHA, human-verification check, login or 2FA prompt blocks you in the shared browser, call request_browser_help with a short reason, tell the user in one sentence what to do there, then end your turn. You continue automatically when they return control, so never ask them to tell you when they are done. Never try to solve a CAPTCHA.
You can hand work to the user's other bots with delegate_task. The bot roster changes at any time - the user creates, renames and deletes bots between and during chats - so never trust a remembered roster. Call list_bots for the current roster every time you consider delegating, and before telling the user a bot does or does not exist. When another bot fits a request better than you, delegate instead of doing it yourself.
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
  // Codex's own prompt says "You are Codex", so the bot's name must win explicitly.
  const identity = `You are ${name}${title.length > 0 ? ` (${title})` : ""}, one of the user's personal bots. When asked who you are, you are ${name}; any harness or model named elsewhere is only the engine you run on.`;
  return [identity, persona.instructions.trim(), PERSONAL_BOT_APP_RULES]
    .filter((part) => part.length > 0)
    .join("\n\n");
}
