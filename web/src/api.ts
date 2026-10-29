export class ApiError extends Error {
    constructor(public status: number, message: string) {
        super(message);
    }
}

export async function api<T = unknown>(method: string, url: string, body?: unknown): Promise<T> {
    const res = await fetch(`/api${url}`, {
        method,
        credentials: 'same-origin',
        headers: {
            'X-Requested-With': 'kb-panel',
            ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (res.status === 401) window.dispatchEvent(new Event('kb:unauthorized'));
    const text = await res.text();
    let data: unknown = null;
    try { data = text ? JSON.parse(text) : null; } catch { /* no es JSON */ }
    if (!res.ok) {
        const msg = (data as { error?: string } | null)?.error ?? `Error ${res.status}`;
        throw new ApiError(res.status, msg);
    }
    return data as T;
}

export const get = <T,>(url: string) => api<T>('GET', url);
export const post = <T,>(url: string, body?: unknown) => api<T>('POST', url, body ?? {});
export const put = <T,>(url: string, body?: unknown) => api<T>('PUT', url, body ?? {});
export const del = <T,>(url: string) => api<T>('DELETE', url);

export async function uploadFiles(files: File[]): Promise<FileInfo[]> {
    const fd = new FormData();
    for (const f of files) fd.append('files', f, f.name);
    const res = await fetch('/api/files', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'X-Requested-With': 'kb-panel' },
        body: fd,
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new ApiError(res.status, data?.error ?? `Error ${res.status}`);
    return data as FileInfo[];
}

// ───────────────────────────── Tipos compartidos ─────────────────────────────

export interface FileInfo {
    id: string;
    name: string;
    mime: string;
    size: number;
    isImage: boolean;
    url: string;
}

export interface EmbedData {
    title?: string;
    description?: string;
    color?: string;
    footer?: string;
    author?: string;
    thumbnail?: string;
    timestamp?: boolean;
}

export interface Msg {
    id: number;
    direction: 'in' | 'out';
    kind: 'dm' | 'channel';
    userId: string | null;
    userTag: string | null;
    userAvatar: string | null;
    channelId: string | null;
    channelName: string | null;
    content: string;
    embed: EmbedData | null;
    source: string;
    sourceRef: string | null;
    status: 'sent' | 'failed' | 'received';
    error: string | null;
    readAt: number | null;
    createdAt: number;
    files: FileInfo[];
}

export type Target =
    | { type: 'user'; id: string }
    | { type: 'users'; ids: string[] }
    | { type: 'role'; id: string }
    | { type: 'all' }
    | { type: 'channel'; id: string };

export interface Member { id: string; username: string; displayName: string; avatar: string }
export interface Role { id: string; name: string; color: string; members: number; managed: boolean }
export interface Channel { id: string; name: string; category: string | null }

export interface Template {
    id: number;
    name: string;
    content: string;
    embed: EmbedData | null;
    fileIds: string[];
    files: FileInfo[];
    updatedAt: number;
}

export interface ModuleInfo { id: string; name: string; description: string; enabled: boolean; running: boolean; error?: string }

export interface Job {
    id: number;
    name: string;
    enabled: boolean;
    scheduleType: 'cron' | 'interval' | 'once';
    schedule: string;
    startAt: number | null;
    timezone: string | null;
    actionType: 'send_template' | 'send_campaign';
    action: { templateId?: number; target?: Target; campaignId?: number };
    lastRunAt: number | null;
    lastStatus: string | null;
    lastResult: string | null;
    runCount: number;
    nextRunAt: number | null;
    running: boolean;
}

export interface Campaign {
    id: number;
    name: string;
    enabled: boolean;
    title: string;
    description: string;
    color: string;
    confirmLabel: string;
    denyLabel: string;
    inputLabel: string;
    allowDeny: boolean;
    confirmedRoleId: string | null;
    deniedRoleId: string | null;
    excludeRoleIds: string[];
    includeRoleIds: string[];
    inputLong: boolean;
    skipResponded: boolean;
    sendOnJoin: boolean;
    setNickname: boolean;
    nicknameTemplate: string;
    counterTitle: string;
    counterChannelId: string | null;
    counterMessageId: string | null;
    legacy: boolean;
}

export interface Entry {
    id: number;
    campaignId: number;
    userId: string;
    username: string | null;
    displayName: string | null;
    answer: string | null;
    status: 'confirmed' | 'denied';
    reason: string | null;
    createdAt: number;
    updatedAt: number;
    inGuild: boolean;
    hasRole: boolean;
    unresolved: boolean;
}

export interface Status {
    ready: boolean;
    bot: { tag: string; avatar: string } | null;
    guild: { id: string; name: string; icon: string | null; memberCount: number } | null;
    uptimeMs: number;
    wsPingMs: number;
    modules: ModuleInfo[];
    stats: { sent24h: number; failed24h: number; received24h: number; unread: number; activeJobs: number; confirmed: number };
}

export interface LogEntry { ts: string; level: 'debug' | 'info' | 'warn' | 'error'; scope?: string; message: string }

export type ServerKind = 'minecraft' | 'hytale';

export interface ServerStatus {
    serverId: number;
    online: boolean;
    checkedAt: number;
    latencyMs: number | null;
    error: string | null;
    version: string | null;
    motd: string | null;
    playersOnline: number;
    maxPlayers: number;
    players: Array<{ name: string; id?: string; discordId?: string | null; discordName?: string | null }>;
    playerListComplete: boolean;
    tps: { s10: number; m1: number; m5: number; m15: number } | null;
    msptMs: number | null;
    cpu: number | null;
    warnings: string[];
    messageError?: string | null;
}

export interface GameServer {
    id: number;
    name: string;
    type: ServerKind;
    host: string;
    port: number | null;
    apiPort: number | null;
    enabled: boolean;
    linkPlayers: boolean;
    channelId: string | null;
    messageId: string | null;
    createdAt: number;
    status: ServerStatus | null;
}

export type ReactionBehavior = 'toggle' | 'add' | 'remove' | 'reverse' | 'click';

export interface ReactionEntry { id?: number; emoji: string; roleId: string; behavior: ReactionBehavior; label: string }

export interface ReactionPanel {
    id: number;
    name: string;
    enabled: boolean;
    exclusive: boolean;
    channelId: string | null;
    messageId: string | null;
    manageEmbed: boolean;
    title: string;
    description: string;
    color: string;
    showList: boolean;
    legacy: boolean;
    createdAt: number;
    entries: ReactionEntry[];
    /** roleId → motivo por el que el bot no puede gestionarlo */
    problems: Record<string, string>;
}

export interface GuildEmoji { id: string; name: string; animated: boolean; value: string; url: string }

export interface HistoryPoint {
    t: number; up: number; players: number | null; peak: number | null; max: number | null;
    tps: number | null; tpsMin: number | null; mspt: number | null; cpu: number | null; latency: number | null;
}

export interface ServerHistory {
    range: string; from: number; to: number; bucketMs: number; points: HistoryPoint[];
    summary: {
        samples: number; uptime: number | null; peakPlayers: number | null; peakAt: number | null; avgPlayers: number | null;
        avgTps: number | null; minTps: number | null; avgMspt: number | null; avgLatency: number | null;
    };
}

export interface WelcomePayload { content?: string; embed?: EmbedData | null; fileIds?: string[] }
export interface WelcomeMessage { enabled: boolean; channelId?: string | null; payload: WelcomePayload }
export interface WelcomeConfig { dm: WelcomeMessage; channel: WelcomeMessage; goodbye: WelcomeMessage; autoRoleIds: string[]; ignoreBots: boolean }

export type ModAction = 'warn' | 'note' | 'timeout' | 'untimeout' | 'kick' | 'ban' | 'unban';
export type LogEvent = 'messageDelete' | 'messageEdit' | 'memberJoin' | 'memberLeave' | 'roles' | 'nicknames' | 'timeouts' | 'bans' | 'modActions';
export interface ModerationConfig { logChannelId: string | null; log: Record<LogEvent, boolean>; ignoreChannelIds: string[]; dmOnAction: boolean }
export interface ModCase {
    id: number; userId: string; userTag: string | null; action: ModAction; reason: string | null; durationMs: number | null;
    moderatorId: string | null; moderatorName: string | null; source: 'panel' | 'discord'; dmStatus: 'sent' | 'failed' | null; createdAt: number;
}
export interface BanInfo { userId: string; username: string; avatar: string; reason: string | null }
