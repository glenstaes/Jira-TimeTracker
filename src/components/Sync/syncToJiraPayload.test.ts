import test from "node:test";
import assert from "node:assert/strict";

import { getJiraWorklogComment } from "./syncToJiraPayload.ts";

test("returns the entered note when a worklog comment is provided", () => {
    assert.equal(getJiraWorklogComment("Pairing on validation"), "Pairing on validation");
});

test("returns an empty string when no worklog comment is provided", () => {
    assert.equal(getJiraWorklogComment(""), "");
    assert.equal(getJiraWorklogComment(undefined), "");
    assert.equal(getJiraWorklogComment("   "), "");
});
