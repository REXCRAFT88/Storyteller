const fs = require('fs');
const path = require('path');

const targetFile = path.join(__dirname, 'index.html');
let html = fs.readFileSync(targetFile, 'utf8');

// 1. Inject CSS
const cssToInject = `
    /* Soundtrack System Styles */
    .soundtrack-bar { position: fixed; bottom: 0; left: 0; right: 0; background-color: var(--bg-secondary); border-top: 2px solid var(--accent-gold-dark); box-shadow: 0 -2px 10px rgba(0,0,0,0.5); z-index: 1040; display: flex; align-items: center; justify-content: space-between; padding: 0.5rem 1rem; gap: 1rem; color: var(--text-primary); font-family: 'Inter', sans-serif; transition: transform 0.3s; transform: translateY(100%); }
    .soundtrack-bar.active { transform: translateY(0); }
    .soundtrack-bar .track-info { flex-grow: 1; display: flex; flex-direction: column; overflow: hidden; }
    .soundtrack-bar .track-title { font-weight: bold; color: var(--accent-gold-light); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-size: 1rem; }
    .soundtrack-bar .playlist-name { font-size: 0.75rem; color: var(--text-secondary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .soundtrack-bar .controls { display: flex; align-items: center; gap: 0.5rem; flex-shrink: 0; }
    .soundtrack-bar .volume-control { display: flex; align-items: center; gap: 0.5rem; width: 150px; flex-shrink: 0; }
    .soundtrack-icons-container { position: fixed; right: 0; top: 50%; transform: translateY(-50%); display: flex; flex-direction: column; gap: 0.25rem; z-index: 1030; padding-right: 0.5rem; }
    .soundtrack-icon { width: 44px; height: 44px; background-color: var(--bg-tertiary); border: 2px solid var(--border-stone); border-radius: 4px; display: flex; justify-content: center; align-items: center; cursor: pointer; color: var(--text-secondary); transition: all 0.2s; position: relative; box-shadow: 0 2px 5px rgba(0,0,0,0.3); margin-bottom: 4px; }
    .soundtrack-icon:hover { border-color: var(--accent-gold-light); color: var(--text-primary); transform: translateX(-2px); }
    .soundtrack-icon.active { border-color: #a3e635; color: #a3e635; box-shadow: 0 0 10px rgba(163, 230, 53, 0.5); }
    .soundtrack-icon .tooltip { position: absolute; right: 100%; top: 50%; transform: translateY(-50%); background: var(--bg-secondary); border: 1px solid var(--accent-gold-dark); color: var(--accent-gold-light); padding: 4px 8px; border-radius: 4px; font-size: 0.8rem; white-space: nowrap; opacity: 0; pointer-events: none; transition: opacity 0.2s; margin-right: 8px; }
    .soundtrack-icon:hover .tooltip { opacity: 1; pointer-events: auto; }
`;

if (!html.includes('.soundtrack-bar')) {
    html = html.replace('</style>', cssToInject + '\n</style>');
}

// 2. Inject Button into Tools & Features dropdown
const btnToInject = `
<button id="openManageSoundtracksButton"><i class="fas fa-list-ul fa-fw"></i> Manage Soundtracks</button>
`;
if (!html.includes('id="openManageSoundtracksButton"')) {
    html = html.replace(/<button id="openExportChapterMenuButton" class="hidden"><\/button>/, match => btnToInject + match);
    if (!html.includes('id="openManageSoundtracksButton"')) {
        // Fallback injection location
        html = html.replace(/<button id="burnBookButton".*?><i class="fas fa-fire fa-fw"><\/i> Burn Book<\/button>/, match => btnToInject + match);
    }
}

