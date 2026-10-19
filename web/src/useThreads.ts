import { useEffect, useState } from 'react';
import type { Project, ProjectUsage, Thread } from '@ccf/shared';
import { getUsage, listProjects, listThreads } from './api';
import { useConnection, useServerEvents } from './live';

/** All projects, refetched after a reconnect. */
export function useProjects(): [Project[], (p: Project) => void] {
  const [projects, setProjects] = useState<Project[]>([]);
  const { epoch } = useConnection();
  useEffect(() => {
    void listProjects().then(setProjects);
  }, [epoch]);
  return [projects, (p) => setProjects((list) => [...list, p])];
}

/** A project's threads (the coordinator included), kept live from thread events. */
export function useThreads(projectId: string | undefined): Thread[] {
  const [threads, setThreads] = useState<Thread[]>([]);
  const { epoch } = useConnection();

  useEffect(() => {
    setThreads([]);
    if (projectId) void listThreads(projectId).then(setThreads);
  }, [projectId, epoch]);

  useServerEvents((event) => {
    if (event.type !== 'thread' || event.thread.projectId !== projectId) return;
    setThreads((list) =>
      list.some((t) => t.id === event.thread.id)
        ? list.map((t) => (t.id === event.thread.id ? event.thread : t))
        : [...list, event.thread],
    );
  });

  return threads;
}

/** Estimated plan usage per thread and for the project, refetched whenever one of its runs ends. */
export function useProjectUsage(projectId: string | undefined): ProjectUsage | null {
  const [usage, setUsage] = useState<ProjectUsage | null>(null);
  const [version, setVersion] = useState(0);
  const { epoch } = useConnection();

  useEffect(() => {
    if (!projectId) return;
    void getUsage(projectId).then(setUsage, () => setUsage(null));
  }, [projectId, epoch, version]);

  useServerEvents((event) => {
    if (event.type === 'message' && event.message.kind === 'run_ended') setVersion((v) => v + 1);
  });

  return usage;
}
