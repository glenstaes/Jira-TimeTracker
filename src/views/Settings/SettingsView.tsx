import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { JiraConnections } from "./JiraConnections"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { FolderOpen, Moon, Sun, Monitor, Trash2, Upload, Loader2, Clock, RefreshCcw, FilePlus2 } from "lucide-react"
import { Checkbox } from "@/components/ui/checkbox"
import { Switch } from "@/components/ui/switch"
import {
    AlertDialog,
    AlertDialogAction,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
    AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import React from "react"
import { useSearchParams } from "react-router-dom"
import { api } from "@/lib/api"
import { MessageDialog } from "@/components/shared/MessageDialog"
import { ColorPicker } from "@/components/shared/ColorPicker"
import { ImportJiraWorklogsDialog } from "@/components/Settings/ImportJiraWorklogsDialog"

type Theme = 'light' | 'dark' | 'system';
type SettingsTab = 'general' | 'connections' | 'database' | 'developer';

function applyTheme(theme: Theme) {
    const root = document.documentElement;
    if (theme === 'system') {
        const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
        root.classList.toggle('dark', prefersDark);
    } else {
        root.classList.toggle('dark', theme === 'dark');
    }
}

export function SettingsView() {
    const [searchParams, setSearchParams] = useSearchParams();
    const [dbPath, setDbPath] = React.useState("Loading...");
    const [theme, setTheme] = React.useState<Theme>('dark');
    const [clearSlices, setClearSlices] = React.useState(false);
    const [clearWorkItems, setClearWorkItems] = React.useState(false);
    const [message, setMessage] = React.useState<{ title: string, description: string } | null>(null);
    const [isImporting, setIsImporting] = React.useState(false);
    const [jiraImportOpen, setJiraImportOpen] = React.useState(false);
    const [awayThreshold, setAwayThreshold] = React.useState(5);
    const [awayEnabled, setAwayEnabled] = React.useState(true);
    const [awaySoundEnabled, setAwaySoundEnabled] = React.useState(true);
    const [roundingEnabled, setRoundingEnabled] = React.useState(false);
    const [roundingInterval, setRoundingInterval] = React.useState(15);
    const [updateInterval, setUpdateInterval] = React.useState(60);
    const [appVersion, setAppVersion] = React.useState<string>("");
    const [otherColor, setOtherColor] = React.useState("#64748b");
    const [checkingUpdate, setCheckingUpdate] = React.useState(false);
    const [updateStatus, setUpdateStatus] = React.useState<{ type: 'current' | 'available' | 'error', message: string } | null>(null);
    const [miniPlayerTheme, setMiniPlayerTheme] = React.useState("inverted");
    const [dailyTargetHours, setDailyTargetHours] = React.useState(8);
    const [hideCompletedItems, setHideCompletedItems] = React.useState(true);
    const requestedTab = searchParams.get('tab');
    const activeTab: SettingsTab = requestedTab === 'connections' || requestedTab === 'database' || requestedTab === 'developer'
        ? requestedTab
        : 'general';

    React.useEffect(() => {
        api.getDatabasePath().then(setDbPath).catch(() => setDbPath("Error fetching path"));
        api.getAppVersion().then(setAppVersion).catch(() => setAppVersion("Unknown"));
        // Load saved theme
        api.getSettings().then(settings => {
            const savedTheme = (settings.theme as Theme) || 'dark';
            setTheme(savedTheme);
            applyTheme(savedTheme);

            // Load mini-player theme
            setMiniPlayerTheme(settings.mini_player_theme || "inverted");

            // Load away detection settings
            const threshold = settings.away_threshold_minutes ? parseInt(settings.away_threshold_minutes, 10) : 5;
            setAwayThreshold(threshold);
            setAwayEnabled(settings.away_detection_enabled !== 'false');
            setAwaySoundEnabled(settings.away_notification_sound !== 'false');
            // Load rounding settings
            setRoundingEnabled(settings.rounding_enabled === 'true');
            const rInterval = settings.rounding_interval ? parseInt(settings.rounding_interval, 10) : 15;
            setRoundingInterval(rInterval);
            // Load update settings
            const uInterval = settings.update_check_interval ? parseInt(settings.update_check_interval, 10) : 60;
            setUpdateInterval(uInterval);
            // Load other color
            setOtherColor(settings.other_color || "#64748b");
            // Load daily target hours
            const target = settings.daily_target_hours ? parseFloat(settings.daily_target_hours) : 8;
            setDailyTargetHours(target);
            // Load search settings
            setHideCompletedItems(settings.hide_completed_items !== 'false');
        });
    }, []);

    const handleThemeChange = async (newTheme: Theme) => {
        setTheme(newTheme);
        applyTheme(newTheme);
        await api.saveSetting('theme', newTheme);
    };

    const handleOpenExisting = async () => {
        const result = await api.selectDatabaseFile();
        if (result.canceled) return;

        if (!result.success) {
            setMessage({
                title: "Invalid File",
                description: result.error || "Failed to open the selected file."
            });
            return;
        }

        if (result.filePath) {
            await api.saveDatabasePath(result.filePath);
            setDbPath(result.filePath);
            setMessage({
                title: "Database File Selected",
                description: `Database set to: ${result.filePath}\nPlease restart the application to apply changes.`
            });
        }
    };

    const handleCreateNew = async () => {
        const result = await api.createDatabaseFile();
        if (result.canceled) return;

        if (result.success && result.filePath) {
            await api.saveDatabasePath(result.filePath);
            setDbPath(result.filePath);
            setMessage({
                title: "Database Location Set",
                description: `New database will be created at: ${result.filePath}\nPlease restart the application to apply changes.`
            });
        }
    };

    const handleClearDatabase = async () => {
        try {
            await api.clearDatabase({
                clearTimeSlices: clearSlices,
                clearWorkItems: clearWorkItems
            });
            setClearSlices(false);
            setClearWorkItems(false);
            setMessage({
                title: "Database Cleared",
                description: "The selected data has been removed from your local database."
            });
        } catch (error) {
            console.error("Failed to clear database:", error);
            setMessage({
                title: "Error",
                description: "Failed to clear the database. Please try again or check the logs."
            });
        }
    };

    const handleCsvImport = async () => {
        try {
            const filePath = await api.selectCsvFile();
            if (!filePath) return;

            setIsImporting(true);
            const csvContent = await api.readFile(filePath);
            const result = await api.importCsv(csvContent);

            setMessage({
                title: "Import Completed",
                description: `Successfully imported ${result.importedSlices} time slices.\nCreated ${result.createdWorkItems} new work items.\nReused ${result.reusedWorkItems} existing work items.${result.skippedLines > 0 ? `\nSkipped ${result.skippedLines} invalid lines.` : ''}`
            });
        } catch (error) {
            console.error("Failed to import CSV:", error);
            setMessage({
                title: "Import Failed",
                description: `Failed to import CSV file. ${error instanceof Error ? error.message : 'Please check the file format.'}`
            });
        } finally {
            setIsImporting(false);
        }
    };

    const handleCheckUpdate = async () => {
        setCheckingUpdate(true);
        setUpdateStatus(null);
        try {
            const result = await api.checkForUpdates();
            if (result.updateAvailable) {
                setUpdateStatus({ type: 'available', message: `Update available: ${result.version}` });
            } else {
                setUpdateStatus({ type: 'current', message: "You are up to date." });
            }
        } catch (error) {
            console.error("Manual update check failed", error);
            setUpdateStatus({ type: 'error', message: "Error checking for updates." });
        } finally {
            setCheckingUpdate(false);
        }
    };

    return (
        <div className="flex flex-col flex-1 min-h-0 bg-background p-6 space-y-6 overflow-y-auto" onWheel={(e) => e.stopPropagation()}>
            <h1 className="text-2xl font-bold tracking-tight">Settings</h1>

            <Tabs
                value={activeTab}
                onValueChange={(value) => {
                    const nextTab = value as SettingsTab;
                    const nextParams = new URLSearchParams(searchParams);
                    if (nextTab === 'general') {
                        nextParams.delete('tab');
                    } else {
                        nextParams.set('tab', nextTab);
                    }
                    setSearchParams(nextParams, { replace: true });
                }}
                className="w-full"
            >
                <TabsList className="grid w-full grid-cols-4 lg:w-[500px]">
                    <TabsTrigger value="general">General</TabsTrigger>
                    <TabsTrigger value="connections">Connections</TabsTrigger>
                    <TabsTrigger value="database">Database</TabsTrigger>
                    <TabsTrigger value="developer">Developer</TabsTrigger>
                </TabsList>

                <TabsContent value="connections" className="mt-6">
                    <JiraConnections />
                </TabsContent>

                <TabsContent value="general" className="mt-6">
                    <Card>
                        <CardHeader>
                            <CardTitle>Appearance</CardTitle>
                            <CardDescription>Customize the application theme.</CardDescription>
                        </CardHeader>
                        <CardContent className="space-y-4">
                            <div className="grid grid-cols-3 gap-4">
                                <Button
                                    variant="outline"
                                    className={`flex flex-col items-center gap-2 h-auto py-4 ${theme === 'light' ? 'border-primary bg-primary/5' : ''}`}
                                    onClick={() => handleThemeChange('light')}
                                >
                                    <Sun className="h-6 w-6" />
                                    <span>Light</span>
                                </Button>
                                <Button
                                    variant="outline"
                                    className={`flex flex-col items-center gap-2 h-auto py-4 ${theme === 'dark' ? 'border-primary bg-primary/5' : ''}`}
                                    onClick={() => handleThemeChange('dark')}
                                >
                                    <Moon className="h-6 w-6" />
                                    <span>Dark</span>
                                </Button>
                                <Button
                                    variant="outline"
                                    className={`flex flex-col items-center gap-2 h-auto py-4 ${theme === 'system' ? 'border-primary bg-primary/5' : ''}`}
                                    onClick={() => handleThemeChange('system')}
                                >
                                    <Monitor className="h-6 w-6" />
                                    <span>System</span>
                                </Button>
                            </div>

                            <div className="grid gap-2 pt-4 border-t">
                                <Label>Mini-Player Theme</Label>
                                <Select
                                    value={miniPlayerTheme}
                                    onValueChange={async (value) => {
                                        setMiniPlayerTheme(value);
                                        await api.saveSetting('mini_player_theme', value);
                                    }}
                                >
                                    <SelectTrigger className="w-[300px]">
                                        <SelectValue placeholder="Select theme" />
                                    </SelectTrigger>
                                    <SelectContent>
                                        <SelectItem value="inverted">Inverted (Opposite of App)</SelectItem>
                                        <SelectItem value="match">Match App Theme</SelectItem>
                                        <SelectItem value="light">Always Light</SelectItem>
                                        <SelectItem value="dark">Always Dark</SelectItem>
                                        <SelectItem value="system">Follow System</SelectItem>
                                    </SelectContent>
                                </Select>
                                <p className="text-xs text-muted-foreground">
                                    Choose how the mini-player should look.
                                </p>
                            </div>

                            <div className="grid gap-2 pt-4 border-t">
                                <Label htmlFor="other-color" className="flex items-center gap-2">
                                    <Clock className="h-4 w-4" /> Non-Jira Time ("Other") Color
                                </Label>
                                <div className="w-[300px]">
                                    <ColorPicker
                                        color={otherColor}
                                        onChange={async (newColor) => {
                                            setOtherColor(newColor);
                                            await api.saveSetting('other_color', newColor);
                                        }}
                                    />
                                </div>
                                <p className="text-xs text-muted-foreground">
                                    This color will be used for time slices not linked to any Jira connection.
                                </p>
                            </div>

                            <div className="grid gap-2 pt-4 border-t">
                                <Label htmlFor="daily-target" className="flex items-center gap-2">
                                    <Clock className="h-4 w-4" /> Daily Target Hours
                                </Label>
                                <div className="flex items-center gap-2">
                                    <Input
                                        id="daily-target"
                                        type="number"
                                        step="0.5"
                                        min="0"
                                        max="24"
                                        value={dailyTargetHours}
                                        onChange={(e) => setDailyTargetHours(parseFloat(e.target.value) || 8)}
                                        onBlur={async () => {
                                            await api.saveSetting('daily_target_hours', String(dailyTargetHours));
                                        }}
                                        className="w-24"
                                    />
                                    <span className="text-sm text-muted-foreground">hours</span>
                                </div>
                                <p className="text-xs text-muted-foreground">
                                    The target hours for a single workday (Monday-Friday).
                                </p>
                            </div>
                        </CardContent>
                    </Card>

                    <Card className="mt-6">
                        <CardHeader>
                            <CardTitle className="flex items-center gap-2">
                                <Clock className="h-5 w-5" />
                                Away Detection
                            </CardTitle>
                            <CardDescription>Configure how the app handles time when you're away.</CardDescription>
                        </CardHeader>
                        <CardContent className="space-y-6">
                            <div className="flex items-center justify-between">
                                <div className="space-y-0.5">
                                    <Label htmlFor="away-enabled">Enable Away Detection</Label>
                                    <p className="text-xs text-muted-foreground">
                                        Show a dialog when you return after being away.
                                    </p>
                                </div>
                                <Switch
                                    id="away-enabled"
                                    checked={awayEnabled}
                                    onCheckedChange={async (checked) => {
                                        setAwayEnabled(checked);
                                        await api.saveSetting('away_detection_enabled', String(checked));
                                    }}
                                />
                            </div>

                            <div className="grid gap-2">
                                <Label htmlFor="away-threshold">Away Threshold (minutes)</Label>
                                <div className="flex items-center gap-2">
                                    <Input
                                        id="away-threshold"
                                        type="number"
                                        min="1"
                                        max="60"
                                        value={awayThreshold}
                                        onChange={(e) => setAwayThreshold(parseInt(e.target.value, 10) || 5)}
                                        onBlur={async () => {
                                            await api.saveSetting('away_threshold_minutes', String(awayThreshold));
                                        }}
                                        className="w-24"
                                        disabled={!awayEnabled}
                                    />
                                    <span className="text-sm text-muted-foreground">minutes</span>
                                </div>
                                <p className="text-xs text-muted-foreground">
                                    How long you need to be away before the dialog appears.
                                </p>
                            </div>

                            <div className="flex items-center justify-between">
                                <div className="space-y-0.5">
                                    <Label htmlFor="away-sound">Notification Sound</Label>
                                    <p className="text-xs text-muted-foreground">
                                        Play a sound when the notification appears.
                                    </p>
                                </div>
                                <Switch
                                    id="away-sound"
                                    checked={awaySoundEnabled}
                                    onCheckedChange={async (checked) => {
                                        setAwaySoundEnabled(checked);
                                        await api.saveSetting('away_notification_sound', String(checked));
                                    }}
                                    disabled={!awayEnabled}
                                />
                            </div>
                        </CardContent>
                    </Card>

                    <Card className="mt-6">
                        <CardHeader>
                            <CardTitle>Time Rounding</CardTitle>
                            <CardDescription>
                                Automatically round start and end times when stopping a timer.
                            </CardDescription>
                        </CardHeader>
                        <CardContent className="space-y-6">
                            <div className="flex items-center justify-between">
                                <div className="space-y-0.5">
                                    <Label htmlFor="rounding-enabled">Enable Rounding</Label>
                                    <p className="text-xs text-muted-foreground">
                                        Round start times down and end times up.
                                    </p>
                                </div>
                                <Switch
                                    id="rounding-enabled"
                                    checked={roundingEnabled}
                                    onCheckedChange={async (checked) => {
                                        setRoundingEnabled(checked);
                                        await api.saveSetting('rounding_enabled', String(checked));
                                    }}
                                />
                            </div>

                            <div className="grid gap-2">
                                <Label htmlFor="rounding-interval">Rounding Interval (minutes)</Label>
                                <div className="flex items-center gap-2">
                                    <Input
                                        id="rounding-interval"
                                        type="text"
                                        inputMode="numeric"
                                        pattern="[0-9]*"
                                        value={roundingInterval}
                                        onChange={(e) => {
                                            const val = e.target.value.replace(/[^0-9]/g, '');
                                            setRoundingInterval(val ? parseInt(val, 10) : 15);
                                        }}
                                        onBlur={async () => {
                                            const freshVal = roundingInterval || 15;
                                            setRoundingInterval(freshVal);
                                            await api.saveSetting('rounding_interval', String(freshVal));
                                        }}
                                        className="w-24"
                                        disabled={!roundingEnabled}
                                    />
                                    <span className="text-sm text-muted-foreground">minutes</span>
                                </div>
                                <p className="text-xs text-muted-foreground">
                                    Example: 15m interval. 09:07 → 09:00 (Start), 09:23 → 09:30 (End).
                                </p>
                            </div>
                        </CardContent>
                    </Card>

                    <Card className="mt-6">
                        <CardHeader>
                            <CardTitle>Updates</CardTitle>
                            <CardDescription>Configure automatic update checks.</CardDescription>
                        </CardHeader>
                        <CardContent className="space-y-4">
                            <div className="grid gap-2">
                                <Label>Check for updates</Label>
                                <Select
                                    value={String(updateInterval)}
                                    onValueChange={async (value) => {
                                        const newVal = parseInt(value, 10);
                                        setUpdateInterval(newVal);
                                        await api.saveSetting('update_check_interval', String(newVal));
                                    }}
                                >
                                    <SelectTrigger className="w-[200px]">
                                        <SelectValue placeholder="Select interval" />
                                    </SelectTrigger>
                                    <SelectContent>
                                        <SelectItem value="15">Every 15 minutes</SelectItem>
                                        <SelectItem value="30">Every 30 minutes</SelectItem>
                                        <SelectItem value="60">Every hour</SelectItem>
                                        <SelectItem value="240">Every 4 hours</SelectItem>
                                        <SelectItem value="1440">Daily</SelectItem>
                                        <SelectItem value="0">Never (Manual only)</SelectItem>
                                    </SelectContent>
                                </Select>
                                <p className="text-xs text-muted-foreground">
                                    The application will check for updates in the background.
                                </p>
                            </div>

                            <div className="flex items-center justify-between pt-4 border-t">
                                <div className="space-y-0.5">
                                    <Label>Manual Update Check</Label>
                                    <p className="text-xs text-muted-foreground">
                                        Check now for the latest version.
                                    </p>
                                </div>
                                <div className="flex items-center gap-2">
                                    {updateStatus && (
                                        <span className={`text-sm ${updateStatus.type === 'available' ? 'text-green-500 font-medium' :
                                            updateStatus.type === 'error' ? 'text-destructive' :
                                                'text-muted-foreground'
                                            }`}>
                                            {updateStatus.message}
                                        </span>
                                    )}
                                    <Button
                                        variant="outline"
                                        size="sm"
                                        onClick={handleCheckUpdate}
                                        disabled={checkingUpdate}
                                    >
                                        {checkingUpdate ? (
                                            <Loader2 className="h-4 w-4 animate-spin" />
                                        ) : (
                                            <RefreshCcw className="h-4 w-4 mr-2" />
                                        )}
                                        Check Now
                                    </Button>
                                </div>
                            </div>
                        </CardContent>
                    </Card>

                    <Card className="mt-6">
                        <CardHeader>
                            <CardTitle className="flex items-center gap-2">
                                <FilePlus2 className="h-5 w-5" />
                                Search
                            </CardTitle>
                            <CardDescription>Configure how search behaves across the app.</CardDescription>
                        </CardHeader>
                        <CardContent className="space-y-6">
                            <div className="flex items-center justify-between">
                                <div className="space-y-0.5">
                                    <Label htmlFor="hide-completed">Hide Completed Items</Label>
                                    <p className="text-xs text-muted-foreground">
                                        Exclude completed local items from search results by default.
                                    </p>
                                </div>
                                <Switch
                                    id="hide-completed"
                                    checked={hideCompletedItems}
                                    onCheckedChange={async (checked) => {
                                        setHideCompletedItems(checked);
                                        await api.saveSetting('hide_completed_items', String(checked));
                                    }}
                                />
                            </div>
                        </CardContent>
                    </Card>
                </TabsContent>

                <TabsContent value="database" className="mt-6 space-y-6">
                    <Card>
                        <CardHeader>
                            <CardTitle>Storage Location</CardTitle>
                            <CardDescription>Manage where your data is stored.</CardDescription>
                        </CardHeader>
                        <CardContent className="space-y-4">
                            <div className="grid gap-2">
                                <Label>Current Database File</Label>
                                <Input value={dbPath} readOnly className="font-mono text-sm" />
                                <div className="flex gap-2 mt-2">
                                    <Button variant="secondary" onClick={handleOpenExisting}>
                                        <FolderOpen className="h-4 w-4 mr-2" /> Open Existing...
                                    </Button>
                                    <Button variant="outline" onClick={handleCreateNew}>
                                        <FilePlus2 className="h-4 w-4 mr-2" /> Create New...
                                    </Button>
                                </div>
                                <p className="text-xs text-muted-foreground">
                                    Select an existing database file or create a new one. Restart required after changing.
                                </p>
                            </div>
                        </CardContent>
                    </Card>

                    <Card>
                        <CardHeader>
                            <CardTitle className="flex items-center gap-2">
                                <Upload className="h-5 w-5" /> Import Data
                            </CardTitle>
                            <CardDescription>Import time slices from CSV or Jira worklogs into your local database.</CardDescription>
                        </CardHeader>
                        <CardContent className="space-y-4">
                            <div className="grid gap-4 md:grid-cols-2">
                                <div className="grid gap-2 rounded-lg border p-4">
                                    <p className="text-sm font-medium">CSV Import</p>
                                    <p className="text-sm text-muted-foreground">
                                        Expected CSV format: Start of timeslice, End of timeslice, timeslice notes, WorkItem, Jira key<br />
                                        <span className="text-xs">Times should be in UTC format (e.g., 2025-12-01 07:30:00)</span>
                                    </p>
                                    <Button onClick={handleCsvImport} disabled={isImporting} className="w-fit">
                                        {isImporting ? (
                                            <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> Importing...</>
                                        ) : (
                                            <><Upload className="h-4 w-4 mr-2" /> Select CSV File...</>
                                        )}
                                    </Button>
                                </div>

                                <div className="grid gap-2 rounded-lg border p-4">
                                    <p className="text-sm font-medium">Jira Worklog Import</p>
                                    <p className="text-sm text-muted-foreground">
                                        Import your own Jira worklogs for a date range and selected Jira connections.
                                    </p>
                                    <Button variant="outline" onClick={() => setJiraImportOpen(true)} className="w-fit">
                                        <Upload className="h-4 w-4 mr-2" /> Import Jira Worklogs...
                                    </Button>
                                </div>
                            </div>
                        </CardContent>
                    </Card>

                    <Card className="border-destructive/20 font-bold">
                        <CardHeader>
                            <CardTitle className="text-destructive flex items-center gap-2">
                                <Trash2 className="h-5 w-5" /> Database Cleanup
                            </CardTitle>
                            <CardDescription>Permanently remove data from your local database.</CardDescription>
                        </CardHeader>
                        <CardContent className="space-y-6">
                            <div className="space-y-4">
                                <div className="items-top flex space-x-2">
                                    <Checkbox
                                        id="clear-slices"
                                        checked={clearSlices}
                                        onCheckedChange={(checked) => setClearSlices(!!checked)}
                                    />
                                    <div className="grid gap-1.5 leading-none">
                                        <label
                                            htmlFor="clear-slices"
                                            className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
                                        >
                                            Clear Time Slices
                                        </label>
                                        <p className="text-xs text-muted-foreground">
                                            Removes all tracked time periods. Work items will remain.
                                        </p>
                                    </div>
                                </div>

                                <div className="items-top flex space-x-2">
                                    <Checkbox
                                        id="clear-work-items"
                                        checked={clearWorkItems}
                                        onCheckedChange={(checked) => {
                                            setClearWorkItems(!!checked);
                                            if (checked) setClearSlices(true); // Clearing work items always clears slices
                                        }}
                                    />
                                    <div className="grid gap-1.5 leading-none">
                                        <label
                                            htmlFor="clear-work-items"
                                            className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
                                        >
                                            Clear Work Items
                                        </label>
                                        <p className="text-xs text-muted-foreground">
                                            Removes all work items and their associated time slices.
                                        </p>
                                    </div>
                                </div>
                            </div>

                            <AlertDialog>
                                <AlertDialogTrigger asChild>
                                    <Button
                                        variant="destructive"
                                        disabled={!clearSlices && !clearWorkItems}
                                    >
                                        Clear Selected Data
                                    </Button>
                                </AlertDialogTrigger>
                                <AlertDialogContent>
                                    <AlertDialogHeader>
                                        <AlertDialogTitle>Are you absolutely sure?</AlertDialogTitle>
                                        <AlertDialogDescription>
                                            This action cannot be undone. This will permanently delete the selected data from your local database.
                                        </AlertDialogDescription>
                                    </AlertDialogHeader>
                                    <AlertDialogFooter>
                                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                                        <AlertDialogAction
                                            onClick={handleClearDatabase}
                                            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                                        >
                                            Yes, clear data
                                        </AlertDialogAction>
                                    </AlertDialogFooter>
                                </AlertDialogContent>
                            </AlertDialog>
                        </CardContent>
                    </Card>
                </TabsContent>

                <TabsContent value="developer" className="mt-6">
                    <Card>
                        <CardHeader>
                            <CardTitle>Developer Tools</CardTitle>
                            <CardDescription>Advanced tools for debugging and development.</CardDescription>
                        </CardHeader>
                        <CardContent className="space-y-4">
                            <div className="flex items-center justify-between border rounded-lg p-4">
                                <div className="space-y-0.5">
                                    <Label className="text-base">Electron DevTools</Label>
                                    <p className="text-sm text-muted-foreground">
                                        Open the Electron Developer Tools window.
                                    </p>
                                </div>
                                <Button onClick={() => api.openDevTools()}>
                                    Open DevTools
                                </Button>
                            </div>

                            <div className="flex items-center justify-between border rounded-lg p-4">
                                <div className="space-y-0.5">
                                    <Label className="text-base">Application Logs</Label>
                                    <p className="text-sm text-muted-foreground">
                                        Open the folder containing application log files.
                                    </p>
                                </div>
                                <Button
                                    variant="outline"
                                    onClick={async () => {
                                        const result = await api.showLogs();
                                        if (!result.success) {
                                            setMessage({
                                                title: "Logs Not Found",
                                                description: result.error || "Could not find the log file location."
                                            });
                                        }
                                    }}
                                >
                                    Show Logs
                                </Button>
                            </div>
                        </CardContent>
                    </Card>
                </TabsContent>
            </Tabs>

            <div className="mt-6 pt-4 border-t text-center">
                <p className="text-xs text-muted-foreground">
                    Version {appVersion || "..."}
                </p>
            </div>

            <MessageDialog
                open={!!message}
                onOpenChange={(open) => !open && setMessage(null)}
                title={message?.title || ""}
                description={message?.description || ""}
            />

            <ImportJiraWorklogsDialog
                open={jiraImportOpen}
                onOpenChange={setJiraImportOpen}
            />
        </div>
    )
}
