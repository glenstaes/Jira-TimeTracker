import { ipcMain, dialog, BrowserWindow, app, shell } from 'electron'
import Database from 'better-sqlite3'
import { formatISO } from 'date-fns'
import path from 'node:path'
import fs from 'node:fs'
import { getDatabase } from '../src/database/db'
import { normalizeTimeSliceBoundary } from '../src/lib/time-utils'
import { updateTrayTooltip, updateTrayIcon } from './tray'
import { getAppConfig, saveAppConfig } from './config-service'
import { startUpdateInterval } from './auto-updater'
import { startOAuthFlow, saveOAuthTokens, getValidAccessToken, cancelPendingOAuth } from './oauth-service'
import { encrypt } from './crypto-service'

export function registerIpcHandlers() {
    const db = getDatabase()

    // Run database migrations/standardization
    runMigrations(db);

    // Initialize auto-update interval
    try {
        const stmt = db.prepare('SELECT value FROM settings WHERE key = ?');
        const setting = stmt.get('update_check_interval') as { value: string } | undefined;
        const interval = setting ? parseInt(setting.value, 10) : 60; // Default 60 mins
        startUpdateInterval(interval);
    } catch (e) {
        console.error('Failed to initialize update interval:', e);
    }

    // Jira Connections
    ipcMain.handle('db:get-all-connections', () => {
        return db.prepare('SELECT * FROM jira_connections ORDER BY created_at DESC').all()
    })

    ipcMain.handle('db:save-connection', (_, connection) => {
        if (connection.id) {
            const stmt = db.prepare(`
        UPDATE jira_connections 
        SET name = @name, base_url = @base_url, email = @email, api_token = @api_token, is_default = @is_default, color = @color, is_enabled = @is_enabled, updated_at = unixepoch()
        WHERE id = @id
      `)
            return stmt.run({
                ...connection,
                color: connection.color || null,
                is_enabled: connection.is_enabled !== undefined ? connection.is_enabled : 1
            })
        } else {
            // Check if any default connection exists
            const defaultExists = db.prepare('SELECT id FROM jira_connections WHERE is_default = 1').get();
            const is_default = defaultExists ? (connection.is_default || 0) : 1;

            const stmt = db.prepare(`
        INSERT INTO jira_connections (name, base_url, email, api_token, is_default, color, is_enabled)
        VALUES (@name, @base_url, @email, @api_token, @is_default, @color, @is_enabled)
      `)
            return stmt.run({
                ...connection,
                is_default,
                color: connection.color || null,
                is_enabled: connection.is_enabled !== undefined ? connection.is_enabled : 1
            })
        }
    })

    ipcMain.handle('db:delete-connection', (_, id) => {
        return db.prepare('DELETE FROM jira_connections WHERE id = ?').run(id)
    })

    // Work Items
    ipcMain.handle('db:get-work-items', (_, { query = '', limit = 50, offset = 0, showCompleted = false } = {}) => {
        const sql = `
        SELECT wi.*, jc.name as connection_name,
               COALESCE(SUM(strftime('%s', COALESCE(ts.end_time, 'now')) - strftime('%s', ts.start_time)), 0) as total_seconds
        FROM work_items wi
        LEFT JOIN jira_connections jc ON wi.jira_connection_id = jc.id
        LEFT JOIN time_slices ts ON wi.id = ts.work_item_id
        WHERE (wi.description LIKE @query OR wi.jira_key LIKE @query)
        AND (@showCompleted = 1 OR wi.is_completed = 0)
        GROUP BY wi.id
        ORDER BY wi.jira_key ASC, wi.description ASC
        LIMIT @limit OFFSET @offset
      `
        return db.prepare(sql).all({ query: `%${query}%`, limit, offset, showCompleted: showCompleted ? 1 : 0 })
    })

    ipcMain.handle('db:get-work-items-count', (_, { query = '', showCompleted = false } = {}) => {
        const sql = `
        SELECT COUNT(*) as count
        FROM work_items
        WHERE (description LIKE @query OR jira_key LIKE @query)
        AND (@showCompleted = 1 OR is_completed = 0)
      `
        const result = db.prepare(sql).get({ query: `%${query}%`, showCompleted: showCompleted ? 1 : 0 }) as { count: number };
        return result.count;
    })

    ipcMain.handle('db:get-work-item', (_, id: number) => {
        const sql = `
            SELECT wi.*, jc.name as connection_name,
                   COALESCE(SUM(strftime('%s', COALESCE(ts.end_time, 'now')) - strftime('%s', ts.start_time)), 0) as total_seconds
            FROM work_items wi
            LEFT JOIN jira_connections jc ON wi.jira_connection_id = jc.id
            LEFT JOIN time_slices ts ON wi.id = ts.work_item_id
            WHERE wi.id = ?
            GROUP BY wi.id
        `
        return db.prepare(sql).get(id);
    })

    ipcMain.handle('db:save-work-item', (_, item) => {
        try {
            if (item.id) {
                const stmt = db.prepare(`
                    UPDATE work_items 
                    SET jira_connection_id = @jira_connection_id, jira_key = @jira_key, description = @description, updated_at = unixepoch()
                    WHERE id = @id
                `)
                return stmt.run(item)
            } else {
                const stmt = db.prepare(`
                    INSERT INTO work_items (jira_connection_id, jira_key, description)
                    VALUES (@jira_connection_id, @jira_key, @description)
                `)
                const info = stmt.run(item)
                return { id: info.lastInsertRowid, ...item }
            }
        } catch (error: unknown) {
            // Check for unique constraint violation
            const sqliteError = error as { code?: string; message?: string };
            if (sqliteError.code === 'SQLITE_CONSTRAINT_UNIQUE' || sqliteError.message?.includes('UNIQUE constraint failed')) {
                throw new Error('A work item with this Jira key already exists.');
            }
            throw error;
        }
    })

    ipcMain.handle('db:delete-work-item', (_, id) => {
        const count = db.prepare('SELECT COUNT(*) as count FROM time_slices WHERE work_item_id = ?').get(id) as { count: number };
        if (count.count > 0) {
            throw new Error('Cannot delete work item with existing time slices.');
        }
        return db.prepare('DELETE FROM work_items WHERE id = ?').run(id);
    })

    ipcMain.handle('db:update-work-item-completion', (_, { ids, completed }) => {
        const placeholders = ids.map(() => '?').join(',');
        const stmt = db.prepare(`UPDATE work_items SET is_completed = ?, updated_at = unixepoch() WHERE id IN (${placeholders})`);
        return stmt.run(completed ? 1 : 0, ...ids);
    })

    ipcMain.handle('db:bulk-update-work-items-connection', (_, { ids, connectionId }: { ids: number[], connectionId: number | null }) => {
        const placeholders = ids.map(() => '?').join(',');
        const stmt = db.prepare(`UPDATE work_items SET jira_connection_id = ?, updated_at = unixepoch() WHERE id IN (${placeholders})`);
        return stmt.run(connectionId, ...ids);
    })

    ipcMain.handle('db:get-recent-work-items', () => {
        const sql = `
            SELECT wi.*, jc.name as connection_name
            FROM work_items wi
            LEFT JOIN jira_connections jc ON wi.jira_connection_id = jc.id
            JOIN (
                SELECT work_item_id, MAX(start_time) as last_start
                FROM time_slices
                GROUP BY work_item_id
            ) recent ON wi.id = recent.work_item_id
            WHERE wi.is_completed = 0
            ORDER BY recent.last_start DESC
            LIMIT 5
        `;
        return db.prepare(sql).all();
    });

    // Time Slices
    ipcMain.handle('db:get-time-slices', (_, { startStr, endStr }) => {
        const stmt = db.prepare(`
            SELECT ts.*, wi.description as work_item_description, wi.jira_key, jc.name as connection_name, jc.is_enabled as jira_connection_is_enabled, wi.jira_connection_id
            FROM time_slices ts 
            LEFT JOIN work_items wi ON ts.work_item_id = wi.id 
            LEFT JOIN jira_connections jc ON wi.jira_connection_id = jc.id
            WHERE ts.start_time >= @startStr AND ts.start_time <= @endStr
            ORDER BY ts.start_time
        `);
        return stmt.all({ startStr, endStr });
    });

    ipcMain.handle('db:get-time-slice', (_, id: number) => {
        const stmt = db.prepare(`
            SELECT ts.*, wi.description as work_item_description, wi.jira_key, jc.name as connection_name, jc.is_enabled as jira_connection_is_enabled, wi.jira_connection_id
            FROM time_slices ts 
            LEFT JOIN work_items wi ON ts.work_item_id = wi.id 
            LEFT JOIN jira_connections jc ON wi.jira_connection_id = jc.id
            WHERE ts.id = ?
        `);
        return stmt.get(id);
    });

    ipcMain.handle('db:save-time-slice', (_, slice) => {
        if (slice.id) {
            // Fetch existing record to preserve fields not provided in the update
            const existing = db.prepare('SELECT * FROM time_slices WHERE id = ?').get(slice.id) as {
                id: number;
                work_item_id: number;
                start_time: string;
                end_time: string | null;
                notes: string;
                synced_to_jira: number;
                jira_worklog_id: string | null;
                synced_start_time: string | null;
                synced_end_time: string | null;
                synced_notes: string | null;
            } | undefined;

            if (!existing) {
                console.error(`[IPC:save-time-slice] Attempted to update non-existent time slice ${slice.id}`);
                // Return safely or throw? Throwing might be caught by frontend.
                // If we assume it's a stale update, maybe we just stop?
                throw new Error(`Time slice ${slice.id} not found.`);
            }

            const merged = {
                ...existing,
                ...slice,
                start_time: normalizeTimeSliceBoundary(slice.start_time !== undefined ? slice.start_time : existing.start_time),
                end_time: normalizeTimeSliceBoundary(slice.end_time !== undefined ? slice.end_time : existing.end_time),
                synced_start_time: normalizeTimeSliceBoundary(slice.synced_start_time !== undefined ? slice.synced_start_time : existing.synced_start_time),
                synced_end_time: normalizeTimeSliceBoundary(slice.synced_end_time !== undefined ? slice.synced_end_time : existing.synced_end_time)
            };

            // Determine if we should reset the sync status
            let synced_to_jira = merged.synced_to_jira || 0;
            const notesChanged = slice.notes !== undefined && existing.notes !== slice.notes;
            const startChanged = slice.start_time !== undefined && existing.start_time !== merged.start_time;
            const endChanged = slice.end_time !== undefined && existing.end_time !== merged.end_time;

            if ((notesChanged || startChanged || endChanged) && existing.synced_to_jira === 1) {
                console.log(`[IPC:save-time-slice] Drift detected (Notes: ${notesChanged}, Start: ${startChanged}, End: ${endChanged}) for synced slice ${slice.id}. Marking as out-of-sync.`);
                synced_to_jira = 0;
            }

            const stmt = db.prepare(`
            UPDATE time_slices
            SET work_item_id = @work_item_id, start_time = @start_time, end_time = @end_time, notes = @notes, synced_to_jira = @synced_to_jira, jira_worklog_id = @jira_worklog_id, synced_start_time = @synced_start_time, synced_end_time = @synced_end_time, synced_notes = @synced_notes, updated_at = unixepoch()
            WHERE id = @id
        `)
            const params = {
                id: merged.id,
                work_item_id: merged.work_item_id,
                start_time: merged.start_time,
                end_time: merged.end_time || null,
                notes: merged.notes || '',
                synced_to_jira: synced_to_jira,
                jira_worklog_id: merged.jira_worklog_id || null,
                synced_start_time: merged.synced_start_time || null,
                synced_end_time: merged.synced_end_time || null,
                synced_notes: merged.synced_notes || null
            };
            return stmt.run(params)
        } else {
            // SAFEGUARD: If starting a NEW active time slice (no end_time), close any other active slices
            if (!slice.end_time) {
                const activeSlices = db.prepare('SELECT id FROM time_slices WHERE end_time IS NULL').all() as { id: number }[];
                if (activeSlices.length > 0) {
                    const now = normalizeTimeSliceBoundary(formatISO(new Date()))!;
                    console.log(`[IPC:save-time-slice] Closing ${activeSlices.length} orphaned active slices before creating new one`);
                    const closeStmt = db.prepare('UPDATE time_slices SET end_time = ?, updated_at = unixepoch() WHERE id = ?');
                    for (const active of activeSlices) {
                        closeStmt.run(now, active.id);
                    }

                    // Broadcast refresh to all windows
                    BrowserWindow.getAllWindows().forEach(win => {
                        win.webContents.send('tracking:refresh');
                    });
                }
            }

            const stmt = db.prepare(`
                INSERT INTO time_slices (work_item_id, start_time, end_time, notes, synced_to_jira, jira_worklog_id, synced_start_time, synced_end_time, synced_notes)
                VALUES (@work_item_id, @start_time, @end_time, @notes, @synced_to_jira, @jira_worklog_id, @synced_start_time, @synced_end_time, @synced_notes)
            `)
            const params = {
                work_item_id: slice.work_item_id,
                start_time: normalizeTimeSliceBoundary(slice.start_time),
                end_time: normalizeTimeSliceBoundary(slice.end_time),
                notes: slice.notes || '',
                synced_to_jira: slice.synced_to_jira || 0,
                jira_worklog_id: slice.jira_worklog_id || null,
                synced_start_time: normalizeTimeSliceBoundary(slice.synced_start_time),
                synced_end_time: normalizeTimeSliceBoundary(slice.synced_end_time),
                synced_notes: slice.synced_notes || null
            };
            const info = stmt.run(params)
            return { id: info.lastInsertRowid, ...slice, ...params }
        }
    })

    ipcMain.handle('db:get-active-time-slice', () => {
        return db.prepare('SELECT * FROM time_slices WHERE end_time IS NULL LIMIT 1').get()
    })

    ipcMain.handle('db:delete-time-slice', (_, id) => {
        return db.prepare('DELETE FROM time_slices WHERE id = ?').run(id)
    })

    ipcMain.handle('db:get-work-item-time-slices', (_, workItemId: number) => {
        const stmt = db.prepare(`
            SELECT ts.*, wi.description as work_item_description, wi.jira_key, jc.name as connection_name, jc.is_enabled as jira_connection_is_enabled, wi.jira_connection_id
            FROM time_slices ts 
            LEFT JOIN work_items wi ON ts.work_item_id = wi.id 
            LEFT JOIN jira_connections jc ON wi.jira_connection_id = jc.id
            WHERE ts.work_item_id = ?
            ORDER BY ts.start_time ASC
        `);
        return stmt.all(workItemId);
    });

    ipcMain.handle('db:search-time-slices', (_, { query = '', limit = 50, offset = 0 } = {}) => {
        const sql = `
            SELECT ts.*, wi.description as work_item_description, wi.jira_key, jc.name as connection_name, jc.is_enabled as jira_connection_is_enabled, wi.jira_connection_id
            FROM time_slices ts 
            LEFT JOIN work_items wi ON ts.work_item_id = wi.id 
            LEFT JOIN jira_connections jc ON wi.jira_connection_id = jc.id
            WHERE ts.notes LIKE @query
               OR wi.description LIKE @query
               OR wi.jira_key LIKE @query
            ORDER BY ts.start_time DESC
            LIMIT @limit OFFSET @offset
        `;
        return db.prepare(sql).all({ query: `%${query}%`, limit, offset });
    });

    ipcMain.handle('db:search-time-slices-count', (_, { query = '' } = {}) => {
        const sql = `
            SELECT COUNT(*) as count
            FROM time_slices ts 
            LEFT JOIN work_items wi ON ts.work_item_id = wi.id 
            WHERE ts.notes LIKE @query
               OR wi.description LIKE @query
               OR wi.jira_key LIKE @query
        `;
        const result = db.prepare(sql).get({ query: `%${query}%` }) as { count: number };
        return result.count;
    });

    ipcMain.handle('db:clear-data', (_, { clearTimeSlices, clearWorkItems }: { clearTimeSlices: boolean, clearWorkItems: boolean }) => {
        if (clearWorkItems) {
            return db.prepare('DELETE FROM work_items').run();
        } else if (clearTimeSlices) {
            return db.prepare('DELETE FROM time_slices').run();
        }
    });

    ipcMain.handle('db:merge-time-slices', (_, { ids }: { ids: number[] }) => {
        const slices = db.prepare(`
            SELECT * FROM time_slices 
            WHERE id IN (${ids.map(() => '?').join(',')})
            ORDER BY start_time ASC
        `).all(...ids) as any[]; // eslint-disable-line @typescript-eslint/no-explicit-any

        if (slices.length < 2) throw new Error("At least two slices are required to merge");

        const firstSlice = slices[0];
        const lastSlice = slices[slices.length - 1];

        // Concatenate notes, filtering out empty ones
        const combinedNotes = slices
            .map(s => s.notes?.trim())
            .filter(n => !!n)
            .join('\n');

        const mergedData = {
            work_item_id: firstSlice.work_item_id,
            start_time: firstSlice.start_time,
            end_time: lastSlice.end_time || null,
            notes: combinedNotes,
            synced_to_jira: 0,
            jira_worklog_id: null,
            synced_start_time: null,
            synced_end_time: null
        };

        const runMerge = db.transaction(() => {
            // Delete all original slices
            db.prepare(`DELETE FROM time_slices WHERE id IN (${ids.map(() => '?').join(',')})`).run(...ids);

            // Insert the new merged slice
            const insertStmt = db.prepare(`
                INSERT INTO time_slices (work_item_id, start_time, end_time, notes, synced_to_jira, jira_worklog_id, synced_start_time, synced_end_time)
                VALUES (@work_item_id, @start_time, @end_time, @notes, @synced_to_jira, @jira_worklog_id, @synced_start_time, @synced_end_time)
            `);
            return insertStmt.run(mergedData);
        });

        const result = runMerge();

        // Broadcast refresh to all windows so they update active tracking state
        BrowserWindow.getAllWindows().forEach(win => {
            win.webContents.send('tracking:refresh');
        });

        return result;
    });

    // Settings
    ipcMain.handle('db:get-settings', () => {
        const stmt = db.prepare('SELECT key, value FROM settings');
        const rows = stmt.all() as { key: string, value: string }[];
        return rows.reduce((acc, row) => ({ ...acc, [row.key]: row.value }), {});
    });

    ipcMain.handle('db:save-setting', (_, { key, value }: { key: string, value: string }) => {
        const stmt = db.prepare('INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, ?)');
        stmt.run(key, value, Date.now());

        if (key === 'update_check_interval') {
            const interval = parseInt(value, 10);
            startUpdateInterval(interval);
        }

        // Broadcast setting update to all windows (e.g. mini-player)
        BrowserWindow.getAllWindows().forEach(win => {
            win.webContents.send('setting:updated', { key, value });
        });

        return { success: true };
    });

    // Helper type for connection with OAuth fields
    type ConnectionRow = {
        id: number;
        name: string;
        base_url: string;
        email: string;
        api_token: string;
        is_enabled?: number;
        auth_type?: string;
        cloud_id?: string;
    };

    // Helper function to create JiraClient for a connection
    async function createJiraClientForConnection(conn: ConnectionRow) {
        const { JiraClient } = await import('../src/services/jira/jira-client');

        if (conn.auth_type === 'oauth' && conn.cloud_id) {
            const accessToken = await getValidAccessToken(conn.id);
            return new JiraClient({
                cloudId: conn.cloud_id,
                accessToken: accessToken
            });
        } else {
            return new JiraClient({
                baseUrl: conn.base_url,
                email: conn.email,
                apiToken: conn.api_token
            });
        }
    }

    // Jira API
    ipcMain.handle('jira:search-issues', async (_, query: string) => {
        const stmt = db.prepare('SELECT * FROM jira_connections WHERE is_default = 1 AND is_enabled = 1 LIMIT 1');
        const conn = stmt.get() as ConnectionRow | undefined;

        if (!conn) {
            throw new Error("No default Jira connection found");
        }

        const client = await createJiraClientForConnection(conn);

        let jql = query.trim();
        if (jql && !jql.includes('=') && !jql.includes('~')) {
            const sanitized = jql.replace(/["\\]/g, '');
            if (/^[A-Za-z]+-[0-9]+$/.test(sanitized)) {
                jql = `key = "${sanitized}" OR summary ~ "${sanitized}*"`;
            } else {
                jql = `summary ~ "${sanitized}*"`;
            }
        }

        return await client.searchIssues(jql);
    });

    ipcMain.handle('jira:search-issues-all-connections', async (_, query: string) => {
        const connections = db.prepare('SELECT * FROM jira_connections WHERE is_enabled = 1').all() as ConnectionRow[];

        if (connections.length === 0) {
            return [];
        }

        let jql = query.trim();
        if (jql && !jql.includes('=') && !jql.includes('~')) {
            const sanitized = jql.replace(/["\\]/g, '');
            if (/^[A-Za-z]+-[0-9]+$/.test(sanitized)) {
                jql = `key = "${sanitized}" OR summary ~ "${sanitized}*"`;
            } else {
                jql = `summary ~ "${sanitized}*"`;
            }
        }

        const errors: { connectionId: number; connectionName: string; error: string }[] = [];
        const successful: { key: string; summary: string; connectionId: number; connectionName: string }[] = [];

        await Promise.all(connections.map(async (conn) => {
            try {
                console.log(`[IPC] Searching connection ${conn.id} (${conn.name})`);
                const client = await createJiraClientForConnection(conn);
                const issues = await client.searchIssues(jql);
                console.log(`[IPC] Connection ${conn.id} found ${issues.length} issues`);

                const mappedIssues = issues.map((issue: { key: string; fields?: { summary?: string } }) => ({
                    key: issue.key,
                    summary: issue.fields?.summary || '',
                    connectionId: conn.id,
                    connectionName: conn.name
                }));
                successful.push(...mappedIssues);
            } catch (error: unknown) {
                const err = error as { message?: string };
                console.error(`[IPC] Connection ${conn.id} search failed:`, error);
                errors.push({
                    connectionId: conn.id,
                    connectionName: conn.name,
                    error: err.message || 'Unknown error'
                });
            }
        }));

        console.log(`[IPC] Total combined issues found: ${successful.length}, Errors: ${errors.length}`);
        return { results: successful, errors };
    });

    // Helper to get connection for an issue (by key) or fall back to default
    const getConnectionForIssue = (issueKey: string): ConnectionRow => {
        // 1. Try to find connection linked to this work item
        const workItem = db.prepare('SELECT jira_connection_id FROM work_items WHERE jira_key = ?').get(issueKey) as { jira_connection_id: number } | undefined;

        if (workItem?.jira_connection_id) {
            const conn = db.prepare('SELECT * FROM jira_connections WHERE id = ?').get(workItem.jira_connection_id) as ConnectionRow | undefined;
            if (conn?.is_enabled === 0) {
                throw new Error(`Jira connection "${conn.name}" is disabled.`);
            }
            if (conn) return conn;
        }

        // 2. Fallback to default
        const defaultConn = db.prepare('SELECT * FROM jira_connections WHERE is_default = 1 AND is_enabled = 1 LIMIT 1').get() as ConnectionRow | undefined;
        if (!defaultConn) throw new Error("No default Jira connection found, and issue is not linked to a specific connection.");
        return defaultConn;
    };

    ipcMain.handle('jira:add-worklog', async (_, { issueKey, timeSpentSeconds, comment, started }) => {
        const conn = getConnectionForIssue(issueKey);
        const client = await createJiraClientForConnection(conn);

        return await client.addWorklog(issueKey, {
            timeSpentSeconds,
            comment,
            started
        });
    });

    ipcMain.handle('jira:get-worklogs', async (_, { issueKey }) => {
        const conn = getConnectionForIssue(issueKey);
        const client = await createJiraClientForConnection(conn);

        return await client.getWorklogs(issueKey);
    });

    ipcMain.handle('jira:update-worklog', async (_, { issueKey, worklogId, timeSpentSeconds, comment, started }) => {
        const conn = getConnectionForIssue(issueKey);
        const client = await createJiraClientForConnection(conn);

        return await client.updateWorklog(issueKey, worklogId, {
            timeSpentSeconds,
            comment,
            started
        });
    });

    ipcMain.handle('jira:import-worklogs', async (_, { startDate, endDate, connectionIds }: {
        startDate: string;
        endDate: string;
        connectionIds: number[];
    }) => {
        if (!startDate || !endDate) {
            throw new Error('A start and end date are required.');
        }

        if (!Array.isArray(connectionIds) || connectionIds.length === 0) {
            throw new Error('Select at least one Jira connection.');
        }

        const startTime = new Date(startDate).getTime();
        const endTime = new Date(endDate).getTime();

        if (Number.isNaN(startTime) || Number.isNaN(endTime)) {
            throw new Error('Invalid import date range.');
        }

        const connections = db.prepare(`
            SELECT *
            FROM jira_connections
            WHERE is_enabled = 1
              AND id IN (${connectionIds.map(() => '?').join(',')})
        `).all(...connectionIds) as ConnectionRow[];

        if (connections.length === 0) {
            throw new Error('No enabled Jira connections found for import.');
        }

        const result: {
            created: number;
            updated: number;
            skipped: number;
            failed: Array<{ connectionId?: number; jiraKey?: string; worklogId?: string; error: string }>;
        } = {
            created: 0,
            updated: 0,
            skipped: 0,
            failed: [],
        };

        const findWorkItemStmt = db.prepare(`
            SELECT id
            FROM work_items
            WHERE jira_connection_id = ?
              AND jira_key = ?
            LIMIT 1
        `);
        const insertWorkItemStmt = db.prepare(`
            INSERT INTO work_items (jira_connection_id, jira_key, description)
            VALUES (?, ?, ?)
        `);
        const updateWorkItemStmt = db.prepare(`
            UPDATE work_items
            SET description = ?, updated_at = unixepoch()
            WHERE id = ?
        `);
        const findImportedSliceStmt = db.prepare(`
            SELECT ts.*
            FROM time_slices ts
            JOIN work_items wi ON wi.id = ts.work_item_id
            WHERE ts.jira_worklog_id = ?
              AND wi.jira_connection_id = ?
            LIMIT 1
        `);
        const insertSliceStmt = db.prepare(`
            INSERT INTO time_slices (
                work_item_id,
                start_time,
                end_time,
                notes,
                synced_to_jira,
                jira_worklog_id,
                synced_start_time,
                synced_end_time,
                synced_notes
            )
            VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?)
        `);
        const updateSliceStmt = db.prepare(`
            UPDATE time_slices
            SET work_item_id = ?,
                start_time = ?,
                end_time = ?,
                notes = ?,
                synced_to_jira = 1,
                jira_worklog_id = ?,
                synced_start_time = ?,
                synced_end_time = ?,
                synced_notes = ?,
                updated_at = unixepoch()
            WHERE id = ?
        `);

        for (const conn of connections) {
            try {
                const client = await createJiraClientForConnection(conn);
                const currentUser = await client.getCurrentUser();
                const issues = await client.searchIssuesByWorklogDateRange(startDate, endDate, currentUser.accountId);

                for (const issue of issues) {
                    try {
                        const worklogs = await client.getWorklogs(issue.key);

                        for (const worklog of worklogs) {
                            const authorMatches = worklog.author?.accountId === currentUser.accountId;
                            const worklogStartTime = new Date(worklog.started).getTime();

                            if (!authorMatches || Number.isNaN(worklogStartTime) || worklogStartTime < startTime || worklogStartTime > endTime) {
                                continue;
                            }

                            const startedAt = new Date(worklog.started);
                            const endedAt = new Date(worklogStartTime + (worklog.timeSpentSeconds * 1000));
                            const normalizedStart = normalizeTimeSliceBoundary(formatISO(startedAt))!;
                            const normalizedEnd = normalizeTimeSliceBoundary(formatISO(endedAt))!;
                            const normalizedNotes = jiraCommentToPlainText(worklog.comment);
                            const issueSummary = issue.fields?.summary || issue.key;

                            const importWorklog = db.transaction(() => {
                                let workItem = findWorkItemStmt.get(conn.id, issue.key) as { id: number } | undefined;

                                if (!workItem) {
                                    const insertInfo = insertWorkItemStmt.run(conn.id, issue.key, issueSummary);
                                    workItem = { id: insertInfo.lastInsertRowid as number };
                                } else {
                                    updateWorkItemStmt.run(issueSummary, workItem.id);
                                }

                                const existingSlice = findImportedSliceStmt.get(worklog.id, conn.id) as {
                                    id: number;
                                    work_item_id: number;
                                    start_time: string;
                                    end_time: string | null;
                                    notes: string | null;
                                    jira_worklog_id: string | null;
                                    synced_start_time: string | null;
                                    synced_end_time: string | null;
                                    synced_notes: string | null;
                                } | undefined;

                                if (!existingSlice) {
                                    insertSliceStmt.run(
                                        workItem.id,
                                        normalizedStart,
                                        normalizedEnd,
                                        normalizedNotes,
                                        worklog.id,
                                        normalizedStart,
                                        normalizedEnd,
                                        normalizedNotes
                                    );
                                    return 'created';
                                }

                                const unchanged =
                                    existingSlice.work_item_id === workItem.id &&
                                    existingSlice.start_time === normalizedStart &&
                                    (existingSlice.end_time || null) === normalizedEnd &&
                                    (existingSlice.notes || '') === normalizedNotes &&
                                    (existingSlice.synced_start_time || null) === normalizedStart &&
                                    (existingSlice.synced_end_time || null) === normalizedEnd &&
                                    (existingSlice.synced_notes || '') === normalizedNotes;

                                if (unchanged) {
                                    return 'skipped';
                                }

                                updateSliceStmt.run(
                                    workItem.id,
                                    normalizedStart,
                                    normalizedEnd,
                                    normalizedNotes,
                                    worklog.id,
                                    normalizedStart,
                                    normalizedEnd,
                                    normalizedNotes,
                                    existingSlice.id
                                );
                                return 'updated';
                            });

                            const outcome = importWorklog();
                            if (outcome === 'created') {
                                result.created += 1;
                            } else if (outcome === 'updated') {
                                result.updated += 1;
                            } else {
                                result.skipped += 1;
                            }
                        }
                    } catch (error: unknown) {
                        const err = error as { message?: string };
                        result.failed.push({
                            connectionId: conn.id,
                            jiraKey: issue.key,
                            error: err.message || 'Failed to import worklogs for issue.'
                        });
                    }
                }
            } catch (error: unknown) {
                const err = error as { message?: string; response?: { data?: { errorMessages?: string[]; errors?: Record<string, string> } } };
                const detail = err.response?.data?.errorMessages?.[0]
                    || Object.values(err.response?.data?.errors || {})[0]
                    || err.message
                    || 'Failed to import from Jira connection.';
                result.failed.push({
                    connectionId: conn.id,
                    error: detail
                });
            }
        }

        return result;
    });

    ipcMain.handle('jira:test-connection', async (_, config) => {
        const { JiraClient } = await import('../src/services/jira/jira-client');
        const client = new JiraClient({
            baseUrl: config.baseUrl,
            email: config.email,
            apiToken: config.apiToken
        });

        try {
            const user = await client.getCurrentUser();
            return { success: true, displayName: user.displayName };
        } catch (e: unknown) {
            const err = e as { response?: { status?: number }; code?: string; message?: string };
            const msg = err.response?.status === 401 ? 'Authentication failed. Check credentials.' :
                err.code === 'ENOTFOUND' ? 'Host not found. Check URL.' :
                    err.message;
            return { success: false, error: msg };
        }
    });

    // OAuth Flow
    ipcMain.handle('oauth:start-flow', async (_, { clientId, clientSecret, connectionId }: { clientId: string; clientSecret: string; connectionId?: number }) => {
        try {
            let actualClientSecret = clientSecret;

            // If secret is missing but connection exists, try to get it from DB
            if (!actualClientSecret && connectionId) {
                const conn = db.prepare(`
                    SELECT client_secret_encrypted FROM jira_connections 
                    WHERE id = ? AND auth_type = 'oauth'
                `).get(connectionId) as { client_secret_encrypted: string } | undefined;

                if (conn?.client_secret_encrypted) {
                    const { decrypt } = await import('./crypto-service');
                    actualClientSecret = decrypt(conn.client_secret_encrypted);
                }
            }

            if (!actualClientSecret) {
                throw new Error('Client Secret is required for new connections or if not already stored.');
            }

            const result = await startOAuthFlow(clientId, actualClientSecret, connectionId || null);

            if (result.success && result.accessToken && result.refreshToken && result.cloudId) {
                // If connectionId exists, save the OAuth tokens
                if (connectionId) {
                    saveOAuthTokens(
                        connectionId,
                        clientId,
                        actualClientSecret,
                        result.accessToken,
                        result.refreshToken,
                        result.expiresIn || 3600,
                        result.cloudId
                    );
                }

                return {
                    success: true,
                    cloudId: result.cloudId,
                    siteName: result.siteName,
                    siteUrl: result.siteUrl,
                    // Return encrypted tokens for new connections (will be saved with the connection)
                    accessTokenEncrypted: encrypt(result.accessToken),
                    refreshTokenEncrypted: encrypt(result.refreshToken),
                    clientSecretEncrypted: encrypt(actualClientSecret),
                    expiresIn: result.expiresIn
                };
            }

            return { success: false, error: result.error || 'OAuth flow failed' };
        } catch (e: unknown) {
            const err = e as { message?: string };
            console.error('[IPC] OAuth flow error:', err);
            return { success: false, error: err.message || 'OAuth flow failed' };
        }
    });

    ipcMain.handle('oauth:cancel-flow', () => {
        cancelPendingOAuth();
        return { success: true };
    });

    ipcMain.handle('oauth:test-connection', async (_, { connectionId }: { connectionId: number }) => {
        try {
            const conn = db.prepare(`
                SELECT cloud_id FROM jira_connections 
                WHERE id = ? AND auth_type = 'oauth'
            `).get(connectionId) as { cloud_id: string } | undefined;

            if (!conn) {
                return { success: false, error: 'OAuth connection not found' };
            }

            const accessToken = await getValidAccessToken(connectionId);

            const { JiraClient } = await import('../src/services/jira/jira-client');
            const client = new JiraClient({
                cloudId: conn.cloud_id,
                accessToken: accessToken
            });

            const user = await client.getCurrentUser();
            return { success: true, displayName: user.displayName };
        } catch (e: unknown) {
            const err = e as { response?: { status?: number }; message?: string };
            const msg = err.response?.status === 401 ? 'OAuth token expired or revoked. Please re-authorize.' :
                err.message;
            return { success: false, error: msg };
        }
    });

    // Save connection with OAuth support
    ipcMain.handle('db:save-connection-oauth', (_, connection: {
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
        // OAuth fields (already encrypted from frontend)
        client_id?: string;
        client_secret_encrypted?: string;
        access_token_encrypted?: string;
        refresh_token_encrypted?: string;
        token_expires_at?: number;
        cloud_id?: string;
    }) => {
        if (connection.id) {
            // Update existing connection
            if (connection.auth_type === 'oauth') {
                const stmt = db.prepare(`
                    UPDATE jira_connections 
                    SET name = @name, base_url = @base_url, is_default = @is_default, 
                        color = @color, is_enabled = @is_enabled, auth_type = @auth_type,
                        client_id = @client_id, client_secret_encrypted = @client_secret_encrypted,
                        access_token_encrypted = @access_token_encrypted, refresh_token_encrypted = @refresh_token_encrypted,
                        token_expires_at = @token_expires_at, cloud_id = @cloud_id,
                        email = '', api_token = '',
                        updated_at = unixepoch()
                    WHERE id = @id
                `);
                return stmt.run({
                    id: connection.id,
                    name: connection.name,
                    base_url: connection.base_url,
                    is_default: connection.is_default,
                    color: connection.color || null,
                    is_enabled: connection.is_enabled,
                    auth_type: connection.auth_type,
                    client_id: connection.client_id,
                    client_secret_encrypted: connection.client_secret_encrypted,
                    access_token_encrypted: connection.access_token_encrypted,
                    refresh_token_encrypted: connection.refresh_token_encrypted,
                    token_expires_at: connection.token_expires_at,
                    cloud_id: connection.cloud_id
                });
            } else {
                // API Token update
                const stmt = db.prepare(`
                    UPDATE jira_connections 
                    SET name = @name, base_url = @base_url, email = @email, api_token = @api_token,
                        is_default = @is_default, color = @color, is_enabled = @is_enabled, 
                        auth_type = 'api_token', updated_at = unixepoch()
                    WHERE id = @id
                `);
                return stmt.run({
                    id: connection.id,
                    name: connection.name,
                    base_url: connection.base_url,
                    email: connection.email,
                    api_token: connection.api_token,
                    is_default: connection.is_default,
                    color: connection.color || null,
                    is_enabled: connection.is_enabled
                });
            }
        } else {
            // Check if any default connection exists
            const defaultExists = db.prepare('SELECT id FROM jira_connections WHERE is_default = 1').get();
            const is_default = defaultExists ? (connection.is_default || 0) : 1;

            // Insert new connection
            if (connection.auth_type === 'oauth') {
                const stmt = db.prepare(`
                    INSERT INTO jira_connections (name, base_url, email, api_token, is_default, color, is_enabled, 
                        auth_type, client_id, client_secret_encrypted, access_token_encrypted, refresh_token_encrypted,
                        token_expires_at, cloud_id)
                    VALUES (@name, @base_url, '', '', @is_default, @color, @is_enabled,
                        @auth_type, @client_id, @client_secret_encrypted, @access_token_encrypted, @refresh_token_encrypted,
                        @token_expires_at, @cloud_id)
                `);
                const result = stmt.run({
                    name: connection.name,
                    base_url: connection.base_url,
                    is_default,
                    color: connection.color || null,
                    is_enabled: connection.is_enabled,
                    auth_type: connection.auth_type,
                    client_id: connection.client_id,
                    client_secret_encrypted: connection.client_secret_encrypted,
                    access_token_encrypted: connection.access_token_encrypted,
                    refresh_token_encrypted: connection.refresh_token_encrypted,
                    token_expires_at: connection.token_expires_at,
                    cloud_id: connection.cloud_id
                });
                return { id: result.lastInsertRowid, ...connection, is_default };
            } else {
                const stmt = db.prepare(`
                    INSERT INTO jira_connections (name, base_url, email, api_token, is_default, color, is_enabled, auth_type)
                    VALUES (@name, @base_url, @email, @api_token, @is_default, @color, @is_enabled, 'api_token')
                `);
                const result = stmt.run({
                    name: connection.name,
                    base_url: connection.base_url,
                    email: connection.email,
                    api_token: connection.api_token,
                    is_default,
                    color: connection.color || null,
                    is_enabled: connection.is_enabled
                });
                return { id: result.lastInsertRowid, ...connection, is_default };
            }
        }
    });

    // Tray
    ipcMain.handle('tray:set-tooltip', (_, text: string) => {
        updateTrayTooltip(text);
    });

    ipcMain.handle('tray:set-icon', (_, type: 'active' | 'idle', description?: string) => {
        updateTrayIcon(type, description);
    });

    // Database Path
    ipcMain.handle('database:get-path', () => {
        return getAppConfig().databasePath;
    });

    ipcMain.handle('database:save-path', async (_, filePath: string) => {
        saveAppConfig({ databasePath: filePath });
        return filePath;
    });

    // Select existing database file
    ipcMain.handle('database:select-file', async () => {
        const result = await dialog.showOpenDialog({
            properties: ['openFile'],
            title: 'Select Database File',
            filters: [{ name: 'SQLite Database', extensions: ['db', 'sqlite', 'sqlite3'] }]
        });

        if (result.canceled || result.filePaths.length === 0) {
            return { success: false, canceled: true };
        }

        const filePath = result.filePaths[0];

        // Validate SQLite file
        try {
            const buffer = Buffer.alloc(16);
            const fd = fs.openSync(filePath, 'r');
            fs.readSync(fd, buffer, 0, 16, 0);
            fs.closeSync(fd);

            // SQLite files start with "SQLite format 3\0"
            const header = buffer.toString('utf8', 0, 15);
            if (header !== 'SQLite format 3') {
                return { success: false, error: 'The selected file is not a valid SQLite database.' };
            }
        } catch {
            return { success: false, error: 'Failed to read the selected file.' };
        }

        return { success: true, filePath };
    });

    // Create new database file
    ipcMain.handle('database:create-file', async () => {
        const result = await dialog.showSaveDialog({
            title: 'Create New Database File',
            defaultPath: path.join(app.getPath('documents'), 'jira-timetracker-app.db'),
            filters: [{ name: 'SQLite Database', extensions: ['db'] }]
        });

        if (result.canceled || !result.filePath) {
            return { success: false, canceled: true };
        }

        let filePath = result.filePath;
        // Ensure .db extension
        if (!filePath.endsWith('.db')) {
            filePath += '.db';
        }

        return { success: true, filePath };
    });

    // CSV Import
    ipcMain.handle('database:select-csv', async () => {
        const result = await dialog.showOpenDialog({
            properties: ['openFile'],
            title: 'Select CSV File to Import',
            filters: [{ name: 'CSV Files', extensions: ['csv'] }]
        });

        if (result.canceled || result.filePaths.length === 0) {
            return null;
        }

        return result.filePaths[0];
    });

    ipcMain.handle('database:import-csv', async (_, csvContent: string) => {
        const rows = parseCSV(csvContent);
        if (rows.length < 2) {
            throw new Error('CSV file must have a header row and at least one data row');
        }

        const dataRows = rows.slice(1);
        let importedSlices = 0;
        let createdWorkItems = 0;
        let reusedWorkItems = 0;
        let skippedLines = 0;

        const defaultConn = db.prepare('SELECT id FROM jira_connections WHERE is_default = 1 LIMIT 1').get() as { id: number } | undefined;

        for (let rowIndex = 0; rowIndex < dataRows.length; rowIndex++) {
            const fields = dataRows[rowIndex];
            if (fields.length < 4) {
                skippedLines++;
                continue;
            }

            const [startTimeStr, endTimeStr, notes, description, jiraKey] = fields;
            if (!startTimeStr?.trim() || !description?.trim()) {
                skippedLines++;
                continue;
            }

            // CSV Import format handling
            // If it already looks like ISO (has T and Z or +/-), formatISO will handle it
            // If it's a simple date string, formatISO will add local offset
            const startTime = normalizeTimeSliceBoundary(formatISO(new Date(startTimeStr.trim())))!;
            const endTime = endTimeStr?.trim() ? normalizeTimeSliceBoundary(formatISO(new Date(endTimeStr.trim()))) : null;

            let workItem: { id: number } | undefined;
            if (jiraKey && jiraKey.trim()) {
                workItem = db.prepare(
                    'SELECT id FROM work_items WHERE jira_key = ? AND description = ?'
                ).get(jiraKey.trim(), description.trim()) as { id: number } | undefined;
            }

            if (!workItem) {
                workItem = db.prepare(
                    'SELECT id FROM work_items WHERE description = ? AND (jira_key IS NULL OR jira_key = ?)'
                ).get(description.trim(), jiraKey?.trim() || null) as { id: number } | undefined;
            }

            if (workItem) {
                reusedWorkItems++;
            } else {
                const stmt = db.prepare(`
                    INSERT INTO work_items (jira_connection_id, jira_key, description)
                    VALUES (@jira_connection_id, @jira_key, @description)
                `);
                const info = stmt.run({
                    jira_connection_id: jiraKey?.trim() ? (defaultConn?.id || null) : null,
                    jira_key: jiraKey?.trim() || null,
                    description: description.trim()
                });
                workItem = { id: info.lastInsertRowid as number };
                createdWorkItems++;
            }

            const sliceStmt = db.prepare(`
                INSERT INTO time_slices (work_item_id, start_time, end_time, notes)
                VALUES (@work_item_id, @start_time, @end_time, @notes)
            `);

            const normalizedNotes = (notes || '')
                .replace(/\r\n/g, '\n')
                .replace(/\r/g, '\n')
                .replace(/\\n/g, '\n')
                .replace(/\\r/g, '\n')
                .trim();

            sliceStmt.run({
                work_item_id: workItem.id,
                start_time: startTime,
                end_time: endTime,
                notes: normalizedNotes
            });
            importedSlices++;
        }

        return {
            importedSlices,
            createdWorkItems,
            reusedWorkItems,
            skippedLines
        };
    });

    // File System
    ipcMain.handle('fs:read-file', async (_, filePath: string) => {
        const fs = await import('node:fs/promises');
        return await fs.readFile(filePath, 'utf-8');
    });

    // Window Controls
    ipcMain.on('window:minimize', (event) => {
        const win = BrowserWindow.fromWebContents(event.sender);
        win?.minimize();
    });

    ipcMain.on('window:maximize', (event) => {
        const win = BrowserWindow.fromWebContents(event.sender);
        win?.maximize();
    });

    ipcMain.on('window:unmaximize', (event) => {
        const win = BrowserWindow.fromWebContents(event.sender);
        win?.unmaximize();
    });

    ipcMain.on('window:close', (event) => {
        const win = BrowserWindow.fromWebContents(event.sender);
        win?.close();
    });

    ipcMain.on('window:open-dev-tools', (event) => {
        const win = BrowserWindow.fromWebContents(event.sender);
        win?.webContents.openDevTools();
    });

    ipcMain.handle('window:is-maximized', (event) => {
        const win = BrowserWindow.fromWebContents(event.sender);
        return win?.isMaximized() || false;
    });

    // App Info
    ipcMain.handle('app:get-version', async () => {
        try {
            const version = app.getVersion();
            // In dev mode, app.getVersion() may return wrong value
            if (version && version !== '0.0.0') {
                return version;
            }
            // Fallback: read from package.json
            const fs = await import('node:fs/promises');
            const pkgPath = path.join(process.env.APP_ROOT || '.', 'package.json');
            const pkg = JSON.parse(await fs.readFile(pkgPath, 'utf-8'));
            return pkg.version || 'Unknown';
        } catch {
            return 'Unknown';
        }
    });

    ipcMain.handle('shell:open-external', async (_, url: string) => {
        return shell.openExternal(url);
    });

    ipcMain.handle('app:show-logs', async () => {
        // electron-log default path on Windows is %AppData%\<app-name>\logs\main.log
        const logPath = path.join(app.getPath('userData'), 'logs', 'main.log');
        if (fs.existsSync(logPath)) {
            shell.showItemInFolder(logPath);
            return { success: true };
        } else {
            // Fallback to logs folder if file doesn't exist yet
            const logsFolder = path.join(app.getPath('userData'), 'logs');
            if (fs.existsSync(logsFolder)) {
                shell.openPath(logsFolder);
                return { success: true };
            }
        }
        return { success: false, error: 'Log file not found' };
    });
}

function parseCSV(content: string): string[][] {
    const rows: string[][] = [];
    let currentRow: string[] = [];
    let currentField = '';
    let inQuotes = false;

    for (let i = 0; i < content.length; i++) {
        const char = content[i];
        const nextChar = content[i + 1];

        if (char === '"') {
            if (inQuotes && nextChar === '"') {
                currentField += '"';
                i++;
            } else {
                inQuotes = !inQuotes;
            }
        } else if (char === ',' && !inQuotes) {
            currentRow.push(currentField);
            currentField = '';
        } else if ((char === '\n' || (char === '\r' && nextChar === '\n')) && !inQuotes) {
            if (char === '\r') i++;
            currentRow.push(currentField);
            if (currentRow.some(f => f.trim().length > 0)) {
                rows.push(currentRow);
            }
            currentRow = [];
            currentField = '';
        } else if (char === '\r' && !inQuotes) {
            currentRow.push(currentField);
            if (currentRow.some(f => f.trim().length > 0)) {
                rows.push(currentRow);
            }
            currentRow = [];
            currentField = '';
        } else {
            currentField += char;
        }
    }

    currentRow.push(currentField);
    if (currentRow.some(f => f.trim().length > 0)) {
        rows.push(currentRow);
    }

    return rows;
}

function jiraCommentToPlainText(comment: unknown): string {
    if (!comment) return '';
    if (typeof comment === 'string') return comment.trim();

    const parts: string[] = [];

    const walk = (node: unknown) => {
        if (!node || typeof node !== 'object') return;

        const record = node as { text?: unknown; content?: unknown; type?: unknown };
        if (typeof record.text === 'string') {
            parts.push(record.text);
        }

        if (Array.isArray(record.content)) {
            for (const child of record.content) {
                walk(child);
            }

            if (record.type === 'paragraph') {
                parts.push('\n');
            }
        }
    };

    walk(comment);

    return parts
        .join('')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

function runMigrations(db: Database.Database) {
    console.log('[Migration] Checking for date format standardization...');
    try {
        const slices = db.prepare('SELECT id, start_time, end_time FROM time_slices').all() as { id: number, start_time: string, end_time: string | null }[];
        const updateStmt = db.prepare('UPDATE time_slices SET start_time = ?, end_time = ? WHERE id = ?');

        let updateCount = 0;

        db.transaction(() => {
            for (const slice of slices) {
                const newStart = standardizeDate(slice.start_time);
                const newEnd = standardizeDate(slice.end_time);

                if (newStart || newEnd) {
                    const finalStart = newStart || slice.start_time;
                    const finalEnd = newEnd || slice.end_time;
                    updateStmt.run(finalStart, finalEnd, slice.id);
                    updateCount++;
                }
            }
        })();

        if (updateCount > 0) {
            console.log(`[Migration] Standardized ${updateCount} time slices.`);
        }
    } catch (e) {
        console.error('[Migration] Failed to run date standardization:', e);
    }
}

function standardizeDate(dateStr: string | null) {
    if (!dateStr) return null;

    // date-fns parseISO is good for standard ISO
    // But we use new Date() as a fallback for missing offsets or Z
    const date = new Date(dateStr);
    if (isNaN(date.getTime())) return null;

    const standardized = normalizeTimeSliceBoundary(formatISO(date));
    if (standardized !== dateStr) {
        return standardized;
    }
    return null;
}
