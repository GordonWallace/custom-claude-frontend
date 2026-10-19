import { useEffect, useState } from 'react';
import type { Project, Thread } from '@ccf/shared';
import { listProjects, listThreads } from './api';
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
