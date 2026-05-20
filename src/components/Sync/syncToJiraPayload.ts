export function getJiraWorklogComment(notes?: string | null): string {
    if (!notes || notes.trim().length === 0) {
        return "";
    }

    return notes;
}
