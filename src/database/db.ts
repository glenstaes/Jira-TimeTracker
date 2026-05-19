import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';

import { getAppConfig } from '../../electron/config-service';

// This file should ONLY be imported by the Main process

let db: Database.Database | null = null;

export function initializeDatabase(customPath?: string): Database.Database {
  if (db) return db;

  const config = getAppConfig();
  const dbPath = customPath || config.databasePath;

  // Ensure directory exists
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  db = new Database(dbPath);

  // Enable WAL mode for better performance
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // Initialize schema
  initSchema(db);

  return db;
}

function initSchema(database: Database.Database) {
  // const schemaPath = path.resolve(__dirname, '../../src/database/schema.sql');
  // Note: logic to read schema file might need adjustment depending on build (bundled vs file)
  // For simplicity, we define schema in code or read from bundled asset
  // Since we are creating this file in src/database, let's embed schema here or read it.

  // Actually, reading from file in bundled app is tricky. 
  // Better to use a string constant or imports. 
  // But for now, let's assume we read the SQL file if possible, or copy content.
  // I will embed the schema content here for reliability in Electron production builds.

  const schema = `
    CREATE TABLE IF NOT EXISTS jira_connections (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      base_url TEXT NOT NULL,
      email TEXT NOT NULL,
      api_token TEXT NOT NULL,
      is_default INTEGER DEFAULT 0,
      color TEXT,
      is_enabled INTEGER DEFAULT 1,
      created_at INTEGER DEFAULT (unixepoch()),
      updated_at INTEGER DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS work_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      jira_connection_id INTEGER,
      jira_key TEXT,
      description TEXT NOT NULL,
      is_completed INTEGER DEFAULT 0,
      created_at INTEGER DEFAULT (unixepoch()),
      updated_at INTEGER DEFAULT (unixepoch()),
      FOREIGN KEY (jira_connection_id) REFERENCES jira_connections(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS time_slices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      work_item_id INTEGER NOT NULL,
      start_time TEXT NOT NULL,
      end_time TEXT,
      notes TEXT,
      synced_to_jira INTEGER DEFAULT 0,
      jira_worklog_id TEXT,
      synced_start_time TEXT,
      synced_end_time TEXT,
      synced_notes TEXT,
      created_at INTEGER DEFAULT (unixepoch()),
      updated_at INTEGER DEFAULT (unixepoch()),
      FOREIGN KEY (work_item_id) REFERENCES work_items(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER DEFAULT (unixepoch())
    );
  `;

  database.exec(schema);
  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_time_slices_jira_worklog_id
    ON time_slices(jira_worklog_id)
    WHERE jira_worklog_id IS NOT NULL;
  `);

  // Run migrations for existing databases
  runMigrations(database);
}

function runMigrations(database: Database.Database) {
  // Migration: Add synced_start_time, synced_end_time, synced_notes columns if they don't exist
  try {
    // Check if columns exist by trying to select them
    database.prepare('SELECT synced_start_time FROM time_slices LIMIT 1').get();
  } catch {
    // Columns don't exist, add them
    console.log('Running migration: Adding synced_start_time and synced_end_time columns');
    database.exec(`
      ALTER TABLE time_slices ADD COLUMN synced_start_time TEXT;
      ALTER TABLE time_slices ADD COLUMN synced_end_time TEXT;
    `);
    console.log('Migration completed successfully');
  }

  try {
    database.prepare('SELECT synced_notes FROM time_slices LIMIT 1').get();
  } catch {
    console.log('Running migration: Adding synced_notes column');
    database.exec(`
      ALTER TABLE time_slices ADD COLUMN synced_notes TEXT;
    `);
    console.log('Migration completed successfully');
  }

  // Migration: Add is_completed column to work_items
  try {
    database.prepare('SELECT is_completed FROM work_items LIMIT 1').get();
  } catch {
    console.log('Running migration: Adding is_completed column to work_items');
    database.exec(`
      ALTER TABLE work_items ADD COLUMN is_completed INTEGER DEFAULT 0;
    `);
    console.log('Migration completed successfully');
  }

  // Migration: Add unique index on (jira_connection_id, jira_key) - only where jira_key is not null
  try {
    // Check if index exists
    const indexExists = database.prepare(`
      SELECT name FROM sqlite_master 
      WHERE type='index' AND name='idx_work_items_jira_unique'
    `).get();

    if (!indexExists) {
      console.log('Running migration: Adding unique index on (jira_connection_id, jira_key)');

      // First, find and remove duplicates (keep the one with time slices, or the oldest)
      const duplicates = database.prepare(`
        SELECT jira_connection_id, jira_key, COUNT(*) as cnt
        FROM work_items
        WHERE jira_key IS NOT NULL
        GROUP BY jira_connection_id, jira_key
        HAVING COUNT(*) > 1
      `).all() as { jira_connection_id: number, jira_key: string, cnt: number }[];

      for (const dup of duplicates) {
        console.log(`Found duplicate: ${dup.jira_key} (${dup.cnt} occurrences)`);

        // Get all work items for this duplicate, ordered by: has time slices first, then by id
        const workItems = database.prepare(`
          SELECT wi.id, 
                 (SELECT COUNT(*) FROM time_slices ts WHERE ts.work_item_id = wi.id) as slice_count
          FROM work_items wi
          WHERE wi.jira_connection_id = ? AND wi.jira_key = ?
          ORDER BY slice_count DESC, wi.id ASC
        `).all(dup.jira_connection_id, dup.jira_key) as { id: number, slice_count: number }[];

        // Keep the first one (has most time slices or is oldest), delete the rest
        const [keep, ...remove] = workItems;
        console.log(`Keeping work item ${keep.id} (${keep.slice_count} time slices)`);

        for (const item of remove) {
          if (item.slice_count === 0) {
            database.prepare('DELETE FROM work_items WHERE id = ?').run(item.id);
            console.log(`Deleted duplicate work item ${item.id}`);
          } else {
            console.warn(`Cannot delete work item ${item.id} - has ${item.slice_count} time slices`);
          }
        }
      }

      // Now create the unique index
      database.exec(`
        CREATE UNIQUE INDEX idx_work_items_jira_unique 
        ON work_items(jira_connection_id, jira_key) 
        WHERE jira_key IS NOT NULL;
      `);
      console.log('Migration completed successfully');
    }
  } catch (error) {
    console.error('Failed to create unique index:', error);
  }
  // Migration: Add color and is_enabled columns to jira_connections
  try {
    database.prepare('SELECT color FROM jira_connections LIMIT 1').get();
  } catch {
    console.log('Running migration: Adding color and is_enabled columns to jira_connections');
    database.exec(`
      ALTER TABLE jira_connections ADD COLUMN color TEXT;
      ALTER TABLE jira_connections ADD COLUMN is_enabled INTEGER DEFAULT 1;
    `);
    console.log('Migration completed successfully');
  }

  // Migration: Add OAuth columns to jira_connections
  try {
    database.prepare('SELECT auth_type FROM jira_connections LIMIT 1').get();
  } catch {
    console.log('Running migration: Adding OAuth columns to jira_connections');
    database.exec(`
      ALTER TABLE jira_connections ADD COLUMN auth_type TEXT DEFAULT 'api_token';
      ALTER TABLE jira_connections ADD COLUMN client_id TEXT;
      ALTER TABLE jira_connections ADD COLUMN client_secret_encrypted TEXT;
      ALTER TABLE jira_connections ADD COLUMN access_token_encrypted TEXT;
      ALTER TABLE jira_connections ADD COLUMN refresh_token_encrypted TEXT;
      ALTER TABLE jira_connections ADD COLUMN token_expires_at INTEGER;
      ALTER TABLE jira_connections ADD COLUMN cloud_id TEXT;
    `);
    console.log('Migration completed successfully');
  }

  try {
    const worklogIndexExists = database.prepare(`
      SELECT name FROM sqlite_master
      WHERE type='index' AND name='idx_time_slices_jira_worklog_id'
    `).get();

    if (!worklogIndexExists) {
      console.log('Running migration: Adding index on jira_worklog_id');
      database.exec(`
        CREATE INDEX idx_time_slices_jira_worklog_id
        ON time_slices(jira_worklog_id)
        WHERE jira_worklog_id IS NOT NULL;
      `);
      console.log('Migration completed successfully');
    }
  } catch (error) {
    console.error('Failed to create jira_worklog_id index:', error);
  }
}

export function getDatabase(): Database.Database {
  if (!db) {
    throw new Error('Database not initialized');
  }
  return db;
}
