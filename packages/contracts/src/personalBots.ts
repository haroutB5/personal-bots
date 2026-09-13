import * as Schema from "effect/Schema";

import { ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ModelSelection } from "./orchestration.ts";

export const PersonalBotId = TrimmedNonEmptyString.pipe(Schema.brand("PersonalBotId"));
export type PersonalBotId = typeof PersonalBotId.Type;

export const BotAvatarShape = Schema.Literals([
  "blob",
  "roundedSquare",
  "pill",
  "triangle",
  "roundedHexagon",
  "scallopedCloud",
  "droplet",
]);
export type BotAvatarShape = typeof BotAvatarShape.Type;

export const BotAvatarColor = Schema.String.check(Schema.isPattern(/^#[0-9A-Fa-f]{6}$/));
export type BotAvatarColor = typeof BotAvatarColor.Type;

export const PersonalBot = Schema.Struct({
  botId: PersonalBotId,
  name: Schema.String,
  description: Schema.String,
  instructions: Schema.String,
  avatarShape: BotAvatarShape,
  avatarColor: BotAvatarColor,
  modelSelection: ModelSelection,
  enabled: Schema.Boolean,
  sortOrder: Schema.Number,
  createdAt: Schema.DateTimeUtcFromString,
  updatedAt: Schema.DateTimeUtcFromString,
});
export type PersonalBot = typeof PersonalBot.Type;

export const PersonalBotThread = Schema.Struct({
  botId: PersonalBotId,
  threadId: ThreadId,
  createdAt: Schema.DateTimeUtcFromString,
  archivedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
});
export type PersonalBotThread = typeof PersonalBotThread.Type;

export const PersonalBotCreateInput = Schema.Struct({
  botId: PersonalBotId,
  name: Schema.String,
  description: Schema.String,
  instructions: Schema.String,
  avatarShape: BotAvatarShape,
  avatarColor: BotAvatarColor,
  modelSelection: ModelSelection,
});
export type PersonalBotCreateInput = typeof PersonalBotCreateInput.Type;

export const PersonalBotUpdateInput = Schema.Struct({
  botId: PersonalBotId,
  name: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  instructions: Schema.optional(Schema.String),
  avatarShape: Schema.optional(BotAvatarShape),
  avatarColor: Schema.optional(BotAvatarColor),
  modelSelection: Schema.optional(ModelSelection),
  enabled: Schema.optional(Schema.Boolean),
  sortOrder: Schema.optional(Schema.Number),
});
export type PersonalBotUpdateInput = typeof PersonalBotUpdateInput.Type;

export const PersonalBotDeleteInput = Schema.Struct({
  botId: PersonalBotId,
});
export type PersonalBotDeleteInput = typeof PersonalBotDeleteInput.Type;

export const PersonalBotCreateThreadInput = Schema.Struct({
  botId: PersonalBotId,
  threadId: ThreadId,
});
export type PersonalBotCreateThreadInput = typeof PersonalBotCreateThreadInput.Type;

export const PersonalBotArchiveThreadInput = Schema.Struct({
  threadId: ThreadId,
  archived: Schema.Boolean,
});
export type PersonalBotArchiveThreadInput = typeof PersonalBotArchiveThreadInput.Type;

export const PersonalBotsListResult = Schema.Struct({
  bots: Schema.Array(PersonalBot),
  threads: Schema.Array(PersonalBotThread),
  personalProjectId: Schema.NullOr(ProjectId),
});
export type PersonalBotsListResult = typeof PersonalBotsListResult.Type;

export class PersonalBotsError extends Schema.TaggedError<PersonalBotsError>()(
  "PersonalBotsError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {}
