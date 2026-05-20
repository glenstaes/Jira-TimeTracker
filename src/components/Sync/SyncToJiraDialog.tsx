import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { TimeSlice, api } from "@/lib/api"
import { useState, useMemo } from "react"
import { Loader2, CheckCircle, AlertTriangle, XCircle } from "lucide-react"
import { format, differenceInSeconds, intervalToDuration } from "date-fns"
import { ScrollArea } from "@/components/ui/scroll-area"
import { toast } from "sonner"
import { cn } from "@/lib/utils"
import { Tooltip, TooltipTrigger } from "@/components/ui/tooltip"
import { TimeSliceTooltipContent } from "@/components/shared/TimeSliceTooltip"
import { getJiraWorklogComment } from "./syncToJiraPayload"

interface SyncToJiraDialogProps {
    date: Date;
    slices: TimeSlice[];
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onSuccess: () => void;
}

type SyncResult = {
    synced: TimeSlice[];
    skippedConnection: TimeSlice[];
    skippedKey: TimeSlice[];
    failed: { slice: TimeSlice; error: string }[];
}

export function SyncToJiraDialog({ date, slices, open, onOpenChange, onSuccess }: SyncToJiraDialogProps) {
    const [syncing, setSyncing] = useState(false);
    const [progress, setProgress] = useState("");
    const [syncResult, setSyncResult] = useState<SyncResult | null>(null);

    // Filter logic
    const { syncable, skippedConnection, skippedKey, activeSlice } = useMemo(() => {
        const syncable: TimeSlice[] = [];
        const skippedConnection: TimeSlice[] = [];
        const skippedKey: TimeSlice[] = [];
        let activeSlice: TimeSlice | undefined;

        slices.forEach(s => {
            // Check for active slice first - global blocker logic
            if (!s.end_time) {
                activeSlice = s;
                return; // Don't add to other lists? Or just block the button? 
                // Requirement: "prevents synching that day". So if there is ANY active slice, we blocking everything.
            }

            // Must have Jira Key to be considered for sync or connection skip
            if (!s.jira_key) {
                skippedKey.push(s);
                return;
            }

            // Must have Jira Connection to be syncable
            if (!s.jira_connection_id) {
                skippedConnection.push(s);
                return;
            }

            // Already synced?
            if (s.synced_to_jira) {
                // Check if changed
                const isOutOfSync = s.start_time !== s.synced_start_time ||
                    s.end_time !== s.synced_end_time ||
                    s.notes !== s.synced_notes;
                if (!isOutOfSync) return; // Already synced and up to date
            }

            syncable.push(s);
        });

        return { syncable, skippedConnection, skippedKey, activeSlice };
    }, [slices]);

    const formatDuration = (slice: TimeSlice) => {
        if (!slice.start_time) return "00:00";
        const start = new Date(slice.start_time);
        const end = slice.end_time ? new Date(slice.end_time) : new Date();
        const duration = intervalToDuration({ start, end });
        const hours = (duration.hours || 0) + (duration.days || 0) * 24;
        const minutes = duration.minutes || 0;
        return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}`;
    };

    const handleSync = async () => {
        setSyncing(true);
        const result: SyncResult = {
            synced: [],
            skippedConnection: [...skippedConnection],
            skippedKey: [...skippedKey],
            failed: []
        };

        try {
            for (const slice of syncable) {
                if (!slice.jira_key || !slice.end_time) continue; // Should be filtered already

                setProgress(`Syncing ${slice.jira_key}...`);

                const start = new Date(slice.start_time);
                const end = new Date(slice.end_time);
                const duration = differenceInSeconds(end, start);

                try {
                    const comment = getJiraWorklogComment(slice.notes);

                    let logResult;
                    if (slice.jira_worklog_id) {
                        try {
                            logResult = await api.updateJiraWorklog(slice.jira_key, slice.jira_worklog_id, {
                                timeSpentSeconds: duration,
                                comment,
                                started: slice.start_time
                            });
                        } catch (updateError: unknown) {
                            const err = updateError as { response?: { status?: number }; message?: string };
                            const is404 = err.response?.status === 404 ||
                                err.message?.includes('404') ||
                                err.message?.includes('status code 404');

                            if (is404) {
                                console.log(`Worklog ${slice.jira_worklog_id} not found, creating new one`);
                                logResult = await api.addJiraWorklog(slice.jira_key, {
                                    timeSpentSeconds: duration,
                                    comment,
                                    started: slice.start_time
                                });
                            } else {
                                throw updateError;
                            }
                        }
                    } else {
                        logResult = await api.addJiraWorklog(slice.jira_key, {
                            timeSpentSeconds: duration,
                            comment,
                            started: slice.start_time
                        });
                    }

                    await api.saveTimeSlice({
                        id: slice.id,
                        work_item_id: slice.work_item_id,
                        start_time: slice.start_time,
                        end_time: slice.end_time,
                        notes: slice.notes,
                        synced_to_jira: 1,
                        jira_worklog_id: logResult.id,
                        synced_start_time: slice.start_time,
                        synced_end_time: slice.end_time,
                        synced_notes: slice.notes
                    });

                    result.synced.push(slice);
                } catch (err: unknown) {
                    console.error(`Failed to sync slice ${slice.id}`, err);
                    const error = err as { response?: { data?: { errorMessages?: string[] } }; message?: string };
                    const msg = error.response?.data?.errorMessages?.[0] || error.message || "Unknown error";
                    result.failed.push({ slice, error: msg });
                }
            }

            setSyncResult(result);

            // Show toast summary
            const skippedCount = result.skippedConnection.length + result.skippedKey.length;
            toast.success(`Sync completed`, {
                description: `${result.synced.length} synced, ${skippedCount} skipped (see details), ${result.failed.length} failed.`
            });

            onSuccess(); // Trigger parent refresh
        } catch (err) {
            console.error("Fatal sync error", err);
            toast.error("Sync process failed abruptly");
        } finally {
            setSyncing(false);
            setProgress("");
        }
    }

    const handleClose = () => {
        onOpenChange(false);
        // Reset state after closing animations could be better but simple reset works
        setTimeout(() => setSyncResult(null), 300);
    }

    // Render Logic
    const renderContent = () => {
        // 1. Post-Sync Results View
        if (syncResult) {
            return (
                <div className="space-y-4 py-4">
                    <div className="flex items-center gap-2 text-emerald-600 bg-emerald-50 p-3 rounded border border-emerald-200">
                        <CheckCircle className="h-5 w-5" />
                        <div className="flex-1">
                            <p className="font-medium">Sync Complete</p>
                            <p className="text-sm text-emerald-700">
                                {syncResult.synced.length} items successfully synced to Jira.
                            </p>
                        </div>
                    </div>

                    {(syncResult.skippedConnection.length > 0 || syncResult.skippedKey.length > 0) && (
                        <div className="space-y-2">
                            <div className="flex items-center gap-2 text-amber-600">
                                <AlertTriangle className="h-4 w-4" />
                                <span className="font-medium text-sm">Skipped Items (Manual Action Required)</span>
                            </div>
                            <ScrollArea className="h-[200px] border rounded bg-slate-50 dark:bg-slate-900/50" onWheel={(e) => e.stopPropagation()}>
                                <div className="p-2 space-y-1">
                                    {syncResult.skippedConnection.map(s => (
                                        <div key={s.id} className="text-sm p-2 bg-white dark:bg-slate-800 rounded border border-amber-100 dark:border-amber-900/30 flex justify-between items-center">
                                            <div className="flex flex-col overflow-hidden">
                                                <span className="font-medium truncate">{s.work_item_description}</span>
                                                <span className="text-xs text-muted-foreground">{s.jira_key} • {formatDuration(s)}</span>
                                            </div>
                                            <span className="text-xs bg-amber-100 dark:bg-amber-900 text-amber-700 dark:text-amber-300 px-2 py-0.5 rounded">No Connection</span>
                                        </div>
                                    ))}
                                    {syncResult.skippedKey.map(s => (
                                        <div key={s.id} className="text-sm p-2 bg-white dark:bg-slate-800 rounded border border-slate-200 dark:border-slate-800 flex justify-between items-center">
                                            <div className="flex flex-col overflow-hidden">
                                                <span className="font-medium truncate">{s.work_item_description}</span>
                                                <span className="text-xs text-muted-foreground">{formatDuration(s)}</span>
                                            </div>
                                            <span className="text-xs bg-slate-100 dark:bg-slate-800 text-slate-500 px-2 py-0.5 rounded">Local Only</span>
                                        </div>
                                    ))}
                                </div>
                            </ScrollArea>
                        </div>
                    )}

                    {syncResult.failed.length > 0 && (
                        <div className="space-y-2">
                            <div className="flex items-center gap-2 text-red-600">
                                <XCircle className="h-4 w-4" />
                                <span className="font-medium text-sm">Failed Items</span>
                            </div>
                            <ScrollArea className="h-[100px] border rounded bg-red-50 dark:bg-red-900/10" onWheel={(e) => e.stopPropagation()}>
                                <div className="p-2 space-y-1">
                                    {syncResult.failed.map(({ slice, error }) => (
                                        <div key={slice.id} className="text-sm p-2 text-red-700 dark:text-red-300">
                                            <span className="font-bold">{slice.jira_key}:</span> {error} • {formatDuration(slice)}
                                        </div>
                                    ))}
                                </div>
                            </ScrollArea>
                        </div>
                    )}
                </div>
            );
        }

        // 2. Active Tracking Warning (Blocking)
        if (activeSlice) {
            return (
                <div className="py-8 flex flex-col items-center text-center space-y-4">
                    <div className="h-12 w-12 rounded-full bg-amber-100 dark:bg-amber-900/30 flex items-center justify-center text-amber-600 dark:text-amber-500">
                        <Loader2 className="h-6 w-6 animate-spin" /> {/* Or just a clock icon */}
                    </div>
                    <div className="space-y-2 px-4">
                        <h3 className="font-semibold text-lg">Active Timer Detected</h3>
                        <p className="text-muted-foreground text-sm">
                            You cannot sync while a timer is running. Please stop the active timer for <span className="font-medium text-foreground">{activeSlice.jira_key || activeSlice.work_item_description}</span> before syncing.
                        </p>
                    </div>
                </div>
            );
        }

        // 3. Pre-Sync View
        const hasWork = syncable.length > 0 || skippedConnection.length > 0 || skippedKey.length > 0;

        if (!hasWork) {
            return (
                <div className="flex flex-col items-center text-center text-muted-foreground py-8">
                    <CheckCircle className="h-12 w-12 mb-4 text-emerald-500/50" />
                    <p>All eligible items for {format(date, "MMMM do")} are already synced.</p>
                </div>
            );
        }

        return (
            <div className="space-y-4 py-4">
                {/* Syncable Items */}
                <div className="space-y-2">
                    <div className="flex items-center justify-between">
                        <h4 className="text-sm font-medium text-muted-foreground">Ready to Sync ({syncable.length})</h4>
                        {syncable.length > 0 && <span className="text-[10px] text-muted-foreground italic">Approx. {Math.ceil(syncable.length * 1.5)}s</span>}
                    </div>

                    {syncable.length > 0 ? (
                        <ScrollArea className="max-h-[60vh] h-auto border rounded bg-white dark:bg-slate-950" onWheel={(e) => e.stopPropagation()}>
                            <div className="p-1">
                                {syncable.map(s => {
                                    const RowContent = (
                                        <div className={cn("grid grid-cols-[80px_1fr_auto] gap-3 items-center p-2 text-sm border-b last:border-0 hover:bg-slate-50 dark:hover:bg-slate-900 group cursor-default transition-colors", s.notes && "cursor-help hover:bg-muted/50")}>
                                            <span className="font-mono font-medium text-emerald-600 dark:text-emerald-500 truncate">{s.jira_key}</span>
                                            <div className={cn("text-muted-foreground truncate min-w-0 group-hover:text-foreground transition-colors", s.notes && "decoration-dotted underline underline-offset-4")}>
                                                {s.work_item_description}
                                            </div>
                                            <span className="font-mono text-xs text-muted-foreground whitespace-nowrap text-right">{formatDuration(s)}</span>
                                        </div>
                                    );

                                    return (
                                        <Tooltip key={s.id}>
                                            <TooltipTrigger asChild>
                                                {RowContent}
                                            </TooltipTrigger>
                                            <TimeSliceTooltipContent
                                                dateLabel={format(date, "EEEE, MMM do")}
                                                jiraKey={s.jira_key}
                                                description={s.work_item_description}
                                                items={[{
                                                    id: s.id,
                                                    startTime: s.start_time,
                                                    endTime: s.end_time,
                                                    text: s.notes
                                                }]}
                                            />
                                        </Tooltip>
                                    );
                                })}
                            </div>
                        </ScrollArea>
                    ) : (
                        <div className="h-[60px] border border-dashed rounded flex items-center justify-center text-sm text-muted-foreground">
                            No items ready to sync.
                        </div>
                    )}
                </div>

                {/* Non-Syncable Items */}
                {(skippedConnection.length > 0 || skippedKey.length > 0) && (
                    <div className="space-y-2">
                        <div className="flex items-center gap-2">
                            <h4 className="text-sm font-medium text-muted-foreground">Won't be Synced ({skippedConnection.length + skippedKey.length})</h4>
                        </div>
                        <ScrollArea className="h-[120px] border rounded bg-slate-50 dark:bg-slate-900/30" onWheel={(e) => e.stopPropagation()}>
                            <div className="p-1">
                                {skippedConnection.map(s => (
                                    <div key={s.id} className="flex justify-between items-center p-2 text-sm border-b border-white/50 dark:border-slate-800 last:border-0 opacity-80">
                                        <div className="flex items-center gap-3">
                                            <span className="font-mono font-medium text-amber-600 dark:text-amber-500 w-[80px]">{s.jira_key}</span>
                                            <div className="flex flex-col">
                                                <span className="text-muted-foreground truncate max-w-[200px]">{s.work_item_description}</span>
                                                <span className="text-[10px] text-amber-600/70 dark:text-amber-400/70">No Jira Connection</span>
                                            </div>
                                        </div>
                                        <span className="font-mono text-xs text-muted-foreground">{formatDuration(s)}</span>
                                    </div>
                                ))}
                                {skippedKey.map(s => (
                                    <div key={s.id} className="flex justify-between items-center p-2 text-sm border-b border-white/50 dark:border-slate-800 last:border-0 opacity-60">
                                        <div className="flex items-center gap-3">
                                            <span className="font-mono font-medium text-slate-400 w-[80px]">LOCAL</span>
                                            <span className="text-muted-foreground truncate max-w-[200px]">{s.work_item_description}</span>
                                        </div>
                                        <span className="font-mono text-xs text-muted-foreground">{formatDuration(s)}</span>
                                    </div>
                                ))}
                            </div>
                        </ScrollArea>
                    </div>
                )}

                {syncing && <p className="text-muted-foreground text-center text-sm mt-2 flex items-center justify-center gap-2"><Loader2 className="h-4 w-4 animate-spin" /> {progress}</p>}
            </div>
        );
    }

    return (
        <Dialog open={open} onOpenChange={(v) => {
            if (!v) handleClose();
            else onOpenChange(true);
        }}>
            <DialogContent className="sm:max-w-[800px]">
                <DialogHeader>
                    <DialogTitle>Sync to Jira</DialogTitle>
                    <DialogDescription>
                        {format(date, "MMMM do, yyyy")}
                    </DialogDescription>
                </DialogHeader>

                {renderContent()}

                <DialogFooter className="gap-2 sm:gap-0">
                    {syncResult ? (
                        <Button onClick={handleClose}>Close</Button>
                    ) : (
                        <>
                            <Button variant="secondary" onClick={handleClose} disabled={syncing}>Cancel</Button>
                            <Button
                                onClick={handleSync}
                                disabled={syncing || !!activeSlice || syncable.length === 0}
                                className={cn(!!activeSlice && "opacity-50 cursor-not-allowed")}
                            >
                                {syncing ? "Syncing..." : "Sync Now"}
                            </Button>
                        </>
                    )}
                </DialogFooter>
            </DialogContent>
        </Dialog>
    )
}
