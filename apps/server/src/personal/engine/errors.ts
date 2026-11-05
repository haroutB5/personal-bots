/**
 * Errors the personal ports expose. The port hides v1 dispatch and projection
 * errors; callers get the operation that failed and a detail they can log.
 *
 * @module personal/engine/errors
 */
import * as Schema from "effect/Schema";

/** The human line from a tagged or plain failure, for a port error detail. */
export const failureDetail = (failure: unknown): string => {
  if (typeof failure === "object" && failure !== null && "message" in failure) {
    const message = (failure as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return String(failure);
};

export class PersonalEngineError extends Schema.TaggedError<PersonalEngineError>()(
  "PersonalEngineError",
  {
    operation: Schema.String,
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `personal engine ${this.operation} failed: ${this.detail}`;
  }
}

export class PersonalProvidersError extends Schema.TaggedError<PersonalProvidersError>()(
  "PersonalProvidersError",
  {
    operation: Schema.String,
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `personal providers ${this.operation} failed: ${this.detail}`;
  }
}
