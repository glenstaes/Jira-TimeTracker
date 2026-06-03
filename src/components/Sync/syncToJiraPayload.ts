import type { TimeSlice } from "@/lib/api";
import { differenceInSeconds } from "date-fns";

export interface SyncToJiraEntry {
    id: string;
    jiraKey: string;
    jiraWorklogId?: string | null;
    started: string;
    timeSpentSeconds: number;
    comment: string;
    description: string;
    slices: TimeSlice[];
}

export interface SyncToJiraSliceClassification {
    syncable: TimeSlice[];
    skippedConnection: TimeSlice[];
    skippedDisabledConnection: TimeSlice[];
    skippedKey: TimeSlice[];
    activeSlice?: TimeSlice;
}

interface CreateSyncToJiraEntriesOptions {
    combineSameTicket: boolean;
}

export function getJiraWorklogComment(notes?: string | null): string {
    if (!notes || notes.trim().length === 0) {
        return "";
    }

    return notes;
}

export function createSyncToJiraEntries(
    slices: TimeSlice[],
    { combineSameTicket }: CreateSyncToJiraEntriesOptions
): SyncToJiraEntry[] {
    const sortedSlices = [...slices].sort(compareSlicesByStartTime);

    if (!combineSameTicket) {
        return sortedSlices.map(createSingleSliceEntry);
    }

    const groups = new Map<string, TimeSlice[]>();

    for (const slice of sortedSlices) {
        if (!slice.jira_key || !slice.jira_connection_id) {
            continue;
        }

        const groupKey = `${slice.jira_connection_id}:${slice.jira_key}`;
        const group = groups.get(groupKey) ?? [];
        group.push(slice);
        groups.set(groupKey, group);
    }

    return Array.from(groups.values()).flatMap(createCombinedEntriesForGroup);
}

export function classifySyncToJiraSlices(slices: TimeSlice[]): SyncToJiraSliceClassification {
    const syncable: TimeSlice[] = [];
    const skippedConnection: TimeSlice[] = [];
    const skippedDisabledConnection: TimeSlice[] = [];
    const skippedKey: TimeSlice[] = [];
    let activeSlice: TimeSlice | undefined;

    for (const slice of slices) {
        // Check for active slice first - global blocker logic
        if (!slice.end_time) {
            activeSlice = slice;
            continue;
        }

        // Must have Jira Key to be considered for sync or connection skip
        if (!slice.jira_key) {
            skippedKey.push(slice);
            continue;
        }

        // Must have Jira Connection to be syncable
        if (!slice.jira_connection_id) {
            skippedConnection.push(slice);
            continue;
        }

        if (slice.jira_connection_is_enabled === 0) {
            skippedDisabledConnection.push(slice);
            continue;
        }

        // Already synced?
        if (slice.synced_to_jira) {
            // Check if changed
            const isOutOfSync = slice.start_time !== slice.synced_start_time ||
                slice.end_time !== slice.synced_end_time ||
                slice.notes !== slice.synced_notes;
            if (!isOutOfSync) {
                continue;
            }
        }

        syncable.push(slice);
    }

    return { syncable, skippedConnection, skippedDisabledConnection, skippedKey, activeSlice };
}

function createCombinedEntriesForGroup(slices: TimeSlice[]): SyncToJiraEntry[] {
    const sortedSlices = [...slices].sort(compareSlicesByStartTime);
    const existingWorklogIds = Array.from(new Set(
        sortedSlices
            .map(slice => slice.jira_worklog_id)
            .filter((id): id is string => !!id)
    ));

    if (existingWorklogIds.length > 1) {
        return sortedSlices.map(createSingleSliceEntry);
    }

    const firstSlice = sortedSlices[0];

    return [{
        id: sortedSlices.map(slice => slice.id).join(":"),
        jiraKey: firstSlice.jira_key!,
        jiraWorklogId: existingWorklogIds[0] ?? null,
        started: firstSlice.start_time,
        timeSpentSeconds: sortedSlices.reduce((total, slice) => total + getSliceDurationSeconds(slice), 0),
        comment: getCombinedJiraWorklogComment(sortedSlices),
        description: firstSlice.work_item_description || firstSlice.jira_key!,
        slices: sortedSlices
    }];
}

function createSingleSliceEntry(slice: TimeSlice): SyncToJiraEntry {
    return {
        id: String(slice.id),
        jiraKey: slice.jira_key!,
        jiraWorklogId: slice.jira_worklog_id,
        started: slice.start_time,
        timeSpentSeconds: getSliceDurationSeconds(slice),
        comment: getJiraWorklogComment(slice.notes),
        description: slice.work_item_description || slice.jira_key!,
        slices: [slice]
    };
}

function getCombinedJiraWorklogComment(slices: TimeSlice[]): string {
    return slices
        .map(slice => slice.notes?.trim() ?? "")
        .filter(note => note.length > 0)
        .join("\n\n");
}

function getSliceDurationSeconds(slice: TimeSlice): number {
    if (!slice.end_time) {
        return 0;
    }

    return differenceInSeconds(new Date(slice.end_time), new Date(slice.start_time));
}

function compareSlicesByStartTime(a: TimeSlice, b: TimeSlice): number {
    return new Date(a.start_time).getTime() - new Date(b.start_time).getTime();
}