// 3. Inject HTML Elements (Bar, Quick Icons, Modals) before Message Box
const htmlToInject = `
    <!-- Soundtrack UI -->
    <div id="soundtrackIconsContainer" class="soundtrack-icons-container"></div>
    <div id="soundtrackBar" class="soundtrack-bar">
        <div class="controls">
            <button id="stPrevBtn" class="btn-rpg-sm btn-rpg-sm-icon" title="Previous Song"><i class="fas fa-step-backward"></i></button>
            <button id="stPlayPauseBtn" class="btn-rpg-sm btn-rpg-sm-icon" title="Play/Pause"><i class="fas fa-play"></i></button>
            <button id="stNextBtn" class="btn-rpg-sm btn-rpg-sm-icon" title="Next Song"><i class="fas fa-step-forward"></i></button>
        </div>
        <div class="track-info">
            <span id="stTrackTitle" class="track-title">No Track Selected</span>
            <span id="stPlaylistName" class="playlist-name">Playlist: None</span>
        </div>
        <div class="volume-control">
            <i class="fas fa-volume-up text-xs text-gray-400"></i>
            <input type="range" id="stVolumeSlider" min="0" max="100" value="100" class="w-full">
            <button id="stCloseBtn" class="btn-rpg-sm btn-rpg-sm-icon ml-2" title="Hide Player"><i class="fas fa-times"></i></button>
        </div>
    </div>
    
    <!-- Soundtrack Modals -->
    <div id="manageSoundtracksModal" class="modal" style="max-width: 800px; z-index: 1045;">
        <div class="modal-body">
            <h3 class="modal-title"><i class="fas fa-music mr-2"></i>Manage Soundtracks</h3>
            <div class="modal-content">
                <div class="flex justify-between items-center mb-2">
                    <button id="addSoundtrackBtn" class="btn-rpg-sm btn-success-sm"><i class="fas fa-plus mr-1"></i> Add Playlist</button>
                    <div>
                        <button id="importSpotifyPlaylistBtn" class="btn-rpg-sm" title="Import from Spotify via YouTube search"><i class="fab fa-spotify mr-1 text-green-500"></i> Import Spotify</button>
                    </div>
                </div>
                <ul id="soundtracksList" class="space-y-2 max-h-64 overflow-y-auto bg-black/20 p-2 border border-stone-700 rounded mb-4"></ul>
                
                <div id="editSoundtrackContainer" class="hidden border-t border-dashed border-stone-700 pt-4 mt-2">
                    <input type="hidden" id="editStId">
                    <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <div class="md:col-span-2"> <label class="block text-sm font-medium mb-1">Playlist Name:</label> <input type="text" id="editStName"> </div>
                        <div> <label class="block text-sm font-medium mb-1">Icon Style (FontAwesome class):</label> <input type="text" id="editStIcon" placeholder="fas fa-music"> </div>
                        <div class="md:col-span-2"> <label class="block text-sm font-medium mb-1">Trigger Keywords (comma-separated):</label> <input type="text" id="editStKeywords" placeholder="e.g., tavern start, battle music"> </div>
                        <div>
                            <label class="block text-sm font-medium mb-1">Time of Day Auto-Play:</label>
                            <select id="editStTimeOfDay">
                                <option value="none">None</option><option value="day">Day</option><option value="night">Night</option>
                            </select>
                        </div>
                        <div>
                            <label class="block text-sm font-medium mb-1">Chapter Auto-Play (if possible check code):</label>
                            <select id="editStChapter"><option value="none">None</option></select>
                        </div>
                    </div>
                    
                    <div class="mt-4">
                        <div class="flex justify-between items-center mb-2">
                            <h4 class="text-sm font-bold text-[var(--accent-gold-light)]">Songs</h4>
                            <button id="addStSongBtn" class="btn-rpg-sm btn-success-sm"><i class="fas fa-plus mr-1"></i> Add Song</button>
                        </div>
                        <ul id="stSongsList" class="space-y-2 max-h-48 overflow-y-auto bg-black/20 p-2 border border-stone-700 rounded"></ul>
                    </div>
                </div>
            </div>
        </div>
        <div class="modal-actions">
            <button id="closeSoundtracksModalBtn" class="btn-rpg-sm">Close</button>
            <button id="saveSoundtrackBtn" class="btn-rpg hidden">Save Playlist</button>
        </div>
    </div>
    
    <!-- Add Song Modal -->
    <div id="stAddSongModal" class="modal" style="max-width: 500px; z-index: 1060;">
        <div class="modal-body">
            <h3 class="modal-title text-sm"><i class="fas fa-plus mr-2"></i>Add/Edit Song</h3>
            <div class="modal-content space-y-3">
                <input type="hidden" id="stSongEditIndex">
                <div> <label class="block text-sm font-medium mb-1">Source Type:</label>
                    <div class="flex gap-4">
                        <label><input type="radio" name="stSongType" value="youtube" checked> YouTube URL</label>
                        <label><input type="radio" name="stSongType" value="file"> Local File</label>
                    </div>
                </div>
                <div id="stSongYoutubeContainer"> <label class="block text-sm font-medium mb-1">YouTube URL:</label> <input type="text" id="stSongYoutubeUrl"> </div>
                <div id="stSongFileContainer" class="hidden"> <label class="block text-sm font-medium mb-1">File:</label> <input type="file" id="stSongFile" accept="audio/*"> </div>
                <div> <label class="block text-sm font-medium mb-1">Song Name:</label> <input type="text" id="stSongName"> </div>
                <div class="flex gap-4">
                    <div class="flex-grow"> <label class="block text-sm font-medium mb-1">Volume Override (Optional - default 100):</label> <input type="number" id="stSongVolume" min="0" max="100" placeholder="100"> </div>
                </div>
            </div>
        </div>
        <div class="modal-actions mt-4">
            <button id="cancelStSongBtn" class="btn-rpg-sm">Cancel</button>
            <button id="saveStSongBtn" class="btn-rpg">Save Song</button>
        </div>
    </div>
    
    <!-- Spotify Import Modal -->
    <div id="spotifyImportModal" class="modal" style="max-width: 600px; z-index: 1060;">
        <div class="modal-body">
            <h3 class="modal-title text-sm"><i class="fab fa-spotify mr-2 text-green-500"></i>Import Spotify Playlist</h3>
            <div class="modal-content space-y-3">
                <p class="text-xs text-gray-400">Paste a Spotify Playlist URL. The app will fetch track details via User token and try to find matching YouTube audio. Requires Spotify Login.</p>
                <div> <label class="block text-sm font-medium mb-1">Spotify Playlist URL:</label> <input type="text" id="spotifyPlaylistUrlInput" placeholder="https://open.spotify.com/playlist/..."> </div>
                <div id="spotifyImportStatus" class="text-sm font-bold text-yellow-400 mt-2"></div>
            </div>
        </div>
        <div class="modal-actions mt-4">
            <button id="cancelSpotifyImportBtn" class="btn-rpg-sm">Cancel</button>
            <button id="executeSpotifyImportBtn" class="btn-rpg">Import & Convert</button>
        </div>
    </div>
`;

