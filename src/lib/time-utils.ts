import { formatISO } from 'date-fns';

/**
 * Rounds a date to the nearest interval.
 * If intervalMinutes is 0 or 1, just clears the seconds.
 */
export function roundToNearestInterval(date: Date, intervalMinutes: number): Date {
    const result = new Date(date);
    result.setSeconds(0, 0); // Always clear seconds and milliseconds

    if (intervalMinutes <= 1) {
        return result;
    }

    const intervalMs = intervalMinutes * 60 * 1000;
    const timestamp = result.getTime();
    const roundedMs = Math.round(timestamp / intervalMs) * intervalMs;
    return new Date(roundedMs);
}

type TimeSliceBoundaries = {
    start_time: string;
    end_time?: string | null;
};

/**
 * Rounds the persisted boundaries on a time slice-shaped object.
 */
export function roundTimeSliceBoundaries<T extends TimeSliceBoundaries>(slice: T, intervalMinutes: number): T {
    return {
        ...slice,
        start_time: formatISO(roundToNearestInterval(new Date(slice.start_time), intervalMinutes)),
        end_time: slice.end_time
            ? formatISO(roundToNearestInterval(new Date(slice.end_time), intervalMinutes))
            : slice.end_time
    };
}

/**
 * Normalizes a persisted time slice boundary to whole-minute precision.
 */
export function normalizeTimeSliceBoundary(dateStr: string | null | undefined): string | null {
    if (!dateStr) return null;

    const date = new Date(dateStr);
    if (isNaN(date.getTime())) return dateStr;

    date.setSeconds(0, 0);
    return formatISO(date);
}

/**
 * Formats a duration in seconds into a human-readable string (e.g., "1h 30m" or "45m").
 */
export function formatDuration(seconds: number): string {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);

    if (hours > 0) {
        return `${hours}h ${minutes}m`;
    }
    return `${minutes}m`;
}
