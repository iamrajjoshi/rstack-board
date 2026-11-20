import { parseJson } from '../shared/json';
import type { BoardEvent, ChannelSummary, Labels, Thread, ThreadSummary } from '../shared/types';

async function request<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(
    path,
    body
      ? {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }
      : {},
  );
  const text = await response.text();
  if (!response.ok) {
    throw new Error(parseJson<{ message: string }>(text).message);
  }
  return parseJson<T>(text);
}

export function fetchHealth(): Promise<{ person: string }> {
  return request('/api/health');
}

export async function fetchChannels(): Promise<ChannelSummary[]> {
  return (await request<{ channels: ChannelSummary[] }>('/api/channels')).channels;
}

export async function fetchThreads(filter: {
  channel: string | undefined;
  labels: string[];
  text: string;
}): Promise<ThreadSummary[]> {
  const params = new URLSearchParams();
  if (filter.channel) {
    params.set('channel', filter.channel);
  }
  for (const label of filter.labels) {
    params.append('label', label);
  }
  if (filter.text) {
    params.set('text', filter.text);
  }
  return (await request<{ threads: ThreadSummary[] }>(`/api/threads?${params}`)).threads;
}

export function fetchThread(id: string): Promise<Thread> {
  return request(`/api/threads/${id}`);
}

/** Starts a thread in `channel` as the person. */
export function postThread(channel: string, text: string, labels: Labels): Promise<Thread> {
  return request('/api/threads', { channel, text, labels });
}

export function postReply(id: string, text: string): Promise<Thread> {
  return request(`/api/threads/${id}/replies`, { text });
}

export function changeLabels(id: string, set: Labels, unset: string[] = []): Promise<Thread> {
  return request(`/api/threads/${id}/labels`, { set, unset });
}

/** Calls `onEvent` for every board event; the browser reconnects and resumes on its own. */
export function subscribe(
  onEvent: (event: BoardEvent) => void,
  onStatus: (live: boolean) => void,
): () => void {
  const source = new EventSource('/api/events');
  source.addEventListener('open', () => onStatus(true));
  source.addEventListener('error', () => onStatus(false));
  source.addEventListener('message', (message: MessageEvent<string>) =>
    onEvent(parseJson<BoardEvent>(message.data)),
  );
  return () => source.close();
}
