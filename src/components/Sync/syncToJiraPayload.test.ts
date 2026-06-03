import test from "node:test";
import assert from "node:assert/strict";

import type { TimeSlice } from "@/lib/api";
import { classifySyncToJiraSlices, createSyncToJiraEntries, getJiraWorklogComment } from "./syncToJiraPayload.ts";

function createSlice(overrides: Partial<TimeSlice>): TimeSlice {
    return {
        id: 1,
        work_item_id: 1,
        start_time: "2026-01-01T09:00:00.000Z",
        end_time: "2026-01-01T10:00:00.000Z",
        notes: "Initial note",
        jira_key: "MEALDB-2477",
        jira_connection_id: 1,
        work_item_description: "Meal database work",
        ...overrides
    };
}

test("returns the entered note when a worklog comment is provided", () => {
    assert.equal(getJiraWorklogComment("Pairing on validation"), "Pairing on validation");
});

test("returns an empty string when no worklog comment is provided", () => {
    assert.equal(getJiraWorklogComment(""), "");
    assert.equal(getJiraWorklogComment(undefined), "");
    assert.equal(getJiraWorklogComment("   "), "");
});

test("creates one sync entry per slice when combining is disabled", () => {
    const entries = createSyncToJiraEntries([
        createSlice({ id: 1 }),
        createSlice({ id: 2, start_time: "2026-01-01T10:00:00.000Z", end_time: "2026-01-01T10:30:00.000Z" })
    ], { combineSameTicket: false });

    assert.equal(entries.length, 2);
    assert.deepEqual(entries.map(entry => entry.slices.map(slice => slice.id)), [[1], [2]]);
    assert.equal(entries[0].timeSpentSeconds, 3600);
    assert.equal(entries[1].timeSpentSeconds, 1800);
});

test("combines unsynced slices for the same Jira key and connection", () => {
    const entries = createSyncToJiraEntries([
        createSlice({ id: 2, start_time: "2026-01-01T10:00:00.000Z", end_time: "2026-01-01T10:30:00.000Z", notes: "Second" }),
        createSlice({ id: 1, start_time: "2026-01-01T09:00:00.000Z", end_time: "2026-01-01T09:45:00.000Z", notes: "First" }),
        createSlice({ id: 3, start_time: "2026-01-01T11:00:00.000Z", end_time: "2026-01-01T11:15:00.000Z", notes: "Third" })
    ], { combineSameTicket: true });

    assert.equal(entries.length, 1);
    assert.deepEqual(entries[0].slices.map(slice => slice.id), [1, 2, 3]);
    assert.equal(entries[0].started, "2026-01-01T09:00:00.000Z");
    assert.equal(entries[0].timeSpentSeconds, 5400);
});

test("joins combined notes in chronological order and ignores blanks", () => {
    const entries = createSyncToJiraEntries([
        createSlice({ id: 1, start_time: "2026-01-01T09:00:00.000Z", end_time: "2026-01-01T09:30:00.000Z", notes: "  First note  " }),
        createSlice({ id: 2, start_time: "2026-01-01T09:30:00.000Z", end_time: "2026-01-01T10:00:00.000Z", notes: "   " }),
        createSlice({ id: 3, start_time: "2026-01-01T10:00:00.000Z", end_time: "2026-01-01T10:30:00.000Z", notes: "Second note" })
    ], { combineSameTicket: true });

    assert.equal(entries[0].comment, "First note\n\nSecond note");
});

test("keeps the same Jira key on different Jira connections separate", () => {
    const entries = createSyncToJiraEntries([
        createSlice({ id: 1, jira_connection_id: 1 }),
        createSlice({ id: 2, jira_connection_id: 2 })
    ], { combineSameTicket: true });

    assert.equal(entries.length, 2);
    assert.deepEqual(entries.map(entry => entry.slices.map(slice => slice.id)), [[1], [2]]);
});

test("combines slices that share an existing Jira worklog id for update", () => {
    const entries = createSyncToJiraEntries([
        createSlice({ id: 1, jira_worklog_id: "123" }),
        createSlice({ id: 2, start_time: "2026-01-01T10:00:00.000Z", end_time: "2026-01-01T10:30:00.000Z", jira_worklog_id: "123" })
    ], { combineSameTicket: true });

    assert.equal(entries.length, 1);
    assert.equal(entries[0].jiraWorklogId, "123");
    assert.deepEqual(entries[0].slices.map(slice => slice.id), [1, 2]);
});

test("keeps slices with distinct existing Jira worklog ids separate", () => {
    const entries = createSyncToJiraEntries([
        createSlice({ id: 1, jira_worklog_id: "123" }),
        createSlice({ id: 2, start_time: "2026-01-01T10:00:00.000Z", end_time: "2026-01-01T10:30:00.000Z", jira_worklog_id: "456" })
    ], { combineSameTicket: true });

    assert.equal(entries.length, 2);
    assert.deepEqual(entries.map(entry => entry.slices.map(slice => slice.id)), [[1], [2]]);
});

test("classifies slices for disabled Jira connections as not ready while keeping the Jira key", () => {
    const disabledSlice = createSlice({
        id: 7,
        jira_key: "MEALDB-3000",
        jira_connection_id: 3,
        jira_connection_is_enabled: 0
    });

    const result = classifySyncToJiraSlices([disabledSlice]);

    assert.equal(result.syncable.length, 0);
    assert.equal(result.skippedDisabledConnection.length, 1);
    assert.equal(result.skippedDisabledConnection[0].jira_key, "MEALDB-3000");
});

test("keeps enabled Jira connection slices ready to sync", () => {
    const enabledSlice = createSlice({
        id: 8,
        jira_connection_is_enabled: 1
    });

    const result = classifySyncToJiraSlices([enabledSlice]);

    assert.deepEqual(result.syncable.map(slice => slice.id), [8]);
    assert.equal(result.skippedDisabledConnection.length, 0);
});
