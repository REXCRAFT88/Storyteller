const fs = require('fs');
const vm = require('vm');
const html = fs.readFileSync('index.html', 'utf8');
const scriptRegex = /<script>([\s\S]*?)<\/script>/gi;
let match;
let errors = 0;
while ((match = scriptRegex.exec(html)) !== null) {
    try {
        new vm.Script(match[1]);
    } catch (e) {
        console.error("Syntax Error found in script block!");
        console.error(e.message);

        // Find line number approximate
        const errLines = match[1].split('\n').map((l, i) => (i + 1) + ': ' + l);
        // We won't print it all, just the error
        errors++;
    }
}
if (errors === 0) {
    console.log("All script blocks parsed successfully!");
} else {
    console.log("Total syntax errors: " + errors);
}
