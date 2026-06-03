import { DateNavigation } from "./DateNavigation"
import { QuickStartBar } from "./QuickStartBar"
import { TimeSliceTable } from "./TimeSliceTable"
import { Timeline } from "./Timeline"
import { useDateStore } from "@/stores/useDateStore"
import { useTrackingStore } from "@/stores/useTrackingStore"
import { useTimeSlices } from "@/hooks/useTimeSlices"
import { TimeSlice, api, JiraConnection, WorkItem } from "@/lib/api"
import { useState, useEffect, useRef, useMemo } from "react"
import { useSearchParams } from "react-router-dom";
import { EditWorkItemDialog } from "@/components/WorkItem/EditWorkItemDialog"
import { EditTimeSliceDialog } from "@/components/TimeSlice/EditTimeSliceDialog"
import { AddTimeSliceDialog } from "@/components/TimeSlice/AddTimeSliceDialog"
import { SplitTimeSliceDialog } from "@/components/TimeSlice/SplitTimeSliceDialog"
import { MoveTimeSliceDialog } from "@/components/TimeSlice/MoveTimeSliceDialog"
import { ConfirmDialog } from "@/components/shared/ConfirmDialog"
import { SyncToJiraDialog } from "@/components/Sync/SyncToJiraDialog"
import { CopyTimeSliceDialog } from "@/components/TimeSlice/CopyTimeSliceDialog"
import { MergeSlicesDialog } from "@/components/shared/MergeSlicesDialog"
import { ArrowLeftRight, Plus, WandSparkles } from "lucide-react"
import { Button } from "@/components/ui/button"
import { roundTimeSliceBoundaries } from "@/lib/time-utils"
import { toast } from "sonner"

