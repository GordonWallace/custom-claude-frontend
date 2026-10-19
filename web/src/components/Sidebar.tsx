import { useState } from 'react';
import type { Project, Thread } from '@ccf/shared';
import { createProject, createThread } from '../api';
import { StatusPill } from './StatusPill';

interface Props {
  projects: Project[];
  project: Project | undefined;
  threads: Thread[];
  selectedThreadId: string | undefined;
  onSelectProject: (projectId: string) => void;
  onSelectThread: (threadId: string) => void;
  onProjectCreated: (project: Project) => void;
}

/** Left pane: the project list, and the selected project's threads with live status. */
export function Sidebar({ projects, project, threads, selectedThreadId, onSelectProject, onSelectThread, onProjectCreated }: Props) {
  const [adding, setAdding] = useState(false);
  const workThreads = threads.filter((t) => t.kind === 'thread');

  const newChat = async () => {
    if (project) onSelectThread((await createThread(project.id)).id);
  };

  return (
    <nav className="sidebar" aria-label="Projects and threads">
      <div className="sidebar-section">
        <div className="section-head">
          <h3>Projects</h3>
          <button type="button" className="link" onClick={() => setAdding((a) => !a)}>
            {adding ? 'Cancel' : 'New'}
          </button>
        </div>
        {adding && (
          <NewProject
            onCreated={(p) => {
              setAdding(false);
              onProjectCreated(p);
            }}
          />
        )}
        <ul className="thread-list">
          {projects.map((p) => (
            <li key={p.id}>
              <button
                type="button"
                className={`thread-item${p.id === project?.id ? ' selected' : ''}`}
                onClick={() => onSelectProject(p.id)}
                title={p.workspacePath}
              >
                <span className="thread-title">{p.name}</span>
              </button>
            </li>
          ))}
        </ul>
        {project && (
          <p className="muted small path" title="Workspace (the sessions' working directory)">
            {project.workspacePath}
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
        {workThreads.length === 0 && (
          <p className="muted small">None yet. Ask in the project chat, or start a chat of your own.</p>
        )}
        <ul className="thread-list">
          {workThreads.map((t) => (
            <li key={t.id}>
              <button
                type="button"
                className={`thread-item${t.id === selectedThreadId ? ' selected' : ''}`}
                onClick={() => onSelectThread(t.id)}
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
