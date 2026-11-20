import { ListFilter } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ChannelSummary, Thread, ThreadSummary } from '../shared/types';
import { NEEDS_LABEL, STATE_LABEL } from '../shared/types';
import {
  fetchChannels,
  fetchHealth,
  fetchThread,
  fetchThreads,
  postThread,
  subscribe,
} from './api';
import { Composer } from './Composer';
import { Feed } from './Feed';
import {
  formatRoute,
  matchesTaskTab,
  parseFilter,
  parseRoute,
  type Route,
  type View,
} from './format';
import { Sidebar } from './Sidebar';
import { Tasks } from './Tasks';
import { ThreadPane } from './ThreadPane';

const HEADINGS: Record<Exclude<View['kind'], 'channel'>, { title: string; meta: string }> = {
  needs: { title: 'needs you', meta: 'threads waiting on you' },
  activity: { title: 'activity', meta: 'the latest across every channel' },
  tasks: { title: 'tasks', meta: 'oldest first' },
};

function useRoute(): [Route, (route: Route) => void] {
  const [hash, setHash] = useState(window.location.hash);
  useEffect(() => {
    const onChange = () => setHash(window.location.hash);
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  const navigate = useCallback((route: Route) => {
    window.location.hash = formatRoute(route);
  }, []);
  return [useMemo(() => parseRoute(hash), [hash]), navigate];
}

export function App() {
  const [route, navigate] = useRoute();
  const [filter, setFilter] = useState('');
  const [channels, setChannels] = useState<ChannelSummary[]>([]);
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [openTasks, setOpenTasks] = useState(0);
  const [thread, setThread] = useState<Thread | null>(null);
  const [person, setPerson] = useState('');
  const [live, setLive] = useState(false);

  const { view, threadId } = route;
  const viewKey = formatRoute({ view, threadId: null });

  const loadList = useCallback(async () => {
    const parsed = parseFilter(filter);
    const listView = parseRoute(viewKey).view;
    const scope = { needs: [NEEDS_LABEL], tasks: [STATE_LABEL], activity: [], channel: [] };
    const [nextChannels, nextThreads, tasks] = await Promise.all([
      fetchChannels(),
      fetchThreads({
        channel: listView.kind === 'channel' ? listView.channel : undefined,
        labels: [...parsed.labels, ...scope[listView.kind]],
        text: parsed.text,
      }),
      fetchThreads({ channel: undefined, labels: [STATE_LABEL], text: '' }),
    ]);
    setChannels(nextChannels);
    setThreads(nextThreads);
    setOpenTasks(tasks.filter((task) => matchesTaskTab(task, 'open')).length);
  }, [filter, viewKey]);

  const loadThread = useCallback(async () => {
    setThread(threadId ? await fetchThread(threadId).catch(() => null) : null);
  }, [threadId]);

  useEffect(() => {
    void loadList();
  }, [loadList]);
  useEffect(() => {
    void loadThread();
  }, [loadThread]);
  useEffect(() => {
    void fetchHealth().then((health) => setPerson(health.person));
  }, []);

  // Every board event refreshes what is on screen; the callbacks are read through a ref so the
  // event stream stays open across navigation.
  const reload = useRef({ loadList, loadThread, threadId });
  reload.current = { loadList, loadThread, threadId };
  useEffect(
    () =>
      subscribe((event) => {
        void reload.current.loadList();
        if (event.threadId === reload.current.threadId) {
          void reload.current.loadThread();
        }
      }, setLive),
    [],
  );
  // After a reconnect the stream resumes from the last event it saw, but reload anyway in case
  // the server restarted.
  useEffect(() => {
    if (live) {
      void reload.current.loadList();
      void reload.current.loadThread();
    }
  }, [live]);

  const closeThread = useCallback(() => navigate({ view, threadId: null }), [navigate, view]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        closeThread();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [closeThread]);

  const select = (id: string) => navigate({ view, threadId: id });
  const channel = view.kind === 'channel' ? view.channel : null;
  const heading = channel
    ? { title: `#${channel.replace(/\/$/, '')}`, meta: `${threads.length} threads` }
    : HEADINGS[view.kind === 'channel' ? 'activity' : view.kind];
  const selectedId = thread?.id ?? null;

  return (
    <div className="shell">
      <Sidebar
        channels={channels}
        view={view}
        person={person}
        openTasks={openTasks}
        onNavigate={(next) => navigate({ view: next, threadId: null })}
      />
      <main className="main">
        <header className="header">
          <span className="title" title={heading.title}>
            {heading.title}
          </span>
          <span className="meta">{heading.meta}</span>
          <span className="spacer" />
          <label className="filter">
            <ListFilter size={13} />
            <input
              value={filter}
              placeholder="filter: text or key=value"
              onChange={(event) => setFilter(event.target.value)}
            />
          </label>
          <span className={`live${live ? ' on' : ''}`}>{live ? 'live' : 'reconnecting'}</span>
        </header>
        {view.kind === 'tasks' ? (
          <Tasks threads={threads} selectedId={selectedId} onSelect={select} />
        ) : (
          <Feed
            threads={threads}
            showChannel={!channel || channel.endsWith('/')}
            selectedId={selectedId}
            empty={
              filter
                ? 'nothing matches these filters'
                : view.kind === 'needs'
                  ? 'nothing needs you'
                  : 'nothing here yet'
            }
            onSelect={select}
          />
        )}
        {channel && !channel.endsWith('/') && (
          <Composer
            placeholder={`message #${channel}…`}
            taskToggle
            onSend={async (text, asTask) => {
              await postThread(channel, text, asTask ? { [STATE_LABEL]: 'ready' } : {});
            }}
          />
        )}
      </main>
      {thread && (
        <ThreadPane
          key={thread.id}
          thread={thread}
          person={person}
          onChange={setThread}
          onClose={closeThread}
        />
      )}
    </div>
  );
}
