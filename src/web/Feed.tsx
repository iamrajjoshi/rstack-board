import { useEffect, useRef } from 'react';
import type { ThreadSummary } from '../shared/types';
import { dayLabel, oneLine, timeAgo } from './format';
import { Avatar, Chips, TaskLine } from './marks';
import { MessageFrame, MessageText } from './MessageView';

/** Threads as a chat feed: oldest activity at the top, newest at the bottom. */
export function Feed({
  threads,
  showChannel,
  selectedId,
  empty,
  onSelect,
}: {
  threads: ThreadSummary[];
  showChannel: boolean;
  selectedId: string | null;
  empty: string;
  onSelect: (id: string) => void;
}) {
  const ordered = threads.toReversed();
  const end = useRef<HTMLDivElement>(null);
  const newest = ordered.at(-1)?.updatedAt;

  // Stay at the newest message as activity arrives, like a chat.
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' });
  }, [newest]);

  if (ordered.length === 0) {
    return <div className="feed empty">{empty}</div>;
  }
  return (
    <div className="feed">
      {ordered.map((thread, index) => {
        const day = dayLabel(thread.updatedAt);
        const previous = ordered[index - 1];
        return (
          <div key={thread.id}>
            {(!previous || dayLabel(previous.updatedAt) !== day) && (
              <div className="day">{day}</div>
            )}
            <button
              type="button"
              className={`message${thread.id === selectedId ? ' active' : ''}`}
              onClick={() => onSelect(thread.id)}
            >
              <MessageFrame
                message={thread.message}
                time={thread.updatedAt}
                {...(showChannel ? { where: thread.channel } : {})}
              >
                <div className="clamp">
                  <MessageText text={thread.message.text} />
                </div>
                <TaskLine labels={thread.labels} />
                <Chips labels={thread.labels} />
                {thread.replyCount > 0 && (
                  <div className="replies">
                    <Avatar name={thread.last.author} size={16} />
                    <span className="count">
                      {thread.replyCount} {thread.replyCount === 1 ? 'reply' : 'replies'} · last{' '}
                      {timeAgo(thread.last.createdAt)}
                    </span>
                    <span className="latest">
                      {thread.last.author}: {oneLine(thread.last.text)}
                    </span>
                  </div>
                )}
              </MessageFrame>
            </button>
          </div>
        );
      })}
      <div ref={end} />
    </div>
  );
}
