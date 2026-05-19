import { useEffect, useMemo, useState } from "react"
import { format, startOfDay, endOfDay } from "date-fns"
import { CalendarDays, CheckCircle2, Loader2, RefreshCcw, XCircle } from "lucide-react"

import { api, JiraConnection, JiraWorklogImportResult } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { Calendar } from "@/components/ui/calendar"
import { Checkbox } from "@/components/ui/checkbox"
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import {
    Popover,
    PopoverContent,
    PopoverTrigger,
} from "@/components/ui/popover"
import { ScrollArea } from "@/components/ui/scroll-area"
import { cn } from "@/lib/utils"
import type { DateRange } from "react-day-picker"

interface ImportJiraWorklogsDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
}

const initialRange = (): DateRange => {
    const today = new Date();
    return { from: today, to: today };
};

export function ImportJiraWorklogsDialog({ open, onOpenChange }: ImportJiraWorklogsDialogProps) {
    const [connections, setConnections] = useState<JiraConnection[]>([]);
    const [selectedConnectionIds, setSelectedConnectionIds] = useState<number[]>([]);
    const [range, setRange] = useState<DateRange | undefined>(initialRange());
    const [importing, setImporting] = useState(false);
    const [result, setResult] = useState<JiraWorklogImportResult | null>(null);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        if (!open) return;

        api.getJiraConnections().then((data) => {
            const enabled = data.filter((conn) => conn.is_enabled === 1);
            setConnections(enabled);
            setSelectedConnectionIds(enabled.map((conn) => conn.id));
        }).catch((err) => {
            console.error("Failed to load Jira connections", err);
            setConnections([]);
            setSelectedConnectionIds([]);
        });

        setRange(initialRange());
        setResult(null);
        setError(null);
        setImporting(false);
    }, [open]);

    const hasValidRange = !!range?.from && !!range?.to;
    const canImport = hasValidRange && selectedConnectionIds.length > 0 && !importing;

    const selectedConnectionNames = useMemo(() => {
        if (selectedConnectionIds.length === connections.length) {
            return "All enabled connections";
        }

        const names = connections
            .filter((conn) => selectedConnectionIds.includes(conn.id))
            .map((conn) => conn.name);

        if (names.length === 0) return "No connections selected";
        if (names.length <= 2) return names.join(", ");
        return `${names.length} connections selected`;
    }, [connections, selectedConnectionIds]);

    const toggleConnection = (connectionId: number, checked: boolean) => {
        setSelectedConnectionIds((current) => {
            if (checked) {
                return current.includes(connectionId) ? current : [...current, connectionId];
            }
            return current.filter((id) => id !== connectionId);
        });
    };

    const handleImport = async () => {
        if (!range?.from || !range?.to || selectedConnectionIds.length === 0) {
            return;
        }

        setImporting(true);
        setError(null);

        try {
            const importResult = await api.importJiraWorklogs({
                startDate: startOfDay(range.from).toISOString(),
                endDate: endOfDay(range.to).toISOString(),
                connectionIds: selectedConnectionIds,
            });
            setResult(importResult);
        } catch (err) {
            console.error("Failed to import Jira worklogs", err);
            setError(err instanceof Error ? err.message : "Import failed.");
        } finally {
            setImporting(false);
        }
    };

    const handleClose = (nextOpen: boolean) => {
        if (!nextOpen) {
            setResult(null);
            setError(null);
        }
        onOpenChange(nextOpen);
    };

    return (
        <Dialog open={open} onOpenChange={handleClose}>
            <DialogContent className="flex max-h-[85vh] flex-col overflow-hidden sm:max-w-[760px]">
                <DialogHeader>
                    <DialogTitle>Import Jira Worklogs</DialogTitle>
                    <DialogDescription>
                        Import your Jira worklogs into local time slices for the selected days and connections.
                    </DialogDescription>
                </DialogHeader>

                <div className="grid min-h-0 flex-1 gap-6 overflow-hidden py-4 md:grid-cols-[320px_minmax(0,1fr)]">
                    <div className="space-y-3">
                        <div className="grid gap-2">
                            <Label>Date Range</Label>
                            <Popover>
                                <PopoverTrigger asChild>
                                    <Button
                                        variant="outline"
                                        className={cn(
                                            "w-full justify-start text-left font-normal",
                                            !hasValidRange && "text-muted-foreground"
                                        )}
                                    >
                                        <CalendarDays className="mr-2 h-4 w-4" />
                                        {range?.from ? (
                                            range.to ? (
                                                `${format(range.from, "PPP")} - ${format(range.to, "PPP")}`
                                            ) : (
                                                format(range.from, "PPP")
                                            )
                                        ) : (
                                            "Select days"
                                        )}
                                    </Button>
                                </PopoverTrigger>
                                <PopoverContent className="w-auto p-0" align="start">
                                    <Calendar
                                        mode="range"
                                        selected={range}
                                        onSelect={setRange}
                                        numberOfMonths={2}
                                        defaultMonth={range?.from}
                                    />
                                </PopoverContent>
                            </Popover>
                            <p className="text-xs text-muted-foreground">
                                Multiple days are imported as one inclusive date range.
                            </p>
                        </div>

                        <div className="grid gap-2">
                            <div className="flex items-center justify-between">
                                <Label>Jira Connections</Label>
                                <Button
                                    type="button"
                                    variant="ghost"
                                    size="sm"
                                    className="h-7 px-2 text-xs"
                                    onClick={() => setSelectedConnectionIds(connections.map((conn) => conn.id))}
                                    disabled={connections.length === 0}
                                >
                                    All
                                </Button>
                            </div>
                            <div className="rounded-md border">
                                <ScrollArea className="h-[220px]" onWheel={(e) => e.stopPropagation()}>
                                    <div className="space-y-2 p-3">
                                        {connections.length === 0 ? (
                                            <p className="text-sm text-muted-foreground">No enabled Jira connections found.</p>
                                        ) : (
                                            connections.map((conn) => (
                                                <label
                                                    key={conn.id}
                                                    className="flex cursor-pointer items-center justify-between gap-3 rounded-md border px-3 py-2 hover:bg-muted/30"
                                                >
                                                    <div className="flex items-center gap-3">
                                                        <Checkbox
                                                            checked={selectedConnectionIds.includes(conn.id)}
                                                            onCheckedChange={(checked) => toggleConnection(conn.id, checked === true)}
                                                        />
                                                        <div className="flex items-center gap-2">
                                                            {conn.color && (
                                                                <span
                                                                    className="h-2.5 w-2.5 rounded-full border border-black/10"
                                                                    style={{ backgroundColor: conn.color }}
                                                                />
                                                            )}
                                                            <span className="text-sm font-medium">{conn.name}</span>
                                                        </div>
                                                    </div>
                                                </label>
                                            ))
                                        )}
                                    </div>
                                </ScrollArea>
                            </div>
                            <p className="text-xs text-muted-foreground">{selectedConnectionNames}</p>
                        </div>
                    </div>

                    <div className="min-h-0 space-y-4">
                        <div className="rounded-md border bg-muted/20 p-4">
                            <p className="text-sm font-medium">Import behavior</p>
                            <ul className="mt-2 space-y-1 text-sm text-muted-foreground">
                                <li>Only the authenticated user&apos;s worklogs are imported.</li>
                                <li>Existing imported slices are updated by Jira worklog ID.</li>
                                <li>Missing Jira issues are created as local work items automatically.</li>
                            </ul>
                        </div>

                        {error && (
                            <div className="rounded-md border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">
                                {error}
                            </div>
                        )}

                        {result ? (
                            <div className="space-y-4">
                                <div className="grid gap-3 sm:grid-cols-3">
                                    <div className="rounded-md border bg-emerald-50 p-4 text-emerald-700 dark:bg-emerald-950/20 dark:text-emerald-300">
                                        <div className="text-xs font-semibold uppercase tracking-wide">Created</div>
                                        <div className="mt-1 text-2xl font-bold">{result.created}</div>
                                    </div>
                                    <div className="rounded-md border bg-blue-50 p-4 text-blue-700 dark:bg-blue-950/20 dark:text-blue-300">
                                        <div className="text-xs font-semibold uppercase tracking-wide">Updated</div>
                                        <div className="mt-1 text-2xl font-bold">{result.updated}</div>
                                    </div>
                                    <div className="rounded-md border bg-muted p-4">
                                        <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Skipped</div>
                                        <div className="mt-1 text-2xl font-bold">{result.skipped}</div>
                                    </div>
                                </div>

                                {result.failed.length > 0 ? (
                                    <div className="space-y-2">
                                        <div className="flex items-center gap-2 text-sm font-medium text-destructive">
                                            <XCircle className="h-4 w-4" />
                                            {result.failed.length} failed imports
                                        </div>
                                        <ScrollArea className="h-[210px] rounded-md border" onWheel={(e) => e.stopPropagation()}>
                                            <div className="space-y-2 p-3">
                                                {result.failed.map((failure, index) => (
                                                    <div key={`${failure.connectionId ?? "na"}-${failure.worklogId ?? "na"}-${index}`} className="rounded-md border border-destructive/20 bg-destructive/5 p-3 text-sm">
                                                        <div className="font-medium">
                                                            {failure.jiraKey || "Connection error"}
                                                            {failure.worklogId ? ` • Worklog ${failure.worklogId}` : ""}
                                                        </div>
                                                        <div className="text-muted-foreground">
                                                            {failure.error}
                                                        </div>
                                                    </div>
                                                ))}
                                            </div>
                                        </ScrollArea>
                                    </div>
                                ) : (
                                    <div className="flex items-center gap-2 rounded-md border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/20 dark:text-emerald-300">
                                        <CheckCircle2 className="h-4 w-4" />
                                        No failures were reported for this import.
                                    </div>
                                )}
                            </div>
                        ) : (
                            <div className="flex min-h-[240px] items-center justify-center rounded-md border border-dashed px-6 text-center text-sm text-muted-foreground">
                                Choose a date range and one or more Jira connections, then start the import.
                            </div>
                        )}
                    </div>
                </div>

                <DialogFooter className="gap-2 sm:gap-0">
                    <Button variant="outline" onClick={() => handleClose(false)} disabled={importing}>
                        {result ? "Close" : "Cancel"}
                    </Button>
                    <Button onClick={handleImport} disabled={!canImport}>
                        {importing ? (
                            <>
                                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                                Importing...
                            </>
                        ) : result ? (
                            <>
                                <RefreshCcw className="mr-2 h-4 w-4" />
                                Import Again
                            </>
                        ) : (
                            "Import Worklogs"
                        )}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    )
}
