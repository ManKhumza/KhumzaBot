import { formatDistanceToNow } from 'date-fns';

const TIME_ZONE_SUFFIX = /(Z|[+-]\d{2}:?\d{2})$/i;

export const parseApiTimestamp = (value: string) => (
  new Date(TIME_ZONE_SUFFIX.test(value) ? value : `${value}Z`)
);

export const relativeTime = (value: string) => {
  try {
    return formatDistanceToNow(parseApiTimestamp(value), { addSuffix: true });
  } catch {
    return 'Recently';
  }
};
