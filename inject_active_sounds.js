const fs = require('fs');
let html = fs.readFileSync('index.html', 'utf8');

const uiHtml = `
    <!-- Active Sounds UI (Top Left) -->
    <div id="activeSoundsListContainer" style="position: fixed; top: 70px; left: 10px; z-index: 1000; max-height: 40vh; overflow-y: auto; display: none; width: 220px; background: rgba(20,20,20,0.85); padding: 8px; border-radius: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.7); backdrop-filter: blur(4px); border: 1px solid var(--border-stone);">
    </div>
`;
if (!html.includes('id="activeSoundsListContainer"')) {
    html = html.replace('</body>', uiHtml + '\n</body>');
}

const jsInjection = `
// ===== ACTIVE SOUNDS TRACKER ===== //
function updateActiveSoundsUI() {
    const container = document.getElementById('activeSoundsListContainer');
    if (!container) return;
    
    const longSounds = [];
    if (typeof activeSounds !== 'undefined') {
        Object.keys(activeSounds).forEach(pageId => {
            const sd = activeSounds[pageId];
            let duration = Infinity; // Default to indefinite (ambient)
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
                        isShort = true; // Syrinscape oneshots are assumed short unless duration is explicitly >= 5
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

    container.style.display = 'block';
    let htmlStr = '<div class="text-[0.65rem] font-bold text-gray-400 mb-1.5 uppercase tracking-widest pl-1">Active Audio</div>';
    htmlStr += '<ul class="space-y-1.5">';
    
    longSounds.forEach(sound => {
        htmlStr += \`
            <li class="flex justify-between items-center bg-black/40 border border-stone-700/60 rounded px-2 py-1.5 text-sm text-stone-300 hover:border-stone-500 transition-colors">
                <span class="truncate pr-2 text-xs font-semibold" style="max-width: 155px;" title="\${sound.title}">\${sound.title}</span>
                <button class="text-red-400 hover:text-red-500 cursor-pointer ml-1 flex-shrink-0 transition-transform hover:scale-110 active:scale-95" onclick="\${sound.isSt ? 'stopSoundtrack()' : 'stopSingleSound(' + sound.id + ')'}">
                    <i class="fas fa-stop-circle"></i>
                </button>
            </li>
        \`;
    });
    
    htmlStr += '</ul>';
    container.innerHTML = htmlStr;
}

// Start tracking loop
setInterval(updateActiveSoundsUI, 1000);
`;

if (!html.includes('updateActiveSoundsUI(')) {
    html = html.replace('// --- Initial Setup ---', jsInjection + '\\n    // --- Initial Setup ---');
}

fs.writeFileSync('index.html', html, 'utf8');
console.log('Active sounds tracker injected.');
