const fs = require('fs');
let html = fs.readFileSync('index.html', 'utf8');

// 1. Relocate Active Sounds List
// First, extract the existing container
let activeSoundsBlock = '';
html = html.replace(/<div id="activeSoundsListContainer"[\s\S]*?<\/div>\s*/, match => {
    activeSoundsBlock = match;
    return ''; // Remove from fixed position at bottom
});

// Strip out fixed positioning and setup flex styling so it sits inline
activeSoundsBlock = activeSoundsBlock.replace(/style="position: fixed;.*?;"/, 'class="mb-4" style="max-height: 15vh; overflow-y: auto; width: 100%; background: rgba(20,20,20,0.85); padding: 8px; border-radius: 8px; border: 1px solid var(--border-stone);"');

// Find the insertion point: inside the golden border container, before the content
// Look for the controls container or the app-container start
const appContainerRegex = /(<div class="[^"]*app-container[^"]*">)([\s\S]*?)(<div class="[^"]*controls-container[^"]*"|<div class="flex justify-end|<header|<div class="flex flex-wrap)/i;
if (appContainerRegex.test(html)) {
    html = html.replace(appContainerRegex, (match, p1, p2, p3) => {
        return p1 + p2 + '\n' + activeSoundsBlock + '\n' + p3;
    });
} else {
    // Fallback: Just insert it right after the body start
    html = html.replace(/<body[^>]*>/, match => match + '\n' + activeSoundsBlock);
}

// 2. Fix the Soundtracks Button click event
// Convert the button to use direct onclick
if (html.includes('id="openManageSoundtracksButton"')) {
    html = html.replace(/<button id="openManageSoundtracksButton"/g, '<button id="openManageSoundtracksButton" onclick="openManageSoundtracksModal()"');
}

// Rewrite the JS handler to be an explicit window function, removing the setInterval wrapper completely
html = html.replace(/const triggerMenuBtnInterval = setInterval\(\(\) => {[\s\S]*?btn\.addEventListener\('click', \(\) => {/m, 'window.openManageSoundtracksModal = function() {');
html = html.replace(/}\);\s*clearInterval\(triggerMenuBtnInterval\);\s*}\s*}, 1000\);/m, '}');

// Also need to make sure we remove any remnants of the old listener setup if the regex varied slightly
// Wait, the regex `const triggerMenuBtnInterval = ...` should perfectly match what we saw earlier.

// 3. Fix Modal CSS max-width issue which might be causing it to hide or constrain incorrectly
html = html.replace(/<div id="manageSoundtracksModal" class="modal" style="max-width: 800px; z-index: 1045;">\s*<div class="modal-body">/g,
    '<div id="manageSoundtracksModal" class="modal" style="z-index: 1045;">\n        <div class="modal-body" style="max-width: 800px; width: 100%;">');

fs.writeFileSync('index.html', html, 'utf8');
console.log('UI Fixes Applied Successfully!');
