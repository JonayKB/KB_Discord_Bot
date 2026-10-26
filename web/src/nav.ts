import { useEffect, useState } from 'react';

const parse = () => location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);

/** Segmentos de la ruta actual (#/inbox/123 → ['inbox', '123']). */
export function useHash(): string[] {
    const [parts, setParts] = useState(parse);
    useEffect(() => {
        const fn = () => setParts(parse());
        window.addEventListener('hashchange', fn);
        return () => window.removeEventListener('hashchange', fn);
    }, []);
    return parts;
}

export const go = (path: string) => { location.hash = `#/${path}`; };
