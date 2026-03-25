const fs = require('fs');
let html = fs.readFileSync('index.html', 'utf8');

// 1. Remove the Syntax Error (\n) and the corrupted jsInjection 
// The corrupted jsInjection spans from // ===== ACTIVE SOUNDS TRACKER ===== // to // ===== BACKGROUND KEEP-ALIVE HACK ===== //
html = html.replace(/\/\/ ===== ACTIVE SOUNDS TRACKER ===== \/\/([\s\S]*?)\/\/ ===== BACKGROUND KEEP-ALIVE HACK ===== \/\//, '// ===== BACKGROUND KEEP-ALIVE HACK ===== //');
// Also clean up any lingering "\n    " text nearby
html = html.replace(/\\n\s*\/\/ ===== BACKGROUND KEEP-ALIVE HACK ===== \/\//g, '\n// ===== BACKGROUND KEEP-ALIVE HACK ===== //');

// 2. Re-inject the correct JavaScript, without using String.prototype.replace which corrupts '$' tokens
const jsInjection = `
// ===== ACTIVE SOUNDS TRACKER ===== //
function updateActiveSoundsUI() {
    const container = document.getElementById('activeSoundsListContainer');
    if (!container) return;
    
    const longSounds = [];
    if (typeof activeSounds !== 'undefined') {
        Object.keys(activeSounds).forEach(pageId => {
            const sd = activeSounds[pageId];
            let duration = Infinity;
            let isShort = false;
            
            if (sd.sourceDetail) {
                if (sd.sourceDetail.type === 'file' && sd.node && sd.node.buffer) {
                    duration = sd.node.buffer.duration;
                    if (duration < 5 && (!sd.page || !sd.page.loop)) isShort = true;
                } else if (sd.sourceDetail.type === 'youtube' && sd.youtubePlayer && typeof sd.youtubePlayer.getDuration === 'function') {
                    duration = sd.youtubePlayer.getDuration() || Infinity;
                    if (sd.sourceDetail.endTime && sd.sourceDetail.startTime) {
                        duration = sd.sourceDetail.endTime - sd.sourceDetail.startTime;
                    }
                    if (duration < 5) isShort = true;
                } else if (sd.sourceDetail.type === 'syrinscape') {
                    if (sd.sourceDetail.syrinscapePlayDuration) {
                        duration = parseFloat(sd.sourceDetail.syrinscapePlayDuration);
                        if (duration < 5) isShort = true;
                    } else if (sd.sourceDetail.syrinscapeKind && (sd.sourceDetail.syrinscapeKind.includes('oneshot') || sd.sourceDetail.syrinscapeKind.includes('element'))) {
                        isShort = true;
                    }
                }
            }
            
            if (!isShort) {
                const title = window.book ? (window.book.pages.find(p => p.id == pageId)?.title || 'Unknown Sound') : 'Unknown';
                longSounds.push({ id: pageId, title: title, isSt: false });
            }
        });
    }

    if (typeof activeSoundtrackId !== 'undefined' && activeSoundtrackId && typeof isStPlaying !== 'undefined' && isStPlaying) {
        const st = window.book ? window.book.soundtracks.find(s => s.id == activeSoundtrackId) : null;
        if (st) {
            longSounds.push({ id: activeSoundtrackId, title: st.name + ' (Playlist)', isSt: true });
        }
    }

    if (longSounds.length === 0) {
        container.style.display = 'none';
        container.innerHTML = '';
        return;
    }

    container.style.display = 'flex';
    container.style.flexDirection = 'column';
    container.style.gap = '0.5rem';

    let htmlStr = '<div class="text-[0.65rem] font-bold text-gray-400 mb-1 uppercase tracking-widest pl-1">Active Audio</div>';
    htmlStr += '<ul class="space-y-1.5 flex-grow overflow-y-auto max-h-[15vh] w-full">';
    
    longSounds.forEach(sound => {
        // Build the string safely without string template literal nesting to avoid any JS evaluation bugs during injection
        htmlStr += '<li class="flex justify-between items-center bg-black/40 border border-stone-700/60 rounded px-2 py-1.5 text-sm text-stone-300 hover:border-stone-500 transition-colors">';
        htmlStr += '<span class="truncate pr-2 text-xs font-semibold" style="max-width: 155px;" title="' + sound.title + '">' + sound.title + '</span>';
        
        const clickAction = sound.isSt ? 'stopSoundtrack()' : 'stopSingleSound(' + sound.id + ')';
        htmlStr += '<button class="text-red-400 hover:text-red-500 cursor-pointer ml-1 flex-shrink-0 transition-transform hover:scale-110 active:scale-95" onclick="' + clickAction + '">';
        htmlStr += '<i class="fas fa-stop-circle"></i></button></li>';
    });
    
    htmlStr += '</ul>';
    container.innerHTML = htmlStr;
}

// Start tracking loop
setInterval(updateActiveSoundsUI, 1000);
`;

html = html.split('// ===== BACKGROUND KEEP-ALIVE HACK ===== //').join(jsInjection + '\n// ===== BACKGROUND KEEP-ALIVE HACK ===== //');

// 3. Move the Active Sounds List Container HTML to right above the book/search logic
// Step A: Extract container from wherever it is.
let activeSoundsBox = '';
html = html.replace(/<div id="activeSoundsListContainer"[\s\S]*?<\/div>/, match => {
    activeSoundsBox = match;
    return '';
});

// Reconstruct container HTML for safety in case old one got mangled
activeSoundsBox = `
<!-- Active Sounds UI Container -->
<div id="activeSoundsListContainer" class="w-64 flex-shrink-0 bg-black/50 p-2 rounded-lg border border-stone-700 shadow-md" style="display: none; height: fit-content; max-height: 20vh;"></div>
`;

// Insert it into the header controls area
// The app has a flex container for controls:
// <div class="controls-container flex flex-wrap justify-between items-center mb-4 gap-4">
// Let's find exactly that element and insert our UI box as the first child of this container.
const controlsContainerAnchor = '<div class="controls-container flex flex-wrap justify-between items-center mb-4 gap-4">';
if (html.includes(controlsContainerAnchor)) {
    html = html.split(controlsContainerAnchor).join(controlsContainerAnchor + '\n' + activeSoundsBox);
} else {
    // Fallback: look for the golden border wrapper itself and insert it right after the opening div
    const appContainerRegex = /(<div[^>]*class="[^"]*app-container[^"]*"[^>]*>)/i;
    if (appContainerRegex.test(html)) {
        html = html.replace(appContainerRegex, '$1\n' + activeSoundsBox);
    } else {
        // Last resort: top of body
        html = html.replace(/<body[^>]*>/i, match => match + '\n' + activeSoundsBox);
    }
}

fs.writeFileSync('index.html', html, 'utf8');
console.log('Script injection logic rewritten and applied cleanly!');
