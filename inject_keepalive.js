const fs = require('fs');
let html = fs.readFileSync('index.html', 'utf8');

// 1. Inject the Settings UI Toggle
const settingHtml = `
                    <div class="mb-4 bg-stone-900 border border-stone-700 p-2 rounded">
                        <label class="flex items-center space-x-2 cursor-pointer tooltip-container">
                            <input type="checkbox" id="settingKeepAlive" class="form-checkbox text-accent-blue rounded bg-stone-800 border-stone-600">
                            <span class="text-sm font-medium">Enable Background Mode (Keep-Alive)</span>
                            <i class="fas fa-info-circle text-stone-500 text-xs mt-0.5"></i>
                            <span class="tooltip">Plays a silent, invisible audio track to trick your browser into running Speech Recognition and Timers at full speed even when you switch tabs.</span>
                        </label>
                    </div>
`;

// Find where settings are injected. "settingCompoundPhrasing" is a good anchor.
if (!html.includes('id="settingKeepAlive"')) {
    html = html.replace(/(<input type="checkbox" id="settingCompoundPhrasing".*?<\/div>)/is, match => match + '\n' + settingHtml);
}

// 2. Inject the JavaScript Logic
const jsHtml = `
// ===== BACKGROUND KEEP-ALIVE HACK ===== //
let keepAliveAudio = null;
function toggleBackgroundMode(enable) {
    if (enable) {
        if (!keepAliveAudio) {
            // Base64 encoded extremely short silent MP3
            keepAliveAudio = new Audio('data:audio/mp3;base64,//OExAAAAANIAAAAAExBTUUzLjEwMKqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq/');
            keepAliveAudio.loop = true;
            keepAliveAudio.volume = 0.01;
        }
        keepAliveAudio.play().catch(e => console.log("Keep-alive auto-play prevented until user interaction."));
    } else {
        if (keepAliveAudio) {
            keepAliveAudio.pause();
        }
    }
}
`;

if (!html.includes('toggleBackgroundMode(')) {
    html = html.replace('// --- Initial Setup ---', jsHtml + '\n    // --- Initial Setup ---');
}

// 3. Hook into Settings Save/Load
// Find function saveSettings()
const saveHook = `
    const keepAliveEnabled = document.getElementById('settingKeepAlive').checked;
    settings.keepAlive = keepAliveEnabled;
    toggleBackgroundMode(keepAliveEnabled);
`;
if (!html.includes('settings.keepAlive = keepAliveEnabled;')) {
    html = html.replace(/(function saveSettings\(\) \{)([\s\S]*?)(localStorage\.setItem)/, (match, p1, p2, p3) => {
        return p1 + p2 + saveHook + '\n        ' + p3;
    });
}

// Find function loadSettings()
const loadHook = `
            if (settings.keepAlive !== undefined) {
                document.getElementById('settingKeepAlive').checked = settings.keepAlive;
                // Wait for first interaction to start audio, or attempt if resuming
                // We'll hook into start listening or user clicks so it bypasses autoplay policies
                document.body.addEventListener('click', () => {
                    if(document.getElementById('settingKeepAlive').checked) toggleBackgroundMode(true);
                }, { once: true });
            }
`;
if (!html.includes('document.getElementById(\\\'settingKeepAlive\\\').checked = settings.keepAlive;')) {
    html = html.replace(/(function loadSettings\(\) \{[\s\S]*?if \(savedSettings\) \{[\s\S]*?try \{[\s\S]*?const settings = JSON\.parse.*?)(if \(settings\.listeningMode)/, (match, p1, p2) => {
        return p1 + loadHook + '\n                ' + p2;
    });
}


fs.writeFileSync('index.html', html, 'utf8');
console.log('Background Keep-Alive Mode injected.');
