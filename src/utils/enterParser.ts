export function parseEnter(input:string) {
    return input.replace(/\\n/g, '\n').replace(/\\t/g, '\t');
}