import { useEffect, useState } from 'react';
import type { AuthStatus, RunnerMode } from '@ccf/shared';
import { getAuth, logout, subscribeLoginRequired } from './api';
import { Login } from './components/Login';
import { ModeBadge } from './components/ModeBadge';
import { NodesView } from './components/NodesView';
import { ModeOptions } from './components/ModeOptions';
import { SettingsPanel } from './components/SettingsPanel';
import { Sidebar } from './components/Sidebar';
import { SwitchDialog } from './components/SwitchDialog';
import { ThreadView } from './components/ThreadView';
import { useRuntime } from './useRuntime';
import { useNodes, useProjects, useProjectUsage, useThreads } from './useThreads';

/** Asks for the password on another device when remote access needs it; this machine never logs in. */
export function App() {
  const [auth, setAuth] = useState<AuthStatus>();
  const [needLogin, setNeedLogin] = useState(false);
  useEffect(() => {
    getAuth().then(setAuth, () => setAuth(undefined));
    return subscribeLoginRequired(() => setNeedLogin(true));
  }, []);
  if (needLogin || (auth && !auth.loopback && !auth.authenticated && auth.remoteAccess)) {
    return <Login passwordSet={auth?.passwordSet ?? true} />;
  }
  return <Workspace auth={auth} />;
}

function Workspace({ auth }: { auth: AuthStatus | undefined }) {
  const { state, connected, setState, refresh } = useRuntime();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [switchTo, setSwitchTo] = useState<RunnerMode>();
  const [route, navigate, navigateNodes] = useRoute();
  const [projects, addProject] = useProjects();
  const project = projects.find((p) => p.id === route.projectId) ?? projects[0];
  const threads = useThreads(project?.id);
  const usage = useProjectUsage(project?.id);
  const threadId = route.projectId === project?.id ? route.threadId : undefined;
  const nodes = useNodes();

  const firstLaunch = state !== null && state.mode === null;

  return (
    <div className="app">
      <header className="header">
        <span className="brand">Custom Claude Frontend</span>
        <ModeBadge state={state} onClick={() => setSettingsOpen(true)} />
        <span className="spacer" />
        {!connected && <span className="chip chip-error">Server disconnected, reconnecting…</span>}
        <button type="button" onClick={() => (route.nodes ? project && navigate(project.id) : navigateNodes())} aria-pressed={route.nodes}>
          Nodes
          {nodes.some((n) => !n.online) && <span className="chip chip-warn small" title="A node is offline"> {nodes.filter((n) => !n.online).length} offline</span>}
        </button>
        <button type="button" onClick={() => setSettingsOpen((open) => !open)}>
          Settings
        </button>
        {auth && !auth.loopback && auth.authenticated && (
          <button type="button" className="link" onClick={() => void logout().then(() => location.reload())}>
            Log out
          </button>
        )}
      </header>

      <main className="main">
        {firstLaunch ? (
          <section className="first-launch">
            <h1>Choose how Claude runs</h1>
            <p className="muted">
              No mode is set in config.json or CCF_MODE, so pick one. You can switch at any time from the badge in the
              header.
            </p>
            <ModeOptions state={state} onPick={setSwitchTo} />
          </section>
        ) : route.nodes ? (
          <NodesView nodes={nodes} onOpenThread={(p, t) => navigate(p, t)} />
        ) : (
          <div className={`workspace${threadId ? ' with-thread' : ''}`}>
            <Sidebar
              projects={projects}
              project={project}
              threads={threads}
              selectedThreadId={threadId}
              onSelectProject={(id) => navigate(id)}
              onSelectThread={(id) => project && navigate(project.id, id)}
              onProjectCreated={(p) => {
                addProject(p);
                navigate(p.id);
              }}
            />
            {project ? (
              <ThreadView
                key={project.coordinatorThreadId}
                threadId={project.coordinatorThreadId}
                threads={threads}
                openThreadId={threadId}
                onOpenThread={(id) => navigate(project.id, id)}
                usage={usage}
                nodes={nodes}
              />
            ) : (
              <section className="thread-view muted">Loading…</section>
            )}
            {project && threadId && (
              <ThreadView key={threadId} threadId={threadId} threads={threads} onClose={() => navigate(project.id)} usage={usage} nodes={nodes} />
            )}
          </div>
        )}
      </main>

      {settingsOpen && state && (
        <SettingsPanel
          state={state}
          onPick={setSwitchTo}
          onState={setState}
          onRefresh={refresh}
          onClose={() => setSettingsOpen(false)}
        />
      )}

      {switchTo && (
        <SwitchDialog
          target={switchTo}
          firstChoice={firstLaunch}
          onDone={(next) => {
            setState(next);
            setSwitchTo(undefined);
          }}
          onCancel={() => setSwitchTo(undefined)}
        />
      )}
    </div>
  );
}

interface Route {
  projectId?: string;
  threadId?: string;
  nodes?: boolean;
}

/** The open project and thread (#/p/<project>/t/<thread>) or the Nodes view (#/nodes), kept in the URL hash so a reload stays put. */
function useRoute(): [Route, (projectId: string, threadId?: string) => void, () => void] {
  const read = (): Route => {
    if (location.hash === '#/nodes') return { nodes: true };
    const m = /^#\/p\/([^/]+)(?:\/t\/([^/]+))?$/.exec(location.hash);
    return { projectId: m?.[1], threadId: m?.[2] };
  };
  const [route, setRoute] = useState(read);
  useEffect(() => {
    const onHash = () => setRoute(read());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  return [
    route,
    (projectId, threadId) => (location.hash = threadId ? `#/p/${projectId}/t/${threadId}` : `#/p/${projectId}`),
    () => (location.hash = '#/nodes'),
  ];
}
