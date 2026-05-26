import test from "node:test";
import assert from "node:assert/strict";

import { normalizeTimeSliceBoundary } from "./time-utils.ts";

test("normalizes saved time slice boundaries to whole minutes", () => {
    const normalized = normalizeTimeSliceBoundary("2026-05-26T10:15:42.987+02:00");

    assert.equal(normalized, "2026-05-26T10:15:00+02:00");
});

test("keeps null boundaries null", () => {
    assert.equal(normalizeTimeSliceBoundary(null), null);
});
