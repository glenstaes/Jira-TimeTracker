import test from "node:test";
import assert from "node:assert/strict";

import { normalizeTimeSliceBoundary, roundTimeSliceBoundaries } from "./time-utils.ts";

test("normalizes saved time slice boundaries to whole minutes", () => {
    const normalized = normalizeTimeSliceBoundary("2026-05-26T10:15:42.987+02:00");

    assert.equal(normalized, "2026-05-26T10:15:00+02:00");
});

test("keeps null boundaries null", () => {
    assert.equal(normalizeTimeSliceBoundary(null), null);
});

test("rounds time slice boundaries to the selected interval", () => {
    const rounded = roundTimeSliceBoundaries({
        id: 7,
        work_item_id: 12,
        start_time: "2026-05-26T10:08:42.987+02:00",
        end_time: "2026-05-26T10:52:10.000+02:00",
    }, 15);

    assert.equal(rounded.start_time, "2026-05-26T10:15:00+02:00");
    assert.equal(rounded.end_time, "2026-05-26T10:45:00+02:00");
    assert.equal(rounded.id, 7);
});

test("leaves open-ended time slices open while rounding the start", () => {
    const rounded = roundTimeSliceBoundaries({
        start_time: "2026-05-26T10:08:42.987+02:00",
        end_time: null,
    }, 15);

    assert.equal(rounded.start_time, "2026-05-26T10:15:00+02:00");
    assert.equal(rounded.end_time, null);
});
