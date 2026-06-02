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
