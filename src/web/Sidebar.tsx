import { Activity, CircleDot, ListTodo, Monitor, Moon, Network, Sun } from 'lucide-react';
import type { ReactNode } from 'react';
import { useState } from 'react';
import type { ChannelSummary } from '../shared/types';
import { splitHandle, type View } from './format';
import { hasSessionTheme, initialTheme, THEME_KEY, type Theme } from './theme';

const NEXT_THEME: Record<Theme, Theme> = { system: 'light', light: 'dark', dark: 'system' };
const THEME_ICONS = { system: Monitor, light: Sun, dark: Moon };

function applyTheme(theme: Theme): void {
  const system = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  document.documentElement.dataset.theme = theme === 'system' ? system : theme;
  (hasSessionTheme() ? window.sessionStorage : window.localStorage).setItem(THEME_KEY, theme);
}

/** A coordinator's channels summed into one line, such as `2 need you · 3 ready · 4 working`. */
function rollup(channels: ChannelSummary[]): string {
  const total = (pick: (channel: ChannelSummary) => number) =>
    channels.reduce((sum, channel) => sum + pick(channel), 0);
  const parts = [
    [total((c) => c.needs), 'need you'],
    [total((c) => c.ready), 'ready'],
    [total((c) => c.working), 'working'],
  ] as const;
  return (
    parts
      .filter(([count]) => count > 0)
      .map(([count, label]) => `${count} ${label}`)
      .join(' · ') || 'nothing open'
  );
}

/** A long name with its slug cut short and its hash kept; the full name is in the tooltip. */
function HandleName({ name, prefix = '' }: { name: string; prefix?: string }) {
  const { base, hash } = splitHandle(name);
  return (
    <span className="handle">
      <span className="base">
        {prefix}
        {base}
      </span>
      {hash && <span className="hash">{hash}</span>}
    </span>
  );
}

function sameView(a: View, b: View): boolean {
  return a.kind === 'channel' && b.kind === 'channel' ? a.channel === b.channel : a.kind === b.kind;
}

export function Sidebar({
  channels,
  view,
  person,
  openTasks,
  onNavigate,
}: {
  channels: ChannelSummary[];
  view: View;
  person: string;
  openTasks: number;
  onNavigate: (view: View) => void;
}) {
  const [theme, setTheme] = useState<Theme>(() =>
    initialTheme(
      window.location.search,
      window.sessionStorage.getItem(THEME_KEY),
      window.localStorage.getItem(THEME_KEY),
    ),
  );
  const ThemeIcon = THEME_ICONS[theme];
  const needs = channels.reduce((sum, channel) => sum + channel.needs, 0);

  const item = (target: View, label: ReactNode, count: number, attention = false) => (
    <button
      type="button"
      key={target.kind === 'channel' ? target.channel : target.kind}
      className={`item${sameView(view, target) ? ' current' : ''}${attention ? ' unread' : ''}`}
      title={target.kind === 'channel' ? target.channel : undefined}
      onClick={() => onNavigate(target)}
    >
      <span className="name">{label}</span>
      {attention && <span className="dot" title="has threads that need you" />}
      <span className="count">{count || ''}</span>
    </button>
  );

  // A channel with a path belongs to a coordinator: `artemis/prs` and `artemis/workers` sit
  // under `artemis`. Flat channels, such as `threads` for one-off sessions, come after.
  const coordinators = new Map<string, ChannelSummary[]>();
  const flat: ChannelSummary[] = [];
  for (const channel of channels) {
    const slash = channel.channel.indexOf('/');
    if (slash === -1) {
      flat.push(channel);
    } else {
      const name = channel.channel.slice(0, slash);
      coordinators.set(name, [...(coordinators.get(name) ?? []), channel]);
    }
  }

  return (
    <nav className="sidebar">
      <div className="brand">
        <span className="board-name">rstack-board</span>
        <span className="at">{window.location.host}</span>
      </div>
      <div className="items">
        {item(
          { kind: 'needs' },
          <>
            <CircleDot size={13} /> needs you
          </>,
          needs,
          needs > 0,
        )}
        {item(
          { kind: 'activity' },
          <>
            <Activity size={13} /> activity
          </>,
          0,
        )}
        {item(
          { kind: 'tasks' },
          <>
            <ListTodo size={13} /> tasks
          </>,
          openTasks,
        )}
        {coordinators.size > 0 && <h2 className="heading">coordinators</h2>}
        {[...coordinators].map(([name, members]) => {
          const target: View = { kind: 'channel', channel: `${name}/` };
          return (
            <div key={name} className="coordinator">
              <button
                type="button"
                className={`item coordinator-name${sameView(view, target) ? ' current' : ''}`}
                title={name}
                onClick={() => onNavigate(target)}
              >
                <span className="name">
                  <Network size={13} /> <HandleName name={name} />
                </span>
              </button>
              <div className="rollup">{rollup(members)}</div>
              {members.map((member) =>
                item(
                  { kind: 'channel', channel: member.channel },
                  `#${member.channel.slice(name.length + 1)}`,
                  member.threads,
                  member.needs > 0,
                ),
              )}
            </div>
          );
        })}
        {flat.length > 0 && <h2 className="heading">channels</h2>}
        {flat.map((channel) =>
          item(
            { kind: 'channel', channel: channel.channel },
            <HandleName name={channel.channel} prefix="#" />,
            channel.threads,
            channel.needs > 0,
          ),
        )}
      </div>
      <div className="foot">
        <span className="who">{person}</span>
        <button
          type="button"
          className="icon-button"
          title={`theme: ${theme}`}
          onClick={() => {
            const next = NEXT_THEME[theme];
            applyTheme(next);
            setTheme(next);
          }}
        >
          <ThemeIcon size={13} />
        </button>
      </div>
    </nav>
  );
}