if (!html.includes('id="soundtrackIconsContainer"')) {
    html = html.replace('<!-- Message Box -->', htmlToInject + '\n    <!-- Message Box -->');
}

// 4. Inject JS Logic
const jsToInject = `
// ===== SOUNDTRACK SYSTEM LOGIC ===== //
let activeSoundtrackId = null;
let activeStSongIndex = 0;
let stPlayerNode = null; 
let isStPlaying = false;
let globalSoundtrackVolume = 100;
let editStCurrentId = null;

function renderSoundtrackIcons() {
    const container = document.getElementById('soundtrackIconsContainer');
    if(!container) return;
    container.innerHTML = '';
    (book.soundtracks || []).forEach(st => {
        const iconDiv = document.createElement('div');
        iconDiv.className = 'soundtrack-icon' + (activeSoundtrackId === st.id ? ' active' : '');
        iconDiv.innerHTML = '<i class="' + (st.icon || 'fas fa-music') + '"></i><div class="tooltip">' + st.name + '</div>';
        iconDiv.onclick = () => { toggleSoundtrack(st.id); };
        container.appendChild(iconDiv);
    });
}

function updateSoundtrackBarUI() {
    const bar = document.getElementById('soundtrackBar');
    if (!bar) return;
    if (activeSoundtrackId) {
        bar.classList.add('active');
        const st = book.soundtracks.find(s => s.id === activeSoundtrackId);
        document.getElementById('stPlaylistName').innerText = 'Playlist: ' + (st ? st.name : '');
        
        let songName = 'No Track Started';
        if (st && st.songs && st.songs.length > 0) {
            const currentSong = st.songs[activeStSongIndex];
            songName = currentSong ? currentSong.name : 'Unknown';
        }
        document.getElementById('stTrackTitle').innerText = songName;
        
        const playBtnI = document.querySelector('#stPlayPauseBtn i');
        if (isStPlaying) {
            playBtnI.className = 'fas fa-pause';
        } else {
            playBtnI.className = 'fas fa-play';
        }
    } else {
        bar.classList.remove('active');
        if (stPlayerNode) {
            if (stPlayerNode.stop) stPlayerNode.stop();
            if (stPlayerNode.pauseVideo) stPlayerNode.pauseVideo();
            if (stPlayerNode.destroy) stPlayerNode.destroy();
            stPlayerNode = null;
        }
    }
}

function playStSong(st, songIndex) {
    if (!st || !st.songs || st.songs.length === 0) return;
    
    // Stop current
    if (stPlayerNode) {
        if (stPlayerNode.gainNode && audioContext) {
            stPlayerNode.gainNode.gain.exponentialRampToValueAtTime(0.001, audioContext.currentTime + 1.0);
            setTimeout(() => { if (stPlayerNode && stPlayerNode.stop) stPlayerNode.stop(); }, 1000);
        } else if (stPlayerNode.destroy) {
            stPlayerNode.destroy(); // YT player
        }
    }
    
    activeStSongIndex = songIndex;
    const song = st.songs[songIndex];
    if (!song) return;
    
    document.getElementById('stTrackTitle').innerText = song.name;
    const baseVol = globalSoundtrackVolume / 100;
    const songVol = (song.volume !== undefined ? song.volume : 100) / 100;
    const finalVol = Math.max(baseVol * songVol, 0.001); // Avoid 0

    if (song.type === 'file' && song.fileData) {
        initAudioContext();
        const reader = new FileReader();
        reader.onload = function(e) {
            audioContext.decodeAudioData(e.target.result, function(buffer) {
                const source = audioContext.createBufferSource();
                source.buffer = buffer;
                const gainNode = audioContext.createGain();
                gainNode.gain.value = 0.001; // start silent for fade
                source.connect(gainNode);
                gainNode.connect(masterGainNode); 
                
                source.onended = () => { nextStSong(); };
                source.start();
                gainNode.gain.exponentialRampToValueAtTime(finalVol, audioContext.currentTime + 2.0); // Fade in
                
                stPlayerNode = source;
                stPlayerNode.gainNode = gainNode; 
                isStPlaying = true;
                updateSoundtrackBarUI();
            });
        };
        reader.readAsArrayBuffer(song.fileData);
    } else if (song.type === 'youtube' && song.videoId) {
        const dummyDiv = document.createElement('div');
        dummyDiv.style.display = 'none';
        document.body.appendChild(dummyDiv);
        
        if (typeof YT === 'undefined' || !YT.Player) {
            setTimeout(() => playStSong(st, songIndex), 500);
            return;
        }
        
        stPlayerNode = new YT.Player(dummyDiv, {
            height: '0',
            width: '0',
            videoId: song.videoId,
            playerVars: { 'autoplay': 1, 'controls': 0, 'start': song.startTime || 0 },
            events: {
                'onReady': (event) => {
                    event.target.setVolume(finalVol * 100);
                    event.target.playVideo();
                    isStPlaying = true;
                    updateSoundtrackBarUI();
                },
                'onStateChange': (event) => {
                    if (event.data == YT.PlayerState.ENDED) {
                        nextStSong();
                    }
                }
            }
        });
    }
}

function stopSoundtrack() {
    activeSoundtrackId = null;
    isStPlaying = false;
    updateSoundtrackBarUI();
    renderSoundtrackIcons();
}

function toggleSoundtrack(id) {
    if (activeSoundtrackId === id) {
        if (isStPlaying) {
            pauseSoundtrack();
        } else {
            resumeSoundtrack();
        }
    } else {
        const st = book.soundtracks.find(s => s.id === id);
        activeSoundtrackId = id;
        activeStSongIndex = 0;
        playStSong(st, 0);
        renderSoundtrackIcons();
    }
}

function pauseSoundtrack() {
    isStPlaying = false;
    if (stPlayerNode) {
        if (stPlayerNode.gainNode && audioContext) {
            stPlayerNode.gainNode.gain.exponentialRampToValueAtTime(0.001, audioContext.currentTime + 1.0);
            setTimeout(() => { if (stPlayerNode && stPlayerNode.context) audioContext.suspend(); }, 1000);
        } else if (stPlayerNode.pauseVideo) {
             stPlayerNode.pauseVideo();
        }
    }
    updateSoundtrackBarUI();
    renderSoundtrackIcons();
}

function resumeSoundtrack() {
    isStPlaying = true;
    if (stPlayerNode) {
        if (stPlayerNode.gainNode && audioContext) {
            audioContext.resume();
            const st = book.soundtracks.find(s => s.id === activeSoundtrackId);
            const song = st.songs[activeStSongIndex];
            const finalVol = Math.max((globalSoundtrackVolume/100) * ((song.volume || 100)/100), 0.001);
            stPlayerNode.gainNode.gain.exponentialRampToValueAtTime(finalVol, audioContext.currentTime + 1.0);
        } else if (stPlayerNode.playVideo) {
             stPlayerNode.playVideo();
        }
    } else {
        const st = book.soundtracks.find(s => s.id === activeSoundtrackId);
        playStSong(st, activeStSongIndex);
    }
    updateSoundtrackBarUI();
    renderSoundtrackIcons();
}

function nextStSong() {
    if (!activeSoundtrackId) return;
    const st = book.soundtracks.find(s => s.id === activeSoundtrackId);
    if (!st || !st.songs || st.songs.length === 0) return;
    activeStSongIndex = (activeStSongIndex + 1) % st.songs.length;
    playStSong(st, activeStSongIndex);
}

function prevStSong() {
    if (!activeSoundtrackId) return;
    const st = book.soundtracks.find(s => s.id === activeSoundtrackId);
    if (!st || !st.songs || st.songs.length === 0) return;
    activeStSongIndex = (activeStSongIndex - 1 + st.songs.length) % st.songs.length;
    playStSong(st, activeStSongIndex);
}

document.addEventListener('DOMContentLoaded', () => {
    const stVolSlider = document.getElementById('stVolumeSlider');
    if (stVolSlider) {
        stVolSlider.addEventListener('input', (e) => {
            globalSoundtrackVolume = parseInt(e.target.value, 10);
            if (activeSoundtrackId && isStPlaying && stPlayerNode) {
                const st = book.soundtracks.find(s => s.id === activeSoundtrackId);
                const song = st.songs[activeStSongIndex];
                const finalVol = Math.max((globalSoundtrackVolume/100) * ((song.volume || 100)/100), 0.001);
                if (stPlayerNode.gainNode && audioContext) {
                    stPlayerNode.gainNode.gain.setTargetAtTime(finalVol, audioContext.currentTime, 0.1);
                } else if (stPlayerNode.setVolume) {
                    stPlayerNode.setVolume(finalVol * 100);
                }
            }
        });
    }

    const stPlayBtn = document.getElementById('stPlayPauseBtn');
    if (stPlayBtn) stPlayBtn.onclick = () => { if (isStPlaying) pauseSoundtrack(); else resumeSoundtrack(); };
    const stNextBtn = document.getElementById('stNextBtn');
    if (stNextBtn) stNextBtn.onclick = nextStSong;
    const stPrevBtn = document.getElementById('stPrevBtn');
    if (stPrevBtn) stPrevBtn.onclick = prevStSong;
    const stCloseBtn = document.getElementById('stCloseBtn');
    if (stCloseBtn) stCloseBtn.onclick = stopSoundtrack;
    
    // Check if openManageSoundtracksButton exists and attach listeners
    const triggerMenuBtnInterval = setInterval(() => {
        const btn = document.getElementById('openManageSoundtracksButton');
        if (btn) {
            btn.addEventListener('click', () => {
                book.soundtracks = book.soundtracks || [];
                renderManifestList();
                document.getElementById('manageSoundtracksModal').style.display = 'flex';
                document.getElementById('modalOverlay').style.display = 'block';
                document.getElementById('editSoundtrackContainer').classList.add('hidden');
            });
            clearInterval(triggerMenuBtnInterval);
        }
    }, 1000);

    document.getElementById('closeSoundtracksModalBtn')?.addEventListener('click', () => {
        document.getElementById('manageSoundtracksModal').style.display = 'none';
        document.getElementById('modalOverlay').style.display = 'none';
        saveToLocalStorage();
        renderSoundtrackIcons();
    });
    
    document.getElementById('addSoundtrackBtn')?.addEventListener('click', () => {
         const newSt = { id: 'st_' + Date.now(), name: 'New Playlist', icon: 'fas fa-music', keywords: [], timeOfDay: 'none', chapter: 'none', songs: [] };
         book.soundtracks.push(newSt);
         openEditSoundtrack(newSt);
         renderManifestList();
    });

    document.getElementById('saveSoundtrackBtn')?.addEventListener('click', () => {
        if(!editStCurrentId) return;
        const st = book.soundtracks.find(s => s.id === editStCurrentId);
        if(st) {
            st.name = document.getElementById('editStName').value.trim() || 'Unnamed';
            st.icon = document.getElementById('editStIcon').value.trim() || 'fas fa-music';
            st.keywords = document.getElementById('editStKeywords').value.split(',').map(s=>s.trim().toLowerCase()).filter(Boolean);
            st.timeOfDay = document.getElementById('editStTimeOfDay').value;
            st.chapter = document.getElementById('editStChapter').value;
            showTemporaryMessage('Saved playlist settings.', 'success');
            renderManifestList();
            renderSoundtrackIcons();
        }
    });

    document.getElementById('addStSongBtn')?.addEventListener('click', () => {
        document.getElementById('stSongEditIndex').value = '';
        document.getElementById('stSongName').value = '';
        document.getElementById('stSongYoutubeUrl').value = '';
        document.getElementById('stSongVolume').value = 100;
        document.getElementById('stSongFile').value = '';
        document.getElementById('stAddSongModal').style.display = 'flex';
    });

    document.querySelectorAll('input[name="stSongType"]').forEach(r => r.addEventListener('change', e => {
        document.getElementById('stSongYoutubeContainer').classList.toggle('hidden', e.target.value!=='youtube');
        document.getElementById('stSongFileContainer').classList.toggle('hidden', e.target.value!=='file');
    }));

    document.getElementById('cancelStSongBtn')?.addEventListener('click', () => {
        document.getElementById('stAddSongModal').style.display = 'none';
    });

    document.getElementById('saveStSongBtn')?.addEventListener('click', () => {
        const st = book.soundtracks.find(s => s.id === editStCurrentId);
        const idx = document.getElementById('stSongEditIndex').value;
        const type = document.querySelector('input[name="stSongType"]:checked').value;
        
        let songData = {
            name: document.getElementById('stSongName').value.trim() || 'New Song',
            type: type,
            volume: parseInt(document.getElementById('stSongVolume').value) || 100
        };
        
        if (type === 'youtube') {
            const url = document.getElementById('stSongYoutubeUrl').value.trim();
            songData.url = url;
            const m = url.match(/(?:https?:\\/\\/)?(?:www\\.)?(?:youtube\\.com\\/(?:[^\\/\\n\\s]+\\/\\S+\\/|(?:v|e(?:mbed)?)\\/|\\S*?[?&]v=)|youtu\\.be\\/)([a-zA-Z0-9_-]{11})/);
            songData.videoId = m ? m[1] : null;
        } else if (type === 'file') {
            const fileInput = document.getElementById('stSongFile');
            if (fileInput.files.length > 0) {
                songData.fileData = fileInput.files[0];
                if (songData.name === 'New Song') songData.name = fileInput.files[0].name;
            }
        }
        
        if (idx === '') {
            st.songs.push(songData);
        } else {
            if(type === 'file' && !songData.fileData && st.songs[idx].fileData) {
                songData.fileData = st.songs[idx].fileData;
            }
            st.songs[idx] = songData;
        }
        
        document.getElementById('stAddSongModal').style.display = 'none';
        renderStSongs(st);
    });

    // Spotify Import Logic
    document.getElementById('importSpotifyPlaylistBtn')?.addEventListener('click', () => {
        document.getElementById('spotifyImportModal').style.display = 'flex';
    });

    document.getElementById('cancelSpotifyImportBtn')?.addEventListener('click', () => {
        document.getElementById('spotifyImportModal').style.display = 'none';
    });

    document.getElementById('executeSpotifyImportBtn')?.addEventListener('click', async () => {
        const url = document.getElementById('spotifyPlaylistUrlInput').value.trim();
        const statusDiv = document.getElementById('spotifyImportStatus');
        const token = localStorage.getItem('spotify_access_token');
        if(!token) {
            statusDiv.innerText = "Error: Please log in to Spotify via Settings first.";
            return;
        }
        const match = url.match(/playlist\\/([a-zA-Z0-9]+)/);
        if(!match) { statusDiv.innerText = "Invalid Spotify URL."; return; }
        
        statusDiv.innerText = "Fetching playlist mapping... (this takes a moment)";
        try {
            const res = await fetch("https://api.spotify.com/v1/playlists/" + match[1], { headers: { 'Authorization': \`Bearer \${token}\`} });
            const data = await res.json();
            
            if (!data.tracks) {
                statusDiv.innerText = "Error fetching playlist or empty playlist."; return;
            }
            
            const newSt = { id: 'st_' + Date.now(), name: data.name || 'Spotify Import', icon: 'fab fa-spotify', keywords: [], timeOfDay: 'none', chapter: 'none', songs: [] };
            
            statusDiv.innerText = "Playlist fetched! Need a YouTube API key to map to video URLs. Generating empty stubs...";
            
            data.tracks.items.forEach(item => {
                if(item.track) {
                    const artistStr = item.track.artists ? item.track.artists[0].name : 'Unknown';
                    newSt.songs.push({ name: item.track.name + " - " + artistStr, type: 'youtube', volume: 100, url: '', videoId: null });
                }
            });
            
            book.soundtracks.push(newSt);
            openEditSoundtrack(newSt);
            renderManifestList();
            
            setTimeout(() => {
                document.getElementById('spotifyImportModal').style.display = 'none';
                statusDiv.innerText='';
            }, 3000);
            
        } catch(err) {
            statusDiv.innerText = "Error: " + err.message;
        }
    });
});

function renderManifestList() {
    const list = document.getElementById('soundtracksList');
    if(!list) return;
    list.innerHTML = '';
    (book.soundtracks || []).forEach(st => {
        const li = document.createElement('li');
        li.className = 'flex justify-between items-center p-2 border-b border-stone-700 hover:bg-black/20';
        li.innerHTML = \`<span class="text-sm font-semibold text-accent-gold-light"><i class="\${st.icon} mr-2"></i>\${st.name} (\${st.songs?st.songs.length:0} songs)</span>
            <div class="flex gap-2">
                <button class="text-accent-blue hover:text-white btn-edit-st" data-id="\${st.id}"><i class="fas fa-edit"></i></button>
                <button class="text-red-400 hover:text-red-500 btn-del-st" data-id="\${st.id}"><i class="fas fa-trash"></i></button>
            </div>\`;
        list.appendChild(li);
        
        li.querySelector('.btn-edit-st').onclick = () => openEditSoundtrack(st);
        li.querySelector('.btn-del-st').onclick = () => {
            if(confirm('Delete playlist?')) {
                book.soundtracks = book.soundtracks.filter(s => s.id !== st.id);
                if(activeSoundtrackId === st.id) stopSoundtrack();
                renderManifestList();
                document.getElementById('editSoundtrackContainer').classList.add('hidden');
            }
        };
    });
}

function openEditSoundtrack(st) {
    document.getElementById('editSoundtrackContainer').classList.remove('hidden');
    document.getElementById('saveSoundtrackBtn').classList.remove('hidden');
    editStCurrentId = st.id;
    document.getElementById('editStName').value = st.name;
    document.getElementById('editStIcon').value = st.icon || 'fas fa-music';
    document.getElementById('editStKeywords').value = (st.keywords || []).join(', ');
    document.getElementById('editStTimeOfDay').value = st.timeOfDay || 'none';
    
    // populate chapter select
    const chSelect = document.getElementById('editStChapter');
    chSelect.innerHTML = '<option value="none">None</option>';
    book.chapters.forEach(ch => {
        chSelect.innerHTML += \`<option value="\${ch.id}">\${ch.name}</option>\`;
    });
    chSelect.value = st.chapter || 'none';
    
    renderStSongs(st);
}

function renderStSongs(st) {
    const list = document.getElementById('stSongsList');
    list.innerHTML = '';
    (st.songs || []).forEach((song, i) => {
        const li = document.createElement('li');
        li.className = 'flex justify-between items-center p-2 text-sm border-b border-stone-800';
        const songTypeBadge = song.type === 'youtube' ? '<i class="fab fa-youtube text-red-500 ml-2"></i>' : '<i class="fas fa-file-audio text-blue-400 ml-2"></i>';
        li.innerHTML = \`<span>\${song.name} \${songTypeBadge}</span>
            <div class="flex gap-2">
                <button class="text-accent-blue" onclick="window.editStSong(\${i})"><i class="fas fa-edit"></i></button>
                <button class="text-red-400" onclick="window.deleteStSong(\${i})"><i class="fas fa-trash"></i></button>
            </div>\`;
        list.appendChild(li);
    });
}

window.deleteStSong = function(index) {
    if(confirm('Delete song?')) {
        const st = book.soundtracks.find(s => s.id === editStCurrentId);
        st.songs.splice(index, 1);
        renderStSongs(st);
    }
}
window.editStSong = function(index) {
    const st = book.soundtracks.find(s => s.id === editStCurrentId);
    const song = st.songs[index];
    document.getElementById('stSongEditIndex').value = index;
    document.getElementById('stSongName').value = song.name;
    document.getElementById('stSongVolume').value = song.volume || 100;
    
    const radioBtn = document.querySelector(\`input[name="stSongType"][value="\${song.type}"]\`);
    if(radioBtn) radioBtn.checked = true;
    
    document.getElementById('stSongYoutubeUrl').value = song.type==='youtube'? song.url : '';
    
    document.getElementById('stSongYoutubeContainer').classList.toggle('hidden', song.type!=='youtube');
    document.getElementById('stSongFileContainer').classList.toggle('hidden', song.type!=='file');
    
    document.getElementById('stAddSongModal').style.display = 'flex';
}
`;

