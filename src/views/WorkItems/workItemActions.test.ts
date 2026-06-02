import test from "node:test";
import assert from "node:assert/strict";

import { startTrackingFromWorkItemOverview } from "./workItemActions.ts";

const workItem = {
    id: 42,
    description: "Build the overview action",
    is_completed: 1
};

test("starts tracking the selected work item and refreshes the overview", async () => {
    const calls: string[] = [];

    await startTrackingFromWorkItemOverview(workItem, {
        startTracking: async item => {
            calls.push(`start:${item.id}`);
        },
        refreshWorkItems: async () => {
            calls.push("refresh");
        }
    });

    assert.deepEqual(calls, ["start:42", "refresh"]);
});

test("logs failures without refreshing the overview", async () => {
    const error = new Error("tracking failed");
    const calls: string[] = [];

    await startTrackingFromWorkItemOverview(workItem, {
        startTracking: async () => {
            throw error;
        },
        refreshWorkItems: async () => {
            calls.push("refresh");
        },
        logError: (message, err) => {
            calls.push(message);
            assert.equal(err, error);
        }
    });

    assert.deepEqual(calls, ["Failed to start tracking from work item overview"]);
});
