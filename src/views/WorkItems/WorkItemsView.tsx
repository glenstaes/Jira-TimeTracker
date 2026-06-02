import { useState, useEffect } from "react"
import { api, WorkItem, JiraConnection } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Plus, Search, Trash2, Edit2, Download, MoreHorizontal, History, Clock, CheckCircle2, XCircle, ArrowRightLeft, ExternalLink, PlayCircle } from "lucide-react"
import { ConfirmDialog } from "@/components/shared/ConfirmDialog"
import { ImportFromJiraDialog } from "@/components/WorkItem/ImportFromJiraDialog"
import { CreateWorkItemDialog } from "@/components/WorkItem/CreateWorkItemDialog"
import { EditWorkItemDialog } from "@/components/WorkItem/EditWorkItemDialog"
import { WorkItemTimeSlicesDialog } from "@/components/WorkItem/WorkItemTimeSlicesDialog"
import { BulkChangeConnectionDialog } from "@/components/WorkItem/BulkChangeConnectionDialog"
import { Switch } from "@/components/ui/switch"
import { Label } from "@/components/ui/label"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, DropdownMenuSeparator } from "@/components/ui/dropdown-menu"
import { MessageDialog } from "@/components/shared/MessageDialog"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import { WorkItemContextMenu } from "./WorkItemContextMenu"
import { startTrackingFromWorkItemOverview } from "./workItemActions"
import { useTrackingStore } from "@/stores/useTrackingStore"
import {
    Pagination,
    PaginationContent,
    PaginationEllipsis,
    PaginationItem,
    PaginationLink,
    PaginationNext,
    PaginationPrevious,
} from "@/components/ui/pagination"

