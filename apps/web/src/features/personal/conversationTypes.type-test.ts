import type {
  ChatMessage as PackageChatMessage,
  ProposedPlan as PackageProposedPlan,
  TimelineEntry as PackageTimelineEntry,
  WorkLogEntry as PackageWorkLogEntry,
} from "@hbots/personal-client/conversation/types";

import type { TimelineEntry, WorkLogEntry } from "~/session-logic";
import type { ChatMessage, ProposedPlan } from "~/types";

/**
 * The package declares structural copies because it cannot import the web
 * app's types. These assertions make upstream drift fail the web typecheck
 * instead of surfacing later as a runtime shape mismatch on the phone.
 */
type IsAssignable<From, To> = [From] extends [To] ? true : false;
type Assert<T extends true> = T;

type ChatMessageMatches = Assert<IsAssignable<ChatMessage, PackageChatMessage>>;
type ProposedPlanMatches = Assert<IsAssignable<ProposedPlan, PackageProposedPlan>>;
type TimelineEntryMatches = Assert<IsAssignable<TimelineEntry, PackageTimelineEntry>>;
type WorkLogEntryMatches = Assert<IsAssignable<WorkLogEntry, PackageWorkLogEntry>>;

export type { ChatMessageMatches, ProposedPlanMatches, TimelineEntryMatches, WorkLogEntryMatches };
