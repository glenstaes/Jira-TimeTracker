import { create } from 'zustand'
import { WorkItem, api } from '@/lib/api'
import { formatISO } from 'date-fns'
import { roundToNearestInterval } from '@/lib/time-utils'

interface TrackingStore {
    activeWorkItem: WorkItem | null;
    activeTimeSliceId: number | null;
    startTime: string | null; // ISO string
    elapsedSeconds: number;
    totalTimeSpent: number; // Historical + current session
    historicalBase: number; // For internal calculation

    startTracking: (workItem: WorkItem, overrideStartTime?: string) => Promise<void>;
    stopTracking: () => Promise<string | null>; // Returns the (possibly rounded) final end time
    tick: () => void; // Update elapsed time
    setElapsedSeconds: (seconds: number) => void;
    handleAwayTime: (action: 'discard' | 'keep' | 'reassign', awayStartTime: string, targetWorkItem?: WorkItem) => Promise<void>;

    updateActiveWorkItem: (workItem: WorkItem) => Promise<void>;

    // Initialize from DB if possible? 
    // We'll need a way to check if tracking is active on load.
    checkActiveTracking: () => Promise<void>;
}

function notifyMiniPlayerIdle() {
    api.updateMiniPlayerState({
        isTracking: false,
        elapsedSeconds: 0,
        description: ''
    });
}

function notifyMiniPlayerActive(workItem: WorkItem, startTime: string) {
    api.updateMiniPlayerState({
        isTracking: true,
        elapsedSeconds: 0,
        jiraKey: workItem.jira_key,
        description: workItem.description,
        startTime
    });
}