export function Dashboard() {
    const { selectedDate, setSelectedDate } = useDateStore();
    const { slices, loading, refresh } = useTimeSlices(selectedDate);
    const activeTimeSliceId = useTrackingStore(state => state.activeTimeSliceId);
    const prevActiveIdRef = useRef<number | null>(activeTimeSliceId);

    // Check for date param
    // Check for date param
    const [searchParams, setSearchParams] = useSearchParams();

    useEffect(() => {
        const dateParam = searchParams.get('date');
        console.log("Dashboard mount - dateParam:", dateParam);

        if (dateParam) {
            const newDate = new Date(dateParam);
            if (!isNaN(newDate.getTime())) {
                console.log("Setting selected date to:", newDate);
                setSelectedDate(newDate);

                // Remove the date param
                searchParams.delete('date');
                setSearchParams(searchParams);
            }
        }
    }, [searchParams, setSearchParams, setSelectedDate]);

    // Selection State
    const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());

    // Dialog States
    const [editSlice, setEditSlice] = useState<TimeSlice | null>(null);
    const [editWorkItem, setEditWorkItem] = useState<WorkItem | null>(null);
    const [addSliceOpen, setAddSliceOpen] = useState(false);
    const [splitSlice, setSplitSlice] = useState<TimeSlice | null>(null);
    const [moveSlice, setMoveSlice] = useState<TimeSlice | null>(null);
    const [deleteSlice, setDeleteSlice] = useState<TimeSlice | null>(null);
    const [copySlice, setCopySlice] = useState<TimeSlice | null>(null);
    const [syncOpen, setSyncOpen] = useState(false);
    const [mergeOpen, setMergeOpen] = useState(false);
    const [jiraConnections, setJiraConnections] = useState<JiraConnection[]>([]);
    const [otherColor, setOtherColor] = useState("#64748b");
    const [dailyTargetHours, setDailyTargetHours] = useState(8);
    const [roundingSlices, setRoundingSlices] = useState(false);

    // Refresh list when tracking starts/stops
    // AND detection of when timing stops to prompt for notes
    useEffect(() => {
        if (prevActiveIdRef.current && !activeTimeSliceId) {
            // Tracking just stopped!
            const lastId = prevActiveIdRef.current;
            api.getTimeSlice(lastId).then(slice => {
                if (slice) setEditSlice(slice);
            });
        }
        prevActiveIdRef.current = activeTimeSliceId;
        refresh();
        setSelectedIds(new Set()); // Clear selection on refresh

        // Fetch connection info for colors
        api.getJiraConnections().then(setJiraConnections);
        api.getSettings().then(settings => {
            setOtherColor(settings.other_color || "#64748b");
            if (settings.daily_target_hours) {
                setDailyTargetHours(parseFloat(settings.daily_target_hours));
            }
        });
    }, [activeTimeSliceId, refresh]);

    // Clear selection when date changes
    useEffect(() => {
        setSelectedIds(new Set());
    }, [selectedDate]);

    // Handlers
    const handleEdit = (slice: TimeSlice) => setEditSlice(slice);
    const handleEditWorkItem = async (slice: TimeSlice) => {
        try {
            const workItem = await api.getWorkItem(slice.work_item_id);
            if (workItem) {
                setEditWorkItem(workItem);
            }
        } catch (error) {
            console.error("Failed to fetch work item", error);
        }
    };
    const handleSplit = (slice: TimeSlice) => setSplitSlice(slice);
    const handleMove = (slice: TimeSlice) => setMoveSlice(slice);
    const handleDelete = (slice: TimeSlice) => setDeleteSlice(slice);
    const handleCopy = (slice: TimeSlice) => setCopySlice(slice);
    const handleResume = async (slice: TimeSlice) => {
        const { startTracking } = useTrackingStore.getState();
        try {
            const workItem = await api.getWorkItem(slice.work_item_id);
            if (workItem) {
                await startTracking(workItem);
                refresh();
            }
        } catch (err) {
            console.error("Failed to resume tracking", err);
        }
    };

    const confirmDelete = async () => {
        if (deleteSlice) {
            await api.deleteTimeSlice(deleteSlice.id);
            setDeleteSlice(null);
            refresh();
        }
    }

    const confirmMerge = async () => {
        const ids = Array.from(selectedIds);
        try {
            await api.mergeTimeSlices(ids);
            setMergeOpen(false);
            setSelectedIds(new Set());
            // Refresh tracking state in case merged slices included the active one
            await useTrackingStore.getState().checkActiveTracking();
            refresh();
        } catch (err) {
            console.error("Failed to merge slices", err);
        }
    }

    const handleRoundTimeSlices = async () => {
        setRoundingSlices(true);
        try {
            const settings = await api.getSettings();
            const roundingEnabled = settings.rounding_enabled === 'true';
            const configuredInterval = parseInt(settings.rounding_interval || '15', 10);
            const intervalMinutes = roundingEnabled && Number.isFinite(configuredInterval)
                ? configuredInterval
                : 1;

            let updatedCount = 0;

            for (const slice of slices) {
                const rounded = roundTimeSliceBoundaries(slice, intervalMinutes);
                if (rounded.start_time === slice.start_time && rounded.end_time === slice.end_time) {
                    continue;
                }

                await api.saveTimeSlice({
                    id: slice.id,
                    work_item_id: slice.work_item_id,
                    start_time: rounded.start_time,
                    end_time: rounded.end_time,
                    notes: slice.notes
                });
                updatedCount++;
            }

            await useTrackingStore.getState().checkActiveTracking();
            await refresh();

            if (updatedCount > 0) {
                toast.success(`Rounded ${updatedCount} time slice${updatedCount === 1 ? '' : 's'}`);
            } else {
                toast.info("Time slices already match the time rounding setting");
            }
        } catch (err) {
            console.error("Failed to round time slices", err);
            toast.error("Failed to round time slices");
        } finally {
            setRoundingSlices(false);
        }
    }

    // Keep track of "now" to update active durations
    const [now, setNow] = useState(new Date());

    useEffect(() => {
        const interval = setInterval(() => setNow(new Date()), 1000); // Update every second
        return () => clearInterval(interval);
    }, []);

    // Calculate total time and connection breakdown for the day
    const dashboardData = useMemo(() => {
        let totalMinutes = 0;
        const connectionMap = new Map<number | string, { name: string, minutes: number }>();

        for (const slice of slices) {
            if (slice.start_time) {
                const start = new Date(slice.start_time).getTime();
                const end = slice.end_time ? new Date(slice.end_time).getTime() : now.getTime();
                const durationMinutes = Math.max(0, end - start) / (1000 * 60);
                totalMinutes += durationMinutes;

                const connId = slice.jira_connection_id || 'other';
                const connName = slice.connection_name || 'Other';

                const existing = connectionMap.get(connId) || { name: connName, minutes: 0 };
                existing.minutes += durationMinutes;
                connectionMap.set(connId, existing);
            }
        }

        const connectionData = Array.from(connectionMap.entries())
            .filter(([, c]) => c.minutes > 0)
            .map(([id, c]) => {
                const connection = typeof id === 'number' ? jiraConnections.find(conn => conn.id === id) : null;
                const color = connection?.color || (id === 'other' ? otherColor : 'hsl(var(--primary))');
                return {
                    name: c.name,
                    minutes: c.minutes,
                    fill: color
                };
            });

        const hours = Math.floor(totalMinutes / 60);
        const minutes = Math.round(totalMinutes % 60);
        return {
            totalMinutes,
            connectionData,
            formatted: `${hours}h ${minutes.toString().padStart(2, '0')}m`
        };
    }, [slices, now, jiraConnections, otherColor]);

    const selectedSlices = useMemo(() => {
        return slices.filter(s => selectedIds.has(s.id));
    }, [slices, selectedIds]);

    return (
        <div className="flex flex-col flex-1 min-h-0 bg-background">
            <div className="flex-1 p-6 space-y-6 overflow-y-auto" onWheel={(e) => e.stopPropagation()}>
                <div className="flex items-center justify-between">
                    <div className="flex items-center gap-4">
                        <h1 className="text-2xl font-bold tracking-tight">Dashboard</h1>
                    </div>
                    <div className="flex items-center gap-2">
                        <Button
                            variant="outline"
                            size="sm"
                            onClick={() => setSyncOpen(true)}
                            className="text-primary hover:text-primary hover:bg-primary/5"
                        >
                            <ArrowLeftRight className="h-4 w-4 mr-2" /> Sync to Jira
                        </Button>
                        <DateNavigation />
                    </div>
                </div>

                <QuickStartBar
                    totalMinutes={dashboardData.totalMinutes}
                    connectionData={dashboardData.connectionData}
                    targetMinutes={dailyTargetHours * 60}
                />

                <Timeline
                    date={selectedDate}
                    slices={slices}
                    onSliceClick={handleEdit}
                    connections={jiraConnections}
                    otherColor={otherColor}
                    onSlicesUpdated={refresh}
                />

                <div className="space-y-4">
                    <div className="flex items-center justify-between">
                        <h2 className="text-lg font-semibold">Time Slices</h2>
                        <div className="flex items-center gap-2">
                            <Button
                                variant="outline"
                                size="sm"
                                onClick={handleRoundTimeSlices}
                                disabled={loading || roundingSlices || slices.length === 0}
                                title="Round time slices for the selected day"
                            >
                                <WandSparkles className="h-4 w-4 mr-2" /> Round Time Slices
                            </Button>
                            <Button
                                variant="outline"
                                size="sm"
                                onClick={() => setAddSliceOpen(true)}
                            >
                                <Plus className="h-4 w-4 mr-2" /> Add Time Slice
                            </Button>
                        </div>
                    </div>
                    {loading ? (
                        <div className="p-10 text-center text-muted-foreground animate-pulse">Loading...</div>
                    ) : (
                        <TimeSliceTable
                            slices={slices}
                            selectedIds={selectedIds}
                            onSelectionChange={setSelectedIds}
                            onEdit={handleEdit}
                            onEditWorkItem={handleEditWorkItem}
                            onDelete={handleDelete}
                            onSplit={handleSplit}
                            onMove={handleMove}
                            onResume={handleResume}
                            onCopy={handleCopy}
                            onMerge={() => setMergeOpen(true)}
                            connections={jiraConnections}
                            otherColor={otherColor}
                            onStop={async (slice) => {
                                if (!slice.end_time) {
                                    await useTrackingStore.getState().stopTracking();
                                    refresh();
                                }
                            }}
                        />
                    )}
                </div>
            </div>

            <EditWorkItemDialog
                open={!!editWorkItem}
                onOpenChange={(open) => !open && setEditWorkItem(null)}
                item={editWorkItem}
                onSave={refresh}
            />
            <EditTimeSliceDialog
                open={!!editSlice}
                onOpenChange={(open) => !open && setEditSlice(null)}
                slice={editSlice}
                onSave={refresh}
            />
            <AddTimeSliceDialog
                open={addSliceOpen}
                onOpenChange={setAddSliceOpen}
                selectedDate={selectedDate}
                onSave={refresh}
            />
            <SplitTimeSliceDialog
                open={!!splitSlice}
                onOpenChange={(open) => !open && setSplitSlice(null)}
                slice={splitSlice}
                onSave={refresh}
            />
            <MoveTimeSliceDialog
                open={!!moveSlice}
                onOpenChange={(open) => !open && setMoveSlice(null)}
                slice={moveSlice}
                onSave={refresh}
            />
            <CopyTimeSliceDialog
                open={!!copySlice}
                onOpenChange={(open) => !open && setCopySlice(null)}
                slice={copySlice}
                onSave={refresh}
            />
            <ConfirmDialog
                open={!!deleteSlice}
                onOpenChange={(open) => !open && setDeleteSlice(null)}
                onConfirm={confirmDelete}
                title="Delete Time Slice?"
                description="This action cannot be undone."
                variant="destructive"
                confirmText="Delete"
            />

            <MergeSlicesDialog
                open={mergeOpen}
                onOpenChange={setMergeOpen}
                slicesToMerge={selectedSlices}
                onConfirm={confirmMerge}
            />

            <SyncToJiraDialog
                open={syncOpen}
                onOpenChange={setSyncOpen}
                date={selectedDate}
                slices={slices}
                onSuccess={refresh}
            />
        </div>
    )
}
