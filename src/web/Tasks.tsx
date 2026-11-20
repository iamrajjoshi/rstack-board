import { useState } from 'react';
import { OWNER_LABEL, type ThreadSummary } from '../shared/types';
import { matchesTaskTab, taskTabs, timeAgo } from './format';
import { Chips, StateMark } from './marks';

/** Every thread that has a state, as rows under state tabs, oldest first. */
export function Tasks({
  threads,
  selectedId,
  onSelect,
}: {
  threads: ThreadSummary[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const [tab, setTab] = useState('open');
  const tabs = taskTabs(threads);
  const rows = threads
    .filter((thread) => matchesTaskTab(thread, tab))
    .toSorted((a, b) => a.message.createdAt.localeCompare(b.message.createdAt));
  return (
    <>
      <div className="tabs">
        {tabs.map((name) => (
          <button
            type="button"
            key={name}
            className={name === tab ? 'current' : ''}
            onClick={() => setTab(name)}
          >
            {name}
            <span className="count">
              {threads.filter((thread) => matchesTaskTab(thread, name)).length}
            </span>
          </button>
        ))}
      </div>
      <div className="feed">
        {rows.length === 0 && (
          <div className="empty">{tab === 'open' ? 'no open tasks' : 'no tasks match'}</div>
        )}
        {rows.map((thread) => (
          <button
            type="button"
            key={thread.id}
            className={`task-row${thread.id === selectedId ? ' active' : ''}`}
            onClick={() => onSelect(thread.id)}
          >
            <StateMark labels={thread.labels} />
            <span className="task-title">
              <span>{thread.title}</span>
              <Chips labels={thread.labels} />
            </span>
            <span className="note">{thread.labels[OWNER_LABEL] ?? ''}</span>
            <span className="note">#{thread.channel}</span>
            <time title={new Date(thread.updatedAt).toLocaleString()}>
              {timeAgo(thread.updatedAt)}
            </time>
          </button>
        ))}
      </div>
    </>
  );
}