export function WorkItemsView() {
    const [items, setItems] = useState<WorkItem[]>([]);
    const [query, setQuery] = useState("");
    const [loading, setLoading] = useState(false);
    const [currentPage, setCurrentPage] = useState(1);
    const [totalCount, setTotalCount] = useState(0);
    const [showCompleted, setShowCompleted] = useState(false);
    const [selectedIds, setSelectedIds] = useState<number[]>([]);
    const [lastClickedId, setLastClickedId] = useState<number | null>(null);
    const itemsPerPage = 50;

    // Dialogs
    const [importOpen, setImportOpen] = useState(false);
    const [createOpen, setCreateOpen] = useState(false);
    const [editItem, setEditItem] = useState<WorkItem | null>(null);
    const [deleteItem, setDeleteItem] = useState<WorkItem | null>(null);
    const [timeSlicesItem, setTimeSlicesItem] = useState<WorkItem | null>(null);
    const [bulkConnectionOpen, setBulkConnectionOpen] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [jiraConnections, setJiraConnections] = useState<JiraConnection[]>([]);

    const fetchItems = async () => {
        setLoading(true);
        try {
            const offset = (currentPage - 1) * itemsPerPage;
            const [data, count] = await Promise.all([
                api.getWorkItems({ query, limit: itemsPerPage, offset, showCompleted }),
                api.getWorkItemsCount({ query, showCompleted })
            ]);
            setItems(data);
            setTotalCount(count);
            setSelectedIds([]); // Clear selection on refresh
        } catch (err) {
            console.error(err);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        api.getJiraConnections().then(setJiraConnections);
    }, []);

    useEffect(() => {
        setCurrentPage(1); // Reset to page 1 on search or filter change
    }, [query, showCompleted]);

    useEffect(() => {
        const timer = setTimeout(fetchItems, 300);
        return () => clearTimeout(timer);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [query, currentPage, showCompleted]);

    const handleDelete = async () => {
        if (deleteItem) {
            try {
                await api.deleteWorkItem(deleteItem.id);
                fetchItems();
            } catch {
                setError("Cannot delete work item with existing time slices.");
            }
            setDeleteItem(null);
        }
    }

    const handleToggleCompletion = async (ids: number[], completed: boolean) => {
        try {
            await api.updateWorkItemCompletion(ids, completed);
            fetchItems();
        } catch (err) {
            console.error(err);
        }
    }

    const toggleSelect = (id: number) => {
        if (selectedIds.includes(id)) {
            setSelectedIds(selectedIds.filter(i => i !== id));
        } else {
            setSelectedIds([...selectedIds, id]);
        }
    }

    const handleBulkSaveConnection = async (connectionId: number | null) => {
        try {
            await api.bulkUpdateWorkItemsConnection(selectedIds, connectionId);
            fetchItems();
        } catch (err) {
            console.error(err);
        }
    };

    const formatTotalTime = (seconds: number | undefined) => {
        if (!seconds || seconds === 0) return "0m";
        const hours = Math.floor(seconds / 3600);
        const minutes = Math.floor((seconds % 3600) / 60);

        if (hours === 0) return `${minutes}m`;
        return `${hours}h ${minutes}m`;
    };

    const handleOpenInJira = (item: WorkItem) => {
        if (!item.jira_key) return;
        const connection = item.jira_connection_id ? jiraConnections.find(c => c.id === item.jira_connection_id) : null;
        const baseUrl = connection?.base_url;
        if (baseUrl) {
            const url = `${baseUrl.replace(/\/$/, '')}/browse/${item.jira_key}`;
            api.openExternal(url);
        }
    };

    const handleStartTracking = (item: WorkItem) => {
        startTrackingFromWorkItemOverview(item, {
            startTracking: useTrackingStore.getState().startTracking,
            refreshWorkItems: fetchItems,
            logError: (message, err) => console.error(message, err)
        });
    };

    const totalPages = Math.ceil(totalCount / itemsPerPage);

    const renderPaginationItems = () => {
        const items = [];
        const maxVisible = 5;

        if (totalPages <= maxVisible) {
            for (let i = 1; i <= totalPages; i++) {
                items.push(
                    <PaginationItem key={i}>
                        <PaginationLink
                            isActive={currentPage === i}
                            onClick={() => setCurrentPage(i)}
                            className="cursor-pointer"
                        >
                            {i}
                        </PaginationLink>
                    </PaginationItem>
                );
            }
        } else {
            items.push(
                <PaginationItem key={1}>
                    <PaginationLink isActive={currentPage === 1} onClick={() => setCurrentPage(1)} className="cursor-pointer">1</PaginationLink>
                </PaginationItem>
            );

            if (currentPage > 3) {
                items.push(<PaginationItem key="ellipsis-start"><PaginationEllipsis /></PaginationItem>);
            }

            const start = Math.max(2, currentPage - 1);
            const end = Math.min(totalPages - 1, currentPage + 1);

            for (let i = start; i <= end; i++) {
                items.push(
                    <PaginationItem key={i}>
                        <PaginationLink
                            isActive={currentPage === i}
                            onClick={() => setCurrentPage(i)}
                            className="cursor-pointer"
                        >
                            {i}
                        </PaginationLink>
                    </PaginationItem>
                );
            }

            if (currentPage < totalPages - 2) {
                items.push(<PaginationItem key="ellipsis-end"><PaginationEllipsis /></PaginationItem>);
            }

            items.push(
                <PaginationItem key={totalPages}>
                    <PaginationLink isActive={currentPage === totalPages} onClick={() => setCurrentPage(totalPages)} className="cursor-pointer">{totalPages}</PaginationLink>
                </PaginationItem>
            );
        }
        return items;
    };

    const handleRowClick = (e: React.MouseEvent, item: WorkItem) => {
        if (e.shiftKey && lastClickedId !== null) {
            const currentIndex = items.findIndex(i => i.id === item.id);
            const lastIndex = items.findIndex(i => i.id === lastClickedId);

            if (currentIndex !== -1 && lastIndex !== -1) {
                const start = Math.min(currentIndex, lastIndex);
                const end = Math.max(currentIndex, lastIndex);
                const rangeIds = items.slice(start, end + 1).map(i => i.id);

                if (e.ctrlKey || e.metaKey) {
                    const newSelection = Array.from(new Set([...selectedIds, ...rangeIds]));
                    setSelectedIds(newSelection);
                } else {
                    setSelectedIds(rangeIds);
                }
            }
        } else if (e.ctrlKey || e.metaKey) {
            toggleSelect(item.id);
        } else {
            // Regular click: clear others and select this one
            setSelectedIds([item.id]);
        }
        setLastClickedId(item.id);
    };

    return (
        <div className="flex flex-col flex-1 min-h-0 bg-background p-6 space-y-6">
            <div className="flex items-center justify-between">
                <h1 className="text-2xl font-bold tracking-tight">Work Items</h1>
                <div className="flex gap-2">
                    <Button variant="outline" onClick={() => setImportOpen(true)}>
                        <Download className="mr-2 h-4 w-4" /> Import from Jira
                    </Button>
                    {selectedIds.length > 0 && (
                        <Button variant="outline" onClick={() => setBulkConnectionOpen(true)}>
                            <ArrowRightLeft className="mr-2 h-4 w-4" /> Change Connection
                        </Button>
                    )}
                    <Button onClick={() => setCreateOpen(true)}>
                        <Plus className="mr-2 h-4 w-4" /> New Work Item
                    </Button>
                </div>
            </div>

            <div className="flex items-center justify-between gap-4">
                <div className="flex items-center gap-2 flex-1 max-w-sm border rounded-md px-3 bg-muted/50">
                    <Search className="h-4 w-4 text-muted-foreground" />
                    <Input
                        className="border-0 bg-transparent focus-visible:ring-0 focus-visible:ring-offset-0"
                        placeholder="Search work items..."
                        value={query}
                        onChange={e => setQuery(e.target.value)}
                    />
                </div>
                <div className="flex items-center space-x-2 bg-muted/30 px-3 py-2 rounded-md border">
                    <Switch
                        id="show-completed"
                        checked={showCompleted}
                        onCheckedChange={setShowCompleted}
                    />
                    <Label htmlFor="show-completed" className="text-sm cursor-pointer whitespace-nowrap">Show Completed</Label>
                </div>
            </div>

            <div className="border rounded-md flex-1 overflow-hidden" onWheel={(e) => e.stopPropagation()}>
                <div className="overflow-y-auto h-full">
                    <Table>
                        <TableHeader>
                            <TableRow className="hover:bg-transparent">
                                <TableHead className="w-[150px]">Jira Key</TableHead>
                                <TableHead>Description</TableHead>
                                <TableHead className="w-[150px]">Connection</TableHead>
                                <TableHead className="w-[120px]">Total Time</TableHead>
                                <TableHead className="w-[100px] text-right">Actions</TableHead>
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {items.length === 0 && !loading && (
                                <TableRow>
                                    <TableCell colSpan={5} className="text-center h-24 text-muted-foreground">
                                        No work items found.
                                    </TableCell>
                                </TableRow>
                            )}
                            {items.map(item => {
                                const isSelected = selectedIds.includes(item.id);
                                return (
                                    <WorkItemContextMenu
                                        key={item.id}
                                        item={item}
                                        isSelected={isSelected}
                                        selectedCount={selectedIds.length}
                                        onEdit={setEditItem}
                                        onDelete={setDeleteItem}
                                        onStartTracking={handleStartTracking}
                                        onShowHistory={setTimeSlicesItem}
                                        onToggleCompletion={handleToggleCompletion}
                                        onChangeConnection={() => setBulkConnectionOpen(true)}
                                        selectedIds={selectedIds}
                                        onOpenInJira={handleOpenInJira}
                                    >
                                        <TableRow
                                            className={cn(
                                                "cursor-default select-none",
                                                item.is_completed === 1 && !isSelected && "opacity-60 bg-muted/20",
                                                isSelected && "bg-primary/10 hover:bg-primary/15"
                                            )}
                                            onDoubleClick={() => setEditItem(item)}
                                            onClick={(e) => handleRowClick(e, item)}
                                        >
                                            <TableCell>
                                                {item.jira_key ? (() => {
                                                    const connection = item.jira_connection_id ? jiraConnections.find(c => c.id === item.jira_connection_id) : null;
                                                    const badgeColor = connection?.color || 'hsl(var(--primary))';
                                                    const isHex = badgeColor.startsWith('#');

                                                    return (
                                                        <span
                                                            className="text-xs font-bold px-1.5 py-0.5 rounded flex-shrink-0"
                                                            style={{
                                                                backgroundColor: isHex ? `${badgeColor}20` : `hsl(var(--primary) / 0.1)`,
                                                                color: badgeColor
                                                            }}
                                                        >
                                                            {item.jira_key}
                                                        </span>
                                                    );
                                                })() : (
                                                    <span className="text-muted-foreground text-xs italic">Manual</span>
                                                )}
                                            </TableCell>
                                            <TableCell className={cn("font-medium", item.is_completed === 1 && "line-through text-muted-foreground")}>
                                                {item.description}
                                            </TableCell>
                                            <TableCell className="text-muted-foreground text-sm">
                                                <div className="flex items-center gap-2">
                                                    {(() => {
                                                        const connection = item.jira_connection_id ? jiraConnections.find(c => c.id === item.jira_connection_id) : null;
                                                        if (connection?.color) {
                                                            return <div className="w-2 h-2 rounded-full" style={{ backgroundColor: connection.color }} />;
                                                        }
                                                        return null;
                                                    })()}
                                                    {item.connection_name || '-'}
                                                </div>
                                            </TableCell>
                                            <TableCell>
                                                <Badge variant="secondary" className="font-mono">
                                                    <Clock className="w-3 h-3 mr-1 opacity-70" />
                                                    {formatTotalTime(item.total_seconds)}
                                                </Badge>
                                            </TableCell>
                                            <TableCell className="text-right" onClick={(e) => e.stopPropagation()}>
                                                <DropdownMenu>
                                                    <DropdownMenuTrigger asChild>
                                                        <Button variant="ghost" size="icon">
                                                            <MoreHorizontal className="h-4 w-4" />
                                                        </Button>
                                                    </DropdownMenuTrigger>
                                                    <DropdownMenuContent align="end">
                                                        {selectedIds.length > 1 && selectedIds.includes(item.id) ? (
                                                            <>
                                                                <DropdownMenuItem onClick={() => handleToggleCompletion(selectedIds, true)}>
                                                                    <CheckCircle2 className="mr-2 h-4 w-4 text-emerald-500" />
                                                                    Mark {selectedIds.length} selected as Complete
                                                                </DropdownMenuItem>
                                                                <DropdownMenuItem onClick={() => handleToggleCompletion(selectedIds, false)}>
                                                                    <XCircle className="mr-2 h-4 w-4" />
                                                                    Mark {selectedIds.length} selected as Incomplete
                                                                </DropdownMenuItem>
                                                                <DropdownMenuSeparator />
                                                            </>
                                                        ) : (
                                                            <>
                                                                <DropdownMenuItem onClick={() => handleStartTracking(item)}>
                                                                    <PlayCircle className="mr-2 h-4 w-4 text-primary" />
                                                                    Start Tracking
                                                                </DropdownMenuItem>
                                                                <DropdownMenuSeparator />
                                                                <DropdownMenuItem onClick={() => handleToggleCompletion([item.id], item.is_completed === 0)}>
                                                                    {item.is_completed === 0 ? (
                                                                        <>
                                                                            <CheckCircle2 className="mr-2 h-4 w-4 text-emerald-500" />
                                                                            Mark as Complete
                                                                        </>
                                                                    ) : (
                                                                        <>
                                                                            <XCircle className="mr-2 h-4 w-4 text-muted-foreground" />
                                                                            Mark as Incomplete
                                                                        </>
                                                                    )}
                                                                </DropdownMenuItem>
                                                                <DropdownMenuSeparator />
                                                                <DropdownMenuItem onClick={() => setEditItem(item)}>
                                                                    <Edit2 className="mr-2 h-4 w-4" />
                                                                    Edit
                                                                </DropdownMenuItem>
                                                                <DropdownMenuItem
                                                                    onClick={() => handleOpenInJira(item)}
                                                                    disabled={!item.jira_key || selectedIds.length > 1}
                                                                >
                                                                    <ExternalLink className="mr-2 h-4 w-4" />
                                                                    Open in Jira
                                                                </DropdownMenuItem>
                                                                <DropdownMenuItem onClick={() => setTimeSlicesItem(item)}>
                                                                    <History className="mr-2 h-4 w-4" />
                                                                    Show Time Slices
                                                                </DropdownMenuItem>
                                                            </>
                                                        )}
                                                        <DropdownMenuSeparator />
                                                        <DropdownMenuItem
                                                            className="text-destructive focus:text-destructive"
                                                            onClick={() => setDeleteItem(item)}
                                                        >
                                                            <Trash2 className="mr-2 h-4 w-4" />
                                                            Delete
                                                        </DropdownMenuItem>
                                                    </DropdownMenuContent>
                                                </DropdownMenu>
                                            </TableCell>
                                        </TableRow>
                                    </WorkItemContextMenu>
                                );
                            })}
                        </TableBody>
                    </Table>
                </div>
            </div>

            {/* Pagination */}
            <div className="flex items-center justify-between px-2">
                <div className="text-sm text-muted-foreground">
                    Showing {totalCount > 0 ? (currentPage - 1) * itemsPerPage + 1 : 0}-
                    {Math.min(totalCount, currentPage * itemsPerPage)} of {totalCount} items
                </div>
                {totalPages > 1 && (
                    <Pagination className="mx-0 w-auto">
                        <PaginationContent>
                            <PaginationItem>
                                <PaginationPrevious
                                    onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
                                    className={cn("cursor-pointer", currentPage === 1 && "pointer-events-none opacity-50")}
                                />
                            </PaginationItem>

                            {renderPaginationItems()}

                            <PaginationItem>
                                <PaginationNext
                                    onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
                                    className={cn("cursor-pointer", currentPage === totalPages && "pointer-events-none opacity-50")}
                                />
                            </PaginationItem>
                        </PaginationContent>
                    </Pagination>
                )}
            </div>

            <ImportFromJiraDialog
                open={importOpen}
                onOpenChange={setImportOpen}
                onImport={fetchItems}
            />
            <CreateWorkItemDialog
                open={createOpen}
                onOpenChange={setCreateOpen}
                onSave={fetchItems}
            />
            <EditWorkItemDialog
                open={!!editItem}
                onOpenChange={(open) => !open && setEditItem(null)}
                item={editItem}
                onSave={fetchItems}
            />
            <WorkItemTimeSlicesDialog
                open={!!timeSlicesItem}
                onOpenChange={(open) => !open && setTimeSlicesItem(null)}
                workItem={timeSlicesItem}
            />
            <ConfirmDialog
                open={!!deleteItem}
                onOpenChange={(open) => !open && setDeleteItem(null)}
                onConfirm={handleDelete}
                title="Delete Work Item?"
                description={`Are you sure you want to delete "${deleteItem?.description}"?`}
                confirmText="Delete"
                variant="destructive"
            />
            <BulkChangeConnectionDialog
                open={bulkConnectionOpen}
                onOpenChange={setBulkConnectionOpen}
                onSave={handleBulkSaveConnection}
                selectedCount={selectedIds.length}
            />
            <MessageDialog
                open={!!error}
                onOpenChange={(open) => !open && setError(null)}
                title="Cannot Delete"
                description={error || ""}
            />
        </div>
    )
}
