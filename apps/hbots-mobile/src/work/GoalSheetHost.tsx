import { buildProjectCards } from "@hbots/personal-client/work/projectCards";
import { buildRunningView, type GoalNowRow } from "@hbots/personal-client/work/nowLine";
import {
  buildWorkNow,
  buildWorkTimeline,
  workChatTurns,
  workRangeMs,
} from "@hbots/personal-client/work/workTimeline";
import type { PersonalBot, PersonalTask } from "@t3tools/contracts";
import { useEffect, useMemo, useState } from "react";

import type { NativePersonal } from "../personal/nativePersonalClient";
import { useBotShells } from "../personal/useBotShells";
import { useWorkingThreads } from "../working/useWorkingThreads";
import { ProjectSheet } from "./ProjectSheet";

const NO_TASKS: ReadonlyMap<string, PersonalTask> = new Map();
const NO_ROWS: ReadonlyArray<GoalNowRow> = [];

function useMinuteNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

/**
 * The goal sheet for a chat screen, with the same record, live rows and history
 * the Work tab's sheet shows. A screen mounts it only while a goal is open, so
 * its reads cost nothing until a tag or a pill is tapped.
 */
export function GoalSheetHost({
  native,
  projectId,
  onClose,
  onOpenTask,
  onOpenChat,
}: {
  readonly native: NativePersonal;
  readonly projectId: string;
  readonly onClose: () => void;
  readonly onOpenTask: (taskId: string) => void;
  readonly onOpenChat: (botId: string, threadId: string) => void;
}) {
  const environmentId = native.environmentId;
  const botsQuery = native.bots.usePersonalBotsList(environmentId);
  const { shells } = useBotShells(native, environmentId);
  const working = useWorkingThreads(native);
  const feed = native.automation.usePersonalTasks(environmentId).tasks;
  const projectsQuery = native.automation.usePersonalProjects(environmentId);
  const history = native.automation.usePersonalProjectHistory(environmentId, projectId);
  const now = useMinuteNow();

  const bots = botsQuery.data?.bots;
  const links = botsQuery.data?.threads;
  const projects = projectsQuery.data?.projects;
  const tasks = feed ?? NO_TASKS;
  const botMap = useMemo(
    () => new Map<string, PersonalBot>((bots ?? []).map((bot) => [bot.botId, bot])),
    [bots],
  );
  const chatTitles = useMemo(
    () => new Map(shells.map((shell) => [shell.id as string, shell.title])),
    [shells],
  );
  const summary = useMemo(
    () =>
      buildProjectCards({
        projects: projects ?? [],
        tasks: [...tasks.values()],
        nowMs: now,
        botName: (botId) => botMap.get(botId)?.name ?? "Removed bot",
      }),
    [projects, tasks, now, botMap],
  );
  const rows = useMemo<ReadonlyArray<GoalNowRow>>(() => {
    const botIdByThread = new Map<string, string>(
      (links ?? []).map((link) => [link.threadId, link.botId]),
    );
    const timeline = buildWorkTimeline({
      tasks: [...tasks.values()],
      chats: workChatTurns(shells, botIdByThread),
      botIds: (bots ?? []).map((bot) => bot.botId),
      nowMs: now,
      rangeMs: workRangeMs("4h", now),
      chatTitles,
    });
    return (
      buildRunningView({
        now: buildWorkNow(timeline),
        tasks,
        summary,
        notes: working.notes,
        chatTitles,
        botName: (botId) => botMap.get(botId)?.name ?? "Removed bot",
        nowMs: now,
      }).rowsByProject.get(projectId) ?? NO_ROWS
    );
  }, [projectId, links, bots, shells, tasks, chatTitles, summary, working.notes, now, botMap]);

  const card = [...summary.cards, ...summary.more, ...summary.quiet].find(
    (entry) => entry.projectId === projectId,
  );
  const project = (projects ?? []).find((entry) => entry.projectId === projectId) ?? null;

  return (
    <ProjectSheet
      card={card}
      project={project}
      rows={rows}
      history={history.data ?? null}
      tasks={feed}
      botMap={botMap}
      chatTitles={chatTitles}
      nowMs={now}
      onClose={onClose}
      onOpenTask={onOpenTask}
      onOpenChat={onOpenChat}
    />
  );
}
