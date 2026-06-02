import type { WorkItem } from "@/lib/api";

interface StartTrackingFromOverviewDependencies {
    startTracking: (workItem: WorkItem) => Promise<void>;
    refreshWorkItems: () => Promise<void> | void;
    logError?: (message: string, error: unknown) => void;
}

export async function startTrackingFromWorkItemOverview(
    workItem: WorkItem,
    { startTracking, refreshWorkItems, logError }: StartTrackingFromOverviewDependencies
) {
    try {
        await startTracking(workItem);
        await refreshWorkItems();
    } catch (error) {
        logError?.("Failed to start tracking from work item overview", error);
    }
}
