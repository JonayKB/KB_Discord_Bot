export interface MentionResolver {
    user(id: string): string | undefined;
    role(id: string): string | undefined;
    channel(id: string): string | undefined;
}

const OPEN = '';
const CLOSE = '';

function formatTimestamp(seconds: string, timeZone: string): string {
    return new Intl.DateTimeFormat('es-ES', { dateStyle: 'medium', timeStyle: 'short', timeZone }).format(new Date(Number(seconds) * 1000));
}

/**
 * Convierte el markdown de Discord en texto plano legible: el launcher no interpreta markdown.
 * URLs, código y menciones se apartan con marcadores para que quitar `_` o `*` no los rompa.
 */
export function toPlainText(input: string, names: MentionResolver, timeZone: string): string {
    const kept: string[] = [];
    const keep = (s: string) => `${OPEN}${kept.push(s) - 1}${CLOSE}`;

    const text = input
        .replace(/\\([*_~`|>#\\-])/g, (_m, c: string) => keep(c))
        .replace(/```(?:[\w+-]*\n)?([\s\S]*?)```/g, (_m, code: string) => keep(code.replace(/\n$/, '')))
        .replace(/`([^`\n]+)`/g, (_m, code: string) => keep(code))
        .replace(/<(https?:\/\/[^\s>]+)>/g, '$1')
        .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_m, label: string, url: string) =>
            label === url ? keep(url) : `${label}: ${keep(url)}`)
        .replace(/https?:\/\/[^\s<>]+/g, url => {
            const core = url.replace(/[*_~|]+$/, '');
            return keep(core) + url.slice(core.length);
        })
        .replace(/<@!?(\d+)>/g, (_m, id: string) => keep(`@${names.user(id) ?? 'usuario'}`))
        .replace(/<@&(\d+)>/g, (_m, id: string) => keep(`@${names.role(id) ?? 'rol'}`))
        .replace(/<#(\d+)>/g, (_m, id: string) => keep(`#${names.channel(id) ?? 'canal'}`))
        .replace(/<a?:(\w+):\d+>/g, (_m, name: string) => keep(`:${name}:`))
        .replace(/<\/([\w -]+):\d+>/g, (_m, cmd: string) => keep(`/${cmd}`))
        .replace(/<t:(\d+)(?::[a-zA-Z])?>/g, (_m, ts: string) => keep(formatTimestamp(ts, timeZone)))
        .replace(/^-#\s+/gm, '')
        .replace(/^#{1,3}\s+/gm, '')
        .replace(/^>>>\s?/gm, '')
        .replace(/^>\s?/gm, '')
        .replace(/(\*{1,3})(?=\S)([\s\S]*?\S)\1/g, '$2')
        .replace(/(?<![\p{L}\p{N}_])(_{1,2})(?=\S)(.*?\S)\1(?![\p{L}\p{N}_])/gu, '$2')
        .replace(/~~(?=\S)([\s\S]*?\S)~~/g, '$1')
        .replace(/\|\|([\s\S]+?)\|\|/g, '$1');

    return text
        .replace(new RegExp(`${OPEN}(\\d+)${CLOSE}`, 'g'), (_m, i: string) => kept[Number(i)])
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}
