import * as DateTime from "effect/DateTime";

import type { PersonalProject } from "@t3tools/contracts";

export const OPEN_PROJECTS_CONTEXT_MAX = 6;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

export const formatSpan = (ms: number): string => {
  const minutes = Math.max(1, Math.round(ms / MINUTE));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.round(ms / HOUR);
  if (hours < 48) return `${hours} h`;
  return `${Math.round(ms / (24 * HOUR))} d`;
};

const stepPart = (project: PersonalProject): string => {
  const total = project.steps.length;
  const doingIndex = project.steps.findIndex((step) => step.state === "doing");
  if (doingIndex === -1) {
    const done = project.steps.filter((step) => step.state === "done").length;
    return done === total ? `all ${total} steps done` : `${done} of ${total} steps done`;
  }
  return `step ${doingIndex + 1} of ${total} (${project.steps[doingIndex]?.label ?? ""})`;
};

const estimatePart = (project: PersonalProject, nowMs: number): string => {
  if (project.estimate === null) return "no estimate";
  const dueMs = DateTime.toEpochMillis(project.estimate.dueAt);
  const ageMs = nowMs - DateTime.toEpochMillis(project.estimate.estimatedAt);
  const age = `estimated ${formatSpan(ageMs)} ago`;
  return dueMs <= nowMs
    ? `overdue by ${formatSpan(nowMs - dueMs)}, ${age}`
    : `about ${formatSpan(dueMs - nowMs)} left, ${age}`;
};

/** One line a lead reads: name, step, estimate and how long it has been quiet. */
export const projectLine = (project: PersonalProject, nowMs: number): string => {
  const state =
    project.state.kind === "open"
      ? `${estimatePart(project, nowMs)}; quiet ${formatSpan(nowMs - DateTime.toEpochMillis(project.lastActivityAt))}`
      : project.state.kind;
  return `${project.name}: ${stepPart(project)}; ${state}`;
};

/** The "Open projects" block of a lead's turn context, or null when it keeps none. */
export const openProjectsContext = (
  projects: ReadonlyArray<PersonalProject>,
  nowMs: number,
): string | null => {
  if (projects.length === 0) return null;
  const shown = projects.slice(0, OPEN_PROJECTS_CONTEXT_MAX);
  const more = projects.length - shown.length;
  return [
    "Open projects (yours, kept with update_project):",
    ...shown.map((project) => `- ${projectLine(project, nowMs)}`),
    ...(more > 0 ? [`- and ${more} more`] : []),
  ].join("\n");
};

/** The line added to a task result that reaches a lead when the task has a project. */
export const projectResultNudge = (projectName: string): string =>
  `Project ${projectName}: update its steps and estimate with update_project.`;
