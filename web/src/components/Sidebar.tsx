import { useEffect, useState } from 'react';
import type { Project, Thread } from '@ccf/shared';
import { createProject, createThread, listProjects, listThreads } from '../api';
import { useConnection, useServerEvents } from '../live';
import { StatusPill } from './StatusPill';

interface Props {
  selectedThreadId: string | undefined;
  onSelect: (threadId: string) => void;
}

/** Projects and their threads, with live status. */
export function Sidebar({ selectedThreadId, onSelect }: Props) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState<string>();
  const [threads, setThreads] = useState<Thread[]>([]);
  const [adding, setAdding] = useState(false);
  const { epoch } = useConnection();

  useEffect(() => {
    void listProjects().then((list) => {
      setProjects(list);
      setProjectId((current) => current ?? list[0]?.id);
    });
  }, [epoch]);

  useEffect(() => {
    if (!projectId) return;
    void listThreads(projectId).then((list) => {
      setThreads(list);
      if (!selectedThreadId && list[0]) onSelect(list[0].id);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, epoch]);

  useServerEvents((event) => {
    if (event.type !== 'thread' || event.thread.projectId !== projectId) return;
    setThreads((list) =>
      list.some((t) => t.id === event.thread.id)
        ? list.map((t) => (t.id === event.thread.id ? event.thread : t))
        : [...list, event.thread],
    );
  });

  const newChat = async () => {
    if (!projectId) return;
    onSelect((await createThread(projectId)).id);
  };

  return (
    <nav className="sidebar" aria-label="Projects and threads">
      <div className="sidebar-section">
        <div className="section-head">
          <h3>Project</h3>
          <button type="button" className="link" onClick={() => setAdding((a) => !a)}>
            {adding ? 'Cancel' : 'New'}
          </button>
        </div>
        {adding ? (
          <NewProject
            onCreated={(p) => {
              setProjects((list) => [...list, p]);
              setProjectId(p.id);
              setThreads([]);
              setAdding(false);
            }}
          />
        ) : (
          <select value={projectId} onChange={(e) => setProjectId(e.target.value)} aria-label="Project">
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        )}
        {projectId && !adding && (
          <p className="muted small path" title="Workspace (the sessions' working directory)">
            {projects.find((p) => p.id === projectId)?.workspacePath}
          </p>
        )}
      </div>

      <div className="sidebar-section grow">
        <div className="section-head">
          <h3>Threads</h3>
          <button type="button" className="link" onClick={newChat} data-testid="new-chat">
            New chat
          </button>
        </div>
        <ul className="thread-list">
          {threads.map((t) => (
            <li key={t.id}>
              <button
                type="button"
                className={`thread-item${t.id === selectedThreadId ? ' selected' : ''}`}
                onClick={() => onSelect(t.id)}
              >
                <span className="thread-title">{t.title}</span>
                <StatusPill status={t.status} />
              </button>
            </li>
          ))}
        </ul>
      </div>
    </nav>
  );
}

function NewProject({ onCreated }: { onCreated: (p: Project) => void }) {
  const [name, setName] = useState('');
  const [path, setPath] = useState('');
  const [error, setError] = useState<string>();
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      onCreated(await createProject(name, path));
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <form className="new-project" onSubmit={submit}>
      <input placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} aria-label="Project name" />
      <input
        placeholder="/absolute/path/to/workspace"
        value={path}
        onChange={(e) => setPath(e.target.value)}
        aria-label="Workspace path"
      />
      <button type="submit">Create</button>
      {error && <p className="error small">{error}</p>}
    </form>
  );
}
