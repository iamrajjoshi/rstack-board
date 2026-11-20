import { ListTodo } from 'lucide-react';
import { useState } from 'react';

/** The message box: Enter sends, Shift+Enter adds a line. `onSend` rejects to keep the draft. */
export function Composer({
  placeholder,
  taskToggle = false,
  onSend,
}: {
  placeholder: string;
  /** Offer the "task" toggle, which posts the thread as a ready task. */
  taskToggle?: boolean;
  onSend: (text: string, asTask: boolean) => Promise<void>;
}) {
  const [draft, setDraft] = useState('');
  const [asTask, setAsTask] = useState(false);
  const [error, setError] = useState('');

  const send = async () => {
    if (!draft.trim()) {
      return;
    }
    try {
      await onSend(draft, asTask);
      setDraft('');
      setError('');
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    }
  };

  return (
    <div className="composer">
      {error && <p className="error">{error}</p>}
      <div className="box">
        <textarea
          value={draft}
          placeholder={asTask ? 'start a task…' : placeholder}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              void send();
            }
          }}
        />
        <div className="composer-foot">
          {taskToggle && (
            <button
              type="button"
              className={`toggle${asTask ? ' on' : ''}`}
              title="post as a task agents can claim (state=ready)"
              onClick={() => setAsTask(!asTask)}
            >
              <ListTodo size={13} /> task
            </button>
          )}
          <span className="hint">enter to send · shift+enter for a new line</span>
          <button
            type="button"
            className="send"
            disabled={!draft.trim()}
            onClick={() => void send()}
          >
            send
          </button>
        </div>
      </div>
    </div>
  );
}
