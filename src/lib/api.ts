// Type-safe wrapper for IPC calls

export interface WorkItem {
    id: number;
    jira_connection_id?: number | null;
    jira_key?: string | null;
    description: string;
    created_at?: number;
    updated_at?: number;

    // Joined fields
    connection_name?: string;
    total_seconds?: number;
    is_completed: number;
}

export interface TimeSlice {
    id: number;
    work_item_id: number;
    start_time: string;
    end_time?: string | null;
    notes?: string | null;
    synced_to_jira?: number; // 0 or 1
    jira_worklog_id?: string | null;
    synced_start_time?: string | null;
    synced_end_time?: string | null;
    synced_notes?: string | null;
    created_at?: number;
    updated_at?: number;

    // Joined fields
    jira_key?: string;
    work_item_description?: string;
    connection_name?: string;
    jira_connection_id?: number | null;
    jira_connection_is_enabled?: number | null;
}

export interface JiraConnection {
    id: number;
    name: string;
    base_url: string;
    email: string;
    api_token: string;
    is_default: number;
    color?: string;
    is_enabled: number;
    // OAuth fields
    auth_type?: 'api_token' | 'oauth';
    client_id?: string;
    cloud_id?: string;
    token_expires_at?: number;
}

export interface JiraWorklogImportRequest {
    startDate: string;
    endDate: string;
    connectionIds: number[];
}

export interface JiraWorklogImportFailure {
    connectionId?: number;
    jiraKey?: string;
    worklogId?: string;
    error: string;
}

export interface JiraWorklogImportResult {
    created: number;
    updated: number;
    skipped: number;
    failed: JiraWorklogImportFailure[];
}

export interface OAuthFlowResult {
    success: boolean;
    cloudId?: string;
    siteName?: string;
    siteUrl?: string;
    accessTokenEncrypted?: string;
    refreshTokenEncrypted?: string;
    clientSecretEncrypted?: string;
    expiresIn?: number;
    error?: string;
}

export interface JiraConnectionOAuth {
    id?: number;
    name: string;
    base_url: string;
    is_default: number;
    color?: string;
    is_enabled: number;
    auth_type: 'api_token' | 'oauth';
    // API Token fields
    email?: string;
    api_token?: string;
    // OAuth fields
    client_id?: string;
    client_secret_encrypted?: string;
    access_token_encrypted?: string;
    refresh_token_encrypted?: string;
    token_expires_at?: number;
    cloud_id?: string;
}

const ipc = window.ipcRenderer;

