const fs = require('fs');
let html = fs.readFileSync('index.html', 'utf8');

let modified = false;

// 1. Inject Menu Button
if (!html.includes('id="openManageSoundtracksButton"')) {
    const btnHtml = `\n                                <button id="openManageSoundtracksButton" title="Manage Soundtracks"> <i class="fas fa-music fa-fw"></i> <span>Manage Soundtracks</span> </button>`;
    html = html.replace(/(<button\s+id="openStoryPlotterButton"[^>]*>[\s\S]*?<\/button>)/, '$1' + btnHtml);
    modified = true;
    console.log("Injected openManageSoundtracksButton");
}

// 2. Inject CSS
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
if (!html.includes('.soundtrack-bar.active')) {
    html = html.replace('</style>', cssToInject + '\n</style>');
    modified = true;
    console.log("Injected CSS");
}

// 3. Inject Modals and UI elements before </body>
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

if (!html.includes('id="soundtrackBar"')) {
    html = html.replace('</body>', htmlToInject + '\n</body>');
    modified = true;
    console.log("Injected HTML UI elements");
}

if (modified) {
    fs.writeFileSync('index.html', html, 'utf8');
    console.log('UI successfully updated.');
} else {
    console.log('UI was already injected.');
}
