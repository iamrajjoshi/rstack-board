import {
  Circle,
  CircleCheck,
  CircleDashed,
  CircleDot,
  CircleEllipsis,
  CirclePause,
  CircleX,
  GitMerge,
  type LucideIcon,
  X,
} from 'lucide-react';
import { type Labels, NEEDS_LABEL, OWNER_LABEL, STATE_LABEL } from '../shared/types';

type Tone = 'bright' | 'dim' | 'faint' | 'red';

// Unknown states get the plain circle.
const STATE_MARKS: Record<string, { icon: LucideIcon; tone: Tone }> = {
  draft: { icon: CircleDashed, tone: 'faint' },
  ready: { icon: Circle, tone: 'bright' },
  claimed: { icon: CircleDot, tone: 'bright' },
  work: { icon: CircleDot, tone: 'bright' },
  working: { icon: CircleDot, tone: 'bright' },
  review: { icon: CircleEllipsis, tone: 'bright' },
  blocked: { icon: CirclePause, tone: 'bright' },
  parked: { icon: CirclePause, tone: 'faint' },
  idle: { icon: CirclePause, tone: 'faint' },
  done: { icon: CircleCheck, tone: 'dim' },
  merged: { icon: GitMerge, tone: 'dim' },
  failed: { icon: CircleX, tone: 'red' },
};

/** A thread's state as an icon and its name; nothing when the thread has no state. */
export function StateMark({ labels }: { labels: Labels }) {
  const state = labels[STATE_LABEL];
  if (!state) {
    return null;
  }
  const { icon: Icon, tone } = STATE_MARKS[state] ?? { icon: Circle, tone: 'bright' as const };
  return (
    <span className={`state tone-${tone}`}>
      <Icon size={13} />
      {state}
    </span>
  );
}

/** The line under a message that makes it a task: its state, then who holds it. */
export function TaskLine({ labels }: { labels: Labels }) {
  if (!labels[STATE_LABEL]) {
    return null;
  }
  return (
    <div className="task-line">
      <StateMark labels={labels} />
      {labels[OWNER_LABEL] && <span>· {labels[OWNER_LABEL]}</span>}
    </div>
  );
}

// The task line already shows these.
const TASK_LINE_LABELS = new Set([STATE_LABEL, OWNER_LABEL]);

/** Labels as `key=value` pills. `onRemove` shows every label, each with a remove button. */
export function Chips({ labels, onRemove }: { labels: Labels; onRemove?: (key: string) => void }) {
  const entries = Object.entries(labels).filter(([key]) => onRemove || !TASK_LINE_LABELS.has(key));
  if (entries.length === 0) {
    return null;
  }
  return (
    <span className="chips">
      {entries.map(([key, value]) => (
        <span key={key} className={`chip${key === NEEDS_LABEL ? ' needs' : ''}`}>
          {key}={value}
          {onRemove && (
            <button type="button" title={`remove ${key}`} onClick={() => onRemove(key)}>
              <X size={10} />
            </button>
          )}
        </span>
      ))}
    </span>
  );
}

export function Avatar({ name, size = 28 }: { name: string; size?: number }) {
  return (
    <span className="avatar" style={{ width: size, height: size, fontSize: size * 0.43 }}>
      {name.slice(0, 1).toUpperCase()}
    </span>
  );
}