if (!html.includes('// ===== SOUNDTRACK SYSTEM LOGIC ===== //')) {
    html = html.replace('// --- Initial Setup ---', jsToInject + '\n    // --- Initial Setup ---');
}

// Ensure default book includes soundtracks
html = html.replace('youtubeApiKeys: []', 'youtubeApiKeys: [], soundtracks: []');

// Add Voice/Chapter/Time hooks dynamically
const triggersInjection = `
    function checkSoundtrackTriggers(keywordMatch = null, chapterId = null, timeOfDay = null) {
        if (!window.book || !window.book.soundtracks) return;
        window.book.soundtracks.forEach(st => {
            let hit = false;
            if (keywordMatch && st.keywords && st.keywords.some(kw => keywordMatch.toLowerCase().includes(kw))) hit = true;
            if (chapterId && st.chapter === chapterId) hit = true;
            if (timeOfDay && st.timeOfDay === timeOfDay) hit = true;
            if (hit && activeSoundtrackId !== st.id) {
                toggleSoundtrack(st.id);
            }
        });
    }
`;

if (!html.includes('checkSoundtrackTriggers')) {
    html = html.replace('function processTranscript(text) {', triggersInjection + '\nfunction processTranscript(text) { checkSoundtrackTriggers(text, null, null); ');
    // Inside function setActiveChapter
    html = html.replace(/function setActiveChapter\(chapterId\) \{/, 'function setActiveChapter(chapterId) { checkSoundtrackTriggers(null, chapterId, null); ');
    // Inside toggleTimeOfDay
    html = html.replace(/currentTimeOfDay = newTimeOfDay;/, 'currentTimeOfDay = newTimeOfDay; checkSoundtrackTriggers(null, null, newTimeOfDay); ');

    // Auto render icons on load inside `initializeApp`
    html = html.replace(/renderChapterTabs\(\);/, 'renderChapterTabs(); renderSoundtrackIcons();');
}

fs.writeFileSync(targetFile, html, 'utf8');
console.log('Soundtrack system injected successfully with updated syntax.');
