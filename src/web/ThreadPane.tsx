import { Check, Copy, ExternalLink, Pause, Play, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { type Labels, NEEDS_LABEL, type Thread } from '../shared/types';
import { changeLabels, postReply } from './api';
import { Composer } from './Composer';
import { rstackCodeThread } from './format';
import { Chips, TaskLine } from './marks';
import { MessageFrame, MessageText } from './MessageView';

export function ThreadPane({
  thread,
  person,
  onChange,
  onClose,
}: {
  thread: Thread;
  person: string;
  onChange: (thread: Thread) => void;
  onClose: () => void;
}) {
  const [newLabel, setNewLabel] = useState('');
  const [error, setError] = useState('');
  const end = useRef<HTMLDivElement>(null);
  const replyCount = thread.replies.length;

  // Keep the newest message in view as replies arrive.
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' });
  }, [replyCount]);

  const label = async (set: Labels, unset: string[] = []) => {
    try {
      onChange(await changeLabels(thread.id, set, unset));
      setError('');
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    }
  };
  const addLabel = async () => {
    const index = newLabel.indexOf('=');
    if (index > 0) {
      await label({ [newLabel.slice(0, index).trim()]: newLabel.slice(index + 1).trim() });
      setNewLabel('');
    }
  };

  const origin = rstackCodeThread(thread.labels);
  const needs = thread.labels[NEEDS_LABEL];
  const held = thread.labels.hold !== undefined;

  return (
    <aside className="pane">
      <header className="header">
        <span className="title">thread</span>
        <span className="meta">#{thread.channel}</span>
        <span className="spacer" />
        {origin?.link && (
          <a className="origin" href={origin.link} title={`rstack code thread ${origin.id}`}>
            <ExternalLink size={12} /> open in rstack code
          </a>
        )}
        {origin && !origin.link && (
          <button
            type="button"
            className="origin"
            title="copy the rstack code thread id"
            onClick={() => void navigator.clipboard?.writeText(origin.id)}
          >
            <Copy size={12} /> <span className="id">{origin.id.slice(0, 8)}</span>
          </button>
        )}
        <button type="button" className="icon-button" title="close (esc)" onClick={onClose}>
          <X size={14} />
        </button>
      </header>
      <div className="feed">
        <div className="message root">
          <MessageFrame message={thread.message}>
            <MessageText text={thread.message.text} />
            <TaskLine labels={thread.labels} />
            <div className="label-row">
              <Chips labels={thread.labels} onRemove={(key) => void label({}, [key])} />
              <input
                className="label-input"
                value={newLabel}
                placeholder="+ key=value"
                onChange={(event) => setNewLabel(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    void addLabel();
                  }
                }}
              />
            </div>
            <div className="actions">
              {needs && (
                <>
                  <button
                    type="button"
                    className="action primary"
                    title="sets decision=approved and clears needs"
                    onClick={() => void label({ decision: 'approved' }, [NEEDS_LABEL, 'hold'])}
                  >
                    <Check size={13} /> approve
                  </button>
                  <button
                    type="button"
                    className="action"
                    title="clears needs without a decision"
                    onClick={() => void label({}, [NEEDS_LABEL])}
                  >
                    resolve
                  </button>
                </>
              )}
              {held ? (
                <button
                  type="button"
                  className="action"
                  title="clears hold"
                  onClick={() => void label({}, ['hold'])}
                >
                  <Play size={13} /> release
                </button>
              ) : (
                <button
                  type="button"
                  className="action"
                  title={`sets hold=${person}`}
                  onClick={() => void label({ hold: person })}
                >
                  <Pause size={13} /> hold
                </button>
              )}
            </div>
            {error && <p className="error">{error}</p>}
          </MessageFrame>
        </div>
        <div className="day">
          {replyCount} {replyCount === 1 ? 'reply' : 'replies'}
        </div>
        {thread.replies.map((reply) => (
          <div key={reply.id} className="message">
            <MessageFrame message={reply}>
              <MessageText text={reply.text} />
            </MessageFrame>
          </div>
        ))}
        <div ref={end} />
      </div>
      <Composer
        placeholder="reply to thread…"
        onSend={async (text) => onChange(await postReply(thread.id, text))}
      />
    </aside>
  );
}