export const useTrackingStore = create<TrackingStore>((set, get) => ({
    activeWorkItem: null,
    activeTimeSliceId: null,
    startTime: null,
    elapsedSeconds: 0,
    totalTimeSpent: 0,
    historicalBase: 0,

    setElapsedSeconds: (seconds) => set({ elapsedSeconds: seconds }),

    startTracking: async (workItem, overrideStartTime) => {
        // 1. Stop current if any (handled by UI or logic? Logic here is safer)
        const { activeTimeSliceId, stopTracking } = get();
        let startTimeToUse = overrideStartTime;

        if (activeTimeSliceId) {
            // stopTracking returns the rounded end time of the stopped slice
            const roundedEndTime = await stopTracking();
            if (roundedEndTime && !overrideStartTime) {
                // Use the rounded end time as the start of the new slice
                startTimeToUse = roundedEndTime;
            }
        }

        // 2. If no overrideStartTime was provided (and no slice was stopped), apply rounding to current time
        if (!startTimeToUse) {
            const now = new Date();
            try {
                const settings = await api.getSettings();
                if (settings.rounding_enabled === 'true') {
                    const intervalMinutes = parseInt(settings.rounding_interval || '15', 10);
                    const roundedStart = roundToNearestInterval(now, intervalMinutes);
                    startTimeToUse = formatISO(roundedStart);
                    console.log(`[TimeRounding] New slice start rounded from ${formatISO(now)} to ${startTimeToUse} (Interval: ${intervalMinutes}m)`);
                } else {
                    startTimeToUse = formatISO(now);
                }
            } catch (err) {
                console.error('[TimeRounding] Failed to get settings for start rounding:', err);
                startTimeToUse = formatISO(now);
            }
        }

        // 3. Create new time slice in DB
        const slice = await api.saveTimeSlice({
            work_item_id: workItem.id,
            start_time: startTimeToUse,
            end_time: null // Open-ended
        });

        // 4. Fetch initial total seconds from DB (historical)
        const workItems = await api.getWorkItems({ query: workItem.jira_key || workItem.description });
        const freshWorkItem = workItems.find(wi => wi.id === workItem.id);
        const historicalSeconds = freshWorkItem?.total_seconds || 0;

        set({
            activeWorkItem: workItem,
            activeTimeSliceId: slice.id,
            startTime: startTimeToUse,
            elapsedSeconds: 0,
            totalTimeSpent: historicalSeconds,
            historicalBase: historicalSeconds
        });

        // Notify main process for tray update
        api.setTrayIcon('active', workItem.description);
        api.setTrayTooltip(`Tracking: ${workItem.description}`);
        notifyMiniPlayerActive(workItem, startTimeToUse);
    },

    stopTracking: async () => {
        const { activeTimeSliceId, activeWorkItem, startTime } = get();
        if (!activeTimeSliceId || !startTime) {
            notifyMiniPlayerIdle();
            return null;
        }

        const now = new Date();
        let finalEndTime = formatISO(now);

        // Apply time rounding to the END time only (start time remains as-is)
        try {
            const settings = await api.getSettings();
            if (settings.rounding_enabled === 'true') {
                const intervalMinutes = parseInt(settings.rounding_interval || '15', 10);
                const roundedEnd = roundToNearestInterval(now, intervalMinutes);
                finalEndTime = formatISO(roundedEnd);
                console.log(`[TimeRounding] End rounded to ${finalEndTime} (Interval: ${intervalMinutes}m)`);
            }
        } catch (err) {
            console.error('[TimeRounding] Failed to apply rounding:', err);
        }

        await api.saveTimeSlice({
            id: activeTimeSliceId,
            work_item_id: activeWorkItem!.id,
            start_time: startTime, // Keep the original start time
            end_time: finalEndTime
        });

        // Reset tray
        api.setTrayIcon('idle');
        api.setTrayTooltip('Jira Time Tracker');

        set({
            activeWorkItem: null,
            activeTimeSliceId: null,
            startTime: null,
            elapsedSeconds: 0,
            totalTimeSpent: 0,
            historicalBase: 0
        });

        notifyMiniPlayerIdle();

        return finalEndTime;
    },

    tick: () => {
        const { startTime } = get();
        if (startTime) {
            const start = new Date(startTime).getTime();
            const now = Date.now();
            const elapsed = Math.max(0, Math.floor((now - start) / 1000));

            // We need to know the historical time to add to elapsed
            // But totalTimeSpent in state is actually already updated if we do it right.
            // Actually, let's keep totalTimeSpent as the "running total" including current session.
            // To do that, we need to know the historical base.
            set((state) => {
                return {
                    elapsedSeconds: elapsed,
                    totalTimeSpent: state.historicalBase + elapsed
                };
            });
        }
    },

    handleAwayTime: async (action, awayStartTime, targetWorkItem) => {
        const { activeTimeSliceId, activeWorkItem, startTime } = get();
        if (!activeTimeSliceId || !activeWorkItem || !startTime) return;

        if (action === 'keep') {
            // Do nothing - time is already included in the current slice
            return;
        }

        if (action === 'discard') {
            // End the current slice at awayStartTime, then start a new one from now
            await api.saveTimeSlice({
                id: activeTimeSliceId,
                work_item_id: activeWorkItem.id,
                start_time: startTime,
                end_time: awayStartTime
            });

            // Start a new slice from now
            const now = formatISO(new Date());
            const newSlice = await api.saveTimeSlice({
                work_item_id: activeWorkItem.id,
                start_time: now,
                end_time: null
            });

            // Fetch updated historical seconds
            const workItems = await api.getWorkItems({ query: activeWorkItem.jira_key || activeWorkItem.description });
            const freshWorkItem = workItems.find(wi => wi.id === activeWorkItem.id);
            const historicalSeconds = freshWorkItem?.total_seconds || 0;

            set({
                activeTimeSliceId: newSlice.id,
                startTime: now,
                elapsedSeconds: 0,
                totalTimeSpent: historicalSeconds,
                historicalBase: historicalSeconds
            });
            return;
        }

        if (action === 'reassign' && targetWorkItem) {
            // End the current slice at awayStartTime
            await api.saveTimeSlice({
                id: activeTimeSliceId,
                work_item_id: activeWorkItem.id,
                start_time: startTime,
                end_time: awayStartTime
            });

            // Create a new slice for the away time assigned to targetWorkItem
            const now = formatISO(new Date());
            await api.saveTimeSlice({
                work_item_id: targetWorkItem.id,
                start_time: awayStartTime,
                end_time: now
            });

            // Start a new slice from now for the original work item
            const newSlice = await api.saveTimeSlice({
                work_item_id: activeWorkItem.id,
                start_time: now,
                end_time: null
            });

            // Fetch updated historical seconds
            const workItems = await api.getWorkItems({ query: activeWorkItem.jira_key || activeWorkItem.description });
            const freshWorkItem = workItems.find(wi => wi.id === activeWorkItem.id);
            const historicalSeconds = freshWorkItem?.total_seconds || 0;

            set({
                activeTimeSliceId: newSlice.id,
                startTime: now,
                elapsedSeconds: 0,
                totalTimeSpent: historicalSeconds,
                historicalBase: historicalSeconds
            });
        }
    },

    updateActiveWorkItem: async (workItem: WorkItem) => {
        const { activeTimeSliceId, elapsedSeconds } = get();

        if (!activeTimeSliceId) return;

        // Fetch fresh work item to get updated total_seconds
        const freshWorkItem = await api.getWorkItem(workItem.id);
        const historicalSeconds = freshWorkItem?.total_seconds || 0;

        set({
            activeWorkItem: workItem,
            historicalBase: historicalSeconds,
            totalTimeSpent: historicalSeconds + elapsedSeconds
        });

        // Notify main process for tray update
        api.setTrayIcon('active', workItem.description);
        api.setTrayTooltip(`Tracking: ${workItem.description}`);
        const currentStartTime = get().startTime;
        if (currentStartTime) {
            notifyMiniPlayerActive(workItem, currentStartTime);
        }
    },

    checkActiveTracking: async () => {
        const activeSlice = await api.getActiveTimeSlice();

        if (activeSlice) {
            // Guaranteed to find it even if it's completed or not in first search results
            const workItem = await api.getWorkItem(activeSlice.work_item_id);

            if (workItem) {
                const elapsed = Math.max(0, Math.floor((Date.now() - new Date(activeSlice.start_time).getTime()) / 1000));
                const totalIncludingActive = workItem.total_seconds || 0;
                const historicalBase = Math.max(0, totalIncludingActive - elapsed);

                set({
                    activeWorkItem: workItem,
                    activeTimeSliceId: activeSlice.id,
                    startTime: activeSlice.start_time,
                    elapsedSeconds: elapsed,
                    totalTimeSpent: historicalBase + elapsed,
                    historicalBase: historicalBase
                });

                // Update tray
                api.setTrayIcon('active', workItem.description);
                api.setTrayTooltip(`Tracking: ${workItem.description}`);
                notifyMiniPlayerActive(workItem, activeSlice.start_time);
            }
        } else {
            set({
                activeWorkItem: null,
                activeTimeSliceId: null,
                startTime: null,
                elapsedSeconds: 0
            });
            api.setTrayIcon('idle');
            api.setTrayTooltip('Jira Time Tracker');
            notifyMiniPlayerIdle();
        }
    }
}))
