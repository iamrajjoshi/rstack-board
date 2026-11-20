import { BoardError } from './errors';
import type { Labels } from './types';

const CHANNEL = /^[a-z0-9][a-z0-9_-]*(\/[a-z0-9][a-z0-9_-]*)*$/;
const LABEL_KEY = /^[a-z][a-z0-9_.-]{0,39}$/;

export function assertChannel(channel: string): void {
  if (!CHANNEL.test(channel)) {
    throw new BoardError(
      'invalid_channel',
      `Channel "${channel}" must be a lowercase path such as prs/backend.`,
    );
  }
}

export function assertLabelKey(key: string): void {
  if (!LABEL_KEY.test(key)) {
    throw new BoardError('invalid_label', `Label key "${key}" must look like state or pr.`);
  }
}

/** Parses `key=value` arguments into labels. */
export function parseLabels(pairs: string[]): Labels {
  const labels: Labels = {};
  for (const pair of pairs) {
    const index = pair.indexOf('=');
    if (index < 1 || index === pair.length - 1) {
      throw new BoardError('invalid_label', `Label "${pair}" must be key=value.`);
    }
    labels[pair.slice(0, index)] = pair.slice(index + 1);
  }
  return labels;
}

/** A filter `key`, `key=value` or `key=a|b`: the label is set, or is one of the values. */
export interface LabelFilter {
  key: string;
  values: string[];
}

export function parseLabelFilter(filter: string): LabelFilter {
  const index = filter.indexOf('=');
  if (index === -1) {
    return { key: filter, values: [] };
  }
  return { key: filter.slice(0, index), values: filter.slice(index + 1).split('|') };
}

export function matchesLabelFilters(labels: Labels, filters: LabelFilter[]): boolean {
  return filters.every(({ key, values }) => {
    const value = labels[key];
    return value !== undefined && (values.length === 0 || values.includes(value));
  });
}

/** Parses `30s`, `10m`, `1h` or bare seconds into milliseconds. */
export function parseDuration(input: string): number {
  const match = /^(\d+(?:\.\d+)?)(s|m|h)?$/.exec(input);
  if (!match) {
    throw new BoardError('invalid_duration', `Duration "${input}" must look like 30s, 10m or 1h.`);
  }
  const [, amount, unit] = match;
  return Number(amount) * (unit === 'h' ? 3_600_000 : unit === 'm' ? 60_000 : 1000);
}
