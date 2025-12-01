module.exports= function parseEnter(input) {
    return input.replace(/\\n/g, '\n').replace(/\\t/g, '\t');
}