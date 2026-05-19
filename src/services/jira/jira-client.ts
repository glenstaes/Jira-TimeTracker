import axios, { AxiosInstance } from 'axios';
import { format } from 'date-fns';
import type { JiraIssue, JiraUser, JiraWorklog } from './jira-types';

// Configuration for API Token authentication (Basic Auth)
export interface JiraApiTokenConfig {
    baseUrl: string;
    email: string;
    apiToken: string;
}

// Configuration for OAuth authentication (Bearer Token)
export interface JiraOAuthConfig {
    cloudId: string;
    accessToken: string;
}

// Union type for all config options
export type JiraConfig = JiraApiTokenConfig | JiraOAuthConfig;

// Type guard to check if config is OAuth
export function isOAuthConfig(config: JiraConfig): config is JiraOAuthConfig {
    return 'cloudId' in config && 'accessToken' in config;
}

export class JiraClient {
    private client: AxiosInstance;

    constructor(config: JiraConfig) {
        if (isOAuthConfig(config)) {
            // OAuth configuration - uses Atlassian API with Bearer token
            this.client = axios.create({
                baseURL: `https://api.atlassian.com/ex/jira/${config.cloudId}/rest/api/3`,
                headers: {
                    'Authorization': `Bearer ${config.accessToken}`,
                    'Content-Type': 'application/json'
                }
            });
        } else {
            // API Token configuration - uses direct Jira URL with Basic Auth
            let baseUrl = config.baseUrl;
            // Enforce HTTPS for atlassian.net domains
            if (baseUrl.includes('atlassian.net') && !baseUrl.startsWith('https://')) {
                baseUrl = baseUrl.replace(/^http:\/\//, 'https://');
            }

            this.client = axios.create({
                baseURL: `${baseUrl}/rest/api/3`,
                auth: {
                    username: config.email,
                    password: config.apiToken
                },
                headers: {
                    'Content-Type': 'application/json'
                }
            });
        }
    }

    async searchIssues(jql: string): Promise<JiraIssue[]> {
        return this.searchIssuesPaginated(jql, ['summary'], 20);
    }

    async searchIssuesByWorklogDateRange(startDate: string, endDate: string, authorAccountId: string): Promise<JiraIssue[]> {
        const start = format(new Date(startDate), 'yyyy/MM/dd');
        const end = format(new Date(endDate), 'yyyy/MM/dd');
        const escapedAccountId = authorAccountId.replace(/"/g, '\\"');
        const jql = `worklogAuthor = "${escapedAccountId}" AND worklogDate >= "${start}" AND worklogDate <= "${end}" ORDER BY updated DESC`;
        return this.searchIssuesPaginated(jql, ['summary'], 100);
    }

    private async searchIssuesPaginated(jql: string, fields: string[], pageSize: number): Promise<JiraIssue[]> {
        try {
            console.log(`[JiraClient] Searching with JQL: ${jql}`);
            const issues: JiraIssue[] = [];
            let nextPageToken: string | undefined;
            let isLast = false;

            do {
                const response = await this.client.get<{
                    issues?: JiraIssue[];
                    nextPageToken?: string;
                    isLast?: boolean;
                }>('/search/jql', {
                    params: {
                        jql,
                        maxResults: pageSize,
                        fields,
                        nextPageToken,
                    },
                });

                const batch = response.data.issues || [];
                issues.push(...batch);
                nextPageToken = response.data.nextPageToken;
                isLast = response.data.isLast ?? !nextPageToken;
            } while (!isLast && nextPageToken);

            return issues;
        } catch (error: unknown) {
            const err = error as { config?: { method?: string; baseURL?: string; url?: string }; message?: string; response?: { status?: number; data?: unknown } };
            console.error(`Jira search failed [${err.config?.method?.toUpperCase()} ${err.config?.baseURL}${err.config?.url}]:`, err.message);
            if (err.response) {
                console.error('Response status:', err.response.status);
                console.error('Response data:', JSON.stringify(err.response.data, null, 2));
            }
            throw error;
        }
    }

    async getData<T = unknown>(path: string): Promise<T> {
        return (await this.client.get(path)).data;
    }

    async getWorklogs(issueIdOrKey: string): Promise<JiraWorklog[]> {
        try {
            const worklogs: JiraWorklog[] = [];
            let startAt = 0;
            let total = 0;

            do {
                const response = await this.client.get<{
                    worklogs: JiraWorklog[];
                    startAt?: number;
                    maxResults?: number;
                    total?: number;
                }>(`/issue/${issueIdOrKey}/worklog`, {
                    params: {
                        startAt,
                        maxResults: 100,
                    },
                });

                const batch = response.data.worklogs || [];
                total = response.data.total || batch.length;
                worklogs.push(...batch);
                startAt += response.data.maxResults || batch.length;
            } while (startAt < total);

            return worklogs;
        } catch (error) {
            console.error('Failed to get worklogs:', error);
            throw error;
        }
    }

    async addWorklog(issueIdOrKey: string, worklog: {
        comment?: string;
        started: string; // ISO 8601
        timeSpentSeconds: number;
    }): Promise<JiraWorklog> {
        try {
            const startedDate = new Date(worklog.started);
            const formattedStarted = format(startedDate, "yyyy-MM-dd'T'HH:mm:ss.SSSXXXX");
            const timeSpentSeconds = Math.max(60, worklog.timeSpentSeconds);

            const payload: { started: string; timeSpentSeconds: number; comment?: { version: number; type: string; content: { type: string; content: { type: string; text: string }[] }[] } } = {
                started: formattedStarted,
                timeSpentSeconds: timeSpentSeconds,
            };

            if (worklog.comment) {
                payload.comment = {
                    version: 1,
                    type: "doc",
                    content: [
                        {
                            type: "paragraph",
                            content: [
                                {
                                    type: "text",
                                    text: worklog.comment
                                }
                            ]
                        }
                    ]
                };
            }

            const response = await this.client.post<JiraWorklog>(`/issue/${issueIdOrKey}/worklog`, payload);
            return response.data;
        } catch (error: unknown) {
            const err = error as { response?: { status?: number; data?: unknown }; message?: string };
            console.error('Failed to add worklog:', err);
            if (err.response) {
                console.error('Response status:', err.response.status);
                console.error('Response data:', JSON.stringify(err.response.data, null, 2));
            }
            throw error;
        }
    }

    async updateWorklog(issueIdOrKey: string, worklogId: string, worklog: {
        comment?: string;
        started: string;
        timeSpentSeconds: number;
    }): Promise<JiraWorklog> {
        try {
            const startedDate = new Date(worklog.started);
            const formattedStarted = format(startedDate, "yyyy-MM-dd'T'HH:mm:ss.SSSXXXX");
            const timeSpentSeconds = Math.max(60, worklog.timeSpentSeconds);

            const payload: { started: string; timeSpentSeconds: number; comment?: { version: number; type: string; content: { type: string; content: { type: string; text: string }[] }[] } } = {
                started: formattedStarted,
                timeSpentSeconds: timeSpentSeconds,
            };

            if (worklog.comment) {
                payload.comment = {
                    version: 1,
                    type: "doc",
                    content: [
                        {
                            type: "paragraph",
                            content: [
                                {
                                    type: "text",
                                    text: worklog.comment
                                }
                            ]
                        }
                    ]
                };
            }

            console.log(`[JiraClient] Updating worklog ${worklogId} on ${issueIdOrKey}`);
            const response = await this.client.put<JiraWorklog>(`/issue/${issueIdOrKey}/worklog/${worklogId}`, payload);
            return response.data;
        } catch (error: unknown) {
            const err = error as { response?: { status?: number; data?: unknown }; message?: string };
            console.error(`[JiraClient] Failed to update worklog ${worklogId}:`, err);
            if (err.response) {
                console.error('Response status:', err.response.status);
                console.error('Response data:', JSON.stringify(err.response.data, null, 2));
            }
            throw error;
        }
    }

    async getCurrentUser(): Promise<JiraUser> {
        try {
            return await this.getData('/myself');
        } catch (error) {
            console.error('Failed to get current user:', error);
            throw error;
        }
    }
}
