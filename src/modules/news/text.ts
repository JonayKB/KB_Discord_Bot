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

/** Sustituye lo que solo Discord sabe resolver (menciones, emojis propios, comandos y fechas). */
function resolveReferences(text: string, names: MentionResolver, timeZone: string, wrap: (s: string) => string): string {
    return text
        .replace(/<@!?(\d+)>/g, (_m, id: string) => wrap(`@${names.user(id) ?? 'usuario'}`))
        .replace(/<@&(\d+)>/g, (_m, id: string) => wrap(`@${names.role(id) ?? 'rol'}`))
        .replace(/<#(\d+)>/g, (_m, id: string) => wrap(`#${names.channel(id) ?? 'canal'}`))
        .replace(/<a?:(\w+):\d+>/g, (_m, name: string) => wrap(`:${name}:`))
        .replace(/<\/([\w -]+):\d+>/g, (_m, cmd: string) => wrap(`/${cmd}`))
        .replace(/<t:(\d+)(?::[a-zA-Z])?>/g, (_m, ts: string) => wrap(formatTimestamp(ts, timeZone)));
}

/** Conserva el formato para el renderizador del launcher y resuelve solo las referencias, salvo dentro de código. */
export function toMarkdown(input: string, names: MentionResolver, timeZone: string): string {
    const kept: string[] = [];
    const keep = (s: string) => `${OPEN}${kept.push(s) - 1}${CLOSE}`;
    // El launcher no admite escapar `_`: fuera de un límite de palabra, un nombre con `_` podría salir en cursiva.
    const escapeName = (s: string) => s.replace(/[*~`|\\]/g, '\\$&');

    const text = input
        .replace(/\\[^\w\s]/g, keep)
        .replace(/```[\s\S]*?```/g, keep)
        .replace(/`[^`\n]+`/g, keep);

    return resolveReferences(text, names, timeZone, escapeName)
        .replace(new RegExp(`${OPEN}(\\d+)${CLOSE}`, 'g'), (_m, i: string) => kept[Number(i)])
        .trim();
}

/**
 * Convierte el markdown de Discord en texto plano legible: el launcher no interpreta markdown.
 * URLs, código y menciones se apartan con marcadores para que quitar `_` o `*` no los rompa.
 */
export function toPlainText(input: string, names: MentionResolver, timeZone: string): string {
    const kept: string[] = [];
    const keep = (s: string) => `${OPEN}${kept.push(s) - 1}${CLOSE}`;

    const text = resolveReferences(input
        .replace(/\\([*_~`|>#\\-])/g, (_m, c: string) => keep(c))
        .replace(/```(?:[\w+-]*\n)?([\s\S]*?)```/g, (_m, code: string) => keep(code.replace(/\n$/, '')))
        .replace(/`([^`\n]+)`/g, (_m, code: string) => keep(code))
        .replace(/<(https?:\/\/[^\s>]+)>/g, '$1')
        .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_m, label: string, url: string) =>
            label === url ? keep(url) : `${label}: ${keep(url)}`)
        .replace(/https?:\/\/[^\s<>]+/g, url => {
            const core = url.replace(/[*_~|]+$/, '');
            return keep(core) + url.slice(core.length);
        }), names, timeZone, keep)
        .replace(/^-#\s+/gm, '')
        .replace(/^#{1,3}\s+/gm, '')
        .replace(/^>>>\s?/gm, '')
        .replace(/^>\s?/gm, '')
        // Como en Discord, el cierre de **, __ y ~~ admite un espacio antes.
        .replace(/\*\*\*(?=\S)([\s\S]+?)\*\*\*/g, '$1')
        .replace(/\*\*(?=\S)([\s\S]+?)\*\*/g, '$1')
        .replace(/\*(?=[^\s*])([^*\n]*?[^\s*])\*/g, '$1')
        .replace(/__(?=\S)([\s\S]+?)__/g, '$1')
        .replace(/(?<![\p{L}\p{N}_])_(?=[^\s_])([^_\n]*?[^\s_])_(?![\p{L}\p{N}_])/gu, '$1')
        .replace(/~~(?=\S)([\s\S]+?)~~/g, '$1')
        .replace(/\|\|([\s\S]+?)\|\|/g, '$1');

    return text
        .replace(new RegExp(`${OPEN}(\\d+)${CLOSE}`, 'g'), (_m, i: string) => kept[Number(i)])
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}
