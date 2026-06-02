import {
    ContextMenu,
    ContextMenuContent,
    ContextMenuItem,
    ContextMenuSeparator,
    ContextMenuTrigger,
} from "@/components/ui/context-menu"
import { WorkItem } from "@/lib/api"
import { Edit2, Trash2, History, CheckCircle2, XCircle, ArrowRightLeft, ExternalLink, PlayCircle } from "lucide-react"

interface WorkItemContextMenuProps {
    children: React.ReactNode;
    item: WorkItem;
    isSelected: boolean;
    selectedCount: number;
    onEdit: (item: WorkItem) => void;
    onDelete: (item: WorkItem) => void;
    onStartTracking: (item: WorkItem) => void;
    onShowHistory: (item: WorkItem) => void;
    onToggleCompletion: (ids: number[], completed: boolean) => void;
    onChangeConnection: () => void;
    selectedIds: number[];
    onOpenInJira?: (item: WorkItem) => void;
}

export function WorkItemContextMenu({
    children,
    item,
    isSelected,
    selectedCount,
    onEdit,
    onDelete,
    onStartTracking,
    onShowHistory,
    onToggleCompletion,
    onChangeConnection,
    selectedIds,
    onOpenInJira
}: WorkItemContextMenuProps) {
    return (
        <ContextMenu>
            <ContextMenuTrigger asChild>
                {children}
            </ContextMenuTrigger>
            <ContextMenuContent className="w-64">
                {selectedCount > 1 && isSelected ? (
                    <>
                        <ContextMenuItem onClick={() => onToggleCompletion(selectedIds, true)}>
                            <CheckCircle2 className="mr-2 h-4 w-4 text-emerald-500" />
                            Mark {selectedCount} selected as Complete
                        </ContextMenuItem>
                        <ContextMenuItem onClick={() => onToggleCompletion(selectedIds, false)}>
                            <XCircle className="mr-2 h-4 w-4" />
                            Mark {selectedCount} selected as Incomplete
                        </ContextMenuItem>
                        <ContextMenuSeparator />
                        <ContextMenuItem onClick={onChangeConnection}>
                            <ArrowRightLeft className="mr-2 h-4 w-4" />
                            Change Connection
                        </ContextMenuItem>
                    </>
                ) : (
                    <>
                        <ContextMenuItem onClick={() => onStartTracking(item)}>
                            <PlayCircle className="mr-2 h-4 w-4 text-primary" />
                            Start Tracking
                        </ContextMenuItem>
                        <ContextMenuSeparator />
                        <ContextMenuItem onClick={() => onToggleCompletion([item.id], item.is_completed === 0)}>
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
                        </ContextMenuItem>
                        <ContextMenuSeparator />
                        <ContextMenuItem onClick={() => onEdit(item)}>
                            <Edit2 className="mr-2 h-4 w-4" />
                            Edit Work Item
                        </ContextMenuItem>
                        <ContextMenuItem
                            onClick={() => onOpenInJira?.(item)}
                            disabled={!item.jira_key || selectedCount > 1}
                        >
                            <ExternalLink className="mr-2 h-4 w-4" />
                            Open in Jira
                        </ContextMenuItem>
                        <ContextMenuItem onClick={onChangeConnection}>
                            <ArrowRightLeft className="mr-2 h-4 w-4" />
                            Change Connection
                        </ContextMenuItem>
                        <ContextMenuItem onClick={() => onShowHistory(item)}>
                            <History className="mr-2 h-4 w-4" />
                            Show Time Slices
                        </ContextMenuItem>
                    </>
                )}

                <ContextMenuSeparator />

                <ContextMenuItem
                    onClick={() => onDelete(item)}
                    className="text-destructive focus:text-destructive"
                >
                    <Trash2 className="mr-2 h-4 w-4" />
                    Delete
                </ContextMenuItem>
            </ContextMenuContent>
        </ContextMenu>
    )
}