export const api = {
    // Jira Connections
    getJiraConnections: () => ipc.invoke('db:get-all-connections') as Promise<JiraConnection[]>,
    saveJiraConnection: (conn: Partial<JiraConnection>) => ipc.invoke('db:save-connection', conn),
    saveJiraConnectionOAuth: (conn: JiraConnectionOAuth) => ipc.invoke('db:save-connection-oauth', conn),
    deleteJiraConnection: (id: number) => ipc.invoke('db:delete-connection', id),

    // OAuth
    startOAuthFlow: (clientId: string, clientSecret: string, connectionId?: number) =>
        ipc.invoke('oauth:start-flow', { clientId, clientSecret, connectionId }) as Promise<OAuthFlowResult>,
    cancelOAuthFlow: () => ipc.invoke('oauth:cancel-flow'),
    testOAuthConnection: (connectionId: number) =>
        ipc.invoke('oauth:test-connection', { connectionId }) as Promise<{ success: boolean; displayName?: string; error?: string }>,

    // Work Items
    getWorkItems: (params: { query?: string, limit?: number, offset?: number, showCompleted?: boolean } = {}) =>
        ipc.invoke('db:get-work-items', params) as Promise<WorkItem[]>,
    getWorkItemsCount: (params: { query?: string, showCompleted?: boolean } = {}) =>
        ipc.invoke('db:get-work-items-count', params) as Promise<number>,
    getWorkItem: (id: number) => ipc.invoke('db:get-work-item', id) as Promise<WorkItem>,
    saveWorkItem: (item: Partial<WorkItem>) => ipc.invoke('db:save-work-item', item) as Promise<WorkItem>,
    deleteWorkItem: (id: number) => ipc.invoke('db:delete-work-item', id),
    updateWorkItemCompletion: (ids: number[], completed: boolean) => ipc.invoke('db:update-work-item-completion', { ids, completed }),
    bulkUpdateWorkItemsConnection: (ids: number[], connectionId: number | null) => ipc.invoke('db:bulk-update-work-items-connection', { ids, connectionId }),
    getRecentWorkItems: () => ipc.invoke('db:get-recent-work-items') as Promise<WorkItem[]>,

    // Time Slices
    getTimeSlices: (startStr: string, endStr: string) => ipc.invoke('db:get-time-slices', { startStr, endStr }),
    getTimeSlice: (id: number) => ipc.invoke('db:get-time-slice', id) as Promise<TimeSlice>,
    getTimeSlicesForWorkItem: (workItemId: number) => ipc.invoke('db:get-work-item-time-slices', workItemId) as Promise<TimeSlice[]>,
    clearDatabase: (options: { clearTimeSlices: boolean, clearWorkItems: boolean }) => ipc.invoke('db:clear-data', options),
    saveTimeSlice: (slice: Partial<TimeSlice>) => ipc.invoke('db:save-time-slice', slice) as Promise<TimeSlice>,
    deleteTimeSlice: (id: number) => ipc.invoke('db:delete-time-slice', id),
    getActiveTimeSlice: () => ipc.invoke('db:get-active-time-slice') as Promise<TimeSlice | undefined>,
    searchTimeSlices: (params: { query?: string, limit?: number, offset?: number } = {}) =>
        ipc.invoke('db:search-time-slices', params) as Promise<TimeSlice[]>,
    searchTimeSlicesCount: (params: { query?: string } = {}) =>
        ipc.invoke('db:search-time-slices-count', params) as Promise<number>,

    // Settings
    getSettings: () => ipc.invoke('db:get-settings'),
    saveSetting: (key: string, value: string) => ipc.invoke('db:save-setting', { key, value }),

    // Jira
    searchJiraIssues: (query: string) => ipc.invoke('jira:search-issues', query),
    searchJiraIssuesAllConnections: (query: string) => ipc.invoke('jira:search-issues-all-connections', query) as Promise<{
        results: Array<{ key: string; summary: string; connectionId: number; connectionName: string }>;
        errors: Array<{ connectionId: number; connectionName: string; error: string }>;
    }>,
    addJiraWorklog: (issueKey: string, data: { timeSpentSeconds: number, comment: string, started: string }) =>
        ipc.invoke('jira:add-worklog', { issueKey, ...data }),
    updateJiraWorklog: (issueKey: string, worklogId: string, data: { timeSpentSeconds: number, comment: string, started: string }) =>
        ipc.invoke('jira:update-worklog', { issueKey, worklogId, ...data }),
    getJiraWorklogs: (issueKey: string) => ipc.invoke('jira:get-worklogs', { issueKey }),
    importJiraWorklogs: (request: JiraWorklogImportRequest) =>
        ipc.invoke('jira:import-worklogs', request) as Promise<JiraWorklogImportResult>,
    testJiraConnection: (config: { baseUrl: string, email: string, apiToken: string }) => ipc.invoke('jira:test-connection', config),
    getDatabasePath: () => ipc.invoke('database:get-path') as Promise<string>,
    selectDatabaseFile: () => ipc.invoke('database:select-file') as Promise<{ success: boolean; filePath?: string; error?: string; canceled?: boolean }>,
    createDatabaseFile: () => ipc.invoke('database:create-file') as Promise<{ success: boolean; filePath?: string; canceled?: boolean }>,
    saveDatabasePath: (filePath: string) => ipc.invoke('database:save-path', filePath) as Promise<string>,

    // System
    setTrayTooltip: (text: string) => ipc.invoke('tray:set-tooltip', text),
    setTrayIcon: (type: 'active' | 'idle', description?: string) => ipc.invoke('tray:set-icon', type, description),

    // CSV Import
    selectCsvFile: () => ipc.invoke('database:select-csv') as Promise<string | null>,
    importCsv: (csvContent: string) => ipc.invoke('database:import-csv', csvContent) as Promise<{ importedSlices: number, createdWorkItems: number, reusedWorkItems: number, skippedLines: number }>,
    readFile: (filePath: string) => ipc.invoke('fs:read-file', filePath) as Promise<string>,

    // Window Controls
    minimizeWindow: () => ipc.send('window:minimize'),
    maximizeWindow: () => ipc.send('window:maximize'),
    unmaximizeWindow: () => ipc.send('window:unmaximize'),
    closeWindow: () => ipc.send('window:close'),
    isWindowMaximized: () => ipc.invoke('window:is-maximized') as Promise<boolean>,
    openDevTools: () => ipc.send('window:open-dev-tools'),

    // Mini Player
    showMiniPlayer: (data: { isTracking: boolean; elapsedSeconds: number; jiraKey?: string | null; description: string; startTime?: string }) =>
        ipc.send('mini-player:show', data),
    hideMiniPlayer: () => ipc.send('mini-player:hide'),
    updateMiniPlayerState: (data: { isTracking: boolean; elapsedSeconds: number; jiraKey?: string | null; description: string; startTime?: string }) =>
        ipc.send('mini-player:update-state', data),
    minimizeToMiniPlayer: () => ipc.send('window:minimize-to-mini-player'),

    // App Info
    getAppVersion: () => ipc.invoke('app:get-version') as Promise<string>,
    quitAndInstallUpdate: () => ipc.send('update:quit-and-install'),
    checkForUpdates: () => ipc.invoke('update:check') as Promise<{ updateAvailable: boolean, version?: string }>,

    // Merge logic
    mergeTimeSlices: (ids: number[]) => ipc.invoke('db:merge-time-slices', { ids }),

    // Utils
    openExternal: (url: string) => ipc.invoke('shell:open-external', url),
    showLogs: () => ipc.invoke('app:show-logs') as Promise<{ success: boolean; error?: string }>,

    // General passthrough for custom handlers
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    invoke: (channel: string, ...args: any[]) => ipc.invoke(channel, ...args),
};
