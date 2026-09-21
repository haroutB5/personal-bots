/**
 * The sensitive-site egress guard's policy: whether a browser action by a bot
 * could carry what it saw on a user-marked sensitive site to a different
 * origin, and so has to wait for the user.
 *
 * Pure. PersonalBrowser supplies what the bot's task has had open and what the
 * user already approved, and decides what to do with a verdict. What this can
 * and cannot see is the browser only: a bot's own shell, its provider's web
 * tools and anything else outside the shared browser are out of reach here.
 */

export interface Exposure {
  /** Sensitive origins the task has had open: the data it may now carry. */
  readonly sources: ReadonlySet<string>;
  /** Approved destinations: an origin, or `script:<origin>` for page scripts there. */
  readonly approved: ReadonlySet<string>;
}

export type EgressIntent =
  /** Top-level navigation to `target` (open, navigate): the URL itself is a channel. */
  | { readonly kind: "navigate"; readonly target: string | null }
  /** Typing or keys on a page whose origin is `page`: text a form could send there. */
  | { readonly kind: "type"; readonly page: string | null }
  /** A model-provided page script, which can read and fetch() anywhere in one call. */
  | { readonly kind: "script"; readonly page: string | null };

export interface EgressApproval {
  /** What an approval is recorded under, so the same destination passes next time. */
  readonly key: string;
  /** The sensitive origins whose content could travel. */
  readonly sources: ReadonlyArray<string>;
  /** Where it could go, as the user should read it. */
  readonly destination: string;
}

/**
 * The same policy for the Connections gateway, a channel the guard above
 * cannot see: a gateway call leaves the app for a vendor API.
 *
 * The browser's shape does not transfer. A gateway call has no page and one
 * fixed outside destination, so an approval here would be a standing permit to
 * send anything this chat read on the bank to GitHub, bought with a question
 * about a repository. This end therefore refuses outright while the thread's
 * exposure set is non-empty and offers nothing to grant.
 *
 * The check is on thread state, never on the arguments, so renaming the
 * operation or rewording a statement changes nothing. Returns what the bot is
 * told, or null when the call may go ahead.
 */
export function connectionEgressRefusal(input: {
  readonly sources: ReadonlyArray<string>;
  readonly vendorName: string;
}): string | null {
  if (input.sources.length === 0) return null;
  return `Blocked: this chat has had ${[...input.sources].toSorted().join(", ")} open, a site the user marked sensitive, so connection tools are closed for the rest of it. They send data to ${input.vendorName}, outside this app, and no approval reopens them; retrying with different arguments will not work. Tell the user in one sentence what you wanted to do there and ask them to do it themselves.`;
}

/** The approval an action needs, or null when it may run unattended. */
export function egressNeedingApproval(input: {
  readonly exposure: Exposure;
  readonly intent: EgressIntent;
  readonly sensitive: ReadonlySet<string>;
}): EgressApproval | null {
  const { exposure, intent, sensitive } = input;
  const sources = [...exposure.sources].toSorted();

  if (intent.kind === "script") {
    const page = intent.page ?? "about:blank";
    const onSensitivePage = intent.page !== null && sensitive.has(intent.page);
    if (!onSensitivePage && sources.length === 0) return null;
    const key = `script:${page}`;
    if (exposure.approved.has(key)) return null;
    return {
      key,
      sources: onSensitivePage ? [...new Set([...sources, page])].toSorted() : sources,
      destination: `a page script on ${page}`,
    };
  }

  if (sources.length === 0) return null;
  const origin = intent.kind === "navigate" ? intent.target : intent.page;
  // A blank page or an unparseable target has nowhere to send anything.
  if (origin === null) return null;
  // Staying on the one sensitive site that was read carries nothing anywhere.
  if (sources.every((source) => source === origin)) return null;
  if (exposure.approved.has(origin)) return null;
  return { key: origin, sources, destination: origin };
}
