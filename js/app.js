                // --- Constants ---
                // v25.8: Syrinscape loop with duration fix, Autoplay on time change fix
                const YT_RECENT_SEARCHES_KEY = 'storytellerYoutubeRecentSearches';
                // Fixed autosave key so version bumps never orphan a user's book (ANALYSIS.md B2).
                // The schema version now lives *inside* the JSON, not in the key.
                const LOCAL_STORAGE_KEY = 'storytellerBookData';
                const LEGACY_KEY_PREFIX = 'storytellerBookData_v';
                const SCHEMA_VERSION = 26; // integer; bump when the book shape changes, add a migration below
                const INTERIM_WORD_BLOCK_SIZE = 6; // Increased from 4 to 6
                const SCORE_TIE_THRESHOLD = 0.2;
                // --- Spotify Constants ---
                const SPOTIFY_DEFAULT_CLIENT_ID = "4ec2098d4c8f49149f5b4bca2850bfd5";
                const SPOTIFY_REDIRECT_URI = window.location.origin + decodeURIComponent(window.location.pathname);
                const SPOTIFY_SCOPES = ["streaming", "user-read-email", "user-read-private", "user-read-playback-state", "user-modify-playback-state"].join(" ");
                const HIGH_CONFIDENCE_THRESHOLD = 0.9;
                const AND_REGEX = /\b(and|&)\b/i;
                const COMPOUND_DELAY_MS = 300;
                const SEQUENTIAL_PLAY_DELAY_MS = 500; // Delay between sounds in a sequence
                const PLOT_NODE_WIDTH = 160;
                const PLOT_NODE_HEIGHT = 44;
                const PLOT_BOARD_PAN_SPEED = 1;
                const PLOT_BOARD_ZOOM_SPEED = 0.1;
                const PLOT_BOARD_MIN_ZOOM = 0.3;
                const PLOT_BOARD_MAX_ZOOM = 2.0;
                const PLOT_THREAD_COLORS = 5;
                const PLOT_THREAD_OFFSET_AMOUNT = 6;
                const SYRINSCAPE_API_SEARCH_URL = 'https://syrinscape.com/search/';
                const PIP_CANVAS_SIZE = 80;

                let currentYoutubeApiKeyIndex = 0;

                // --- YouTube API Setup ---
                let youtubeApiReady = false;
                let pendingYTPlays = []; // Queue for plays attempted before API is ready
                // YouTube calls this global when the IFrame API finishes loading. It runs at
                // module scope, so it cannot see playSound (which lives in the DOMContentLoaded
                // closure). It therefore defers draining the queue to a callback the closure
                // registers once playSound is in scope (B4 — previously threw ReferenceError,
                // so any YouTube sound queued before the API loaded never played).
                function onYouTubeIframeAPIReady() {
                    console.log("YouTube IFrame API Ready");
                    youtubeApiReady = true;
                    if (typeof window.__ytApiReadyCallback === 'function') window.__ytApiReadyCallback();
                }
                const tag = document.createElement('script'); tag.src = "https://www.youtube.com/iframe_api";
                const firstScriptTag = document.getElementsByTagName('script')[0]; firstScriptTag.parentNode.insertBefore(tag, firstScriptTag);

                // --- Main Script Logic ---
                document.addEventListener('DOMContentLoaded', () => {
                    // Drain YouTube plays queued before the IFrame API was ready. Registered
                    // here so it closes over the closure-scoped playSound (B4). playSound is a
                    // hoisted function declaration, so it is safe to reference now.
                    window.__ytApiReadyCallback = () => {
                        if (pendingYTPlays.length > 0) {
                            log(`Processing ${pendingYTPlays.length} pending YouTube plays...`);
                            const queued = pendingYTPlays;
                            pendingYTPlays = [];
                            queued.forEach(play => playSound(play.page, play.sourceDetailToPlay, play.startedByAutoplay, play.onEndedCallback, play.isCompoundSequence, play.isPlotThreadSound, play.isInternalLoopIteration, play.triggeredByAppendix));
                        }
                    };
                    // If the API became ready before this closure ran, drain now.
                    if (youtubeApiReady) window.__ytApiReadyCallback();

                    // Leveled debug logging (3.5). The app emitted 300+ console.log lines in
                    // normal operation; those now go through log() and are silent unless the
                    // user opts in with storytellerDebug(true) from the console. Warnings and
                    // errors still use console.warn/console.error directly.
                    let DEBUG_LOGGING = false;
                    function log(...args) { if (DEBUG_LOGGING) console.log(...args); }
                    window.storytellerDebug = (on = true) => {
                        DEBUG_LOGGING = !!on;
                        console.log(`Storyteller debug logging ${DEBUG_LOGGING ? 'ON' : 'OFF'}`);
                    };

                    // --- Local audio persistence (IndexedDB) — ANALYSIS.md B3 ---------------
                    // Audio files were previously decoded into memory only; every reload forced
                    // the user to re-pick their audio folder. We now keep the raw file bytes in
                    // IndexedDB keyed by a content hash, so sounds survive a reload. Decoding to
                    // AudioBuffer still happens in memory (lazily, after load).
                    const audioStore = (() => {
                        const DB_NAME = 'storytellerAudio';
                        const STORE = 'files';
                        let dbPromise = null;
                        function open() {
                            if (dbPromise) return dbPromise;
                            dbPromise = new Promise((resolve, reject) => {
                                if (!window.indexedDB) { reject(new Error('IndexedDB unavailable')); return; }
                                const req = indexedDB.open(DB_NAME, 1);
                                req.onupgradeneeded = () => {
                                    const db = req.result;
                                    if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
                                };
                                req.onsuccess = () => resolve(req.result);
                                req.onerror = () => reject(req.error);
                            });
                            return dbPromise;
                        }
                        function tx(mode, fn) {
                            return open().then(db => new Promise((resolve, reject) => {
                                const t = db.transaction(STORE, mode);
                                const store = t.objectStore(STORE);
                                const req = fn(store);
                                // Resolve with the request's result (undefined for a missing key,
                                // an array for getAllKeys, the key for put) — never the request itself.
                                t.oncomplete = () => resolve(req ? req.result : undefined);
                                t.onerror = () => reject(t.error);
                                t.onabort = () => reject(t.error);
                            }));
                        }
                        return {
                            available: () => !!window.indexedDB,
                            async put(hash, blob, meta) {
                                await tx('readwrite', store => store.put({ blob, meta: meta || {}, savedAt: Date.now() }, hash));
                                return hash;
                            },
                            get(hash) { return tx('readonly', store => store.get(hash)).then(r => r || null); },
                            has(hash) { return tx('readonly', store => store.getKey(hash)).then(k => k !== undefined && k !== null); },
                            delete(hash) { return tx('readwrite', store => store.delete(hash)); },
                            keys() { return tx('readonly', store => store.getAllKeys()).then(k => k || []); },
                        };
                    })();

                    // SHA-256 hex when crypto.subtle is available (secure contexts); otherwise a
                    // cheap deterministic fallback from size + name + a byte sample, so file://
                    // (where subtle may be missing) still gets stable keys.
                    async function computeAudioHash(arrayBuffer, file) {
                        try {
                            if (window.crypto && crypto.subtle && crypto.subtle.digest) {
                                const digest = await crypto.subtle.digest('SHA-256', arrayBuffer);
                                return 'sha256-' + [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
                            }
                        } catch (e) { /* fall through to lightweight hash */ }
                        const bytes = new Uint8Array(arrayBuffer);
                        let h = 2166136261 >>> 0; // FNV-1a over a sampling of the bytes
                        const step = Math.max(1, Math.floor(bytes.length / 4096));
                        for (let i = 0; i < bytes.length; i += step) { h ^= bytes[i]; h = Math.imul(h, 16777619) >>> 0; }
                        const name = (file && file.name) || '';
                        return `fnv-${bytes.length}-${name.length}-${h.toString(16)}`;
                    }

                    // Store a decoded file's bytes and stamp the source with its hash. Best-effort:
                    // if persistence fails (quota/private mode) the source still plays this session.
                    async function persistAudioSource(source, file, arrayBuffer) {
                        if (!audioStore.available()) return;
                        try {
                            const hash = await computeAudioHash(arrayBuffer, file);
                            source.audioHash = hash;
                            if (!(await audioStore.has(hash))) {
                                await audioStore.put(hash, new Blob([arrayBuffer], { type: (file && file.type) || 'audio/*' }),
                                    { fileName: (file && file.name) || source.fileName || null });
                            }
                            source.needsFile = false;
                        } catch (e) {
                            console.warn('Could not persist audio to IndexedDB:', e);
                        }
                    }

                    // After a book loads, decode any file sources whose bytes are cached in
                    // IndexedDB so they play without a manual relink. Runs in the background.
                    async function rehydrateAudioFromStore() {
                        if (!audioStore.available() || !initAudioContext()) return;
                        let restored = 0;
                        const fileSubSources = [];
                        (book.pages || []).forEach(page => (page.sources || []).forEach(variation =>
                            (variation.sources || []).forEach(sub => { if (sub.type === 'file' && sub.audioHash) fileSubSources.push(sub); })));
                        for (const sub of fileSubSources) {
                            if (sub.source instanceof AudioBuffer) { sub.needsFile = false; continue; }
                            try {
                                const rec = await audioStore.get(sub.audioHash);
                                if (rec && rec.blob) {
                                    const buf = await audioContext.decodeAudioData(await rec.blob.arrayBuffer());
                                    sub.source = buf;
                                    sub.needsFile = false;
                                    restored++;
                                } else {
                                    sub.needsFile = true; // hash recorded but bytes are gone
                                }
                            } catch (e) {
                                console.warn('Failed to rehydrate audio', sub.audioHash, e);
                                sub.needsFile = true;
                            }
                        }
                        if (restored > 0) {
                            log(`Rehydrated ${restored} audio file(s) from IndexedDB.`);
                            renderPageList();
                            if (typeof updateRelinkButtonVisibility === 'function') updateRelinkButtonVisibility();
                        }
                    }

                    // --- Default Empty Book Structure ---
                    function getDefaultBook() {
                        return {
                            pages: [],
                            chapters: [{ id: 'index', name: 'Index', isIndex: true, isStarred: false, pageIds: [], chapterKeywords: [], autoPlayPageIds: [], leaveSoundPageIds: [], leaveTransitionTargetId: 'index' }],
                            activeChapterId: 'index',
                            currentTimeOfDay: 'day',
                            collections: [],
                            soundtracks: [],
                            nextCollectionId: 0,
                            nextPageId: 0,
                            nextTagId: 0,
                            nextChapterId: 1,
                            settings: {
                                listeningMode: 'toggle',
                                compoundPhrasing: true,
                                accuracyThreshold: 0.80,
                                stopAudioMode: 'indexContinue',
                                autoplayOnClick: 'listening',
                                masterVolume: 100,
                                stopPhrases: [],
                                customEnterPhrases: [],
                                customExitPhrases: [],
                                daytimeTransitionPhrases: [],
                                nighttimeTransitionPhrases: [],
                                syrinscapeAuthToken: null,
                                appendix: [],
                                chapterTags: [],
                            },
                            storyPlot: {
                                nodes: [],
                                threads: [],
                                nextPlotNodeId: 0,
                                nextPlotThreadId: 0,
                                viewTransform: { x: 0, y: 0, scale: 1.0 }
                            }
                        };
                    }
                    // --- DOM Elements ---
                    // Main Controls & Actions
                    const toggleListenButton = document.getElementById('toggleListenButton');
                    const stopAllSoundsButton = document.getElementById('stopAllSoundsButton');
                    const openSettingsModalButton = document.getElementById('openSettingsModalButton');
                    const openGuidebookModalButton = document.getElementById('openGuidebookModalButton');
                    const openSaveFileModalButton = document.getElementById('openSaveFileModalButton');
                    const openAppendixModalButton = document.getElementById('openAppendixModalButton');
                    const openAddPageModalButton = document.getElementById('openAddPageModalButton');
                    const addChapterButton = document.getElementById('addChapterButton');
                    const addAppendixEffectButton = document.getElementById('addAppendixEffectButton');
                    // exportChapterButton removed: no such element/feature in the current UI (B4)
                    const loadSampleBookButton = document.getElementById('loadSampleBookButton');
                    const burnBookButton = document.getElementById('burnBookButton');
                    const relinkFromDropdownButton = document.getElementById('relinkFromDropdownButton');
                    const toggleLayoutButton = document.getElementById('toggleLayoutButton');
                    const timeOfDayButton = document.getElementById('timeOfDayButton');
                    const togglePipButton = document.getElementById('togglePipButton');

                    // Hidden Inputs
                    const loadFileInput = document.getElementById('loadFileInput');
                    const directoryInput = document.getElementById('directoryInput');
                    // importChapterInput / importCollectionsInput removed: no such inputs in the current UI (B4)

                    // UI Inputs & Displays
                    const searchInput = document.getElementById('searchInput');
                    const guidebookSearchInput = document.getElementById('guidebookSearchInput');
                    const masterVolumeSlider = document.getElementById('masterVolumeSlider');
                    const statusDiv = document.getElementById('status');
                    const transcriptDisplay = document.getElementById('transcriptDisplay');
                    const pageListUl = document.getElementById('pageList');
                    const noPagesMessage = document.getElementById('noPagesMessage');
                    const noSearchResultsMessage = document.getElementById('noSearchResultsMessage');
                    const messageBox = document.getElementById('messageBox');
                    const youtubePlayersContainer = document.getElementById('youtubePlayersContainer');
                    const chapterTabsContainer = document.getElementById('chapterTabsContainer');
                    const guidebookEntriesDiv = document.getElementById('guidebookEntries');
                    const masterVolumeValueSpan = document.getElementById('masterVolumeValue');
                    const pipCanvas = document.getElementById('pipCanvas');
                    const pipVideo = document.getElementById('pipVideo');

                    // Modal Overlay
                    const modalOverlay = document.getElementById('modalOverlay');

                    // --- Observer for Background Blurring when Modals are open ---
                    const modalObserver = new MutationObserver(() => {
                        const isVisible = (modalOverlay.style.display !== 'none' && modalOverlay.style.display !== '') || !modalOverlay.classList.contains('hidden');
                        document.body.classList.toggle('modal-open', isVisible);
                    });
                    modalObserver.observe(modalOverlay, { attributes: true, attributeFilter: ['style', 'class'] });

                    // Settings Modal
                    const settingsModal = document.getElementById('settingsModal');
                    const settingsListeningModeRadios = document.querySelectorAll('input[name="settingsListeningMode"]');
                    const settingsCompoundPhrasingCheckbox = document.getElementById('settingsCompoundPhrasingCheckbox');
                    const settingsAccuracyThresholdInput = document.getElementById('settingsAccuracyThreshold');
                    const settingsAccuracyValueSpan = document.getElementById('settingsAccuracyValue');
                    const accuracyThresholdContainer = document.getElementById('accuracyThresholdContainer');
                    const settingsStopAudioModeRadios = document.querySelectorAll('input[name="settingsStopAudioMode"]');
                    const settingsStopPhrasesInput = document.getElementById('settingsStopPhrases');
                    const settingsCustomEnterPhrasesInput = document.getElementById('settingsCustomEnterPhrases');
                    const settingsCustomExitPhrasesInput = document.getElementById('settingsCustomExitPhrases');
                    const settingsDaytimePhrasesInput = document.getElementById('settingsDaytimePhrases');
                    const settingsNighttimePhrasesInput = document.getElementById('settingsNighttimePhrases');
                    const settingsAutoplayOnClickRadios = document.querySelectorAll('input[name="settingsAutoplayOnClick"]');
                    const settingsYoutubeApiKeysInput = document.getElementById('settingsYoutubeApiKeys');
                    const settingsSyrinscapeAuthTokenInput = document.getElementById('settingsSyrinscapeAuthToken');
                    const initializeSyrinscapeButton = document.getElementById('initializeSyrinscapeButton');
                    const saveSettingsButton = document.getElementById('saveSettingsButton');
                    const settingsSpotifyClientIdInput = document.getElementById('settingsSpotifyClientId');
                    const spotifyLoginContainer = document.getElementById('spotifyLoginContainer');
                    const spotifyLogoutContainer = document.getElementById('spotifyLogoutContainer');
                    const spotifyLoginButton = document.getElementById('spotifyLoginButton');
                    const spotifyLogoutButton = document.getElementById('spotifyLogoutButton');
                    const spotifyUserStatus = document.getElementById('spotifyUserStatus');
                    const cancelSettingsButton = document.getElementById('cancelSettingsButton');

                    // Save File Modal
                    const saveFileModal = document.getElementById('saveFileModal');
                    const saveFileNameInput = document.getElementById('saveFileName');
                    const saveSwitchChapters = document.getElementById('saveSwitchChapters');
                    const saveSwitchCollections = document.getElementById('saveSwitchCollections');
                    const saveSwitchPages = document.getElementById('saveSwitchPages');
                    const saveSwitchAppendix = document.getElementById('saveSwitchAppendix');
                    const saveSwitchSettings = document.getElementById('saveSwitchSettings');
                    const saveFileButton = document.getElementById('saveFileButton');
                    const cancelSaveFileButton = document.getElementById('cancelSaveFileButton');

                    // Burn Book Modal
                    const burnBookModal = document.getElementById('burnBookModal');
                    const burnSwitchChapters = document.getElementById('burnSwitchChapters');
                    const burnSwitchCollections = document.getElementById('burnSwitchCollections');
                    const burnSwitchPages = document.getElementById('burnSwitchPages');
                    const burnSwitchAppendix = document.getElementById('burnSwitchAppendix');
                    const burnSwitchSettings = document.getElementById('burnSwitchSettings');
                    const confirmBurnBookButton = document.getElementById('confirmBurnBookButton');
                    const cancelBurnBookButton = document.getElementById('cancelBurnBookButton');

                    // Add Page Modal
                    const addPageModal = document.getElementById('addPageModal');
                    const addPageTitleInput = document.getElementById('addPageTitle');
                    const addSourceNameInput = document.getElementById('addSourceName');
                    const addPrimaryKeyInput = document.getElementById('addPrimaryKey');
                    const addKeywordsInput = document.getElementById('addKeywords');
                    const addPhrasesInput = document.getElementById('addPhrases');
                    const addLoopSoundCheckbox = document.getElementById('addLoopSound');
                    const addLoopCountInput = document.getElementById('addLoopCount');
                    const addLoopIndefinitelyCheckbox = document.getElementById('addLoopIndefinitely');
                    const addFadeInOutCheckbox = document.getElementById('addFadeInOut');
                    const addEndPlayKeywordsInput = document.getElementById('addEndPlayKeywords');
                    const addNextPageIdSelect = document.getElementById('addNextPageId');
                    const addVolumeInput = document.getElementById('addVolume');
                    const addVolumeValueSpan = document.getElementById('addVolumeValue');
                    const addYoutubeUrlInput = document.getElementById('addYoutubeUrl');
                    const addStartTimeInput = document.getElementById('addStartTime');
                    const addEndTimeInput = document.getElementById('addEndTime');
                    // New preview containers

                    const sourceYoutubeUrlStatus = document.getElementById('sourceYoutubeUrlStatus');
                    const addYoutubeUrlStatus = document.getElementById('addYoutubeUrlStatus');

                    const addSourceTypeRadios = document.querySelectorAll('input[name="addSourceType"]');
                    const addPageFilePreviewContainer = document.getElementById('addPageFilePreviewContainer');
                    const addPageYouTubePreviewContainer = document.getElementById('addPageYouTubePreviewContainer');
                    const sourceFilePreviewContainer = document.getElementById('sourceFilePreviewContainer');
                    const sourceYouTubePreviewContainer = document.getElementById('sourceYouTubePreviewContainer');
                    const addKeywordsInputContainer = document.getElementById('addKeywordsInputContainer');
                    const addPhrasesInputContainer = document.getElementById('addPhrasesInputContainer');
                    const addLoopOptionsContainer = document.getElementById('addLoopOptionsContainer');
                    const addEndPlayKeywordsContainer = document.getElementById('addEndPlayKeywordsContainer');
                    const addFileInputContainer = document.getElementById('addFileInputContainer');
                    const addSourceListUl = document.getElementById('addSourceList');
                    const addYoutubeInputContainer = document.getElementById('addYoutubeInputContainer');
                    const addSyrinscapeInputContainer = document.getElementById('addSyrinscapeInputContainer');
                    const addSyrinscapeSearchInput = document.getElementById('addSyrinscapeSearch');
                    const addSyrinscapeSearchButton = document.getElementById('addSyrinscapeSearchButton');
                    const addSyrinscapeElementIdInput = document.getElementById('addSyrinscapeElementId');
                    const addSyrinscapeKindInput = document.getElementById('addSyrinscapeKind');
                    const addSyrinscapeSelectedSoundSpan = document.getElementById('addSyrinscapeSelectedSound');
                    const addSyrinscapePlayDurationInput = document.getElementById('addSyrinscapePlayDuration');
                    const addTimeOfDaySettingRadios = document.querySelectorAll('input[name="addTimeOfDaySetting"]');
                    const addYoutubeSearchButton = document.getElementById('addYoutubeSearchButton');
                    const addButton = document.getElementById('addButton');
                    const cancelAddButton = document.getElementById('cancelAddButton');

                    // Edit Page Modal
                    const editPageModal = document.getElementById('editPageModal');
                    const editPageIdInput = document.getElementById('editPageId');
                    const editPageTitleInput = document.getElementById('editPageTitle');
                    const editIsStarredCheckbox = document.getElementById('editIsStarred');
                    const editPrimaryKeyInput = document.getElementById('editPrimaryKey');
                    const editKeywordsInput = document.getElementById('editKeywords');
                    const editKeywordsInputContainer = document.getElementById('editKeywordsInputContainer');
                    const editPhrasesInput = document.getElementById('editPhrases');
                    const editPhrasesInputContainer = document.getElementById('editPhrasesInputContainer');
                    const editVolumeInput = document.getElementById('editVolume');
                    const editVolumeValueSpan = document.getElementById('editVolumeValue');
                    const editNextPageIdSelect = document.getElementById('editNextPageId');
                    const editLoopSoundCheckbox = document.getElementById('editLoopSound');
                    const editFadeInOutCheckbox = document.getElementById('editFadeInOut');
                    const editLoopOptionsContainer = document.getElementById('editLoopOptionsContainer');
                    const editLoopCountInput = document.getElementById('editLoopCount');
                    const editLoopIndefinitelyCheckbox = document.getElementById('editLoopIndefinitely');
                    const editEndPlayKeywordsContainer = document.getElementById('editEndPlayKeywordsContainer');
                    const editEndPlayKeywordsInput = document.getElementById('editEndPlayKeywords');
                    const editTimeOfDaySettingRadios = document.querySelectorAll('input[name="editTimeOfDaySetting"]');
                    const editSourceListUl = document.getElementById('editSourceList');
                    const saveEditButton = document.getElementById('saveEditButton');
                    const cancelEditButton = document.getElementById('cancelEditButton');
                    const openAddSourceVariationModalButton = document.getElementById('openAddSourceVariationModalButton');
                    const openAddSourceVariationModalButton_addPage = document.getElementById('openAddSourceVariationModalButton_addPage');

                    // Add/Edit Source Variation Modal
                    const variationSettingsModal = document.getElementById('variationSettingsModal');
                    const sourceVariationModalTitle = document.getElementById('sourceVariationModalTitle');
                    const editingSourceVariationIndexInput = document.getElementById('editingSourceVariationIndex');
                    const sourceVariationSourceTypeRadios = document.querySelectorAll('input[name="sourceVariationSourceType"]');
                    const sourceVariationNameInput = document.getElementById('sourceVariationName');
                    // Per-variation source-type editing (file/YouTube/Syrinscape inputs) was
                    // removed from the variation modal; its orphaned element lookups and the
                    // code paths that used them have been dropped (B4).
                    const sourceVariationKeywordsInput = document.getElementById('sourceVariationKeywords');
                    const sourceYoutubeSearchButton = document.getElementById('sourceYoutubeSearchButton');
                    const sourceVariationEnableVolumeOverrideCheckbox = document.getElementById('sourceVariationEnableVolumeOverride');
                    const sourceVariationVolumeContainer = document.getElementById('sourceVariationVolumeContainer');
                    const sourceVariationVolumeInput = document.getElementById('sourceVariationVolume');
                    const sourceVariationVolumeValueSpan = document.getElementById('sourceVariationVolumeValue');
                    const saveSourceVariationButton = document.getElementById('saveSourceVariationButton');
                    const cancelSourceVariationButton = document.getElementById('cancelSourceVariationButton');

                    const sourceVariationIsDefaultCheckbox = document.getElementById('sourceVariationIsDefault');

                    // Manage Sources (Sub-Variations) Modal
                    const manageSourcesModal = document.getElementById('manageSourcesModal');
                    const manageSourcesModalTitle = document.getElementById('manageSourcesModalTitle');
                    const managingSourcesVariationIndexInput = document.getElementById('managingSourcesVariationIndex');
                    const openAddSourceModalButton = document.getElementById('openAddSourceModalButton');
                    const subVariationSourceListUl = document.getElementById('subVariationSourceList');
                    const closeManageSourcesModalButton = document.getElementById('closeManageSourcesModalButton');

                    // Add/Edit Source (Sub-Variation) Modal
                    const addEditSourceModal = document.getElementById('addEditSourceModal');
                    const sourceModalTitle = document.getElementById('sourceModalTitle');
                    const editingSourceIndexInput = document.getElementById('editingSourceIndex');
                    const sourceFileInput = document.getElementById('sourceFile');
                    const existingSourceFileSpan = document.getElementById('existingSourceFile');
                    const sourceYoutubeUrlInput = document.getElementById('sourceYoutubeUrl');
                    const sourceStartTimeInput = document.getElementById('sourceStartTime');
                    const sourceEndTimeInput = document.getElementById('sourceEndTime');
                    const sourceSyrinscapeSearchInput = document.getElementById('sourceSyrinscapeSearch');
                    const sourceSyrinscapeSearchButton = document.getElementById('sourceSyrinscapeSearchButton');
                    const sourceSyrinscapeElementIdInput = document.getElementById('sourceSyrinscapeElementId');
                    const sourceSyrinscapeKindInput = document.getElementById('sourceSyrinscapeKind');
                    const sourceSyrinscapeSelectedSoundSpan = document.getElementById('sourceSyrinscapeSelectedSound');
                    const sourceSyrinscapePlayDurationInput = document.getElementById('sourceSyrinscapePlayDuration');
                    const sourceFileInputContainer = document.getElementById('sourceFileInputContainer');
                    const sourceYoutubeInputContainer = document.getElementById('sourceYoutubeInputContainer');
                    const sourceSyrinscapeInputContainer = document.getElementById('sourceSyrinscapeInputContainer');
                    const saveSourceButton = document.getElementById('saveSourceButton');
                    const cancelSourceButton = document.getElementById('cancelSourceButton');
                    // Edit Chapter Modal
                    const editChapterModal = document.getElementById('editChapterModal');
                    const editChapterIdInput = document.getElementById('editChapterId');
                    const editChapterNameInput = document.getElementById('editChapterName');
                    const editChapterIsStarredCheckbox = document.getElementById('editChapterIsStarred');
                    const editChapterKeywordsInput = document.getElementById('editChapterKeywords');
                    const editChapterAutoplayPagesSelect = document.getElementById('editChapterAutoplayPages');
                    const editChapterTagsContainer = document.getElementById('editChapterTagsContainer');
                    const editChapterLeaveSoundsSelect = document.getElementById('editChapterLeaveSounds');
                    const editChapterLeaveTransitionSelect = document.getElementById('editChapterLeaveTransition');
                    const saveChapterEditButton = document.getElementById('saveChapterEditButton');
                    const cancelChapterEditButton = document.getElementById('cancelChapterEditButton');

                    // Edit Collection Modal
                    const editCollectionModal = document.getElementById('editCollectionModal');
                    const editCollectionIdInput = document.getElementById('editCollectionId');
                    const editCollectionNameInput = document.getElementById('editCollectionName'); // Note: editCollectionTagsSelect is already defined above
                    const editCollectionTagsSelect = document.getElementById('editCollectionTags');
                    const saveCollectionEditButton = document.getElementById('saveCollectionEditButton');
                    const cancelCollectionEditButton = document.getElementById('cancelCollectionEditButton');

                    // Guidebook Modal
                    const guidebookModal = document.getElementById('guidebookModal');
                    const closeGuidebookButton = document.getElementById('closeGuidebookButton');

                    // Appendix Modal
                    const appendixModal = document.getElementById('appendixModal');
                    const closeAppendixModalButton = document.getElementById('closeAppendixModalButton');
                    const openAddAppendixEntryModalButton = document.getElementById('openAddAppendixEntryModalButton');
                    const appendixEntryListUl = document.getElementById('appendixEntryList');

                    // Add/Edit Appendix Entry Modal
                    const addEditAppendixEntryModal = document.getElementById('addEditAppendixEntryModal');
                    const cancelAppendixEntryButton = document.getElementById('cancelAppendixEntryButton');
                    const saveAppendixEntryButton = document.getElementById('saveAppendixEntryButton');
                    const appendixTriggerTypeRadios = document.querySelectorAll('input[name="appendixTriggerType"]');
                    const appendixPhraseTriggerContainer = document.getElementById('appendixPhraseTriggerContainer');
                    const appendixPageEventTriggerContainer = document.getElementById('appendixPageEventTriggerContainer');
                    const appendixPageEventTargetList = document.getElementById('appendixPageEventTargetList');
                    const appendixPageEventSearchInput = document.getElementById('appendixPageEventSearchInput');
                    const appendixContextualPhraseTriggerContainer = document.getElementById('appendixContextualPhraseTriggerContainer');
                    const appendixContextualPageTargetList = document.getElementById('appendixContextualPageTargetList');
                    const appendixContextualPageSearchInput = document.getElementById('appendixContextualPageSearchInput');
                    const appendixConditionTriggerContainer = document.getElementById('appendixConditionTriggerContainer');

                    const appendixEffectsContainer = document.getElementById('appendixEffectsContainer');

                    // Appendix Effect Modal
                    const appendixEffectModal = document.getElementById('appendixEffectModal');
                    const appendixEffectModalTitle = document.getElementById('appendixEffectModalTitle');
                    const editingAppendixEffectIndexInput = document.getElementById('editingAppendixEffectIndex');
                    const appendixEffectTypeSelect = document.getElementById('appendixEffectTypeSelect');
                    const appendixEffectParamsContainer = document.getElementById('appendixEffectParamsContainer');
                    const appendixEffectTargetContainer = document.getElementById('appendixEffectTargetContainer');
                    const saveAppendixEffectButton = document.getElementById('saveAppendixEffectButton');
                    const cancelAppendixEffectButton = document.getElementById('cancelAppendixEffectButton');

                    // Story Plotter Modal
                    const storyPlotterModal = document.getElementById('storyPlotterModal');
                    const openStoryPlotterButton = document.getElementById('openStoryPlotterButton');
                    const closeStoryPlotterButton = document.getElementById('closeStoryPlotterButton');
                    const plotterZoomInButton = document.getElementById('plotterZoomInButton');
                    const plotterZoomOutButton = document.getElementById('plotterZoomOutButton');
                    const plotterResetViewButton = document.getElementById('plotterResetViewButton');
                    const plotBoardContainer = document.getElementById('plotBoardContainer');
                    const plotBoardSVG = document.getElementById('plotBoard');

                    // Plot Thread Configuration Menu
                    const plotThreadMenu = document.getElementById('plotThreadMenu');
                    const plotThreadMenuTitle = document.getElementById('plotThreadMenuTitle');
                    const plotThreadTitleInput = document.getElementById('plotThreadTitleInput');
                    const plotThreadKeywordsInput = document.getElementById('plotThreadKeywords'); // This is the correct one to keep
                    const plotThreadTimeConditionButton = document.getElementById('plotThreadTimeConditionButton');
                    const plotThreadTransitionPhrasesInput = document.getElementById('plotThreadTransitionPhrases');
                    const plotThreadSoundSearchInput = document.getElementById('plotThreadSoundSearchInput'); // For sounds
                    const plotThreadSoundsListDiv = document.getElementById('plotThreadSoundsList');
                    // plotThreadConditionSearchInput / plotThreadConditionsList removed: not in current markup, never used (B4)
                    const plotThreadDisableAutoplayCheckbox = document.getElementById('plotThreadDisableAutoplay');
                    const plotThreadTimeChangeButton = document.getElementById('plotThreadTimeChangeButton');
                    const plotThreadEnableReturnCheckbox = document.getElementById('plotThreadEnableReturn');
                    const plotThreadReturnKeywordTypeButton = document.getElementById('plotThreadReturnKeywordTypeButton');
                    const deletePlotThreadButton = document.getElementById('deletePlotThreadButton');
                    const cancelPlotThreadMenuButton = document.getElementById('cancelPlotThreadMenuButton');
                    const savePlotThreadChangesButton = document.getElementById('savePlotThreadChangesButton');

                    // Syrinscape Search Modal Elements
                    const syrinscapeSearchModal = document.getElementById('syrinscapeSearchModal');
                    const syrinscapeSearchQueryInput = document.getElementById('syrinscapeSearchQueryInput');
                    const executeSyrinscapeSearchButton = document.getElementById('executeSyrinscapeSearchButton');
                    const syrinscapeSearchStatusP = document.getElementById('syrinscapeSearchStatus');
                    const syrinscapeSearchResultsUl = document.getElementById('syrinscapeSearchResults');
                    const cancelSyrinscapeSearchButton = document.getElementById('cancelSyrinscapeSearchButton');

                    // YouTube Search Modal Elements
                    const youtubeSearchModal = document.getElementById('youtubeSearchModal');
                    const youtubeSearchQueryInput = document.getElementById('youtubeSearchQueryInput');
                    const executeYoutubeSearchButton = document.getElementById('executeYoutubeSearchButton');
                    const youtubeSearchLoading = document.getElementById('youtubeSearchLoading');
                    const youtubeSearchResultsUl = document.getElementById('youtubeSearchResults');
                    // YouTube search pagination was removed; its DOM elements no longer exist (B4).
                    const youtubeSearchError = document.getElementById('youtubeSearchError');
                    const cancelYoutubeSearchButton = document.getElementById('cancelYoutubeSearchButton');
                    const addSelectedYoutubeVideosButton = document.getElementById('addSelectedYoutubeVideosButton');

                    // YouTube Preview Player State
                    let ytPreviewPlayer;
                    let ytPreviewUpdateInterval;
                    let currentYtPreviewVideoId = null;
                    let currentlyPlayingYtTile = null;

                    // YouTube Search Pagination (removed; buttons no longer in markup, B4)
                    let ytSearchNextPageToken = null;
                    let ytSearchPrevPageToken = null;
                    let ytSearchPageHistory = [];
                    let ytSearchCurrentQuery = '';

                    // --- State Variables ---
                    let audioContext; let recognition;
                    let isListening = false;
                    let isSmartFilteringEnabled = true;
                    let pttActive = false;
                    let lastInterimWordCount = 0;
                    let consumedWordsForUtterance = new Set();

                    // State for "Look-Behind with Conjunction" logic
                    let lookBehindContext = {
                        active: false,
                        page: null, // This seems to be unused, consider removing
                        primaryKeys: [],
                        returnChapterContext: null, // { fromChapterId: string, viaThreadId: string }
                        timestamp: 0
                    };
                    let recentPageEvents = {
                        events: [],
                        timestamp: 0
                    };
                    let appendixConditionStates = {
                        // entryId: { isActive: boolean }
                    };

                    const LOOK_BEHIND_DURATION_MS = 4000; // 4 seconds
                    let currentlyEditingAppendixEffect = null;
                    // Settings state variables
                    let currentListeningMode = 'toggle';
                    let currentAppendixEffects = []; // Temporary state for the modal            
                    let isCompoundPhrasingEnabled = false;
                    let currentKeywordConfidenceThreshold = 0.80;
                    let stopAudioMode = 'indexContinue';
                    // Flag to indicate that autoplay is being triggered due to a time-of-day change.  When set, the
                    // playAutoplayPages function will perform special logic to determine which pages should be
                    // retriggered based on their time-of-day restrictions and variation definitions.  The flag is
                    // toggled within toggleTimeOfDay() and reset immediately after autoplay is processed.
                    let currentMasterVolume = 100;

                    // Flag to indicate that autoplay is being triggered due to a time-of-day change.  When set, the
                    // playAutoplayPages function will perform special logic to determine which pages should be
                    // retriggered based on their time-of-day restrictions and variation definitions.  The flag is
                    // toggled within toggleTimeOfDay() and reset immediately after autoplay is processed.
                    let isTimeChangeAutoplay = false;
                    let stopPhrases = [];
                    let customEnterPhrases = [];
                    let customExitPhrases = [];
                    let daytimeTransitionPhrases = [];
                    let nighttimeTransitionPhrases = [];
                    let autoplayOnClickSetting = 'listening';
                    let youtubeApiKeys = [];
                    let syrinscapeAuthToken = null;
                    let syrinscapePlayerReady = false;
                    let currentSyrinscapeSearchContext = null;
                    let activeSyrinscapePreview = null; // { elementId, kind, name, buttonElement }

                    // YouTube Search State
                    let currentYoutubeSearchContext = null; // 'add' or 'source'
                    let ytNextPageToken = null;
                    let ytPrevPageToken = null; // This is for the API response, not the UI history
                    let ytPageHistory = [];
                    let ytVerificationPlayer = null;
                    let isYtVerifying = false;
                    let recentYoutubeSearches = [];
                    let currentYtVerificationVideoId = null;
                    let ytCurrentQuery = '';

                    // Modal Preview Player State
                    let tempPageForAddModal = null; // Holds the page object while in the Add Page modal
                    let modalPreviewAudio = new Audio();
                    let modalPreviewUpdateInterval = null;
                    let activePreviewContext = null; // { container, type, source }

                    function initializePreviewSliders(container, player) {
                        if (!container || !player || !activePreviewContext) return;
                        const startBar = container.querySelector('.media-preview-start-bar');
                        const endBar = container.querySelector('.media-preview-end-bar');
                        const selectionDiv = container.querySelector('.media-range-selection');
                        const duration = player.duration || (player.getDuration ? player.getDuration() : 0);

                        // Prioritize using the startTime/endTime from the context object, which is more reliable.
                        // Fallback to reading from the input fields.
                        const startTimeFromContext = activePreviewContext.startTime;
                        const endTimeFromContext = activePreviewContext.endTime;

                        if (startTimeFromContext !== null && startTimeFromContext !== undefined && duration > 0) {
                            startBar.value = Math.min(100, (startTimeFromContext / duration) * 100);
                        } else {
                            const timeInputStart = container.closest('.modal-content, .yt-video-item')?.querySelector('.yt-search-start-time, #addStartTime, #sourceStartTime');
                            if (timeInputStart?.value && duration > 0) {
                                startBar.value = Math.min(100, (parseTimeHms(timeInputStart.value) / duration) * 100);
                            }
                        }

                        if (endTimeFromContext !== null && endTimeFromContext !== undefined && duration > 0) {
                            endBar.value = (endTimeFromContext / duration) * 100;
                        } else {
                            const timeInputEnd = container.closest('.modal-content, .yt-video-item')?.querySelector('.yt-search-end-time, #addEndTime, #sourceEndTime');
                            if (timeInputEnd?.value && duration > 0) {
                                endBar.value = (parseTimeHms(timeInputEnd.value) / duration) * 100;
                            }
                        }
                        selectionDiv.style.left = `${startBar.value}%`;
                        selectionDiv.style.width = `${endBar.value - startBar.value}%`;
                    }

                    function resetPreviewSliders(container) {
                        if (!container) return;
                        const startBar = container.querySelector('.media-preview-start-bar');
                        const endBar = container.querySelector('.media-preview-end-bar');
                        const selectionDiv = container.querySelector('.media-range-selection');
                        if (startBar) startBar.value = 0;
                        if (endBar) endBar.value = 100;
                        if (selectionDiv) {
                            selectionDiv.style.left = '0%';
                            selectionDiv.style.width = '100%';
                        }
                    }
                    // --- Modal Preview Player Functions ---
                    function setupFilePreview(file, container) {
                        if (!file || !container) {
                            if (container) container.classList.add('hidden');
                            return;
                        }
                        if (activePreviewContext) stopModalPreview();
                        resetPreviewSliders(container);

                        const objectURL = URL.createObjectURL(file);
                        modalPreviewAudio.src = objectURL;
                        modalPreviewAudio.load();

                        activePreviewContext = {
                            container: container,
                            type: 'audio',
                            source: modalPreviewAudio,
                            urlToRevoke: objectURL
                        };

                        container.classList.remove('hidden');
                        attachModalPreviewListeners(container, modalPreviewAudio);
                        modalPreviewAudio.onloadedmetadata = () => initializePreviewSliders(container, modalPreviewAudio);
                    }

                    function setupYouTubePreview(urlOrVideoId, container, autoplay = false, startTime = null, endTime = null) {
                        if (!urlOrVideoId || !container) {
                            if (container) container.classList.add('hidden');
                            return;
                        }
                        const videoId = urlOrVideoId.includes('youtube.com') || urlOrVideoId.includes('youtu.be') ? extractYouTubeVideoId(urlOrVideoId) : urlOrVideoId;
                        if (!videoId) {
                            container.classList.add('hidden');
                            // If the URL becomes invalid, ensure we stop any active preview
                            if (activePreviewContext && activePreviewContext.container === container) {
                                stopModalPreview();
                            }
                            return;
                        }
                        if (activePreviewContext) stopModalPreview();
                        resetPreviewSliders(container);
                        container.classList.remove('hidden'); // Re-show container in case stopModalPreview hid it

                        // For YouTube, we use the main preview player
                        createOrLoadYtPreviewPlayer(videoId, autoplay);
                        activePreviewContext = {
                            container: container,
                            type: 'youtube',
                            source: ytPreviewPlayer,
                            startTime: startTime,
                            endTime: endTime
                        };

                        container.classList.remove('hidden');
                        attachModalPreviewListeners(container, ytPreviewPlayer);
                    } // This function is correct

                    function attachModalPreviewListeners(container, player) {
                        const playPauseBtn = container.querySelector('.media-preview-play-pause-btn');
                        const scrubBar = container.querySelector('.media-preview-scrub-bar');
                        const goToStartBtn = container.querySelector('.media-preview-goto-start-btn');
                        const startBar = container.querySelector('.media-preview-start-bar');
                        const endBar = container.querySelector('.media-preview-end-bar');
                        const selectionDiv = container.querySelector('.media-range-selection');
                        const timelineContainer = scrubBar.parentElement; // The div containing all sliders
                        const playPauseIcon = playPauseBtn.querySelector('i');

                        const playHandler = () => {
                            if (player.paused || (player.getPlayerState && player.getPlayerState() !== YT.PlayerState.PLAYING && player.getPlayerState() !== YT.PlayerState.BUFFERING)) {
                                if (player.playVideo) player.playVideo(); else player.play();
                            } else {
                                // If it's already playing or buffering, pause it.
                                if (player.pauseVideo) player.pauseVideo(); else player.pause();
                                playPauseIcon.className = 'fas fa-play fa-fw';
                            }
                        };

                        const scrubHandler = () => {
                            const duration = player.duration || (player.getDuration ? player.getDuration() : 0);
                            if (!isNaN(duration) && duration > 0) {
                                const newTime = duration * (scrubBar.value / 100);
                                if (player.seekTo) player.seekTo(newTime, true);
                                else player.currentTime = newTime;
                            }
                        };

                        const timelineClickHandler = (e) => {
                            const rect = timelineContainer.getBoundingClientRect();
                            const clickX = e.clientX - rect.left;
                            const percentage = (clickX / rect.width) * 100;
                            scrubBar.value = percentage;
                            scrubHandler(); // Use the existing scrub handler logic
                        };

                        const goToStartHandler = () => {
                            const duration = player.duration || (player.getDuration ? player.getDuration() : 0);
                            if (!isNaN(duration) && duration > 0) {
                                const startTime = duration * (startBar.value / 100);
                                if (player.seekTo) player.seekTo(startTime, true);
                                else player.currentTime = startTime;
                                updateModalPreviewUI(); // Immediately update UI after seeking
                            }
                        };

                        const updateRangeSelection = () => {
                            const startVal = parseFloat(startBar.value);
                            const endVal = parseFloat(endBar.value);
                            selectionDiv.style.left = `${startVal}%`;
                            selectionDiv.style.width = `${endVal - startVal}%`;
                        };

                        const startHandler = () => {
                            if (parseFloat(startBar.value) >= parseFloat(endBar.value)) {
                                startBar.value = endBar.value;
                            }
                            updateRangeSelection();
                            const duration = player.duration || (player.getDuration ? player.getDuration() : 0);
                            // Find the correct time input associated with this previewer
                            const timeInput = container.closest('.modal-content, .yt-video-item')?.querySelector('.yt-search-start-time, #addStartTime, #sourceStartTime');
                            if (!isNaN(duration) && duration > 0 && timeInput) {
                                const newStartTime = duration * (startBar.value / 100);
                                timeInput.value = formatTime(newStartTime);
                                timeInput.dispatchEvent(new Event('input')); // Trigger input event for any listeners
                            }
                        };

                        const endHandler = () => {
                            if (parseFloat(endBar.value) <= parseFloat(startBar.value)) {
                                endBar.value = startBar.value;
                            }
                            updateRangeSelection();
                            const duration = player.duration || (player.getDuration ? player.getDuration() : 0);
                            // Find the correct time input associated with this previewer
                            const timeInput = container.closest('.modal-content, .yt-video-item')?.querySelector('.yt-search-end-time, #addEndTime, #sourceEndTime');
                            if (!isNaN(duration) && duration > 0 && timeInput) {
                                const newEndTime = duration * (endBar.value / 100);
                                timeInput.value = formatTime(newEndTime);
                                timeInput.dispatchEvent(new Event('input')); // Trigger input event for any listeners
                            }
                        };

                        const timeInputStart = container.closest('.modal-content, .yt-video-item')?.querySelector('.yt-search-start-time, #addStartTime, #sourceStartTime');
                        const timeInputEnd = container.closest('.modal-content, .yt-video-item')?.querySelector('.yt-search-end-time, #addEndTime, #sourceEndTime');

                        if (timeInputStart) {
                            timeInputStart.addEventListener('input', () => {
                                const duration = player.duration || (player.getDuration ? player.getDuration() : 0);
                                const newStartTime = parseTimeHms(timeInputStart.value);
                                if (duration > 0 && newStartTime !== null) {
                                    startBar.value = (newStartTime / duration) * 100;
                                    updateRangeSelection();
                                }
                            });
                        }
                        if (timeInputEnd) {
                            timeInputEnd.addEventListener('input', () => {
                                const duration = player.duration || (player.getDuration ? player.getDuration() : 0);
                                const newEndTime = parseTimeHms(timeInputEnd.value);
                                if (duration > 0 && newEndTime !== null) {
                                    endBar.value = (newEndTime / duration) * 100;
                                    updateRangeSelection();
                                }
                            });
                        }

                        playPauseBtn.onclick = playHandler;
                        scrubBar.oninput = scrubHandler;
                        timelineContainer.onclick = timelineClickHandler;
                        goToStartBtn.onclick = goToStartHandler;
                        startBar.oninput = startHandler;
                        endBar.oninput = endHandler;

                        startModalPreviewInterval();
                    }

                    function updateModalPreviewUI() {
                        if (!activePreviewContext) return;
                        const { container, source, type } = activePreviewContext;
                        const startBar = container.querySelector('.media-preview-start-bar');
                        const endBar = container.querySelector('.media-preview-end-bar');
                        const scrubBar = container.querySelector('.media-preview-scrub-bar');
                        const currentTimeEl = container.querySelector('.media-preview-current-time');
                        const durationEl = container.querySelector('.media-preview-duration');
                        const icon = container.querySelector('.media-preview-play-pause-btn i');

                        const currentTime = type === 'audio' ? source.currentTime : (source.getCurrentTime ? source.getCurrentTime() : 0);
                        const duration = type === 'audio' ? source.duration : (source.getDuration ? source.getDuration() : 0);

                        const isPlaying = type === 'audio' ? !source.paused : (source.getPlayerState && source.getPlayerState() === YT.PlayerState.PLAYING);

                        if (!isNaN(duration) && duration > 0) {
                            scrubBar.value = (currentTime / duration) * 100;
                            currentTimeEl.textContent = formatTime(currentTime);
                            durationEl.textContent = formatTime(duration);

                            // Loop within range logic
                            if (isPlaying) {
                                const startTime = duration * (parseFloat(startBar.value) / 100);
                                // If endBar is at 100%, use the full duration to avoid floating point issues stopping it just before the end.
                                const endTime = (endBar.value >= 100) ? duration : duration * (parseFloat(endBar.value) / 100);

                                // If playback is outside the defined range, loop back to the start.
                                if (currentTime < startTime || currentTime >= endTime) {
                                    if (source.seekTo) source.seekTo(startTime, true);
                                    else source.currentTime = startTime;
                                }
                            }
                        }

                        icon.className = isPlaying ? 'fas fa-pause fa-fw' : 'fas fa-play fa-fw';
                    }

                    function startModalPreviewInterval() { stopModalPreviewInterval(); modalPreviewUpdateInterval = setInterval(updateModalPreviewUI, 250); }
                    function stopModalPreviewInterval() { clearInterval(modalPreviewUpdateInterval); }

                    function stopModalPreview() {
                        if (!activePreviewContext) return;
                        const { container, source, type, urlToRevoke } = activePreviewContext;
                        if (type === 'audio') {
                            source.pause();
                            source.removeAttribute('src'); // More reliable than setting to ''
                            if (urlToRevoke) URL.revokeObjectURL(urlToRevoke);
                        }
                        else if (type === 'youtube' && source && typeof source.stopVideo === 'function') { source.stopVideo(); }
                        stopModalPreviewInterval(); container.classList.add('hidden'); activePreviewContext = null;
                    }

                    // Other state variables
                    let volumeModifiers = {}; // Tracks volume changes from Appendix effects
                    let activeSounds = {}; // Stores data about currently playing sounds { pageId: { node, gainNode, sourceDetail, startedByAutoplay, isPlotThreadSound, onEndedCallback, isCompoundSequence, syrinscapeTimeoutId, syrinscapeTimeoutInstanceId } }
                    let youtubePlayers = {}; // Stores YouTube player instances { playerId: playerInstance }
                    let soundCooldowns = {}; // { pageId: timeoutId }
                    const SMART_COOLDOWN_MS = 1000;
                    const QUICK_COOLDOWN_MS = 200;
                    let currentSearchTerm = '';
                    let recognitionStarted = false;
                    // Speech-recognition restart backoff (ANALYSIS.md B1). Prevents the
                    // unbounded start->error->restart loop when the mic is unavailable or
                    // the browser's cloud recognition can't be reached (e.g. offline).
                    let srRestartAttempts = 0;
                    let srRestartTimer = null;
                    let srNetworkErrorCount = 0;
                    const SR_MAX_RESTART_ATTEMPTS = 8;
                    const SR_RESTART_BASE_MS = 500;
                    const SR_RESTART_MAX_MS = 30000;
                    const FADE_DURATION = 2.0;
                    const MIN_GAIN = 0.0001;
                    let fuseInstance = null;
                    let keywordListForFuse = [];
                    let chapterKeywordList = [];
                    let isGridView = false;
                    let currentlyEditingPageId = null;
                    let currentTimeOfDay = 'day';
                    let activeTagInput = null; // To manage the currently active tag input component
                    let pipWindow = null;
                    let pipCanvasCtx = null;
                    let pipStream = null;

                    // Built-in phrases
                    const BUILT_IN_ENTER_PHRASES = ['enter', 'entering', 'arriving', 'go into', 'going into', 'wandering into', 'arrive', 'move to', 'walk into', 'run into', 'head to', 'opening into', 'teleporting to', 'falling into'];
                    const BUILT_IN_EXIT_PHRASES = ['leave', 'leaving', 'exit', 'exiting', 'depart from', 'departing from'];
                    const PRONOUNS = new Set(['i', 'me', 'my', 'mine', 'myself', 'you', 'your', 'yours', 'yourself', 'yourselves', 'he', 'him', 'his', 'himself', 'she', 'her', 'hers', 'herself', 'it', 'its', 'itself', 'we', 'us', 'our', 'ours', 'ourselves', 'they', 'them', 'their', 'theirs', 'themselves', 'who', 'whom', 'whose', 'which', 'what', 'this', 'that', 'these', 'those']);
                    const IGNORED_WORDS = new Set(['a', 'an', 'the']);

                    // Book Data Structure
                    let book = getDefaultBook();

                    // Fuse.js Options
                    let fuseOptions = {
                        includeScore: true,
                        keys: ['keyword'],
                        threshold: 0.2, // This will be updated based on currentKeywordConfidenceThreshold
                        minMatchCharLength: 3,
                        includeMatches: true
                    };

                    // Story Plotter State
                    let plotBoardView = { x: 0, y: 0, scale: 1.0 };
                    let isPlotBoardPanning = false;
                    let lastPanPosition = { x: 0, y: 0 };
                    let activePlotNodes = [];
                    let isDraggingPlotNode = false;
                    let draggedPlotNode = null;
                    let dragPlotNodeOffset = { x: 0, y: 0 };
                    let isReconnectingThread = false;
                    let isDrawingPlotThread = false;
                    let plotThreadStartConnector = null;
                    let plotThreadPreviewLine = null;
                    let currentlySelectedPlotThreadId = null;

                    // --- Web Speech API Setup ---
                    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
                    if (!SpeechRecognition) {
                        showTemporaryMessage('Speech Recognition API not supported. Try Chrome.', 'error', 5000);
                        // Disable relevant buttons if SR not supported
                        [toggleListenButton, stopAllSoundsButton, openSettingsModalButton, openGuidebookModalButton, saveButton, openAddPageModalButton, addChapterButton, timeOfDayButton, openStoryPlotterButton, togglePipButton, openAppendixModalButton].forEach(el => { if (el) el.disabled = true; });
                        const loadLabel = loadFileInput?.closest('label'); if (loadLabel) { loadLabel.classList.add('opacity-50', 'cursor-not-allowed'); }
                        // Disable settings controls as well
                        settingsListeningModeRadios.forEach(radio => radio.disabled = true);
                        settingsSmartFilteringCheckbox.disabled = true;
                        settingsCompoundPhrasingCheckbox.disabled = true;
                        settingsAccuracyThresholdInput.disabled = true;
                        settingsStopAudioModeRadios.forEach(radio => radio.disabled = true);
                        settingsStopPhrasesInput.disabled = true;
                        settingsCustomEnterPhrasesInput.disabled = true;
                        settingsCustomExitPhrasesInput.disabled = true;
                        settingsDaytimePhrasesInput.disabled = true;
                        settingsNighttimePhrasesInput.disabled = true;
                        settingsAutoplayOnClickRadios.forEach(radio => radio.disabled = true);
                        settingsSyrinscapeAuthTokenInput.disabled = true;
                        initializeSyrinscapeButton.disabled = true;
                    } else {
                        recognition = new SpeechRecognition();
                        recognition.continuous = true; // Keep listening even after a pause
                        recognition.interimResults = true; // We want interim results for faster response
                        recognition.lang = 'en-US';

                        recognition.onresult = (event) => {
                            // A result means recognition is working — clear the failure budget (B1).
                            if (srRestartAttempts !== 0 || srNetworkErrorCount !== 0) resetSpeechRetryState();
                            let interimTranscript = "";
                            let finalTranscript = "";

                            for (let i = event.resultIndex; i < event.results.length; ++i) {
                                const transcriptPart = event.results[i][0].transcript;
                                if (event.results[i].isFinal) {
                                    finalTranscript += transcriptPart;
                                } else {
                                    interimTranscript += transcriptPart;
                                }
                            }

                            // Process final transcript first, as it's the most accurate.
                            if (finalTranscript) {
                                const lowerFinal = finalTranscript.trim().toLowerCase();
                                log('Final Transcript:', lowerFinal);
                                if (transcriptDisplay) transcriptDisplay.textContent = `"${finalTranscript.trim()}"`;

                                // Create a string with only the unconsumed words for the final check.
                                const finalWords = lowerFinal.split(/\s+/).filter(Boolean);
                                const unconsumedFinalText = finalWords.filter(word => !consumedWordsForUtterance.has(word)).join(' ');

                                if (unconsumedFinalText) {
                                    log('Processing unconsumed final text:', unconsumedFinalText);
                                    checkForKeywords(unconsumedFinalText, book, false, consumedWordsForUtterance);
                                } else {
                                    log('All words in final transcript were already consumed by interim results.');
                                }

                                consumedWordsForUtterance.clear(); // Clear consumed words for the next full utterance.
                                lastInterimWordCount = 0; // Reset for the next utterance.
                                return;
                            }

                            // Process interim transcript if no final one.
                            if (interimTranscript) {
                                const lowerInterim = interimTranscript.trim().toLowerCase();
                                const currentWords = lowerInterim.split(/\s+/).filter(Boolean);
                                const currentWordCount = currentWords.length;
                                if (transcriptDisplay) transcriptDisplay.textContent = `"${interimTranscript.trim()}..."`;

                                // Check if we have a new block of words to process
                                if (currentWordCount >= lastInterimWordCount + INTERIM_WORD_BLOCK_SIZE) {
                                    // Create a string of all unconsumed words from the *entire* transcript so far.
                                    const textToCheck = currentWords.filter(word => !consumedWordsForUtterance.has(word)).join(' ');
                                    if (textToCheck) {
                                        log(`Interim check at ${currentWordCount} words. Processing unconsumed text:`, textToCheck);
                                        // Pass only the unconsumed text to avoid re-evaluating triggered parts.
                                        // The delay logic is now handled inside checkForKeywords
                                        checkForKeywords(textToCheck, book, true, consumedWordsForUtterance);
                                    }
                                    lastInterimWordCount = currentWordCount;
                                }
                            }
                        };

                        recognition.onerror = (event) => {
                            console.error('SR Error:', event.error, event.message);
                            let msg = `SR error: ${event.error}`;
                            let shouldStop = false;
                            let attemptRestart = isListening; // By default, try to restart if it was listening

                            if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
                                msg = "Microphone access denied.";
                                shouldStop = true; // Definitely stop and don't restart
                                attemptRestart = false;
                            } else if (event.error === 'no-speech') {
                                msg = "No speech detected.";
                                // For 'no-speech', only restart if it was actively listening.
                                // If it was a PTT release that caused 'no-speech', it shouldn't restart.
                                attemptRestart = isListening;
                            } else if (event.error === 'aborted') {
                                // This often happens when recognition.stop() or .abort() is called.
                                // It's usually an intentional stop, so don't show an error message or restart.
                                log("SR aborted (likely intentional).");
                                shouldStop = true;
                                attemptRestart = false;
                            } else if (event.error === 'network') {
                                msg = "Network error during SR.";
                                srNetworkErrorCount++;
                                attemptRestart = isListening; // Restart if was listening
                            } else {
                                // For other errors, attempt restart if it was listening.
                                msg = `SR error: ${event.error}. Attempting restart if listening.`;
                                attemptRestart = isListening;
                            }

                            // Avoid showing message for 'aborted' as it's usually an intentional stop
                            if (event.error !== 'aborted' && (shouldStop || event.error === 'not-allowed' || event.error === 'service-not-allowed')) {
                                showTemporaryMessage(msg, 'error', 5000);
                            } else if (event.error !== 'aborted') {
                                console.warn(`SR non-critical error: ${event.error}`);
                            }


                            if (shouldStop) {
                                stopListening(true); // Pass true to force UI update and recognitionStarted = false
                            } else if (attemptRestart) {
                                // Route through the bounded, backing-off restart funnel (B1)
                                // instead of an unconditional 500ms retry. onend will also
                                // fire; scheduleRecognitionRestart() is idempotent so the two
                                // do not double-restart.
                                scheduleRecognitionRestart();
                            } else if (event.error !== 'aborted') {
                                // If not stopping, not restarting, and not an abort, ensure consistent state
                                isListening = false;
                                recognitionStarted = false;
                                updateUIState();
                            }
                        };


                        recognition.onend = () => {
                            log(`SR ended. isListening: ${isListening}, pttActive: ${pttActive}, mode: ${currentListeningMode}, recognitionStarted: ${recognitionStarted}`);
                            const wasListening = isListening; // Capture state before modification
                            isListening = false; // Recognition has ended, so not actively listening right now

                            // Determine if it should restart based on the original intent (recognitionStarted)
                            // and if PTT was active (for push mode)
                            const shouldBeListening = (currentListeningMode === 'toggle' && recognitionStarted) ||
                                (currentListeningMode === 'push' && pttActive && recognitionStarted);

                            if (shouldBeListening) {
                                log("SR ended but should be listening; scheduling bounded restart...");
                                scheduleRecognitionRestart(); // bounded + backoff (B1)
                            } else {
                                log("SR ended intentionally or not restarting.");
                                recognitionStarted = false; // Ensure this is false if not restarting
                                updateUIState(); // Update UI to reflect stopped state
                            }
                        };

                        recognition.onaudiostart = () => { log('Audio capturing started.'); resetSpeechRetryState(); if (isListening) updateUIState(); };
                        recognition.onaudioend = () => { log('Audio capturing ended.'); };
                        recognition.onspeechstart = () => { log('Speech detected.'); if (isListening && statusDiv) statusDiv.textContent = 'Speech Detected...'; };
                        recognition.onspeechend = () => { log('Speech ended.'); if (isListening && statusDiv) statusDiv.textContent = 'Listening...'; };
                    }

                    // --- Web Audio API Setup ---
                    function initAudioContext() {
                        if (!audioContext) {
                            try {
                                audioContext = new (window.AudioContext || window.webkitAudioContext)();
                                if (audioContext.state === 'suspended') {
                                    audioContext.resume().then(() => log("AudioContext resumed. State:", audioContext.state));
                                }
                                log("AudioContext initialized. State:", audioContext.state);
                            } catch (e) {
                                showTemporaryMessage('Web Audio API not supported.', 'error', 5000);
                                console.error("Error creating AudioContext:", e);
                                return false;
                            }
                        }
                        if (audioContext.state === 'suspended') {
                            const resumeContext = () => {
                                if (audioContext && audioContext.state === 'suspended') {
                                    audioContext.resume().then(() => {
                                        log("AudioContext resumed on interaction. State:", audioContext.state);
                                        document.body.removeEventListener('click', resumeContext);
                                        document.body.removeEventListener('keydown', resumeContext);
                                    });
                                } else { // Already resumed or closed, remove listeners
                                    document.body.removeEventListener('click', resumeContext);
                                    document.body.removeEventListener('keydown', resumeContext);
                                }
                            };
                            // Add event listeners that are removed once triggered or if context is no longer suspended
                            document.body.addEventListener('click', resumeContext, { once: true });
                            document.body.addEventListener('keydown', resumeContext, { once: true });
                            console.warn("AudioContext is suspended. Requires user interaction to resume.");
                        }
                        return true;
                    }

                    // --- Message Box ---
                    // Escape user-controlled strings before interpolating them into innerHTML.
                    // Books are shared as .story files, so a title like <img src=x onerror=...>
                    // would otherwise run arbitrary script in the importer's browser (B6).
                    function escapeHtml(value) {
                        if (value === null || value === undefined) return '';
                        return String(value)
                            .replace(/&/g, '&amp;')
                            .replace(/</g, '&lt;')
                            .replace(/>/g, '&gt;')
                            .replace(/"/g, '&quot;')
                            .replace(/'/g, '&#39;');
                    }

                    function showTemporaryMessage(message, type = 'info', duration = 3000) {
                        messageBox.textContent = message;
                        messageBox.className = ''; // Clear existing classes
                        messageBox.classList.add(`message-${type}`); // Add specific type class
                        messageBox.style.display = 'block';

                        if (messageBox.timeoutId) {
                            clearTimeout(messageBox.timeoutId);
                        }
                        messageBox.timeoutId = setTimeout(() => {
                            messageBox.style.display = 'none';
                            messageBox.timeoutId = null;
                        }, duration);
                    }

                    // --- YouTube Title Fetcher ---
                    function getYouTubeVideoTitle(videoId) {
                        return new Promise((resolve, reject) => {
                            if (!youtubeApiReady) {
                                return reject(new Error("YouTube API not ready."));
                            }
                            const tempPlayerId = `yt-title-fetch-${Date.now()}`;
                            const tempPlayerDiv = document.createElement('div');
                            tempPlayerDiv.id = tempPlayerId;
                            youtubePlayersContainer.appendChild(tempPlayerDiv);

                            const player = new YT.Player(tempPlayerId, {
                                height: '0', width: '0', videoId: videoId,
                                events: {
                                    'onReady': (event) => { resolve(event.target.getVideoData().title); player.destroy(); tempPlayerDiv.remove(); },
                                    'onError': (event) => { reject(new Error(`YouTube player error ${event.data}`)); player.destroy(); tempPlayerDiv.remove(); }
                                }
                            });
                        });
                    }

                    // --- YouTube Fade Out ---
                    function fadeOutYouTube(player, durationSeconds) {
                        if (!player || typeof player.getVolume !== 'function' || typeof player.setVolume !== 'function') {
                            console.warn("Cannot fade YouTube video: player or functions missing.");
                            if (player && typeof player.stopVideo === 'function') player.stopVideo();
                            return;
                        }

                        const initialVolume = player.getVolume();
                        if (initialVolume <= 0) {
                            if (typeof player.stopVideo === 'function') player.stopVideo();
                            return;
                        }

                        const steps = 20;
                        const interval = (durationSeconds * 1000) / steps;
                        let currentStep = 0;

                        const fadeInterval = setInterval(() => {
                            currentStep++;
                            const newVolume = initialVolume * (1 - (currentStep / steps));
                            if (player && typeof player.setVolume === 'function') {
                                player.setVolume(Math.max(0, newVolume));
                            }

                            if (currentStep >= steps) {
                                clearInterval(fadeInterval);
                                if (player && typeof player.stopVideo === 'function') player.stopVideo();
                            }
                        }, interval);
                    }

                    // --- Core Listening Logic ---
                    // --- Speech recognition restart backoff (B1) ---
                    function showPersistentSpeechError(message) {
                        const banner = document.getElementById('speechErrorBanner');
                        if (banner) { banner.textContent = message; banner.classList.remove('hidden'); }
                    }
                    function clearPersistentSpeechError() {
                        const banner = document.getElementById('speechErrorBanner');
                        if (banner) { banner.classList.add('hidden'); banner.textContent = ''; }
                    }
                    // Called when recognition is demonstrably working (got audio or a result),
                    // or when the user manually (re)starts. Resets the failure budget.
                    function resetSpeechRetryState() {
                        srRestartAttempts = 0;
                        srNetworkErrorCount = 0;
                        if (srRestartTimer) { clearTimeout(srRestartTimer); srRestartTimer = null; }
                        clearPersistentSpeechError();
                    }
                    function userStillWantsToListen() {
                        return (currentListeningMode === 'toggle' && recognitionStarted) ||
                            (currentListeningMode === 'push' && pttActive && recognitionStarted);
                    }
                    // Single funnel for all automatic restarts (onerror + onend). Idempotent
                    // (one pending timer at a time), backs off exponentially, and gives up
                    // after SR_MAX_RESTART_ATTEMPTS with a clear, persistent message.
                    function scheduleRecognitionRestart() {
                        if (srRestartTimer) return; // a restart is already pending
                        if (!userStillWantsToListen()) {
                            recognitionStarted = false;
                            isListening = false;
                            updateUIState();
                            return;
                        }
                        if (srRestartAttempts >= SR_MAX_RESTART_ATTEMPTS) {
                            recognitionStarted = false;
                            isListening = false;
                            updateUIState();
                            const offline = !navigator.onLine || srNetworkErrorCount >= 2;
                            showPersistentSpeechError(offline
                                ? "Speech recognition keeps failing. Chrome's built-in recognition needs an internet connection and a working microphone. Offline recognition (Vosk) is planned — see VOSK_PLAN.md."
                                : "Speech recognition stopped after repeated failures. Check that a microphone is connected and permitted, then press the mic button to try again.");
                            return;
                        }
                        srRestartAttempts++;
                        const delay = Math.min(SR_RESTART_BASE_MS * Math.pow(2, srRestartAttempts - 1), SR_RESTART_MAX_MS);
                        console.warn(`Scheduling SR restart #${srRestartAttempts} of ${SR_MAX_RESTART_ATTEMPTS} in ${delay}ms.`);
                        isListening = false;
                        updateUIState();
                        srRestartTimer = setTimeout(() => {
                            srRestartTimer = null;
                            if (userStillWantsToListen()) {
                                startListening();
                            } else {
                                recognitionStarted = false;
                                updateUIState();
                            }
                        }, delay);
                    }

                    function startListening() {
                        if (!recognition) { console.error("SR not available."); return; }
                        if (!initAudioContext()) { showTemporaryMessage("Audio system not ready.", "error"); return; }
                        if (isListening) { log("Already listening or starting."); return; }

                        log("Attempting to start listening...");
                        if (transcriptDisplay) transcriptDisplay.textContent = ''; // Clear previous transcript
                        isListening = true;
                        recognitionStarted = true; // Mark that we've intentionally started it
                        updateUIState();

                        try {
                            recognition.start();
                            log("recognition.start() called.");
                        } catch (error) {
                            isListening = false; // Failed to start
                            recognitionStarted = false; // Failed to start
                            console.error("Error calling recognition.start():", error);
                            if (error.name !== 'InvalidStateError') { // InvalidStateError means it was already started or starting
                                showTemporaryMessage(`Error starting listening: ${error.message}`, 'error');
                            } else {
                                // If it's InvalidStateError, it might already be running from a rapid restart.
                                // We'll assume it's running or will run.
                                console.warn("Tried to start SR when already started/starting (InvalidStateError). Assuming it's running or will run.");
                                isListening = true; // Keep as true if InvalidStateError
                                recognitionStarted = true;
                            }
                            updateUIState();
                        }
                    }

                    function stopListening(forceStopAndUIUpdate = false) {
                        if (!recognition) { console.error("SR not available."); return; }

                        // Only proceed if recognition was started or if we're forcing an update
                        if (recognitionStarted || forceStopAndUIUpdate) {
                            log(`Attempting to stop listening... Current state: isListening=${isListening}, recognitionStarted=${recognitionStarted}`);
                            const wasListening = isListening; // Capture if it was actively in the 'isListening' state

                            isListening = false; // No longer actively listening
                            pttActive = false;   // Ensure PTT is considered off
                            recognitionStarted = false; // Mark that we've intentionally stopped it

                            // Only call abort if it might have been running or trying to start
                            // This check helps prevent errors if abort() is called when recognition is already stopped.
                            if (wasListening) {
                                try {
                                    recognition.abort(); // Use abort to stop immediately
                                    log("recognition.abort() called.");
                                } catch (error) {
                                    // Log error but don't let it break the flow, as the main goal is to set state to stopped.
                                    console.warn("Error calling recognition.abort():", error.name, error.message);
                                }
                            } else {
                                log("Stop request processed, but was not actively in 'isListening' state. Ensured recognitionStarted is false.");
                            }
                            clearAllCooldowns();
                            resetSpeechRetryState(); // cancel any pending auto-restart + clear banner (B1)
                            updateUIState();
                            consumedWordsForUtterance.clear();
                            lastInterimWordCount = 0;
                            if (transcriptDisplay) transcriptDisplay.textContent = ''; // Clear transcript
                        } else {
                            log("Already stopped or not intended to be listening (recognitionStarted is false).");
                        }
                    }


                    // --- UI State Management ---
                    function updateUIState() {
                        const listenButtonIcon = toggleListenButton.querySelector('i');
                        if (isListening) {
                            toggleListenButton.title = "Stop Listening (Spacebar)";
                            toggleListenButton.classList.add('listening');
                            listenButtonIcon.classList.remove('fa-microphone');
                            listenButtonIcon.classList.add('fa-stop-circle');
                            if (statusDiv) statusDiv.textContent = 'Listening...';
                            if (statusDiv) statusDiv.classList.add('text-green-600');
                            if (statusDiv) statusDiv.classList.remove('text-red-600');
                            if (statusDiv) statusDiv.classList.toggle('listening-ptt', currentListeningMode === 'push' && pttActive);
                        } else {
                            toggleListenButton.title = "Start Listening (Spacebar)";
                            toggleListenButton.classList.remove('listening');
                            listenButtonIcon.classList.remove('fa-stop-circle');
                            listenButtonIcon.classList.add('fa-microphone');
                            if (statusDiv) statusDiv.textContent = 'Stopped.';
                            if (statusDiv) statusDiv.classList.add('text-red-600');
                            if (statusDiv) statusDiv.classList.remove('text-green-600');
                            if (statusDiv) statusDiv.classList.remove('listening-ptt');
                        }

                        const timeIcon = timeOfDayButton.querySelector('i');
                        if (currentTimeOfDay === 'day') {
                            timeIcon.className = 'fas fa-sun day fa-fw';
                            timeOfDayButton.title = "Current: Day (Click to switch to Night)";
                        } else {
                            timeIcon.className = 'fas fa-moon night fa-fw';
                            timeOfDayButton.title = "Current: Night (Click to switch to Day)";
                        }
                        updateRelinkButtonVisibility(); // Check if relink button should be visible
                        renderPageList(); // Re-render page list as time restrictions might change appearance
                        drawPipCanvas(); // Update the PiP canvas
                    }

                    function updateRelinkButtonVisibility() {
                        const needsRelink = book.pages.some(p => p.sources.some(s => s.type === 'file' && s.needsFile));
                        relinkFromDropdownButton.classList.toggle('hidden', !needsRelink);
                    }

                    // --- Settings Modal Functions ---
                    function openSettingsModal() {
                        log("Opening Settings modal.");
                        // Populate settings from the 'book.settings' object
                        settingsListeningModeRadios.forEach(radio => {
                            radio.checked = (radio.value === book.settings.listeningMode);
                        });
                        settingsCompoundPhrasingCheckbox.checked = book.settings.compoundPhrasing;

                        const savedKeywordConfidence = book.settings.accuracyThreshold ?? 0.80;
                        settingsAccuracyThresholdInput.value = savedKeywordConfidence * 100;
                        settingsAccuracyValueSpan.textContent = savedKeywordConfidence.toFixed(2);

                        settingsStopAudioModeRadios.forEach(radio => {
                            radio.checked = (radio.value === book.settings.stopAudioMode);
                        });
                        settingsAutoplayOnClickRadios.forEach(radio => {
                            radio.checked = (radio.value === (book.settings.autoplayOnClick || 'listening'));
                        });

                        settingsStopPhrasesInput.value = (book.settings.stopPhrases || []).join(', ');
                        settingsCustomEnterPhrasesInput.value = (book.settings.customEnterPhrases || []).join(', ');
                        settingsCustomExitPhrasesInput.value = (book.settings.customExitPhrases || []).join(', ');
                        settingsDaytimePhrasesInput.value = (book.settings.daytimeTransitionPhrases || []).join(', ');
                        settingsNighttimePhrasesInput.value = (book.settings.nighttimeTransitionPhrases || []).join(', ');
                        settingsSyrinscapeAuthTokenInput.value = book.settings.syrinscapeAuthToken || '';
                        settingsYoutubeApiKeysInput.value = (book.settings.youtubeApiKeys || []).join(', ');

                        // Spotify settings
                        settingsSpotifyClientIdInput.value = book.settings.spotifyClientId || '';
                        updateSpotifyLoginUI();


                        modalOverlay.style.display = 'block';
                        settingsModal.style.display = 'flex';
                    }

                    function closeSettingsModal() {
                        modalOverlay.style.display = 'none';
                        settingsModal.style.display = 'none';
                    }

                    function saveSettings() {
                        log("Saving settings...");
                        const oldKeywordConfidence = book.settings.accuracyThreshold;
                        const oldListeningMode = book.settings.listeningMode;
                        const oldSyrinscapeToken = book.settings.syrinscapeAuthToken;
                        const oldYoutubeKeys = (book.settings.youtubeApiKeys || []).join(',');

                        // Update book.settings from modal inputs
                        book.settings.listeningMode = document.querySelector('input[name="settingsListeningMode"]:checked')?.value || 'toggle';
                        book.settings.compoundPhrasing = settingsCompoundPhrasingCheckbox.checked;
                        book.settings.stopAudioMode = document.querySelector('input[name="settingsStopAudioMode"]:checked')?.value || 'all';
                        book.settings.autoplayOnClick = document.querySelector('input[name="settingsAutoplayOnClick"]:checked')?.value || 'listening';


                        book.settings.stopPhrases = settingsStopPhrasesInput.value.trim().toLowerCase().split(',').map(k => k.trim()).filter(Boolean);
                        book.settings.customEnterPhrases = settingsCustomEnterPhrasesInput.value.trim().toLowerCase().split(',').map(k => k.trim()).filter(Boolean);
                        book.settings.customExitPhrases = settingsCustomExitPhrasesInput.value.trim().toLowerCase().split(',').map(k => k.trim()).filter(Boolean);
                        book.settings.daytimeTransitionPhrases = settingsDaytimePhrasesInput.value.trim().toLowerCase().split(',').map(k => k.trim()).filter(Boolean);
                        book.settings.nighttimeTransitionPhrases = settingsNighttimePhrasesInput.value.trim().toLowerCase().split(',').map(k => k.trim()).filter(Boolean);
                        book.settings.syrinscapeAuthToken = settingsSyrinscapeAuthTokenInput.value.trim() || null;
                        book.settings.youtubeApiKeys = settingsYoutubeApiKeysInput.value.trim().split(',').map(k => k.trim()).filter(Boolean);
                        book.settings.spotifyClientId = settingsSpotifyClientIdInput.value.trim() || null;

                        const newKeywordConfidenceValue = parseFloat(settingsAccuracyThresholdInput.value) / 100;
                        book.settings.accuracyThreshold = isNaN(newKeywordConfidenceValue) ? 0.80 : Math.max(0.5, Math.min(1, newKeywordConfidenceValue));

                        // Update global state variables from book.settings
                        currentListeningMode = book.settings.listeningMode;
                        isCompoundPhrasingEnabled = book.settings.compoundPhrasing;
                        currentKeywordConfidenceThreshold = book.settings.accuracyThreshold;
                        stopAudioMode = book.settings.stopAudioMode;
                        // currentMasterVolume is handled by its own slider, but ensure book.settings.masterVolume is the source of truth
                        stopPhrases = book.settings.stopPhrases;
                        customEnterPhrases = book.settings.customEnterPhrases;
                        customExitPhrases = book.settings.customExitPhrases;
                        daytimeTransitionPhrases = book.settings.daytimeTransitionPhrases;
                        nighttimeTransitionPhrases = book.settings.nighttimeTransitionPhrases;
                        autoplayOnClickSetting = book.settings.autoplayOnClick;
                        youtubeApiKeys = book.settings.youtubeApiKeys;
                        syrinscapeAuthToken = book.settings.syrinscapeAuthToken;

                        // Re-initialize Fuse.js if relevant settings changed
                        if (oldKeywordConfidence !== currentKeywordConfidenceThreshold) {
                            log(`Settings changed affecting Fuse.js. Re-initializing... Min Confidence: ${currentKeywordConfidenceThreshold.toFixed(2)}`);
                            fuseOptions.threshold = 1.0 - currentKeywordConfidenceThreshold; // Update Fuse threshold
                            updateFuseIndex(); // Rebuild index
                        }

                        // Restart listening if mode changed
                        if (isListening && oldListeningMode !== currentListeningMode) {
                            stopListening(true); // Force stop
                            // startListening(); // No, let user restart if they want to
                        } else {
                            updateUIState(); // Just update button appearance
                        }

                        // Handle Syrinscape token change
                        if (oldSyrinscapeToken !== syrinscapeAuthToken) {
                            syrinscapePlayerReady = false; // Needs re-initialization
                            log("Syrinscape Auth Token changed. Player will need re-initialization.");
                            if (syrinscapeAuthToken) {
                                initializeSyrinscapePlayer(); // Attempt re-init if new token provided
                            }
                        }
                        // Reset YouTube API key index if keys have changed
                        if (oldYoutubeKeys !== book.settings.youtubeApiKeys.join(',')) {
                            currentYoutubeApiKeyIndex = 0;
                            log("YouTube API keys changed. Resetting key index.");
                        }


                        saveToLocalStorage();
                        closeSettingsModal();
                        showTemporaryMessage("Settings saved.", "success");
                        log("Settings saved:", book.settings);
                    }

                    // --- Event Listeners (Settings Modal) ---
                    openSettingsModalButton.addEventListener('click', openSettingsModal);
                    cancelSettingsButton.addEventListener('click', closeSettingsModal);
                    saveSettingsButton.addEventListener('click', saveSettings);
                    settingsAccuracyThresholdInput.addEventListener('input', (e) => {
                        const value = parseFloat(e.target.value) / 100;;
                        settingsAccuracyValueSpan.textContent = value.toFixed(2);
                    });
                    // Spotify Settings Listeners
                    spotifyLoginButton.addEventListener('click', redirectToSpotifyLogin);
                    spotifyLogoutButton.addEventListener('click', logoutSpotify);


                    // --- Guidebook Modal Functions ---
                    function openGuidebookModal() {
                        log("Opening Guidebook modal.");
                        guidebookSearchInput.value = ''; // Clear previous search
                        filterGuidebook(); // Apply empty filter to show all
                        modalOverlay.style.display = 'block';
                        guidebookModal.style.display = 'flex';
                    }
                    function closeGuidebookModal() {
                        modalOverlay.style.display = 'none';
                        guidebookModal.style.display = 'none';
                    }

                    // --- Event Listeners (Guidebook Modal) ---
                    openGuidebookModalButton.addEventListener('click', openGuidebookModal);
                    closeGuidebookButton.addEventListener('click', closeGuidebookModal);
                    guidebookSearchInput.addEventListener('input', filterGuidebook);

                    // --- Appendix Modal Functions ---
                    function openAppendixModal() {
                        log("Opening Appendix modal.");
                        renderAppendixList();
                        modalOverlay.style.display = 'block';
                        appendixModal.style.display = 'flex';
                    }
                    function closeAppendixModal() {
                        modalOverlay.style.display = 'none';
                        appendixModal.style.display = 'none';
                        closeAddEditAppendixEntryModal(); // Also close the sub-modal if it's open
                    }
                    openAppendixModalButton.addEventListener('click', openAppendixModal);
                    closeAppendixModalButton.addEventListener('click', closeAppendixModal);

                    // --- Add/Edit Appendix Entry Modal Functions ---
                    function openAddAppendixEntryModal() {
                        log("Opening Add Appendix Entry modal.");
                        document.getElementById('appendixEntryModalTitle').textContent = 'Add Appendix Entry';
                        document.getElementById('editingAppendixEntryId').value = ''; // Ensure we're adding, not editing

                        // Reset name field
                        const nameInput = document.getElementById('appendixEntryName');
                        if (nameInput) nameInput.value = '';

                        // Reset form fields
                        document.getElementById('appendixPhrases').value = '';
                        document.getElementById('appendixPageEvent').value = 'activated';
                        const pageCheckboxes = appendixPageEventTargetList.querySelectorAll('input[name="appendixEventTargetPages"]');
                        pageCheckboxes.forEach(cb => cb.checked = false);
                        document.getElementById('appendixContextualPhrases').value = '';
                        document.getElementById('appendixContextualTimeWindow').value = '5';
                        document.getElementById('appendixContextualAllowMultiple').checked = false;
                        appendixContextualPageTargetList.querySelectorAll('input[type="checkbox"]').forEach(cb => cb.checked = false);
                        document.getElementById('appendixConditionReverseToggle').checked = false;
                        appendixPageEventSearchInput.value = '';
                        handleAppendixPageEventSearch({ target: { value: '' } }); // Reset search filter

                        currentAppendixEffects = []; // Reset temporary effects
                        renderAppendixEffectsList(); // Render the empty list
                        populateAppendixPageEventTargetList();

                        // Reset condition builders for Add/Edit Appendix Entry Modal
                        initializeConditionBuilder('appendixTriggerPageConditionsList', 'appendixOtherTriggerConditions', 'appendixTagTriggerConditions', [], 'appendixTriggerPageConditionSearchInput', 'appendixTriggerTagSearchInput');
                        initializeConditionBuilder('appendixActivationPageConditionsList', 'appendixOtherActivationConditions', 'appendixTagActivationConditions', [], 'appendixActivationPageConditionSearchInput', 'appendixActivationTagSearchInput');




                        // Reset to default trigger type view
                        document.querySelector('input[name="appendixTriggerType"][value="phrase"]').checked = true;
                        appendixPhraseTriggerContainer.classList.remove('hidden');
                        appendixPageEventTriggerContainer.classList.add('hidden');
                        appendixContextualPhraseTriggerContainer.classList.add('hidden');
                        appendixConditionTriggerContainer.classList.add('hidden');
                        appendixConditionTriggerContainer.classList.add('hidden');


                        // Clear out any existing effects from previous openings
                        addEditAppendixEntryModal.style.display = 'flex';
                        appendixModal.style.zIndex = '1005'; // Hide the main appendix modal behind this one
                    }

                    function openAppendixEntryForEdit(entryId) {
                        const entry = book.appendix.find(e => e.id === entryId);
                        if (!entry) {
                            showTemporaryMessage("Could not find appendix entry to edit.", "error");
                            return;
                        }
                        log("Opening Appendix Entry for edit:", entry);

                        // Set modal state for editing
                        document.getElementById('appendixEntryModalTitle').textContent = 'Edit Appendix Entry';
                        document.getElementById('editingAppendixEntryId').value = entry.id;

                        // Populate name
                        const nameInput = document.getElementById('appendixEntryName');
                        if (nameInput) nameInput.value = entry.name || '';


                        // Populate trigger
                        const triggerType = entry.trigger.type;
                        document.querySelector(`input[name="appendixTriggerType"][value="${triggerType}"]`).checked = true;
                        handleAppendixTriggerTypeChange({ target: { value: triggerType } }); // Manually trigger the view change

                        if (triggerType === 'phrase') {
                            document.getElementById('appendixPhrases').value = entry.trigger.phrases.join(', ');
                        } else if (triggerType === 'page_event') {
                            document.getElementById('appendixPageEvent').value = entry.trigger.event;
                            const pageCheckboxes = appendixPageEventTargetList.querySelectorAll('input[name="appendixEventTargetPages"]');
                            pageCheckboxes.forEach(cb => cb.checked = false); // Clear first
                            entry.trigger.pages.forEach(pageId => { const checkbox = appendixPageEventTargetList.querySelector(`input[value="${pageId}"]`); if (checkbox) checkbox.checked = true; });
                        } else if (triggerType === 'chapter_has_tag') {
                            // Legacy trigger type; its UI (appendixTriggerTagSelect) was removed. No-op. (B4)
                        } else if (triggerType === 'contextual_phrase') {
                            document.getElementById('appendixContextualEvent').value = entry.trigger.event;
                            document.getElementById('appendixContextualPhrases').value = entry.trigger.phrases.join(', ');
                            document.getElementById('appendixContextualTimeWindow').value = entry.trigger.timeWindow || 5;
                            document.getElementById('appendixContextualAllowMultiple').checked = entry.trigger.allowMultiple || false;

                            const contextualPageCheckboxes = appendixContextualPageTargetList.querySelectorAll('input[type="checkbox"]'); contextualPageCheckboxes.forEach(cb => cb.checked = false); // Clear first
                            entry.trigger.pages.forEach(pageId => { const checkbox = appendixContextualPageTargetList.querySelector(`input[value="${pageId}"]`); if (checkbox) checkbox.checked = true; });
                        } else if (triggerType === 'condition') {
                            initializeConditionBuilder('appendixTriggerPageConditionsList', 'appendixOtherTriggerConditions', 'appendixTagTriggerConditions', entry.trigger.conditions || [], 'appendixTriggerPageConditionSearchInput', 'appendixTriggerTagSearchInput');
                            document.getElementById('appendixConditionReverseToggle').checked = entry.trigger.reverseOnExit || false;
                        }
                        currentAppendixEffects = JSON.parse(JSON.stringify(entry.effects)); // Deep copy
                        renderAppendixEffectsList();

                        // Populate activation conditions for all types except 'condition'
                        // *** LOG: Check what conditions are being passed to the 'Activation Conditions' builder.
                        // It should be entry.conditions, NOT entry.trigger.conditions.
                        log("LOG: Initializing ACTIVATION conditions with:", entry.conditions);
                        initializeConditionBuilder('appendixActivationPageConditionsList', 'appendixOtherActivationConditions', 'appendixTagActivationConditions', entry.conditions || [], 'appendixActivationPageConditionSearchInput', 'appendixActivationTagSearchInput');

                        addEditAppendixEntryModal.style.display = 'flex';
                        appendixModal.style.zIndex = '1005';
                    }

                    function closeAddEditAppendixEntryModal() {
                        addEditAppendixEntryModal.style.display = 'none';
                        appendixModal.style.zIndex = '1010'; // Restore the z-index of the main appendix modal
                    }

                    function populateAppendixPageEventTargetList() {
                        appendixPageEventTargetList.innerHTML = '';
                        if (book.pages.length === 0) {
                            appendixPageEventTargetList.innerHTML = '<span class="text-xs text-gray-400 italic">No pages in book.</span>';
                            return;
                        }
                        const sortedPages = [...book.pages].sort((a, b) => a.title.localeCompare(b.title));
                        sortedPages.forEach(page => {
                            const label = document.createElement('label');
                            label.title = page.title;
                            label.innerHTML = `
                        <input type="checkbox" name="appendixEventTargetPages" value="${page.id}">
                        <span class="ml-2 truncate">${escapeHtml(page.title)}</span>
                    `;
                            appendixPageEventTargetList.appendChild(label);
                        });
                        // Also populate the contextual one
                        appendixContextualPageTargetList.innerHTML = '';
                        if (book.pages.length === 0) {
                            appendixContextualPageTargetList.innerHTML = '<span class="text-xs text-gray-400 italic">No pages in book.</span>';
                            return;
                        }
                        sortedPages.forEach(page => {
                            const label = document.createElement('label');
                            label.title = page.title;
                            label.innerHTML = `
                        <input type="checkbox" name="appendixContextualTargetPages" value="${page.id}">
                        <span class="ml-2 truncate">${escapeHtml(page.title)}</span>
                    `;
                            appendixContextualPageTargetList.appendChild(label);
                        });
                    }

                    function handleAppendixTriggerTypeChange(event) {
                        const selectedType = document.querySelector('input[name="appendixTriggerType"]:checked')?.value || 'phrase';
                        appendixPhraseTriggerContainer.classList.toggle('hidden', selectedType !== 'phrase');
                        appendixPageEventTriggerContainer.classList.toggle('hidden', selectedType !== 'page_event');
                        appendixContextualPhraseTriggerContainer.classList.toggle('hidden', selectedType !== 'contextual_phrase');
                        appendixConditionTriggerContainer.classList.toggle('hidden', selectedType !== 'condition');

                        // Show/hide activation conditions
                        document.getElementById('appendixActivationConditionsContainer').classList.toggle('hidden', selectedType === 'condition');

                        // Limit effects for 'condition' trigger type
                        const effectTypeSelect = document.getElementById('appendixEffectTypeSelect');
                        limitAppendixEffectsForTrigger(selectedType, effectTypeSelect);
                    }
                    function handleAppendixContextualPageSearch(event) {
                        const searchTerm = event.target.value.toLowerCase();
                        const labels = appendixContextualPageTargetList.querySelectorAll('label');
                        labels.forEach(label => { label.style.display = label.textContent.toLowerCase().includes(searchTerm) ? 'block' : 'none'; });
                    }
                    function handleAppendixPageEventSearch(event) {
                        const searchTerm = event.target.value.toLowerCase();
                        const labels = appendixPageEventTargetList.querySelectorAll('label');
                        labels.forEach(label => {
                            label.style.display = label.textContent.toLowerCase().includes(searchTerm) ? 'block' : 'none';
                        });
                    }
                    openAddAppendixEntryModalButton.addEventListener('click', openAddAppendixEntryModal);
                    cancelAppendixEntryButton.addEventListener('click', closeAddEditAppendixEntryModal);
                    addAppendixEffectButton.addEventListener('click', handleAddAppendixEffect);
                    saveAppendixEffectButton.addEventListener('click', saveAppendixEffect);
                    cancelAppendixEffectButton.addEventListener('click', (e) => { e.stopPropagation(); closeAppendixEffectModal(); });
                    saveAppendixEntryButton.addEventListener('click', saveAppendixEntry); // This one is fine
                    appendixEffectTypeSelect.addEventListener('change', () => {
                        const effectType = appendixEffectTypeSelect.value;
                        const triggerType = document.querySelector('input[name="appendixTriggerType"]:checked')?.value || 'phrase';
                        // Get the current ID from the hidden input to maintain consistency during edits
                        const effectId = document.getElementById('currentAppendixEffectId').value;
                        renderAppendixEffectControls(effectType, appendixEffectParamsContainer, appendixEffectTargetContainer, effectId, {}, triggerType);
                    });
                    appendixTriggerTypeRadios.forEach(radio => radio.addEventListener('change', handleAppendixTriggerTypeChange));
                    appendixPageEventSearchInput.addEventListener('input', handleAppendixPageEventSearch);
                    appendixContextualPageSearchInput.addEventListener('input', handleAppendixContextualPageSearch);

                    function saveAppendixEntry(event) {
                        if (event) event.stopPropagation(); // Prevent event from bubbling up
                        const entryId = document.getElementById('editingAppendixEntryId').value;
                        const isEditing = !!entryId;

                        const triggerType = document.querySelector('input[name="appendixTriggerType"]:checked').value;
                        let trigger = { type: triggerType };
                        let conditions = [];
                        let name = null; // Initialize name

                        // Get the name from the new input field
                        const nameInput = document.getElementById('appendixEntryName');
                        if (nameInput) name = nameInput.value.trim() || null;

                        if (triggerType === 'phrase') {
                            const phrases = document.getElementById('appendixPhrases').value.trim().toLowerCase().split(',').map(p => p.trim()).filter(Boolean);
                            if (phrases.length === 0) { showTemporaryMessage('Trigger phrases cannot be empty.', 'error'); return; }
                            trigger = { type: 'phrase', phrases: phrases };
                        } else if (triggerType === 'page_event') { // This logic remains the same
                            const pages = Array.from(appendixPageEventTargetList.querySelectorAll('input:checked')).map(cb => parseInt(cb.value, 10));
                            if (pages.length === 0) { showTemporaryMessage('Please select at least one target page for the event trigger.', 'error'); return; }
                            trigger = { type: 'page_event', event: document.getElementById('appendixPageEvent').value, pages: pages };
                        } else if (triggerType === 'contextual_phrase') { // This logic is correct
                            const pages = Array.from(appendixContextualPageTargetList.querySelectorAll('input:checked')).map(cb => parseInt(cb.value, 10)); // This logic remains the same
                            const phrases = document.getElementById('appendixContextualPhrases').value.trim().toLowerCase().split(',').map(p => p.trim()).filter(Boolean);
                            const timeWindow = parseInt(document.getElementById('appendixContextualTimeWindow').value, 10) || 5;

                            if (pages.length === 0) { showTemporaryMessage('Please select at least one pre-condition page.', 'error'); return; }
                            if (phrases.length === 0) { showTemporaryMessage('Trigger phrases cannot be empty for a contextual trigger.', 'error'); return; }

                            trigger = { type: 'contextual_phrase', event: document.getElementById('appendixContextualEvent').value, pages, phrases, timeWindow, allowMultiple: document.getElementById('appendixContextualAllowMultiple').checked };
                        } else if (triggerType === 'condition') {
                            const conditionsFromBuilder = getConditionsFromBuilder('appendixTriggerPageConditionsList', 'appendixOtherTriggerConditions', 'appendixTagTriggerConditions');
                            if (conditionsFromBuilder.length === 0) { showTemporaryMessage('Please add at least one condition for the trigger.', 'error'); return; }
                            const reverseOnExit = document.getElementById('appendixConditionReverseToggle').checked;
                            trigger.conditions = conditionsFromBuilder;
                            trigger.reverseOnExit = reverseOnExit;
                        }

                        // Get activation conditions if applicable
                        if (triggerType !== 'condition') {
                            conditions = getConditionsFromBuilder('appendixActivationPageConditionsList', 'appendixOtherActivationConditions', 'appendixTagActivationConditions');
                        }

                        // *** LOG: Check the state of the trigger and conditions objects right before saving.
                        log("LOG (SAVE): Trigger object being saved:", JSON.parse(JSON.stringify(trigger)));
                        log("LOG (SAVE): Activation conditions array being saved:", JSON.parse(JSON.stringify(conditions)));

                        // Use the temporary state array directly, creating a deep copy to be safe.
                        const effects = JSON.parse(JSON.stringify(currentAppendixEffects));

                        if (effects.length === 0) { showTemporaryMessage('An appendix entry must have at least one effect.', 'error'); return; }

                        const entryIndex = isEditing ? book.appendix.findIndex(e => e.id === entryId) : -1;
                        if (entryIndex > -1) { // This logic is correct
                            book.appendix[entryIndex].name = name;
                            book.appendix[entryIndex].trigger = trigger;
                            book.appendix[entryIndex].effects = effects;
                            book.appendix[entryIndex].conditions = conditions; // Save activation conditions
                            showTemporaryMessage('Appendix entry updated.', 'success');
                            log("Updated appendix entry:", JSON.parse(JSON.stringify(book.appendix[entryIndex])));
                        } else {
                            const newEntry = { id: `appendix_${generateUUID()}`, name, trigger, effects, conditions };
                            if (!book.appendix) book.appendix = []; // Ensure appendix array exists
                            book.appendix.push(newEntry);
                            showTemporaryMessage(`Appendix entry saved.`, 'success');
                            log("Saved new appendix entry:", newEntry);
                        }

                        saveToLocalStorage();
                        renderAppendixList(); // Update the list in the background
                        evaluateAppendixStateTriggers(); // Re-evaluate all conditions immediately
                        closeAddEditAppendixEntryModal();
                    }

                    function renderAppendixList(event) {
                        if (event) event.stopPropagation();
                        appendixEntryListUl.innerHTML = '';
                        if (!book.appendix || book.appendix.length === 0) {
                            appendixEntryListUl.innerHTML = '<li class="text-center py-4 italic text-gray-400">No appendix entries found.</li>';
                            return;
                        }

                        book.appendix.forEach(entry => {
                            const li = document.createElement('li');
                            li.className = 'page-item !cursor-default'; // Re-use page-item style for consistency

                            let triggerText = '';
                            if (entry.trigger.type === 'phrase') {
                                const phrasesToShow = entry.trigger.phrases.slice(0, 2).join('", "');
                                const ellipsis = entry.trigger.phrases.length > 2 ? '...' : '';
                                const entryName = entry.name ? `<strong class="text-stone-200">${escapeHtml(entry.name)}</strong><br>` : '';
                                triggerText = `${entryName}<strong>Phrase:</strong> "${phrasesToShow}${ellipsis}"`;
                            } else if (entry.trigger.type === 'page_event') {
                                const pageNames = entry.trigger.pages
                                    .map(pId => book.pages.find(p => p.id === pId)?.title || `ID ${pId}`)
                                    .join(', ');
                                const eventName = entry.trigger.event === 'activated' ? 'Activated' : 'Stopped';
                                triggerText = `<strong>On Page ${eventName}:</strong> ${pageNames}`;
                            } else if (entry.trigger.type === 'contextual_phrase') {
                                const pageNames = entry.trigger.pages.map(pId => book.pages.find(p => p.id === pId)?.title || `ID ${pId}`).slice(0, 1).join(', ');
                                const pageEllipsis = entry.trigger.pages.length > 2 ? '...' : '';
                                const eventName = entry.trigger.event === 'activated' ? 'Activated' : 'Stopped';
                                const phraseToShow = entry.trigger.phrases[0];
                                triggerText = `<strong>On Page ${eventName} (${pageNames}${pageEllipsis}), then Phrase:</strong> "${phraseToShow}..."`;
                            } else if (entry.trigger.type === 'condition') {
                                const conditionCount = entry.trigger.conditions.length;
                                const reverseText = entry.trigger.reverseOnExit ? ' (Reversible)' : '';
                                triggerText = `<strong>Condition Met:</strong> ${conditionCount} condition(s)${reverseText}`;
                            }

                            const effectsText = entry.effects.map(eff => eff.type.replace(/_/g, ' ')).join(', ');

                            li.innerHTML = `
                        <div class="flex justify-between items-center">
                            <div class="flex-grow min-w-0">
                                <p class="text-sm truncate" title="${triggerText.replace(/<[^>]*>/g, '')}">${triggerText}</p>
                                <p class="text-xs text-gray-400 truncate" title="Effects: ${effectsText}"><i class="fas fa-magic mr-1"></i> ${effectsText || 'No effects'}</p>
                            </div>
                            <div class="flex-shrink-0 ml-4 space-x-2">
                                <button class="btn-rpg-sm-icon edit-appendix-entry-button" title="Edit Entry"><i class="fas fa-pencil-alt"></i></button>
                                <button class="btn-rpg-sm-icon btn-danger-sm delete-appendix-entry-button" title="Delete Entry"><i class="fas fa-trash-alt"></i></button>
                            </div>
                        </div>
                    `;

                            li.querySelector('.edit-appendix-entry-button').addEventListener('click', () => openAppendixEntryForEdit(entry.id));
                            li.querySelector('.delete-appendix-entry-button').addEventListener('click', () => deleteAppendixEntry(entry.id));

                            appendixEntryListUl.appendChild(li);
                        });
                    }

                    function deleteAppendixEntry(entryId) {
                        const entryIndex = book.appendix.findIndex(entry => entry.id === entryId);
                        if (entryIndex === -1) {
                            showTemporaryMessage("Could not find appendix entry to delete.", "error");
                            return;
                        }

                        const entry = book.appendix[entryIndex];
                        const triggerText = entry.trigger.type === 'phrase' ? `the phrase trigger "${entry.trigger.phrases[0]}..."` : `the page event trigger`;

                        if (!confirm(`Are you sure you want to delete ${triggerText}? This cannot be undone.`)) return;

                        book.appendix.splice(entryIndex, 1);
                        saveToLocalStorage();
                        renderAppendixList();
                        showTemporaryMessage("Appendix entry deleted.", "success");
                        log(`Deleted appendix entry ID: ${entryId}`);
                    }

                    function renderAppendixEffectsList() {
                        appendixEffectsContainer.innerHTML = '';
                        if (currentAppendixEffects.length === 0) {
                            appendixEffectsContainer.innerHTML = '<li class="text-center py-4 italic text-sm text-gray-400">No effects added yet.</li>';
                            return;
                        }

                        currentAppendixEffects.forEach((effect, index) => {
                            const li = document.createElement('li');
                            li.className = 'page-item !cursor-default !py-2 !px-3';
                            const effectName = effect.type.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
                            li.innerHTML = `
                        <div class="flex justify-between items-center">
                            <span class="font-semibold text-sm text-stone-300">${effectName}</span>
                            <div class="space-x-2">
                                <button class="btn-rpg-sm-icon edit-appendix-effect-button" data-index="${index}" title="Edit Effect"><i class="fas fa-pencil-alt"></i></button>
                                <button class="btn-rpg-sm-icon btn-danger-sm delete-appendix-effect-button" data-index="${index}" title="Delete Effect"><i class="fas fa-trash-alt"></i></button>
                            </div>
                        </div>
                    `;
                            li.querySelector('.edit-appendix-effect-button').addEventListener('click', (e) => openAppendixEffectModal(index, e));
                            li.querySelector('.delete-appendix-effect-button').addEventListener('click', () => {
                                currentAppendixEffects.splice(index, 1);
                                renderAppendixEffectsList();
                            });
                            appendixEffectsContainer.appendChild(li);
                        });
                    }

                    function handleAddAppendixEffect() {
                        openAppendixEffectModal(null, event);
                    }


                    function openAppendixEffectModal(effectIndex = null, event = null) {
                        if (event) event.stopPropagation();
                        const isEditing = effectIndex !== null;
                        editingAppendixEffectIndexInput.value = isEditing ? effectIndex : '';

                        appendixEffectModalTitle.textContent = isEditing ? 'Edit Effect' : 'Add Effect';
                        const effectData = isEditing ? currentAppendixEffects[effectIndex] : {};
                        // Store the full data object on the select element's dataset for easy access
                        // when rendering controls. This avoids having to pass it around.
                        appendixEffectTypeSelect.dataset.effectData = JSON.stringify(effectData);
                        const effectType = effectData.type || 'start_pages';
                        appendixEffectTypeSelect.value = effectType;
                        limitAppendixEffectsForTrigger(document.querySelector('input[name="appendixTriggerType"]:checked')?.value || 'phrase', appendixEffectTypeSelect);

                        const effectId = effectData.id || `effect_${generateUUID()}`;
                        document.getElementById('currentAppendixEffectId').value = effectId; // Store the ID

                        // Pass the full effectData to the rendering function and the current trigger type
                        renderAppendixEffectControls(effectType, appendixEffectParamsContainer, appendixEffectTargetContainer, effectId, effectData);

                        appendixEffectModal.style.display = 'flex';
                        addEditAppendixEntryModal.style.zIndex = '1005';
                    }

                    function closeAppendixEffectModal(event) {
                        if (event) event.stopPropagation();
                        appendixEffectModal.style.display = 'none';
                        addEditAppendixEntryModal.style.zIndex = '1010';
                    }

                    function renderAppendixEffectControls(effectType, paramsContainer, targetContainer, effectId, effectData = {}, triggerType = 'phrase') {
                        paramsContainer.innerHTML = '';
                        targetContainer.innerHTML = '';

                        const isConditionTrigger = triggerType === 'condition';

                        effectData.type = effectType;
                        effectData.params = effectData.params || {};
                        effectData.target = effectData.target || {};

                        const createPageSelector = (container, id) => {
                            const isStartPages = effectData.type === 'start_pages';
                            const playSequentially = isStartPages && (effectData.params?.playSequentially || false);

                            let sequentialHtml = '';
                            let sequentialUiContainerHtml = '';

                            if (isStartPages) {
                                sequentialHtml = `
                            <label class="flex items-center text-sm">
                                <input type="checkbox" class="appendix-play-sequentially" ${playSequentially ? 'checked' : ''}>
                                <span class="ml-2">Play Sequentially (in order of selection)</span>
                            </label>
                        `;
                                sequentialUiContainerHtml = `
                            <div id="appendix-sequential-ui" class="${playSequentially ? '' : 'hidden'}">
                                <ul id="appendix-selected-pages-list" class="chapter-checkbox-list !max-h-28 border-dashed border-2 border-stone-600 mt-2">
                                    <!-- Selected pages will be rendered here -->
                                </ul>
                            </div>
                        `;
                            }

                            container.innerHTML = `
                        <div class="flex justify-between items-center mb-2">
                            <label class="block text-sm font-medium mb-1">Target Pages:</label>
                            ${sequentialHtml}
                        </div>
                        ${sequentialUiContainerHtml}
                        <input type="search" class="appendix-page-search-input text-sm !py-1 mt-2" placeholder="Search pages to add/remove...">
                        <div class="chapter-checkbox-list mt-2 appendix-page-list">
                            ${book.pages.length > 0
                                    ? book.pages.sort((a, b) => a.title.localeCompare(b.title)).map(page => `
                                    <label title="${escapeHtml(page.title)}">
                                        <input type="checkbox" name="appendixEffectPages_${id}" value="${page.id}">
                                        <span class="ml-2 truncate">${escapeHtml(page.title)}</span> </label> `).join('') : '<span class="text-xs text-gray-400 italic">No pages in book.</span>'
                                }
                        </div>
                        <div class="mt-2 space-y-1">
                            <label class="flex items-center text-sm"><input type="checkbox" class="appendix-affect-all-pages"><span class="ml-2">Affect All Pages</span></label>
                            <label class="flex items-center text-sm"><input type="checkbox" class="appendix-only-active-pages"><span class="ml-2">Only Affect Active Pages</span></label>
                        </div>
                    `;

                            const allPagesList = container.querySelector('.appendix-page-list');
                            allPagesList.innerHTML = ''; // Clear and rebuild with variation selectors

                            book.pages.sort((a, b) => a.title.localeCompare(b.title)).forEach(page => {
                                const template = document.getElementById('appendixEffectTemplate');
                                const itemClone = template.content.querySelector('.appendix-page-selector-item').cloneNode(true);
                                const checkbox = itemClone.querySelector('.page-checkbox');
                                const titleSpan = itemClone.querySelector('.page-title');
                                const variationSelect = itemClone.querySelector('.variation-select');

                                checkbox.value = page.id;
                                titleSpan.textContent = page.title;

                                if (page.sources && page.sources.length > 1) {
                                    variationSelect.classList.remove('hidden');
                                    variationSelect.add(new Option('Any Variation', ''));
                                    page.sources.forEach((variation, index) => {
                                        const variationName = variation.name || `Variation ${index + 1}`;
                                        variationSelect.add(new Option(variationName, variation.id));
                                    });
                                }

                                // Check if this page was selected in the effect data
                                const selectedPageData = effectData.target?.pages?.find(p => p.pageId === page.id);
                                if (selectedPageData) {
                                    checkbox.checked = true;
                                    if (selectedPageData.variationId && variationSelect) {
                                        variationSelect.value = selectedPageData.variationId;
                                    }
                                }

                                allPagesList.appendChild(itemClone);
                            });



                            const searchInput = container.querySelector('.appendix-page-search-input');

                            // Common search logic
                            searchInput.addEventListener('input', () => {
                                const searchTerm = searchInput.value.toLowerCase();
                                const labels = allPagesList.querySelectorAll('label');
                                labels.forEach(label => {
                                    const pageTitle = label.textContent.toLowerCase();
                                    label.style.display = pageTitle.includes(searchTerm) ? 'block' : 'none';
                                });
                            });

                            if (isStartPages) {
                                const sequentialCheckbox = container.querySelector('.appendix-play-sequentially');
                                const sequentialUi = container.querySelector('#appendix-sequential-ui');
                                const selectedPagesList = container.querySelector('#appendix-selected-pages-list');

                                const renderSelectedList = () => {
                                    if (!selectedPagesList) return;
                                    selectedPagesList.innerHTML = '';
                                    const selectedIds = effectData.target?.pages?.map(p => p.pageId) || [];
                                    if (selectedIds.length === 0) {
                                        selectedPagesList.innerHTML = '<li class="text-xs text-gray-500 italic text-center">No pages selected.</li>';
                                        return;
                                    }
                                    selectedIds.forEach((pageId, index) => {
                                        const page = book.pages.find(p => p.id === pageId);
                                        if (page) { // This check is correct
                                            const li = document.createElement('li'); li.className = 'flex justify-between items-center p-1 bg-stone-700 rounded my-1 gap-2';
                                            li.dataset.pageId = page.id;
                                            li.innerHTML = `
                                        <span class="flex-grow">${escapeHtml(page.title)}</span>
                                        <div class="flex-shrink-0 flex items-center gap-2">
                                            <button type="button" class="appendix-reorder-btn move-up-btn" title="Move Up" ${index === 0 ? 'disabled' : ''}>&uarr;</button>
                                            <button type="button" class="appendix-reorder-btn move-down-btn" title="Move Down" ${index === selectedIds.length - 1 ? 'disabled' : ''}>&darr;</button>
                                            <button type="button" class="text-red-400 hover:text-red-600 remove-from-queue-btn text-lg leading-none" title="Remove">&times;</button>
                                        </div>`;

                                            li.querySelector('.move-up-btn').addEventListener('click', (e) => {
                                                e.stopPropagation();
                                                const pageIdToMove = parseInt(li.dataset.pageId, 10);
                                                const pages = effectData.target.pages; // Use the main effectData
                                                const currentIndex = pages.findIndex(p => p.pageId === pageIdToMove);
                                                if (currentIndex > 0) {
                                                    [pages[currentIndex], pages[currentIndex - 1]] = [pages[currentIndex - 1], pages[currentIndex]]; // Swap
                                                    renderSelectedList(); // Re-render the list
                                                }
                                            });

                                            li.querySelector('.move-down-btn').addEventListener('click', (e) => {
                                                e.stopPropagation();
                                                const pageIdToMove = parseInt(li.dataset.pageId, 10);
                                                const pages = effectData.target.pages; // Use the main effectData
                                                const currentIndex = pages.findIndex(p => p.pageId === pageIdToMove);
                                                if (currentIndex > -1 && currentIndex < pages.length - 1) {
                                                    [pages[currentIndex], pages[currentIndex + 1]] = [pages[currentIndex + 1], pages[currentIndex]]; // Swap
                                                    renderSelectedList(); // Re-render the list
                                                }
                                            });

                                            selectedPagesList.appendChild(li);
                                        }
                                    });
                                };

                                allPagesList.addEventListener('change', (e) => {
                                    if (e.target.type === 'checkbox') {
                                        if (!effectData.target) effectData.target = {};
                                        if (!effectData.target.pages) effectData.target.pages = [];
                                        const pageId = parseInt(e.target.value, 10);
                                        const index = effectData.target.pages.findIndex(p => p.pageId === pageId);

                                        if (e.target.checked && index === -1) {
                                            const variationSelect = e.target.closest('.appendix-page-selector-item').querySelector('.variation-select');
                                            effectData.target.pages.push({ pageId: pageId, variationId: variationSelect ? variationSelect.value : null });
                                        } else if (!e.target.checked && index > -1) {
                                            effectData.target.pages.splice(index, 1);
                                        }
                                        renderSelectedList();
                                    }
                                });
                                if (selectedPagesList) {
                                    selectedPagesList.addEventListener('click', (e) => {
                                        if (e.target.closest('.remove-from-queue-btn')) {
                                            const li = e.target.closest('li');
                                            const pageId = parseInt(li.dataset.pageId, 10);
                                            effectData.target.pages = (effectData.target.pages || []).filter(p => p.pageId !== pageId);
                                            // Uncheck the corresponding checkbox in the main list
                                            const mainCheckbox = allPagesList.querySelector(`.page-checkbox[value="${pageId}"]`);
                                            if (mainCheckbox) mainCheckbox.checked = false;
                                            renderSelectedList();
                                        }
                                    });

                                    let draggedItem = null;
                                    selectedPagesList.addEventListener('dragstart', e => {
                                        if (e.target.tagName === 'LI') {
                                            draggedItem = e.target;
                                            e.dataTransfer.effectAllowed = 'move';
                                            // No need to set data, we're reordering within the same list
                                            setTimeout(() => e.target.style.opacity = '0.5', 0);
                                        }
                                    });
                                    selectedPagesList.addEventListener('dragend', e => { if (e.target.tagName === 'LI') { e.target.style.opacity = '1'; } });
                                    selectedPagesList.addEventListener('dragover', e => {
                                        e.preventDefault();
                                        const afterElement = getDragAfterElement(selectedPagesList, e.clientY);
                                        if (draggedItem) {
                                            if (afterElement == null) { selectedPagesList.appendChild(draggedItem); } else { selectedPagesList.insertBefore(draggedItem, afterElement); }
                                        }
                                    });
                                    selectedPagesList.addEventListener('drop', e => {
                                        if (draggedItem) {
                                            const newOrderIds = Array.from(selectedPagesList.querySelectorAll('li[data-page-id]')).map(li => parseInt(li.dataset.pageId, 10));
                                            // Reorder the actual data array to match the new visual order
                                            effectData.target.pages.sort((a, b) => newOrderIds.indexOf(a.pageId) - newOrderIds.indexOf(b.pageId));
                                            draggedItem = null;
                                        }
                                    });
                                }

                                if (sequentialCheckbox) {
                                    if (sequentialUi) {
                                        sequentialCheckbox.addEventListener('change', () => {
                                            effectData.params.playSequentially = sequentialCheckbox.checked;
                                            sequentialUi.classList.toggle('hidden', !sequentialCheckbox.checked);
                                            renderSelectedList(); // Populate list when checkbox is toggled
                                        });
                                    }
                                }

                                renderSelectedList();
                            } else {
                                // This part is now handled by the unified checkbox logic above.
                            }
                        };

                        const createChapterSelector = (container, id) => {
                            // This function remains the same as it's only used for volume effects
                            // ... (omitted for brevity, no changes needed here)
                        };

                        switch (effectType) {

                            case 'play_soundtrack':
                                paramsContainer.innerHTML = '<label class="block text-sm font-medium mb-1 mt-2">Select Soundtrack:</label><select class="appendix-st-select bg-stone-900 border border-stone-700 rounded px-2 py-1 w-full text-sm"></select>';
                                const stSelect = paramsContainer.querySelector('.appendix-st-select');
                                stSelect.innerHTML = '<option value="">-- Select --</option>';
                                (book.soundtracks || []).forEach(st => {
                                    stSelect.innerHTML += '<option value="' + st.id + '">' + escapeHtml(st.name) + '</option>';
                                });
                                if (params && params.soundtrackId) stSelect.value = params.soundtrackId;
                                targetContainer.innerHTML = '<p class="text-xs text-gray-500 mt-2">Target: Global Context (Audio System)</p>';
                                break;
                            case 'stop_soundtrack':
                                paramsContainer.innerHTML = '<p class="text-xs text-gray-500 mt-2">Stops the currently playing soundtrack.</p>';
                                targetContainer.innerHTML = '<p class="text-xs text-gray-500 mt-2">Target: Global Context (Audio System)</p>';
                                break;
                            case 'start_pages':
                            case 'end_pages':
                            case 'reset_volume':
                                createPageSelector(targetContainer, effectId);
                                break;


                            case 'play_soundtrack':
                                const stSel = paramsContainer.querySelector('.appendix-st-select');
                                if (stSel) params.soundtrackId = stSel.value;
                                break;
                            case 'stop_soundtrack':
                                break;
                            case 'increase_volume':
                            case 'decrease_volume':
                                paramsContainer.innerHTML = `
                            <label for="appendixVolumeMod_${effectId}" class="block text-sm font-medium mb-1">Amount (1-100):</label>
                            <input type="number" id="appendixVolumeMod_${effectId}" class="appendix-volume-modifier" min="1" max="100" value="10">
                        `;
                                targetContainer.innerHTML = `
                            <label class="block text-sm font-medium mb-1">Apply To:</label>
                            <select class="appendix-volume-target-type">
                                <option value="pages">Specific Pages</option>
                                <option value="chapters">Specific Chapters</option>
                                <option value="master">Master Volume</option>
                            </select>
                            <div class="appendix-volume-target-selector mt-2"></div>
                        `;
                                const targetTypeSelect = targetContainer.querySelector('.appendix-volume-target-type');
                                const targetSelectorDiv = targetContainer.querySelector('.appendix-volume-target-selector');
                                targetTypeSelect.addEventListener('change', (e) => {
                                    if (e.target.value === 'pages') createPageSelector(targetSelectorDiv, effectId);
                                    else if (e.target.value === 'chapters') createChapterSelector(targetSelectorDiv, effectId);
                                    else targetSelectorDiv.innerHTML = '';
                                });
                                createPageSelector(targetSelectorDiv, effectId);
                                break;

                            case 'change_chapter':
                                paramsContainer.innerHTML = `
                            <label for="appendixChapterTarget_${effectId}" class="block text-sm font-medium mb-1">Target Chapter:</label>
                            ${isConditionTrigger ? `<p class="text-xs text-gray-400 mb-2">Warning: Using 'Change Chapter' in a reversible Condition trigger can cause rapid, unintended chapter switching if not designed carefully.</p>` : ''}
                            <select id="appendixChapterTarget_${effectId}">
                                ${book.chapters.sort((a, b) => a.name.localeCompare(b.name)).map(ch => `<option value="${ch.id}">${escapeHtml(ch.name)}</option>`).join('')}
                            </select>
                        `;
                                break;

                            case 'set_time':
                                paramsContainer.innerHTML = `
                            <label class="block text-sm font-medium mb-1">Set Time To:</label>
                            <div class="time-of-day-options !gap-2 !mt-1">
                                <label><input type="radio" name="appendixTimeSet_${effectId}" value="day" checked> <i class="fas fa-sun day"></i> Day</label>
                                <label><input type="radio" name="appendixTimeSet_${effectId}" value="night"> <i class="fas fa-moon night"></i> Night</label>
                            </div>`;
                                break;

                            case 'toggle_time':
                                // No parameters or targets needed for a global time toggle
                                paramsContainer.innerHTML = '<p class="text-xs text-gray-400 italic">This effect will toggle the time of day between Day and Night.</p>';
                                break;
                            case 'transition_variation':
                                paramsContainer.innerHTML = `
                            <div class="flex flex-col gap-2">
                                <label class="block text-sm font-medium">Page:</label>
                                <select class="appendix-transition-page-select"></select>
                                <label class="block text-sm font-medium">From:</label>
                                <select class="appendix-transition-from-select"></select>
                                <label class="block text-sm font-medium">To:</label>
                                <select class="appendix-transition-to-select"></select>
                            </div>
                        `;
                                const pageSelect = paramsContainer.querySelector('.appendix-transition-page-select');
                                const fromSelect = paramsContainer.querySelector('.appendix-transition-from-select');
                                const toSelect = paramsContainer.querySelector('.appendix-transition-to-select');

                                pageSelect.add(new Option('-- Select a Page --', ''));
                                book.pages.filter(p => p.sources.length > 1).sort((a, b) => a.title.localeCompare(b.title)).forEach(p => pageSelect.add(new Option(p.title, p.id)));

                                const populateVariationSelects = (pageId) => {
                                    fromSelect.innerHTML = '<option value="any">Any Active Variation</option>';
                                    toSelect.innerHTML = '<option value="">-- Select Target Variation --</option>';
                                    const page = book.pages.find(p => p.id == pageId);
                                    if (page) {
                                        page.sources.forEach(v => {
                                            const optionText = v.name || `Variation ${page.sources.indexOf(v) + 1}`;
                                            fromSelect.add(new Option(optionText, v.id));
                                            toSelect.add(new Option(optionText, v.id));
                                        });
                                    }
                                    // Restore selection if editing
                                    if (effectData.params?.fromVariationId) fromSelect.value = effectData.params.fromVariationId;
                                    if (effectData.params?.toVariationId) toSelect.value = effectData.params.toVariationId;
                                };

                            case 'set_page_title':
                                paramsContainer.innerHTML = `
                            <div class="flex flex-col gap-2">
                                <label class="block text-sm font-medium">Page to Rename:</label>
                                <select class="appendix-page-target-select"></select>
                                <label class="block text-sm font-medium">New Title:</label>
                                <input type="text" class="appendix-new-title-input" placeholder="Enter new title...">
                            </div>`;
                                pageSelect.addEventListener('change', () => populateVariationSelects(pageSelect.value));

                                // Set initial state if editing
                                if (effectData.params?.pageId) {
                                    pageSelect.value = effectData.params.pageId;
                                    populateVariationSelects(effectData.params.pageId);
                                }
                                break;
                        }
                    }

                    function getAppendixEffectParamsFromUI() {
                        const effectType = appendixEffectTypeSelect.value;
                        const paramsContainer = appendixEffectParamsContainer; // Use the global reference
                        const targetContainer = appendixEffectTargetContainer; // Use the global reference
                        const params = {};

                        switch (effectType) {
                            case 'transition_variation':
                                const pageSelect = paramsContainer.querySelector('.appendix-transition-page-select');
                                const fromSelect = paramsContainer.querySelector('.appendix-transition-from-select');
                                const toSelect = paramsContainer.querySelector('.appendix-transition-to-select');
                                if (pageSelect) params.pageId = pageSelect.value;
                                if (fromSelect) params.fromVariationId = fromSelect.value;
                                if (toSelect) params.toVariationId = toSelect.value;
                                break;
                            case 'increase_volume':
                            case 'decrease_volume':
                                const volMod = paramsContainer.querySelector('.appendix-volume-modifier');
                                if (volMod) params.amount = parseInt(volMod.value, 10) || 10;
                                break;
                            case 'change_chapter':
                                const chapterTarget = paramsContainer.querySelector('select[id^="appendixChapterTarget_"]');
                                if (chapterTarget) params.chapterId = chapterTarget.value;
                                break;
                            case 'set_time':
                                const timeSet = paramsContainer.querySelector('input[name^="appendixTimeSet_"]:checked');
                                if (timeSet) params.time = timeSet.value;
                                break;
                            case 'set_page_title':
                                const pageTargetSelect = paramsContainer.querySelector('.appendix-page-target-select');
                                const newTitleInput = paramsContainer.querySelector('.appendix-new-title-input');
                                if (pageTargetSelect) params.pageId = pageTargetSelect.value;
                                if (newTitleInput) params.newTitle = newTitleInput.value;
                                break;
                            case 'transition_variation':
                                // This is already handled in the main switch, but we can add it here for completeness
                                break;
                        }
                        const sequentialCheckbox = targetContainer.querySelector('.appendix-play-sequentially');
                        if (sequentialCheckbox) params.playSequentially = sequentialCheckbox.checked;
                        return params;
                    }

                    function saveAppendixEffect(event) {
                        if (event) event.stopPropagation();
                        const editingIndex = editingAppendixEffectIndexInput.value;
                        const isEditing = editingIndex !== '';
                        const effectId = document.getElementById('currentAppendixEffectId').value; // Use the stored ID

                        const effectType = appendixEffectTypeSelect.value;
                        const effect = { id: effectId, type: effectType, params: {}, target: {} };


                        log(`%c[SAVE EFFECT]`, 'color: #7DF9FF; font-weight: bold;', `Starting save for effect type: ${effectType}`);
                        log(`%c[SAVE EFFECT]`, 'color: #7DF9FF; font-weight: bold;', `Effect ID: ${effectId}, Is Editing: ${isEditing}`);


                        effect.params = getAppendixEffectParamsFromUI();

                        // Gather targets (this logic remains the same)
                        const pageItems = appendixEffectTargetContainer.querySelectorAll('.appendix-page-list .appendix-page-selector-item');
                        effect.target.pages = Array.from(pageItems)
                            .filter(item => item.querySelector('.page-checkbox').checked)
                            .map(item => ({ pageId: parseInt(item.querySelector('.page-checkbox').value, 10), variationId: item.querySelector('.variation-select').value || null }));


                        log(`%c[SAVE EFFECT]`, 'color: #7DF9FF; font-weight: bold;', 'Gathered Params from UI:', JSON.parse(JSON.stringify(effect.params)));
                        log(`%c[SAVE EFFECT]`, 'color: #7DF9FF; font-weight: bold;', 'Gathered Targets from UI:', JSON.parse(JSON.stringify(effect.target)));


                        const volTargetTypeSelect = appendixEffectTargetContainer.querySelector('.appendix-volume-target-type');
                        if (effectType === 'set_page_title') {
                            const pageTargetSelect = paramsContainer.querySelector('.appendix-page-target-select');
                            if (pageTargetSelect) {
                                effect.target.pages = [{ pageId: parseInt(pageTargetSelect.value, 10), variationId: null }];
                            }
                        }
                        if (volTargetTypeSelect) effect.target.targetType = volTargetTypeSelect.value;

                        if (isEditing) {
                            currentAppendixEffects[parseInt(editingIndex, 10)] = effect;
                        } else {
                            currentAppendixEffects.push(effect);
                        }

                        log(`LOG (saveAppendixEffect): currentAppendixEffects array is now:`, JSON.parse(JSON.stringify(currentAppendixEffects)));

                        renderAppendixEffectsList();
                        closeAppendixEffectModal();
                    }




                    // --- Event Listeners (Main Buttons & File Inputs) ---
                    toggleListenButton.addEventListener('click', () => {
                        if (currentListeningMode === 'toggle') {
                            if (isListening) stopListening(true); else { resetSpeechRetryState(); startListening(); }
                        } else { // Push-to-talk mode
                            showTemporaryMessage("Use Spacebar for Push-to-Talk.", "info");
                        }
                    });
                    stopAllSoundsButton.addEventListener('click', () => {
                        stopAllSounds();
                        showTemporaryMessage('All sounds stopped.', 'info');
                    });
                    openSaveFileModalButton.addEventListener('click', openSaveFileModal);
                    loadFileInput.addEventListener('change', handleFileLoad);

                    relinkFromDropdownButton.addEventListener('click', () => {
                        if (!initAudioContext()) { showTemporaryMessage("Audio system not ready.", "error"); return; }
                        directoryInput.click(); // Trigger hidden directory input
                        showTemporaryMessage("Select the directory containing your audio files.", "info", 4000);
                    });
                    directoryInput.addEventListener('change', handleDirectorySelection);

                    searchInput.addEventListener('input', () => {
                        currentSearchTerm = searchInput.value.trim().toLowerCase();
                        renderPageList(); // Re-render the list with the filter
                    });

                    addChapterButton.addEventListener('click', createNewChapter); // This button is now hidden, but we'll leave the listener in case it's re-enabled.
                    cancelChapterEditButton.addEventListener('click', closeEditChapterModal);
                    saveChapterEditButton.addEventListener('click', saveChapterChanges);
                    burnBookButton.addEventListener('click', () => {
                        burnSwitchChapters.checked = true;
                        burnSwitchCollections.checked = true;
                        burnSwitchPages.checked = true;
                        burnSwitchAppendix.checked = true;
                        burnSwitchSettings.checked = true;
                        modalOverlay.style.display = 'block';
                        burnBookModal.style.display = 'flex';
                    });

                    // Save File Modal Listeners
                    saveFileButton.addEventListener('click', saveFileFromModal);
                    cancelSaveFileButton.addEventListener('click', closeSaveFileModal);


                    saveCollectionEditButton.addEventListener('click', saveCollectionChanges);
                    cancelBurnBookButton.addEventListener('click', () => {
                        burnBookModal.style.display = 'none';
                        modalOverlay.style.display = 'none';
                    });

                    // Add listener for the confirmation button inside the burn modal
                    confirmBurnBookButton.addEventListener('click', () => {
                        burnBookFromModal();
                    });
                    cancelCollectionEditButton.addEventListener('click', closeEditCollectionModal);


                    toggleLayoutButton.addEventListener('click', () => {
                        isGridView = !isGridView;
                        pageListUl.classList.toggle('grid-view', isGridView);
                        const icon = toggleLayoutButton.querySelector('i');
                        if (isGridView) {
                            icon.className = 'fas fa-grip-horizontal fa-fw'; // Icon for grid view
                            toggleLayoutButton.title = "Switch to Row Layout";
                        } else {
                            icon.className = 'fas fa-th-list fa-fw'; // Icon for row view
                            toggleLayoutButton.title = "Switch to Grid Layout";
                        }
                        renderPageList(); // Re-render with new layout
                    });

                    timeOfDayButton.addEventListener('click', () => toggleTimeOfDay());

                    masterVolumeSlider.addEventListener('input', () => {
                        const newVolume = parseInt(masterVolumeSlider.value, 10);
                        masterVolumeValueSpan.textContent = `${newVolume}`;
                        book.settings.masterVolume = newVolume; // Save to book settings
                        currentMasterVolume = newVolume; // Update global state

                        if (typeof book !== 'undefined' && book.settings && book.settings.masterVolumeAffectsSoundtracks !== false) {
                            if (typeof activeSoundtrackId !== 'undefined' && activeSoundtrackId && isStPlaying && typeof stPlayerNode !== 'undefined') {
                                const stVolSlider = document.getElementById('stVolumeSlider');
                                if (stVolSlider) stVolSlider.dispatchEvent(new Event('input'));
                            }
                        }

                        // Adjust volume of currently playing sounds. Iterate entries so we get
                        // each sound's page id directly instead of re-scanning all keys per sound
                        // (was O(n^2); this runs on every master-volume slider tick). (3.3)
                        Object.entries(activeSounds).forEach(([pageIdStr, soundData]) => {
                            const activePage = book.pages.find(p => p.id === parseInt(pageIdStr, 10));
                            if (soundData.gainNode && soundData.sourceDetail.type === 'file') { // File-based sound
                                const page = activePage;
                                if (page) {
                                    const pageOrVariationVolume = (typeof soundData.sourceDetail.volumeOverride === 'number') ? soundData.sourceDetail.volumeOverride : page.volume;
                                    const finalGain = (pageOrVariationVolume / 100) * (currentMasterVolume / 100);
                                    soundData.gainNode.gain.setTargetAtTime(finalGain, audioContext.currentTime, 0.01); // Smooth transition
                                }
                            } else if (soundData.node && soundData.sourceDetail.type === 'youtube') { // YouTube sound
                                const page = activePage;
                                if (page) {
                                    const pageOrVariationVolume = (typeof soundData.sourceDetail.volumeOverride === 'number') ? soundData.sourceDetail.volumeOverride : page.volume;
                                    const finalYTVolume = Math.round(pageOrVariationVolume * (currentMasterVolume / 100));
                                    soundData.node.setVolume(finalYTVolume);
                                }
                            } else if (soundData.sourceDetail.type === 'syrinscape' && syrinscapePlayerReady && syrinscape.player && syrinscape.player.audioSystem) { // Syrinscape sound
                                const page = activePage;
                                if (page) {
                                    const pageOrVariationVolume = (typeof soundData.sourceDetail.volumeOverride === 'number') ? soundData.sourceDetail.volumeOverride : page.volume;
                                    const scaledVolume = (pageOrVariationVolume / 100) * (currentMasterVolume / 100); // Scale 0-1
                                    const syrinscapeLocalVolume = Math.min(1.5, scaledVolume * 1.5); // Syrinscape uses 0-1.5 for local volume
                                    log(`Adjusting Syrinscape local volume to: ${syrinscapeLocalVolume} (Master: ${currentMasterVolume}%, Page/Var: ${pageOrVariationVolume}%)`);
                                    syrinscape.player.audioSystem.setLocalVolume(syrinscapeLocalVolume.toString());
                                }
                            }
                        });
                        saveToLocalStorage(); // Persist master volume change
                    });


                    // --- Add Page Modal Listeners ---
                    openAddPageModalButton.addEventListener('click', openAddPageModal);
                    cancelAddButton.addEventListener('click', closeAddPageModal);
                    openAddSourceVariationModalButton_addPage.addEventListener('click', () => openVariationSettingsModal(null, null, true));

                    // New previewer listeners
                    document.getElementById('addPageFile').addEventListener('change', (e) => setupFilePreview(e.target.files[0], addPageFilePreviewContainer));
                    document.getElementById('addYoutubeUrl').addEventListener('input', (e) => setupYouTubePreview(e.target.value, addPageYouTubePreviewContainer));

                    sourceYoutubeUrlInput.addEventListener('input', () => checkYouTubeEmbeddability(sourceYoutubeUrlInput, sourceYoutubeUrlStatus));
                    addYoutubeUrlInput.addEventListener('paste', () => setTimeout(() => checkYouTubeEmbeddability(addYoutubeUrlInput, addYoutubeUrlStatus), 50));
                    addYoutubeUrlInput.addEventListener('input', () => checkYouTubeEmbeddability(addYoutubeUrlInput, addYoutubeUrlStatus));
                    addButton.addEventListener('click', createNewPageFromModal);

                    addSourceTypeRadios.forEach(radio => {
                        radio.addEventListener('change', (event) => {
                            const selectedType = event.target.value;
                            addFileInputContainer.classList.toggle('hidden', selectedType !== 'file');
                            addYoutubeInputContainer.classList.toggle('hidden', selectedType !== 'youtube');
                            addSyrinscapeInputContainer.classList.toggle('hidden', selectedType !== 'syrinscape');
                            addFadeInOutCheckbox.disabled = selectedType !== 'file';
                            // Hide previewers when type changes
                            if (addPageFilePreviewContainer) addPageFilePreviewContainer.classList.add('hidden');
                            if (addPageYouTubePreviewContainer) {
                                addPageYouTubePreviewContainer.classList.add('hidden');
                            }
                            if (selectedType !== 'file') addFadeInOutCheckbox.checked = false;

                            const syrinscapeKind = addSyrinscapeKindInput.value;
                            const syrinscapeDuration = addSyrinscapePlayDurationInput.value;
                            evaluateSyrinscapeLoopControls(
                                selectedType,
                                syrinscapeKind,
                                syrinscapeDuration,
                                addLoopSoundCheckbox,
                                addLoopIndefinitelyCheckbox,
                                addLoopCountInput,
                                addLoopOptionsContainer,
                                addEndPlayKeywordsContainer
                            );
                        });
                    });
                    addVolumeInput.addEventListener('input', () => { addVolumeValueSpan.textContent = addVolumeInput.value; });

                    addLoopSoundCheckbox.addEventListener('change', (event) => {
                        const isLooping = event.target.checked;
                        const selectedType = document.querySelector('input[name="addSourceType"]:checked')?.value;
                        const syrinscapeKind = addSyrinscapeKindInput.value;
                        const syrinscapeDuration = addSyrinscapePlayDurationInput.value;

                        evaluateSyrinscapeLoopControls(
                            selectedType,
                            syrinscapeKind,
                            syrinscapeDuration,
                            addLoopSoundCheckbox,
                            addLoopIndefinitelyCheckbox,
                            addLoopCountInput,
                            addLoopOptionsContainer,
                            addEndPlayKeywordsContainer,
                            isLooping // Pass current loop state
                        );
                    });


                    addLoopIndefinitelyCheckbox.addEventListener('change', (event) => {
                        const selectedType = document.querySelector('input[name="addSourceType"]:checked')?.value;
                        const syrinscapeKind = addSyrinscapeKindInput.value;
                        const syrinscapeDuration = addSyrinscapePlayDurationInput.value;

                        evaluateSyrinscapeLoopControls(
                            selectedType,
                            syrinscapeKind,
                            syrinscapeDuration,
                            addLoopSoundCheckbox,
                            addLoopIndefinitelyCheckbox,
                            addLoopCountInput,
                            addLoopOptionsContainer,
                            addEndPlayKeywordsContainer
                        );
                    });


                    if (addLoopCountInput) {
                        addLoopCountInput.addEventListener('input', () => {
                            if (!addLoopCountInput.disabled && parseInt(addLoopCountInput.value) < 1) {
                                addLoopCountInput.value = 1; // Ensure count is at least 1
                            }
                        });
                    } else {
                        console.error("Could not find element with ID 'addLoopCount' to attach listener.");
                    }

                    if (addSyrinscapePlayDurationInput) {
                        addSyrinscapePlayDurationInput.addEventListener('input', (event) => {
                            const duration = event.target.value;
                            const selectedType = document.querySelector('input[name="addSourceType"]:checked')?.value;
                            const syrinscapeKind = addSyrinscapeKindInput.value;
                            evaluateSyrinscapeLoopControls(
                                selectedType,
                                syrinscapeKind,
                                duration, // Pass current duration
                                addLoopSoundCheckbox,
                                addLoopIndefinitelyCheckbox,
                                addLoopCountInput,
                                addLoopOptionsContainer,
                                addEndPlayKeywordsContainer
                            );
                        });
                    }
                    // (Removed: input listener for the deleted sourceVariationSyrinscapePlayDuration field, B4)


                    // --- Create New Page Function (from Modal) ---
                    async function createNewPageFromModal(eventOrReturn = false) {
                        const returnPageObject = (eventOrReturn === true);
                        log("Create New Page button clicked (from modal).");
                        if (!initAudioContext()) { showTemporaryMessage("Audio system not ready.", "error"); return; }

                        let title = addPageTitleInput.value.trim();
                        const sourceName = addSourceNameInput.value.trim() || null;
                        const primaryKeyRaw = addPrimaryKeyInput.value.trim();
                        const primaryKey = primaryKeyRaw ? primaryKeyRaw.toLowerCase() : null;
                        const keywordsRaw = addKeywordsInput.value.trim();
                        const phrasesRaw = addPhrasesInput.value.trim();
                        const endPlayKeywordsRaw = addEndPlayKeywordsInput.value.trim();
                        const volume = parseInt(addVolumeInput.value, 10);
                        const loop = addLoopSoundCheckbox.checked;
                        const sourceType = document.querySelector('input[name="addSourceType"]:checked')?.value;
                        const loopIndefinitely = addLoopIndefinitelyCheckbox.checked;
                        const loopCountValue = addLoopCountInput ? parseInt(addLoopCountInput.value, 10) : 1;
                        const loopCount = loop ? (loopIndefinitely ? -1 : (isNaN(loopCountValue) || loopCountValue < 1 ? 0 : loopCountValue)) : 0;
                        const nextPageIdValue = addNextPageIdSelect.value ? parseInt(addNextPageIdSelect.value, 10) : null;
                        const fadeInOut = sourceType === 'file' && addFadeInOutCheckbox.checked;
                        const timeOfDaySetting = document.querySelector('input[name="addTimeOfDaySetting"]:checked')?.value || 'always';
                        const syrinscapePlayDurationRaw = addSyrinscapePlayDurationInput.value.trim();
                        const syrinscapePlayDuration = (sourceType === 'syrinscape' && syrinscapePlayDurationRaw) ? parseInt(syrinscapePlayDurationRaw, 10) : null;

                        if (loop && loopCount === 0 && !loopIndefinitely && !(tempPageForAddModal.sources[0]?.type === 'syrinscape' && tempPageForAddModal.sources[0]?.syrinscapePlayDuration)) {
                            showTemporaryMessage('Invalid Loop Count.', 'error'); return;
                        }

                        if (tempPageForAddModal.sources.length === 0) {
                            let newSourceDetail = null;
                            const addPageFileInput = document.getElementById('addPageFile');
                            if (sourceType === 'file' && addPageFileInput && addPageFileInput.files.length > 0) {
                                const file = addPageFileInput.files[0];
                                const arrayBuffer = await file.arrayBuffer();
                                const bytesForStore = arrayBuffer.slice(0); // decodeAudioData detaches arrayBuffer
                                if (!initAudioContext()) throw new Error("Audio system not ready.");
                                const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
                                newSourceDetail = {
                                    type: 'file',
                                    source: audioBuffer,
                                    fileName: file.name,
                                    startTime: addStartTimeInput.value ? parseTimeHms(addStartTimeInput.value) : 0,
                                    endTime: addEndTimeInput.value ? parseTimeHms(addEndTimeInput.value) : null,
                                    needsFile: false
                                };
                                await persistAudioSource(newSourceDetail, file, bytesForStore); // B3: cache bytes in IndexedDB
                            } else if (sourceType === 'youtube' && addYoutubeUrlInput.value.trim() !== '') {
                                newSourceDetail = {
                                    type: 'youtube',
                                    source: extractYouTubeVideoId(addYoutubeUrlInput.value.trim()),
                                    fileName: addYoutubeUrlInput.value.trim(),
                                    videoId: extractYouTubeVideoId(addYoutubeUrlInput.value.trim()),
                                    startTime: addStartTimeInput.value ? parseTimeHms(addStartTimeInput.value) : 0,
                                    endTime: addEndTimeInput.value ? parseTimeHms(addEndTimeInput.value) : null
                                };
                            } else if (sourceType === 'syrinscape' && addSyrinscapeElementIdInput.value) {
                                newSourceDetail = {
                                    type: 'syrinscape',
                                    syrinscapeElementId: addSyrinscapeElementIdInput.value,
                                    syrinscapeName: addSyrinscapeSelectedSoundSpan.dataset.syrinscapeName,
                                    syrinscapeKind: addSyrinscapeSelectedSoundSpan.dataset.syrinscapeKind,
                                    syrinscapePlayDuration: syrinscapePlayDuration,
                                    fileName: addSyrinscapeSelectedSoundSpan.dataset.syrinscapeName
                                }
                            }

                            if (newSourceDetail) {
                                tempPageForAddModal.sources.push({
                                    id: `var_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                                    name: sourceName || "Main",
                                    volumeOverride: null,
                                    isDefault: true,
                                    variationKeywords: [],
                                    conditions: null,
                                    sources: [newSourceDetail]
                                });
                            } else {
                                showTemporaryMessage('A new page must have at least one sound source variation. Please ensure you have selected a file or entered a valid URL.', 'error'); return;
                            }
                        }

                        if (!title) { showTemporaryMessage('Page Title is required.', 'error'); return; }
                        const duplicateTitle = book.pages.some(page => page.title.toLowerCase() === title.toLowerCase());
                        if (duplicateTitle) { showTemporaryMessage(`A page titled "${title}" already exists.`, 'error', 5000); return; }
                        if (sourceType === 'syrinscape' && syrinscapePlayDurationRaw && (isNaN(syrinscapePlayDuration) || syrinscapePlayDuration < 1)) {
                            showTemporaryMessage('Invalid Syrinscape Play Duration. Must be a positive number.', 'error'); return;
                        }


                        const keywords = keywordsRaw === '' ? [] : keywordsRaw.toLowerCase().split(',').map(k => k.trim()).filter(Boolean);
                        const phrases = phrasesRaw === '' ? [] : phrasesRaw.split('\n').map(p => p.trim().toLowerCase()).filter(Boolean);
                        const endPlayKeywords = endPlayKeywordsRaw === '' ? [] : endPlayKeywordsRaw.toLowerCase().split(',').map(k => k.trim()).filter(Boolean);

                        addButton.disabled = true;
                        addButton.innerHTML = '<i class="fas fa-spinner fa-spin"></i><span> Creating...</span>';

                        try {
                            // The tempPageForAddModal already has the sources, we just need to update the main page properties
                            const newPageId = book.nextPageId++;
                            log(`Creating new page from modal: "${title}" (ID: ${newPageId}), PrimaryKey(s): "${primaryKey}"`);

                            let finalLoop = loop;
                            let finalLoopCount = loopCount;


                            const newPage = {
                                id: newPageId,
                                title,
                                primaryKey,
                                keywords,
                                phrases,
                                isStarred: false,
                                volume,
                                loop: finalLoop,
                                loopCount: finalLoopCount,
                                fadeInOut,
                                endPlayKeywords,
                                nextPageId: nextPageIdValue,
                                timeOfDaySetting: timeOfDaySetting,
                                currentLoop: 0, // This property seems to be unused, consider removing
                                sources: tempPageForAddModal.sources // Use the sources built up in the modal
                            };
                            book.pages.push(newPage);

                            const currentActiveChapter = book.chapters.find(ch => ch.id == book.activeChapterId) || book.chapters.find(ch => ch.isIndex);
                            if (currentActiveChapter && !currentActiveChapter.isIndex) {
                                if (!currentActiveChapter.pageIds) currentActiveChapter.pageIds = [];
                                currentActiveChapter.pageIds.push(newPageId);
                                log(`Added page ${newPageId} to chapter "${currentActiveChapter.name}"`);
                            } else {
                                log(`New page ${newPageId} created (not added to a specific non-Index chapter).`);
                            }

                            updateFuseIndex();
                            updateChapterKeywordList();
                            saveToLocalStorage();
                            renderChapterTabs(); renderSoundtrackIcons();
                            renderPageList();
                            if (returnPageObject) {
                                return newPage;
                            } else {
                                showTemporaryMessage(`New page "${title}" created!`, 'success');
                                closeAddPageModal();
                            }

                        } catch (error) {
                            console.error("Error creating new page from modal:", error);
                            showTemporaryMessage(`Error: ${error.message}`, 'error', 5000);
                        } finally {
                            addButton.disabled = false;
                            addButton.innerHTML = '<i class="fas fa-plus-circle"></i><span> Create New Page</span>';
                        }
                    }


                    // --- Helper Functions ---
                    function clearAddForm() {
                        // addPageFileInput is no longer a direct element, it's part of the source modal logic
                        addSourceListUl.innerHTML = '<li class="italic text-sm text-center py-2">No sources added yet.</li>';
                        addYoutubeUrlInput.value = '';
                        addStartTimeInput.value = '';
                        addEndTimeInput.value = '';
                        addSyrinscapeSearchInput.value = '';
                        addSyrinscapeElementIdInput.value = '';
                        addSyrinscapeKindInput.value = '';
                        addSyrinscapeSelectedSoundSpan.textContent = 'No Syrinscape sound selected.';
                        addSyrinscapeSelectedSoundSpan.dataset.syrinscapeName = '';
                        addSyrinscapeSelectedSoundSpan.dataset.syrinscapeKind = '';
                        addSyrinscapePlayDurationInput.value = '';

                        addPageTitleInput.value = '';
                        addSourceNameInput.value = '';
                        addPrimaryKeyInput.value = '';
                        addKeywordsInput.value = '';
                        addPhrasesInput.value = '';
                        addVolumeInput.value = 80;
                        addVolumeValueSpan.textContent = '80';
                        addLoopSoundCheckbox.checked = false;
                        addLoopSoundCheckbox.disabled = false;
                        addLoopOptionsContainer.classList.add('hidden');
                        addEndPlayKeywordsContainer.classList.add('hidden');
                        if (addLoopCountInput) {
                            addLoopCountInput.value = 1;
                            addLoopCountInput.disabled = true;
                        }
                        addLoopIndefinitelyCheckbox.checked = false;
                        addLoopIndefinitelyCheckbox.disabled = true;
                        addEndPlayKeywordsInput.value = '';
                        addNextPageIdSelect.value = '';
                        addFadeInOutCheckbox.checked = false;
                        document.querySelector('input[name="addSourceType"][value="file"]').checked = true;
                        addFileInputContainer.classList.remove('hidden');
                        addYoutubeInputContainer.classList.add('hidden');
                        addSyrinscapeInputContainer.classList.add('hidden');
                        addFadeInOutCheckbox.disabled = false;

                        // Clear previewer
                        if (addPageFilePreviewContainer) addPageFilePreviewContainer.classList.add('hidden');
                        if (addPageYouTubePreviewContainer) addPageYouTubePreviewContainer.classList.add('hidden');
                        if (activePreviewContext?.container === addPageFilePreviewContainer || activePreviewContext?.container === addPageYouTubePreviewContainer) {
                            stopModalPreview();
                        }

                        document.querySelector('input[name="addTimeOfDaySetting"][value="always"]').checked = true;
                    }

                    function extractYouTubeVideoId(url) {
                        const regex = /(?:https?:\/\/)?(?:www\.)?(?:youtube\.com\/(?:[^\/\n\s]+\/\S+\/|(?:v|e(?:mbed)?)\/|\S*?[?&]v=)|youtu\.be\/)([a-zA-Z0-9_-]{11})/;
                        const match = url.match(regex);
                        return match ? match[1] : null;
                    }

                    function setSoundCooldown(pageId, duration) {
                        if (soundCooldowns[pageId]) {
                            clearTimeout(soundCooldowns[pageId]);
                        }
                        soundCooldowns[pageId] = setTimeout(() => {
                            delete soundCooldowns[pageId];
                        }, duration);
                    }

                    // --- YouTube Embeddability Check ---
                    let ytCheckTimeout = null;
                    function checkYouTubeEmbeddability(inputElement, statusElement, context) {
                        clearTimeout(ytCheckTimeout);

                        ytCheckTimeout = setTimeout(() => {
                            if (!youtubeApiReady) {
                                statusElement.textContent = "Cannot check URL: YouTube API not ready.";
                                statusElement.style.color = 'var(--text-secondary)';
                                return;
                            }

                            const url = inputElement.value.trim();
                            const videoId = extractYouTubeVideoId(url);

                            if (!videoId) {
                                statusElement.textContent = url ? "Invalid YouTube URL." : "";
                                statusElement.style.color = 'var(--danger-color)';
                                return;
                            }

                            statusElement.textContent = "Checking video availability...";
                            statusElement.style.color = 'var(--accent-blue)';

                            const tempPlayerId = `yt-check-${Date.now()}`;
                            const tempPlayerDiv = document.createElement('div');
                            tempPlayerDiv.id = tempPlayerId;
                            youtubePlayersContainer.appendChild(tempPlayerDiv);

                            const player = new YT.Player(tempPlayerId, {
                                height: '0', width: '0', videoId: videoId,
                                events: {
                                    'onReady': (event) => {
                                        // onReady isn't enough. We need to try to play it.
                                        event.target.mute();
                                        event.target.playVideo();
                                    },
                                    'onStateChange': (event) => {
                                        // If it starts playing or buffering, it's embeddable.
                                        if (event.data === YT.PlayerState.PLAYING || event.data === YT.PlayerState.BUFFERING) {
                                            statusElement.textContent = "Video is available to embed.";
                                            statusElement.style.color = 'var(--high-confidence-match-color)';
                                            player.destroy();
                                            tempPlayerDiv.remove();
                                        }
                                    },
                                    'onError': (event) => {
                                        if (event.data === 101 || event.data === 150) { // 101 and 150 are "embedding disabled" errors
                                            statusElement.textContent = "Error: This video cannot be embedded.";
                                            statusElement.style.color = 'var(--danger-color)';
                                        }
                                        player.destroy();
                                        tempPlayerDiv.remove();
                                    }
                                }
                            });
                        }, 500); // Debounce the check
                    }

                    function fadeOutYouTube(player, durationSeconds) {
                        if (!player || typeof player.getVolume !== 'function' || typeof player.setVolume !== 'function') {
                            console.warn("Cannot fade YouTube video: player or functions missing.");
                            if (player && typeof player.stopVideo === 'function') { try { player.stopVideo(); } catch (e) { } }
                            return;
                        }

                        const initialVolume = player.getVolume();
                        if (initialVolume <= 0) {
                            if (typeof player.stopVideo === 'function') { try { player.stopVideo(); } catch (e) { } }
                            return;
                        }

                        const steps = 20;
                        const interval = (durationSeconds * 1000) / steps;
                        let currentStep = 0;

                        const fadeInterval = setInterval(() => {
                            currentStep++;
                            const newVolume = initialVolume * (1 - (currentStep / steps));
                            if (player && typeof player.setVolume === 'function') {
                                try { player.setVolume(Math.max(0, newVolume)); } catch (e) { clearInterval(fadeInterval); }
                            }
                            // Also check if the player object itself has been destroyed (e.g., by a rapid stopAllSounds)
                            if (!youtubePlayers[player.getIframe().id]) {
                                clearInterval(fadeInterval);
                            }

                            if (currentStep >= steps) {
                                clearInterval(fadeInterval);
                                if (player && typeof player.stopVideo === 'function') {
                                    try { player.stopVideo(); } catch (e) { /* ignore if already destroyed */ }
                                }
                            }
                        }, interval);
                    }

                    function clearAllCooldowns() {
                        log("Clearing cooldowns.");
                        Object.values(soundCooldowns).forEach(clearTimeout);
                        soundCooldowns = {};
                    }

                    // --- Fuzzy Search & Chapter Keyword Setup ---
                    function updateFuseIndex() {
                        log("Updating Fuse.js keyword index for pages...");
                        keywordListForFuse = [];
                        book.pages.forEach(page => {
                            const keysToIndex = [...(page.keywords || [])];
                            if (page.primaryKey) {
                                keysToIndex.push(...page.primaryKey.split(',').map(k => k.trim()).filter(Boolean));
                            }
                            keysToIndex.forEach(keyword => {
                                const trimmedKeyword = keyword.trim().toLowerCase();
                                if (trimmedKeyword.length > 0 && !IGNORED_WORDS.has(trimmedKeyword)) {
                                    keywordListForFuse.push({
                                        keyword: trimmedKeyword,
                                        pageId: page.id,
                                        pageTitle: page.title
                                    });
                                }
                            });
                        });

                        if (typeof Fuse === 'function') {
                            fuseOptions.threshold = 1.0 - currentKeywordConfidenceThreshold;
                            fuseInstance = new Fuse(keywordListForFuse, fuseOptions);
                            log(`Fuse index updated with ${keywordListForFuse.length} items. Fuse Threshold: ${fuseOptions.threshold.toFixed(2)} (Min Confidence: ${currentKeywordConfidenceThreshold.toFixed(2)})`);
                        } else {
                            console.error("Fuse.js library not loaded.");
                            fuseInstance = null;
                        }
                    }

                    function updateChapterKeywordList() {
                        log("Updating chapter keyword list...");
                        chapterKeywordList = [];
                        book.chapters.forEach(chapter => {
                            if (!chapter.isIndex && Array.isArray(chapter.chapterKeywords)) {
                                chapter.chapterKeywords.forEach(word => {
                                    const trimmedWord = word.trim().toLowerCase();
                                    if (trimmedWord.length > 0 && !IGNORED_WORDS.has(trimmedWord)) {
                                        chapterKeywordList.push({
                                            keyword: trimmedWord,
                                            chapterId: chapter.id
                                        });
                                    }
                                });
                            }
                        });
                        log(`Chapter keyword list updated with ${chapterKeywordList.length} words.`);
                    }

                    // --- Page Matching Logic (findBestMatch) ---
                    function checkPrimaryKeyConfidence(page, text, excludedTranscriptWords) {
                        if (!page || !page.primaryKey) return true; // If no PK defined, condition is met
                        const primaryKeys = page.primaryKey.split(',').map(k => k.trim()).filter(Boolean);
                        if (primaryKeys.length === 0) return true; // If PK is empty string after trim, condition is met

                        const wordsInText = text.split(/\s+/).filter(w => w.length >= (fuseOptions.minMatchCharLength || 1) && !IGNORED_WORDS.has(w) && !excludedTranscriptWords.has(w));
                        const minConfidence = currentKeywordConfidenceThreshold;

                        for (const pk of primaryKeys) {
                            if (IGNORED_WORDS.has(pk)) continue;

                            if (!isSmartFilteringEnabled) {
                                const escapedPk = pk.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
                                const pkRegex = new RegExp(`\\b${escapedPk}\\b`, 'i');
                                if (text.match(pkRegex)) return true;
                            } else {
                                if (typeof fuseInstance !== 'undefined' && fuseInstance) {
                                    for (const word of wordsInText) {
                                        const results = fuseInstance.search(word);
                                        for (const res of results) {
                                            if (res.item.pageId === page.id && page.primaryKey.includes(res.item.keyword) && (1.0 - res.score) >= minConfidence) return true;
                                        }
                                    }
                                }
                            }
                        }

                        // If not found in current text, check look-behind context
                        if (lookBehindContext.active && (Date.now() - lookBehindContext.timestamp < LOOK_BEHIND_DURATION_MS)) {
                            // Check if any of the page's required PKs are in the active look-behind context
                            const foundInContext = primaryKeys.some(pk => {
                                // The context might store multi-word PKs. The text might contain one word of that PK.
                                // We need to see if any of the context's PKs are present in the look-behind store.
                                // This is a direct check.
                                return lookBehindContext.primaryKeys.includes(pk);
                            });

                            if (foundInContext) {
                                log(`PK condition for "${page.title}" met via look-behind context: [${lookBehindContext.primaryKeys.join(', ')}]`);
                                return true; // Found a required PK in the look-behind context
                            }
                        }
                        return false; // No primary key condition met
                    }

                    function calculatePronounAdjacency(text, sortedMatchDetails) {
                        if (!Array.isArray(sortedMatchDetails) || sortedMatchDetails.length < 2) return 0;
                        let adjacencyCount = 0;
                        const transcriptWords = text.split(/\s+/);
                        const wordMap = new Map();
                        let currentOffset = 0;
                        transcriptWords.forEach((tw, idx) => {
                            wordMap.set(currentOffset, { word: tw, transcriptIndex: idx, isPronoun: PRONOUNS.has(tw.toLowerCase()) });
                            currentOffset += tw.length + 1;
                        });

                        const mappedKeywordDetails = [];
                        sortedMatchDetails.forEach(detail => {
                            if (wordMap.has(detail.index)) {
                                mappedKeywordDetails.push({
                                    transcriptIndex: wordMap.get(detail.index).transcriptIndex,
                                    isPronoun: detail.isPronoun
                                });
                            }
                        });

                        const uniqueTranscriptIndexDetails = [];
                        const seenTranscriptIndices = new Set();
                        mappedKeywordDetails.forEach(detail => {
                            if (!seenTranscriptIndices.has(detail.transcriptIndex)) {
                                uniqueTranscriptIndexDetails.push(detail);
                                seenTranscriptIndices.add(detail.transcriptIndex);
                            }
                        });

                        uniqueTranscriptIndexDetails.sort((a, b) => a.transcriptIndex - b.transcriptIndex);

                        for (let i = 0; i < uniqueTranscriptIndexDetails.length - 1; i++) {
                            const detail1 = uniqueTranscriptIndexDetails[i];
                            const detail2 = uniqueTranscriptIndexDetails[i + 1];
                            if (detail2.transcriptIndex === detail1.transcriptIndex + 1) {
                                if (detail1.isPronoun !== detail2.isPronoun) {
                                    adjacencyCount++;
                                }
                            }
                        }
                        return adjacencyCount;
                    }

                    function findBestMatch(textToSearch, eligiblePageIds, excludedTranscriptWords = new Set(), excludePageIds = new Set(), context = 'normal') {
                        log(`--- findBestMatch (Context: ${context}, Time: ${currentTimeOfDay}, Text: "${textToSearch}", Eligible: ${[...eligiblePageIds]}, Exclude Pages: ${[...excludePageIds]}, Exclude KW: ${[...excludedTranscriptWords]}) ---`);
                        let potentialMatchesData = [];
                        const minConfidence = currentKeywordConfidenceThreshold;

                        eligiblePageIds.forEach(pageId => {
                            if (excludePageIds.has(pageId)) return;
                            const page = book.pages.find(p => p.id === pageId);
                            if (!page || soundCooldowns[pageId]) return;

                            if (page.timeOfDaySetting && page.timeOfDaySetting !== 'always' && page.timeOfDaySetting !== currentTimeOfDay) {
                                return;
                            }

                            const pkMetConfidence = checkPrimaryKeyConfidence(page, textToSearch, excludedTranscriptWords);
                            if (!pkMetConfidence) return;

                            let currentMatchDetails = [];
                            let meetsMinRequirements = false;

                            if (fuseInstance) {
                                const wordsInText = textToSearch.split(/\s+/).filter(w => w.length >= (fuseOptions.minMatchCharLength || 1) && !IGNORED_WORDS.has(w));
                                const pageKeywords = new Set(page.keywords || []);
                                const pagePrimaryKeys = new Set(page.primaryKey ? page.primaryKey.split(',').map(k => k.trim()).filter(Boolean) : []);
                                const tempMatchDetails = [];

                                wordsInText.forEach((transcriptWord) => {
                                    if (excludedTranscriptWords.has(transcriptWord.toLowerCase())) return;
                                    const fuseResults = fuseInstance.search(transcriptWord);
                                    fuseResults.forEach(result => {
                                        const { item: matchedKeywordData, score } = result;
                                        const confidence = 1.0 - score;
                                        const pageDefinitionKeyword = matchedKeywordData.keyword;
                                        const isPK = pagePrimaryKeys.has(pageDefinitionKeyword);
                                        const isRegularKeyword = pageKeywords.has(pageDefinitionKeyword); if (matchedKeywordData.pageId === pageId && (isPK || isRegularKeyword) && confidence >= minConfidence) {
                                            let matchIndex = -1;
                                            let searchFromIdx = 0;
                                            let found = false;
                                            let tempIndex;
                                            while (!found && (tempIndex = textToSearch.indexOf(transcriptWord, searchFromIdx)) !== -1) {
                                                let isSubPartOfExcluded = false;
                                                for (const excluded of excludedTranscriptWords) {
                                                    if (excluded.includes(transcriptWord) && textToSearch.substring(tempIndex - excluded.indexOf(transcriptWord), tempIndex - excluded.indexOf(transcriptWord) + excluded.length) === excluded) {
                                                        isSubPartOfExcluded = true;
                                                        break;
                                                    }
                                                }
                                                if (!isSubPartOfExcluded) {
                                                    matchIndex = tempIndex;
                                                    found = true;
                                                }
                                                searchFromIdx = tempIndex + 1;
                                            }
                                            if (matchIndex === -1) matchIndex = textToSearch.indexOf(transcriptWord);


                                            tempMatchDetails.push({
                                                keyword: pageDefinitionKeyword,
                                                confidence,
                                                index: matchIndex,
                                                matchedWord: transcriptWord,
                                                isPK,
                                                isExact: confidence === 1.0,
                                                isPronoun: PRONOUNS.has(pageDefinitionKeyword.toLowerCase())
                                            });
                                        }
                                    });
                                });

                                const uniqueBestMatches = new Map();
                                tempMatchDetails.forEach(detail => {
                                    if (!uniqueBestMatches.has(detail.keyword) || detail.confidence > uniqueBestMatches.get(detail.keyword).confidence) {
                                        uniqueBestMatches.set(detail.keyword, detail);
                                    }
                                });

                                // NEW: Ensure one transcript word can only satisfy one keyword match (PK or regular).
                                const allPotentialMatches = Array.from(uniqueBestMatches.values());
                                // Prioritize PK matches, then by confidence, to claim the best use of a transcript word.
                                allPotentialMatches.sort((a, b) => {
                                    if (a.isPK !== b.isPK) return a.isPK ? -1 : 1; // PKs first
                                    return b.confidence - a.confidence; // Higher confidence first
                                });

                                const claimedTranscriptWords = new Set();
                                const finalValidatedMatches = [];
                                allPotentialMatches.forEach(match => {
                                    const word = match.matchedWord.toLowerCase();
                                    if (!claimedTranscriptWords.has(word)) {
                                        finalValidatedMatches.push(match);
                                        claimedTranscriptWords.add(word);
                                    }
                                });

                                currentMatchDetails = finalValidatedMatches; // Use the validated list now
                                currentMatchDetails.sort((a, b) => a.index - b.index);

                                const matchedPKs = currentMatchDetails.filter(d => d.isPK);
                                const matchedRegularKeywords_NonPronoun = currentMatchDetails.filter(d => !d.isPK && !d.isPronoun);

                                const hasDefinedPK = page.primaryKey && page.primaryKey.trim().length > 0;
                                // The PK condition is met if it was found in the text OR via look-behind.
                                // pkMetConfidence is the variable that holds this combined truth.

                                if (hasDefinedPK) { // This logic is correct
                                    // RULE 1: If a PK is defined and the condition is met (via text or look-behind),
                                    // we only need one additional regular keyword from the current text.
                                    if (pkMetConfidence && matchedRegularKeywords_NonPronoun.length > 0) {
                                        meetsMinRequirements = true;
                                    } else {
                                        // This can happen if the look-behind PK was met, but no other keywords from the current text chunk matched.
                                        // e.g., "arrow flies... and then..." -> "and then" has no keywords for "Arrow Hits Object".
                                    }
                                } else {
                                    // RULE 2: If NO PK is defined, at least TWO other non-pronoun keywords must be matched.
                                    if (matchedRegularKeywords_NonPronoun.length >= 2) {
                                        meetsMinRequirements = true;
                                    }
                                }
                            }

                            if (meetsMinRequirements) {
                                let highConfidenceCount = 0;
                                let fuzzyScoreSum = 0;
                                let exactPKMatch = false;
                                let exactKeywordCount = 0;
                                const matchIndices = [];
                                const matchedDefinitionKeywords = new Set();

                                currentMatchDetails.forEach(detail => {
                                    if (!detail.isPronoun && !IGNORED_WORDS.has(detail.matchedWord.toLowerCase())) {
                                        if (detail.confidence >= HIGH_CONFIDENCE_THRESHOLD) highConfidenceCount++;
                                        fuzzyScoreSum += detail.confidence;
                                    }
                                    if (detail.isExact) {
                                        if (detail.isPK) exactPKMatch = true;
                                        else if (!detail.isPronoun && !IGNORED_WORDS.has(detail.matchedWord.toLowerCase())) exactKeywordCount++;
                                    }
                                    // Store the unique *definition* keywords that were matched, not the spoken words.
                                    if (!detail.isPK) {
                                        matchedDefinitionKeywords.add(detail.keyword);
                                    }
                                    matchIndices.push(detail.index);
                                });

                                const pronounAdjacencyCount = calculatePronounAdjacency(textToSearch, currentMatchDetails);
                                const playableSource = findPlayableSourceVariation(page, false);

                                if (playableSource) {
                                    potentialMatchesData.push({
                                        page: page,
                                        matchDetails: currentMatchDetails,
                                        matchedNonPKWords: matchedDefinitionKeywords,
                                        highConfidenceCount: highConfidenceCount,
                                        fuzzyScoreSum: fuzzyScoreSum,
                                        pronounAdjacencyCount: pronounAdjacencyCount,
                                        exactPKMatch: exactPKMatch,
                                        exactKeywordCount: exactKeywordCount,
                                        matchIndices: matchIndices
                                    });
                                } else if (!page.warnedMissing) {
                                    showTemporaryMessage(`Cannot consider "${page.title}": No playable variation for this chapter/time!`, 'warning');
                                    page.warnedMissing = true; setTimeout(() => { delete page.warnedMissing; }, 5000);
                                }
                            }
                        });

                        if (potentialMatchesData.length === 0) {
                            log(`--- findBestMatch (Context: ${context}) Result: No valid matches found meeting requirements.`);
                            return null;
                        }

                        log(`--- Sorting Potential Matches (Context: ${context}, ${potentialMatchesData.length} candidates) ---`);
                        potentialMatchesData.forEach(m => {
                            const matchedWords = m.matchDetails.map(d => d.matchedWord).join(', ');
                            log(`  -> Page ${m.page.id} ("${m.page.title}"): HiConfCnt=${m.highConfidenceCount}, FuzzyScore=${m.fuzzyScoreSum.toFixed(3)}, AdjCnt=${m.pronounAdjacencyCount}, ExactPK=${m.exactPKMatch}, ExactKW=${m.exactKeywordCount}, Indices=${m.matchIndices}, MatchedWords=${matchedWords}`);
                        });

                        potentialMatchesData.sort((a, b) => {
                            if (a.highConfidenceCount !== b.highConfidenceCount) {
                                return b.highConfidenceCount - a.highConfidenceCount;
                            }
                            // Prioritize matches with more unique non-PK definition words.
                            // This helps "branch snaps" (matching "snap") win over "thunder" (matching "sounded" via "under").
                            if (a.matchedNonPKWords.size !== b.matchedNonPKWords.size) {
                                return b.matchedNonPKWords.size - a.matchedNonPKWords.size;
                            }
                            // Prioritize matches with an exact Primary Key match.
                            if (a.exactPKMatch !== b.exactPKMatch) return a.exactPKMatch ? -1 : 1;
                            if (Math.abs(b.fuzzyScoreSum - a.fuzzyScoreSum) > SCORE_TIE_THRESHOLD) {
                                return b.fuzzyScoreSum - a.fuzzyScoreSum;
                            }
                            const firstIndexA = a.matchIndices?.[0] ?? Infinity;
                            const firstIndexB = b.matchIndices?.[0] ?? Infinity;
                            if (firstIndexA !== firstIndexB) return firstIndexA - firstIndexB;

                            if (b.exactKeywordCount !== a.exactKeywordCount) return b.exactKeywordCount - a.exactKeywordCount;

                            if (a.pronounAdjacencyCount !== b.pronounAdjacencyCount) {
                                return b.pronounAdjacencyCount - a.pronounAdjacencyCount;
                            }

                            const nonIgnoredKeywordsA = (a.page.keywords || []).filter(kw => !PRONOUNS.has(kw.toLowerCase()) && !IGNORED_WORDS.has(kw.toLowerCase()));
                            const pkKeywordsA_filtered = (a.page.primaryKey ? a.page.primaryKey.split(',').map(k => k.trim().toLowerCase()).filter(pk => !IGNORED_WORDS.has(pk)) : []);
                            const totalKeywordsA = nonIgnoredKeywordsA.length + pkKeywordsA_filtered.length;

                            const nonIgnoredKeywordsB = (b.page.keywords || []).filter(kw => !PRONOUNS.has(kw.toLowerCase()) && !IGNORED_WORDS.has(kw.toLowerCase()));
                            const pkKeywordsB_filtered = (b.page.primaryKey ? b.page.primaryKey.split(',').map(k => k.trim().toLowerCase()).filter(pk => !IGNORED_WORDS.has(pk)) : []);
                            const totalKeywordsB = nonIgnoredKeywordsB.length + pkKeywordsB_filtered.length;

                            if (totalKeywordsA !== totalKeywordsB) {
                                return totalKeywordsA - totalKeywordsB;
                            }

                            const matchedDetailsLengthA = a.matchDetails.length;
                            const matchedDetailsLengthB = b.matchDetails.length;
                            if (matchedDetailsLengthA !== matchedDetailsLengthB) {
                                return matchedDetailsLengthB - matchedDetailsLengthA;
                            }

                            return a.page.id - b.page.id;
                        });

                        const bestMatchData = potentialMatchesData[0];

                        // Confidence Floor: Even if it's the "best" match, if it has no high-confidence keywords, it's not good enough.
                        if (bestMatchData.highConfidenceCount === 0) {
                            log(`--- findBestMatch (Context: ${context}) Result: Best match "${bestMatchData.page.title}" rejected. No high-confidence keywords matched.`);
                            return null;
                        }

                        log(`--- findBestMatch (Context: ${context}) Result: Best match is Page ${bestMatchData.page.id} ("${bestMatchData.page.title}") - HiConfCnt=${bestMatchData.highConfidenceCount}, FuzzyScore=${bestMatchData.fuzzyScoreSum.toFixed(3)}, AdjCnt=${bestMatchData.pronounAdjacencyCount}`);
                        return bestMatchData;
                    }

                    // --- Keyword Checking Logic ---
                    // --- Keyword Checking Logic ---
                    async function checkForKeywords(text, currentBook, isInterim = false, wordsToExclude = new Set()) {
                        if (!text || !isListening) return;

                        // 1. Stop Phrases Check (Highest Priority)
                        // Clean up old page events before checking anything else
                        const now = Date.now();
                        if (recentPageEvents.events.length > 0) {
                            // Find the max time window from all contextual triggers to be efficient
                            let maxTimeWindow = 0;
                            if (book.appendix) {
                                book.appendix.forEach(entry => {
                                    if (entry.trigger.type === 'contextual_phrase' && entry.trigger.timeWindow > maxTimeWindow) {
                                        maxTimeWindow = entry.trigger.timeWindow;
                                    }
                                });
                            }
                            const oldestAllowedTimestamp = now - ((maxTimeWindow || 5) * 1000); // Use 5s as a fallback
                            recentPageEvents.events = recentPageEvents.events.filter(event => event.timestamp >= oldestAllowedTimestamp);
                        }



                        // 1. Stop Phrases Check (Highest Priority)
                        if (stopPhrases && stopPhrases.length > 0) {
                            const foundStopPhrase = stopPhrases.find(phrase => new RegExp(`\\b${phrase.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&')}\\b`, 'i').test(text));
                            if (foundStopPhrase) {
                                log(`Stop Phrase "${foundStopPhrase}" detected! Stopping all sounds.`);
                                stopAllSounds();
                                return; // Stop further processing
                            }
                        }

                        // 2. Time Transition Phrase Check
                        let timeTransitionHandled = false;
                        if (currentTimeOfDay === 'day' && nighttimeTransitionPhrases && nighttimeTransitionPhrases.length > 0) {
                            const foundNightPhrase = nighttimeTransitionPhrases.find(phrase => new RegExp(`\\b${phrase.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&')}\\b`, 'i').test(text));
                            if (foundNightPhrase) {
                                log(`Nighttime transition phrase "${foundNightPhrase}" detected.`);
                                toggleTimeOfDay('night'); // This will handle autoplay checks
                                timeTransitionHandled = true;
                            }
                        } else if (currentTimeOfDay === 'night' && daytimeTransitionPhrases && daytimeTransitionPhrases.length > 0) {
                            const foundDayPhrase = daytimeTransitionPhrases.find(phrase => new RegExp(`\\b${phrase.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&')}\\b`, 'i').test(text));
                            if (foundDayPhrase) {
                                log(`Daytime transition phrase "${foundDayPhrase}" detected.`);
                                toggleTimeOfDay('day'); // This will handle autoplay checks
                                timeTransitionHandled = true;
                            }
                        }
                        if (timeTransitionHandled) return; // Stop further processing if time changed

                        // 3. Appendix Checks (Contextual first, then simple phrase)
                        if (book.appendix && book.appendix.length > 0) {
                            for (const entry of book.appendix) {
                                if (entry.trigger.type === 'phrase') {
                                    const foundPhrase = entry.trigger.phrases.find(phrase => new RegExp(`\\b${phrase.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&')}\\b`, 'i').test(text));
                                    if (foundPhrase) {
                                        if (entry.conditions && entry.conditions.length > 0 && !checkAppendixConditions(entry.conditions)) {
                                            continue; // Skip if activation conditions are not met
                                        }
                                        log(`Appendix Phrase Triggered: "${foundPhrase}" for entry ID ${entry.id}`);
                                        executeAppendixEntry(entry);
                                        // For now, we assume an appendix phrase is a standalone command and stop further page checks.
                                        return;
                                    }
                                } else if (entry.trigger.type === 'contextual_phrase') {
                                    // Check if a pre-condition event has occurred recently
                                    if (entry.conditions && entry.conditions.length > 0 && !checkAppendixConditions(entry.conditions)) {
                                        continue; // Skip if activation conditions are not met
                                    }

                                    const recentMatchingEvent = recentPageEvents.events.find(e =>
                                        e.event === entry.trigger.event &&
                                        entry.trigger.pages.includes(e.pageId) &&
                                        (now - e.timestamp <= (entry.trigger.timeWindow * 1000)) &&
                                        !e.usedBy.has(entry.id) // Check if this entry has already used this specific event
                                    );

                                    if (recentMatchingEvent) {
                                        const foundContextualPhrase = entry.trigger.phrases.find(phrase => new RegExp(`\\b${phrase.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&')}\\b`, 'i').test(text));
                                        if (foundContextualPhrase) {
                                            log(`Appendix Contextual Phrase Triggered: "${foundContextualPhrase}" for entry ID ${entry.id} after event on page ${recentMatchingEvent.pageId}`);
                                            executeAppendixEntry(entry);
                                            if (!entry.trigger.allowMultiple) {
                                                recentMatchingEvent.usedBy.add(entry.id); // Mark this event as used by this entry
                                            }
                                            return; // Contextual phrases take precedence
                                        }
                                    }
                                }
                            }
                        }

                        // 4. Story Plot Thread Activation Check (Priority over standard chapter transitions)
                        const activeChapterNode = currentBook.storyPlot.nodes.find(node => node.chapterId == currentBook.activeChapterId);
                        if (activeChapterNode) {
                            const outgoingThreads = (currentBook.storyPlot.threads || []).filter(thread => thread.fromNodeId === activeChapterNode.id);
                            for (const thread of outgoingThreads) {
                                // Check all conditions (page, time, etc.) for the thread.
                                if (!checkAppendixConditions(thread.conditions)) {
                                    continue; // Skip thread if its conditions are not met.
                                }

                                let threadTriggered = false;
                                const threadPhrases = thread.transitionPhrases || [];
                                const threadKeywords = thread.keywords || [];

                                // Check phrases first
                                if (threadPhrases.length > 0) {
                                    const foundThreadPhrase = threadPhrases.find(phrase => new RegExp(`\\b${phrase.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&')}\\b`, 'i').test(text));
                                    if (foundThreadPhrase) {
                                        log(`Plot Thread "${thread.id}" (${thread.title || 'Untitled'}) triggered by phrase: "${foundThreadPhrase}"`);
                                        threadTriggered = true;
                                    }
                                }
                                // If not triggered by phrase, check keywords
                                if (!threadTriggered && threadKeywords.length > 0) {
                                    const foundThreadKeyword = threadKeywords.find(kw => new RegExp(`\\b${kw.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&')}\\b`, 'i').test(text));
                                    if (foundThreadKeyword) {
                                        log(`Plot Thread "${thread.id}" (${thread.title || 'Untitled'}) triggered by keyword: "${foundThreadKeyword}"`);
                                        threadTriggered = true;
                                    }
                                }

                                if (threadTriggered) {
                                    const toPlotNode = getPlotNodeById(thread.toNodeId);
                                    if (toPlotNode && toPlotNode.chapterId) {
                                        log(`Activating Plot Thread: From Chapter ${activeChapterNode.chapterId} to Chapter ${toPlotNode.chapterId}`);
                                        const soundsToPlayFromThread = thread.soundPageIds || [];
                                        if (thread.timeChange && thread.timeChange !== 'none' && thread.timeChange !== currentTimeOfDay) {
                                            log(`Plot Thread changing time to: ${thread.timeChange}`);
                                            toggleTimeOfDay(thread.timeChange); // This will handle sound adjustments for time change
                                        }
                                        const triggerChapterAutoplay = !(thread.disableAutoplay || false);
                                        // setActiveChapter will handle sound stopping/variation switching based on new chapter
                                        setActiveChapter(toPlotNode.chapterId, triggerChapterAutoplay, 'plot_thread', soundsToPlayFromThread, thread);
                                        // Play sounds specifically configured for this thread
                                        playSoundsFromPlotThread(soundsToPlayFromThread, `plot_thread_${thread.id}`);
                                        return; // Plot thread activation takes precedence
                                    } else {
                                        console.warn(`Plot Thread ${thread.id} target node or chapterId missing.`);
                                    }
                                }
                            }
                        }

                        // 5. Exit Phrase Check
                        let exitPhraseHandled = false;
                        const allExitPhrases = [...BUILT_IN_EXIT_PHRASES, ...(customExitPhrases || [])];
                        const currentActiveChapterData = currentBook.chapters.find(ch => ch.id == currentBook.activeChapterId);

                        if (currentActiveChapterData && !currentActiveChapterData.isIndex) { // Cannot "exit" the Index chapter via phrase
                            for (const exitPhrase of allExitPhrases) {
                                // Check for return context first
                                if (lookBehindContext.returnChapterContext?.fromChapterId && lookBehindContext.returnChapterContext.viaThreadId) {
                                    const originThread = getPlotThreadById(lookBehindContext.returnChapterContext.viaThreadId);
                                    if (originThread) {
                                        const returnKeywordType = originThread.returnKeywordType || 'both'; // Default to 'both'
                                        let keywordsToCheck = [];

                                        if (returnKeywordType === 'chapter' || returnKeywordType === 'both') {
                                            keywordsToCheck.push(...(currentActiveChapterData.chapterKeywords || []));
                                        }
                                        if (returnKeywordType === 'thread' || returnKeywordType === 'both') {
                                            keywordsToCheck.push(...(originThread.keywords || []));
                                        }

                                        // Remove duplicates
                                        keywordsToCheck = [...new Set(keywordsToCheck)];

                                        for (const keyword of keywordsToCheck) {
                                            const returnRegex = new RegExp(`\\b${exitPhrase.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&')}\\s+(?:the\\s+|a\\s+|an\\s+|from\\s+)?${keyword.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&')}\\b`, 'i');
                                            if (returnRegex.test(text)) {
                                                const triggerAutoplay = !(originThread.disableAutoplay || false);
                                                log(`Exit Phrase "${exitPhrase}" + Keyword "${keyword}" (Type: ${returnKeywordType}) detected with active return context. Returning to chapter ${lookBehindContext.returnChapterContext.fromChapterId}. Autoplay: ${triggerAutoplay}`);
                                                setActiveChapter(lookBehindContext.returnChapterContext.fromChapterId, triggerAutoplay, 'exit_phrase_return');
                                                exitPhraseHandled = true;
                                                break; // Keyword found, no need to check others for this exit phrase
                                            }
                                        }
                                    }
                                }
                                if (exitPhraseHandled) {
                                    break; // Exit phrase handled, no need to check other exit phrases
                                }
                                for (const chapterKeywordData of chapterKeywordList) {
                                    const targetKeyword = chapterKeywordData.keyword;
                                    // Regex to match "exitPhrase [the/a/an/from] chapterKeyword"
                                    const exitPhraseRegex = new RegExp(`\\b${exitPhrase.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&')}\\s+(?:the\\s+|a\\s+|an\\s+|from\\s+)?${targetKeyword.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&')}\\b`, 'i');
                                    const match = text.match(exitPhraseRegex);

                                    if (match && chapterKeywordData.chapterId == currentBook.activeChapterId) { // Matched an exit phrase for the *current* chapter
                                        log(`Exit Phrase "${exitPhrase}" + Chapter Keyword "${targetKeyword}" detected for active chapter "${currentActiveChapterData.name}".`);
                                        const leaveTransitionTargetId = currentActiveChapterData.leaveTransitionTargetId || 'index'; // Default to Index
                                        const afterLeaveSoundsCallback = () => {
                                            log(`Leave sounds finished. Transitioning to chapter ${leaveTransitionTargetId}.`);
                                            setActiveChapter(leaveTransitionTargetId, true, 'exit_phrase');
                                        };
                                        // Play sounds configured to play on leaving this chapter, then transition
                                        playLeaveSounds(currentActiveChapterData.leaveSoundPageIds || [], afterLeaveSoundsCallback);
                                        exitPhraseHandled = true;
                                        break; // Exit inner loop (chapter keywords)
                                    }
                                }
                                if (exitPhraseHandled) break; // Exit outer loop (exit phrases)
                            }
                        }
                        if (exitPhraseHandled) return; // Stop further processing

                        // 6. Enter Phrase Check
                        let enterPhraseFound = false;
                        const allEnterPhrases = [...BUILT_IN_ENTER_PHRASES, ...(customEnterPhrases || [])];
                        for (const cue of allEnterPhrases) {
                            const cueRegex = new RegExp(`\\b${cue.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&')}\\s+(?:the\\s+|a\\s+|an\\s+|to\\s+)?(.+)`, 'i');
                            const match = text.match(cueRegex);
                            if (match && match[1]) {
                                const potentialTargetPhrase = match[1].trim(); // The part after "enter the/a/to"
                                // Check this phrase against all chapter keywords
                                for (const chapterKeywordData of chapterKeywordList) {
                                    const targetRegex = new RegExp(`\\b${chapterKeywordData.keyword.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&')}\\b`, 'i');
                                    if (targetRegex.test(potentialTargetPhrase) && chapterKeywordData.chapterId != currentBook.activeChapterId) {
                                        log(`Enter Phrase "${cue}" + Chapter Keyword "${chapterKeywordData.keyword}" matched! Switching to chapter ID: ${chapterKeywordData.chapterId}`);
                                        setActiveChapter(chapterKeywordData.chapterId, true, 'enter_phrase'); // True for triggeredByVoice for autoplay
                                        enterPhraseFound = true;
                                        break; // Exit chapterKeywordList loop
                                    }
                                }
                            }
                            if (enterPhraseFound) break; // Exit allEnterPhrases loop
                        }
                        if (enterPhraseFound) return; // Stop further processing

                        // 7. Determine Relevant Pages for individual page triggering
                        const activeChapterForPages = currentBook.chapters.find(ch => ch.id == currentBook.activeChapterId);
                        if (!activeChapterForPages) { console.error(`Active chapter ${currentBook.activeChapterId} not found!`); return; }
                        const textForVariationCheck = text; // Capture the full text for variation matching
                        let relevantPageIds = new Set();
                        const potentialPages = []; // Pages to consider for matching

                        if (activeChapterForPages.isIndex) {
                            // If in Index, all pages are potentially relevant
                            potentialPages.push(...currentBook.pages);
                        } else {
                            // Pages in the current active chapter
                            potentialPages.push(...activeChapterForPages.pageIds.map(id => currentBook.pages.find(p => p.id === id)).filter(Boolean));

                            // Add pages from collections that have a matching tag with the active chapter
                            const activeChapterTagIds = new Set(activeChapterForPages.tagIds || []);
                            if (activeChapterTagIds.size > 0) {
                                (book.collections || []).forEach(collection => {
                                    const hasMatchingTag = (collection.tagIds || []).some(tagId => activeChapterTagIds.has(tagId));
                                    if (hasMatchingTag) {
                                        collection.pageIds.forEach(pageId => {
                                            const page = book.pages.find(p => p.id === pageId);
                                            if (page && !potentialPages.some(p => p.id === pageId)) potentialPages.push(page);
                                        });
                                    }
                                });
                            }
                            // Individually starred pages not already in the current chapter
                            potentialPages.push(...currentBook.pages.filter(p => p.isStarred && !activeChapterForPages.pageIds.includes(p.id)));
                            // Pages from other starred chapters
                            const starredChapters = currentBook.chapters.filter(ch => ch.isStarred && !ch.isIndex && ch.id != activeChapterForPages.id);
                            starredChapters.forEach(starredChapter => {
                                starredChapter.pageIds.forEach(pageId => {
                                    if (!potentialPages.some(pc => pc.id === pageId)) { // Avoid duplicates
                                        const page = currentBook.pages.find(p => p.id === pageId);
                                        if (page) potentialPages.push(page);
                                    }
                                });
                            });
                        }
                        // Filter by time of day
                        potentialPages.forEach(page => {
                            if (page.timeOfDaySetting === 'always' || page.timeOfDaySetting === currentTimeOfDay) {
                                relevantPageIds.add(page.id);
                            }
                        });

                        // 8. Check Loop End Keywords for currently active sounds
                        let stoppedSoundThisCheck = false;
                        Object.keys(activeSounds).forEach(activePageIdStr => { // Use a copy of keys to avoid issues if activeSounds is modified
                            const activePageId = parseInt(activePageIdStr, 10);
                            if (relevantPageIds.has(activePageId)) {
                                const activePage = currentBook.pages.find(p => p.id === activePageId);
                                if (activePage?.loop && activePage.endPlayKeywords?.length > 0) {
                                    const foundEndKeyword = activePage.endPlayKeywords.find(keyword =>
                                        new RegExp(`\\b${keyword.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&')}\\b`, 'i').test(text)
                                    ); // This regex needs to check against the un-consumed part of the text
                                    if (foundEndKeyword) {
                                        log(`End keyword "${foundEndKeyword}" for looping sound "${activePage.title}". Stopping.`);
                                        stopSingleSound(activePageId);
                                        setSoundCooldown(activePageId, SMART_COOLDOWN_MS); // Cooldown to prevent immediate retrigger
                                        stoppedSoundThisCheck = true;
                                    }
                                }
                            }
                        });
                        if (stoppedSoundThisCheck) return;

                        // 9. Find Match(es) for individual page triggering
                        let keepSearching = true;
                        const pageIdsPlayedThisUtterance = new Set(); // Prevent re-playing the same page in one utterance

                        while (keepSearching) {
                            // Deactivate look-behind if it's expired
                            if (lookBehindContext.active && (Date.now() - lookBehindContext.timestamp >= LOOK_BEHIND_DURATION_MS)) {
                                log("Look-behind context expired.");
                                lookBehindContext.active = false;
                                lookBehindContext.primaryKeys = [];
                            }

                            // Find the best match from the remaining text, excluding pages already played in this utterance.
                            const bestMatch = findBestMatch(text, relevantPageIds, wordsToExclude, pageIdsPlayedThisUtterance, 'multi_match_loop');

                            if (bestMatch) {
                                log(`Multi-match loop: Found match "${bestMatch.page.title}". Playing.`);
                                pageIdsPlayedThisUtterance.add(bestMatch.page.id); // Add to exclusion list for this utterance

                                const sourceToPlay = findPlayableSourceVariation(bestMatch.page, false, textForVariationCheck);
                                if (sourceToPlay) {
                                    // Consume the matched words from the transcript so they aren't re-used.
                                    const wordsInMatch = bestMatch.matchDetails.map(d => d.matchedWord.toLowerCase());
                                    wordsInMatch.forEach(w => wordsToExclude.add(w));
                                    log(`Consumed words from multi-match: ${[...wordsInMatch]}`);

                                    // Set the look-behind context if this match has a primary key. // This logic is correct
                                    if (isCompoundPhrasingEnabled && bestMatch.page.primaryKey) {
                                        const primaryKeys = bestMatch.page.primaryKey.split(',').map(k => k.trim()).filter(Boolean);
                                        lookBehindContext.active = true;
                                        lookBehindContext.primaryKeys = primaryKeys;
                                        lookBehindContext.timestamp = Date.now();
                                        log(`Look-behind context activated with PKs: [${primaryKeys.join(', ')}]`);
                                    }

                                    playSound(bestMatch.page, sourceToPlay, false, () => {
                                        if (bestMatch.page.nextPageId !== null) {
                                            triggerNextPage(bestMatch.page.nextPageId);
                                        }
                                    });
                                    const cooldownDuration = SMART_COOLDOWN_MS;
                                    setSoundCooldown(bestMatch.page.id, cooldownDuration);
                                } else {
                                    console.warn(`Match found for "${bestMatch.page.title}" but no playable source. Stopping search for this utterance.`);
                                    keepSearching = false;
                                }
                            } else {
                                keepSearching = false; // No more matches found, exit the loop.
                            }
                        }

                        // 10. Soundtrack Keywords Check
                        if (typeof evaluateSoundtrackTriggers === 'function') {
                            evaluateSoundtrackTriggers(text, 'keyword');
                        }
                    }


                    // --- Play Compound Sequence ---
                    function playCompoundSequence(queue, finalNextPageId) {
                        if (!queue || queue.length === 0) return;
                        log(`Starting compound sequence playback (${queue.length} pages). Final next page: ${finalNextPageId}`);
                        let currentQueueIndex = 0;

                        function playNextInSequence() {
                            if (currentQueueIndex >= queue.length) {
                                log("Compound sequence finished.");
                                if (finalNextPageId !== null && finalNextPageId !== undefined) {
                                    log(`Compound sequence finished. Triggering final nextPageId: ${finalNextPageId}`);
                                    triggerNextPage(finalNextPageId);
                                }
                                return;
                            }

                            const { page } = queue[currentQueueIndex];
                            const sourceToPlay = findPlayableSourceVariation(page, false, null); // No text to check for compound sequence variations

                            if (sourceToPlay) {
                                const cooldownDuration = isSmartFilteringEnabled ? SMART_COOLDOWN_MS : QUICK_COOLDOWN_MS;
                                log(`Compound Play (${currentQueueIndex + 1}/${queue.length}): "${page.title}" (ID: ${page.id}) Variation: ${sourceToPlay.name || sourceToPlay.fileName || sourceToPlay.type} (Chapter: ${sourceToPlay.chapterIds?.join(',') || 'General'}, Time: ${sourceToPlay.timeOfDay})`);
                                playSound(page, sourceToPlay, false, onEnded, true, false); // isCompoundSequence = true
                                setSoundCooldown(page.id, cooldownDuration);
                            } else {
                                console.warn(`Skipping compound page "${page.title}" (ID: ${page.id}): No playable sources for chapter ${book.activeChapterId} / time ${currentTimeOfDay}.`);
                                showTemporaryMessage(`Cannot play compound page "${page.title}": No variation for this chapter/time!`, 'warning');
                                currentQueueIndex++;
                                setTimeout(() => { playNextInSequence(); }, SEQUENTIAL_PLAY_DELAY_MS); // Still proceed with sequence
                            }
                        }
                        playNextInSequence();
                    }


                    // --- Play Sounds From Plot Thread (Simultaneous) ---
                    function playSoundsFromPlotThread(pageIds, context = "plot_thread_sounds") {
                        if (!pageIds || pageIds.length === 0) {
                            log(`playSoundsFromPlotThread (${context}): No page IDs to play.`);
                            return;
                        }
                        log(`playSoundsFromPlotThread (${context}): Starting simultaneous playback of ${pageIds.length} sounds in chapter ${book.activeChapterId} at time ${currentTimeOfDay}.`);

                        pageIds.forEach(pageIdToPlay => {
                            const page = book.pages.find(p => p.id === pageIdToPlay);
                            if (page) {
                                // Check page's overall time restriction
                                if (checkVariationConditions(page.conditions)) {
                                    // Find a playable variation based on the NEW chapter and current time
                                    const sourceToPlay = findPlayableSourceVariation(page, true, null); // No text to check for plotter variations
                                    if (sourceToPlay) {
                                        log(`playSoundsFromPlotThread (${context}) - Playing: "${page.title}" (ID: ${page.id})`);
                                        playSound(page, sourceToPlay, true, null, false, true); // startedByAutoplay=true, isPlotThreadSound=true
                                    } else {
                                        console.warn(`playSoundsFromPlotThread (${context}): Skipping "${page.title}" - No playable variation for chapter ${book.activeChapterId} / time ${currentTimeOfDay}.`);
                                        showTemporaryMessage(`Plot: Cannot play "${page.title}" - No variation for new chapter/time.`, 'warning');
                                    }
                                } else {
                                    log(`playSoundsFromPlotThread (${context}): Skipping "${page.title}" due to page conditions not being met.`);
                                }
                            } else {
                                console.warn(`playSoundsFromPlotThread (${context}): Page ID ${pageIdToPlay} not found. Skipping.`);
                            }
                        });
                    }


                    // --- Play Leave Sounds Helper (Sequential with Callback) ---
                    function playLeaveSounds(pageIds, onAllSoundsFinishedCallback) {
                        if (!pageIds || pageIds.length === 0) {
                            log("No 'leave sounds' configured for this chapter.");
                            if (typeof onAllSoundsFinishedCallback === 'function') onAllSoundsFinishedCallback();
                            return;
                        }
                        log(`Playing ${pageIds.length} leave sounds sequentially.`);
                        let currentIndex = 0;

                        function playNextLeaveSound() {
                            if (currentIndex >= pageIds.length) {
                                log("All leave sounds finished.");
                                if (typeof onAllSoundsFinishedCallback === 'function') onAllSoundsFinishedCallback();
                                return;
                            }
                            const pageIdToPlay = pageIds[currentIndex];
                            const page = book.pages.find(p => p.id === pageIdToPlay);
                            if (page) {
                                // Check page's overall time restriction
                                if (checkVariationConditions(page.conditions)) {
                                    const sourceToPlay = findPlayableSourceVariation(page, false, null); // No text to check for leave sound variations
                                    if (sourceToPlay) {
                                        log(`Playing leave sound ${currentIndex + 1}/${pageIds.length}: "${page.title}"`);
                                        playSound(page, sourceToPlay, true, () => { // Mark as autoplay, provide callback
                                            currentIndex++;
                                            setTimeout(playNextLeaveSound, SEQUENTIAL_PLAY_DELAY_MS); // Delay before next sound in sequence
                                        }, false, false); // Not compound, not plot thread
                                    } else {
                                        console.warn(`Skipping leave sound "${page.title}": No playable variation.`);
                                        currentIndex++; // Move to next sound even if this one fails
                                        setTimeout(playNextLeaveSound, SEQUENTIAL_PLAY_DELAY_MS);
                                    }
                                } else {
                                    log(`Skipping leave sound "${page.title}" due to page conditions not being met.`);
                                    currentIndex++;
                                    setTimeout(playNextLeaveSound, SEQUENTIAL_PLAY_DELAY_MS);
                                }
                            } else {
                                console.warn(`Leave sound Page ID ${pageIdToPlay} not found. Skipping.`);
                                currentIndex++;
                                setTimeout(playNextLeaveSound, COMPOUND_DELAY_MS);
                            }
                        }
                        playNextLeaveSound(); // Start the sequence
                    }


                    function playSound(page, sourceDetailToPlay = null, startedByAutoplay = false, onEndedCallback = null, isCompoundSequence = false, isPlotThreadSound = false, isInternalLoopIteration = false, triggeredByAppendix = false) {
                        // If this page is already playing and this is not an internal loop call, just ignore the request.
                        if (activeSounds[page.id] && !isInternalLoopIteration) {
                            log(`playSound: Ignoring trigger for Page ID ${page.id} ("${page.title}") because it is already playing.`);
                            return;
                        }

                        let sourceDetail = sourceDetailToPlay || findPlayableSourceVariation(page, isPlotThreadSound, null); // Text is not available here, so pass null
                        let parentVariation = null; // To hold the container

                        // NEW: If the selected source is a variation container, pick a playable sub-source from it.
                        if (sourceDetail && Array.isArray(sourceDetail.sources) && sourceDetail.sources.length > 0) {
                            parentVariation = sourceDetail; // This is the container
                            const playableSubSources = sourceDetail.sources.filter(sub =>
                                // This logic is correct for finding a playable source
                                (sub.type === 'file' && !sub.needsFile) ||
                                sub.type === 'youtube' ||
                                (sub.type === 'syrinscape' && sub.syrinscapeElementId)
                            );
                            if (playableSubSources.length > 0) {
                                const randomIndex = Math.floor(Math.random() * playableSubSources.length);
                                sourceDetail = playableSubSources[randomIndex]; // Now sourceDetail is a playable sub-source
                            } else {
                                sourceDetail = null; // The variation had sources, but none were playable.
                            }
                        }

                        if (!page || !sourceDetail) {
                            console.error("playSound: Page or suitable Source Variation not found.", { pageId: page?.id, activeChapterId: book.activeChapterId, timeOfDay: currentTimeOfDay });
                            if (page) { // Removed !sourceDetailToPlay check to show warning even if a variation container was found but had no playable sub-sources
                                showTemporaryMessage(`Cannot play "${page.title}": No playable variation for this chapter/time!`, 'warning');
                            }
                            if (onEndedCallback && typeof onEndedCallback === 'function') { console.warn(`Executing onEndedCallback immediately for Page ID ${page?.id} due to playback prerequisites error.`); try { onEndedCallback(); } catch (e) { console.error("Error in immediate callback (prerequisites):", e); } }
                            return;
                        }
                        if (sourceDetail.type === 'file' && sourceDetail.needsFile) {
                            console.error("playSound prerequisites not met (file needed)", { pageId: page.id, sourceDetail });
                            showTemporaryMessage(`Cannot play "${page.title}" (Variation: ${sourceDetail.name || sourceDetail.fileName}): File Missing!`, 'error');
                            if (onEndedCallback && typeof onEndedCallback === 'function') { console.warn(`Executing onEndedCallback immediately for Page ID ${page.id} due to file missing.`); try { onEndedCallback(); } catch (e) { console.error("Error in immediate callback (file missing):", e); } }
                            return;
                        }
                        if (sourceDetail.type === 'youtube' && !youtubeApiReady) { // Defer playback if YT API isn't ready
                            console.warn(`YouTube API not ready. Queuing play request for Page ID ${page.id} ("${page.title}").`);
                            pendingYTPlays.push({ page, sourceDetailToPlay: sourceDetail, startedByAutoplay, onEndedCallback, isCompoundSequence, isPlotThreadSound, isInternalLoopIteration, triggeredByAppendix });
                            return;
                        }
                        if (sourceDetail.type === 'syrinscape' && !syrinscapePlayerReady) {
                            console.error("playSound prerequisites not met (Syrinscape player not ready)", { pageId: page.id });
                            showTemporaryMessage(`Cannot play "${page.title}" (Syrinscape): Player not initialized. Check Settings.`, 'error', 5000);
                            if (onEndedCallback && typeof onEndedCallback === 'function') { console.warn(`Executing onEndedCallback immediately for Page ID ${page.id} due to Syrinscape player not ready.`); try { onEndedCallback(); } catch (e) { console.error("Error in immediate callback (Syrinscape player):", e); } }
                            return;
                        }

                        // LOG: Trigger 'activated' event for Appendix
                        if (!isInternalLoopIteration && !triggeredByAppendix) {
                            triggerAppendixPageEvent(page.id, 'activated');
                        }
                        if (!isInternalLoopIteration) {
                            page.currentLoop = 0; // Reset loop count only for fresh (non-internal-loop) plays
                        }

                        const soundData = {
                            node: null,
                            gainNode: null,
                            parentVariation: parentVariation, // NEW: To store the parent variation container
                            sourceDetail: sourceDetail,
                            startedByAutoplay: startedByAutoplay && !isPlotThreadSound,
                            isPlotThreadSound: isPlotThreadSound,
                            onEndedCallback: onEndedCallback, isCompoundSequence: isCompoundSequence,
                            syrinscapeTimeoutId: null,
                            syrinscapeTimeoutInstanceId: null
                        };
                        activeSounds[page.id] = soundData; // This will overwrite if it's an internal loop, which is fine as the instance data is fresh.
                        log(`LOG (playSound): Playing Page ID ${page.id} ("${page.title}") - Type: ${sourceDetail.type}, Variation: ${sourceDetail.name || sourceDetail.fileName || sourceDetail.syrinscapeElementId} (LoopIter: ${page.currentLoop + 1}), Autoplay: ${soundData.startedByAutoplay}, PlotThreadSound: ${soundData.isPlotThreadSound}`);

                        // Add to recent events list for contextual triggers
                        recentPageEvents.events.push({
                            pageId: page.id,
                            event: 'activated',
                            timestamp: Date.now(),
                            usedBy: new Set() // To track which single-use triggers have used this event
                        });
                        // reEvaluateActiveSounds(page.id); // Re-evaluate other sounds now that this one is active

                        const playInstance = (currentSourceDetail, isRestart = false) => { // isRestart is for file-based loop restart (less relevant now)
                            if (currentSourceDetail.type === 'file') {
                                if (!audioContext || !currentSourceDetail.source || !(currentSourceDetail.source instanceof AudioBuffer)) {
                                    console.error("AudioContext or source buffer missing for file playback.");
                                    const callback = activeSounds[page.id]?.onEndedCallback; delete activeSounds[page.id]; updatePageItem(page.id);
                                    if (callback && typeof callback === 'function') { console.warn(`Executing onEndedCallback immediately for Page ID ${page?.id} due to playback start error.`); try { callback(); } catch (e) { console.error("Error in immediate callback (start error):", e); } }
                                    return;
                                }
                                if (audioContext.state === 'suspended') audioContext.resume();
                                const sourceNode = audioContext.createBufferSource(); sourceNode.buffer = currentSourceDetail.source;
                                const gainNode = audioContext.createGain(); sourceNode.connect(gainNode); gainNode.connect(audioContext.destination);

                                let actualLoopForFile = page.loop && page.loopCount === -1; // AudioBufferSourceNode.loop is boolean for indefinite
                                sourceNode.loop = actualLoopForFile;

                                const now = audioContext.currentTime;
                                const pageOrVariationVolume = (typeof currentSourceDetail.volumeOverride === 'number') ? currentSourceDetail.volumeOverride : page.volume;
                                const modifier = volumeModifiers[page.id] || 0;
                                const finalVolume = Math.max(0, Math.min(100, pageOrVariationVolume + modifier));
                                const finalGainValue = (finalVolume / 100) * (currentMasterVolume / 100);
                                const targetGain = Math.max(MIN_GAIN, Math.min(1, finalGainValue));

                                log(`LOG (playSound): Setting FILE volume for "${page.title}". Page/Var Vol: ${pageOrVariationVolume}, Modifier: ${modifier}, Master: ${currentMasterVolume}%, Final Gain: ${targetGain.toFixed(4)}`);

                                if (page.fadeInOut && !isRestart) { // isRestart for files might mean a manual re-trigger of a counted loop
                                    gainNode.gain.setValueAtTime(MIN_GAIN, now);
                                    gainNode.gain.linearRampToValueAtTime(targetGain, now + FADE_DURATION);
                                } else {
                                    gainNode.gain.setValueAtTime(targetGain, now);
                                }

                                const bufferDuration = sourceNode.buffer.duration;
                                if (page.fadeInOut && !actualLoopForFile && bufferDuration > FADE_DURATION) { // Fade out for non-indefinite loops
                                    const naturalEndTime = now + bufferDuration + (page.fadeInOut && !isRestart ? FADE_DURATION : 0);
                                    const fadeOutStartTime = naturalEndTime - FADE_DURATION;
                                    const actualFadeOutStartTime = Math.max(now + (page.fadeInOut && !isRestart ? FADE_DURATION : 0), fadeOutStartTime);

                                    if (actualFadeOutStartTime < naturalEndTime) {
                                        gainNode.gain.setValueAtTime(targetGain, actualFadeOutStartTime);
                                        gainNode.gain.linearRampToValueAtTime(MIN_GAIN, actualFadeOutStartTime + FADE_DURATION);
                                    }
                                }
                                sourceNode.onended = () => {
                                    const activeData = activeSounds[page.id];
                                    if (!activeData || activeData.node !== sourceNode || activeData.sourceDetail !== currentSourceDetail) return;

                                    let isFinalEnd = true; // Assume final unless looping continues
                                    if (page.loop && !actualLoopForFile && page.loopCount > 0) { // Counted loop for files (not using sourceNode.loop)
                                        if (page.currentLoop < page.loopCount) {
                                            page.currentLoop++;
                                            log(`Looping FILE Page ID ${page.id} ("${page.title}") - Starting iteration ${page.currentLoop + 1} of ${page.loopCount}`);
                                            playSound(page, currentSourceDetail, startedByAutoplay, onEndedCallback, isCompoundSequence, isPlotThreadSound, true, activeData.triggeredByAppendix); // isInternalLoopIteration = true
                                            return; // Recursive call, so return
                                        }
                                    }
                                    // If actualLoopForFile was true (indefinite), this onended only fires on explicit stop.

                                    if (isFinalEnd) {
                                        log(`Final end for FILE Page ID ${page.id} ("${page.title}") Variation: ${currentSourceDetail.name || currentSourceDetail.fileName}`);
                                        const callbackToExecute = activeData.onEndedCallback;
                                        const nextPageToTriggerId = page.nextPageId;
                                        const isCompound = activeData.isCompoundSequence;
                                        // Before deleting, capture the ID to pass to re-evaluation
                                        const stoppedPageId = page.id;

                                        delete activeSounds[page.id]; updatePageItem(page.id);
                                        // reEvaluateActiveSounds(stoppedPageId); // Re-evaluate other sounds now that this one has stopped
                                        if (callbackToExecute && typeof callbackToExecute === 'function') { log(`Executing onEndedCallback for Page ID ${page.id}`); try { callbackToExecute(); } catch (e) { console.error(`Callback error Page ID ${page.id}:`, e); } }
                                        else if (!isCompound && nextPageToTriggerId !== null) { log(`Triggering page's own nextPageId: ${nextPageToTriggerId}`); triggerNextPage(nextPageToTriggerId); }
                                    }
                                };
                                if (activeSounds[page.id]) {
                                    activeSounds[page.id].node = sourceNode; activeSounds[page.id].gainNode = gainNode; updatePageItem(page.id); sourceNode.start(0);
                                }
                                else { console.warn(`playSound: Active sound for Page ${page.id} removed before node assignment.`); }
                            } else if (currentSourceDetail.type === 'youtube') {
                                playYouTubeVideo(page, currentSourceDetail, isInternalLoopIteration, startedByAutoplay, onEndedCallback, isCompoundSequence, isPlotThreadSound, triggeredByAppendix);
                            } else if (currentSourceDetail.type === 'syrinscape') {
                                if (syrinscapePlayerReady && syrinscape.player && syrinscape.player.controlSystem && currentSourceDetail.syrinscapeElementId) {
                                    const elementId = parseInt(currentSourceDetail.syrinscapeElementId, 10);
                                    const kind = currentSourceDetail.syrinscapeKind?.toLowerCase();
                                    const timeoutInstanceId = Date.now() + Math.random(); // Unique ID for this play instance's timeout

                                    // Set volume for this specific sound
                                    const pageOrVariationVolume = (typeof currentSourceDetail.volumeOverride === 'number') ? currentSourceDetail.volumeOverride : page.volume;
                                    const modifier = volumeModifiers[page.id] || 0;
                                    const finalVolume = Math.max(0, Math.min(100, pageOrVariationVolume + modifier));
                                    const scaledVolume = (finalVolume / 100) * (currentMasterVolume / 100);
                                    const syrinscapeLocalVolume = Math.min(1.5, scaledVolume * 1.5);
                                    log(`LOG (playSound): Setting SYRINSCAPE volume for "${page.title}". Page/Var Vol: ${pageOrVariationVolume}, Modifier: ${modifier}, Master: ${currentMasterVolume}%, Final Local Vol: ${syrinscapeLocalVolume.toFixed(4)}`);
                                    syrinscape.player.audioSystem.setLocalVolume(syrinscapeLocalVolume.toString());

                                    activeSounds[page.id].syrinscapeTimeoutInstanceId = timeoutInstanceId;
                                    evaluateAppendixStateTriggers(); // Evaluate state as soon as the sound starts

                                    log(`Playing Syrinscape: ID=${elementId}, Kind=${kind}, Name="${currentSourceDetail.fileName}", Duration: ${currentSourceDetail.syrinscapePlayDuration || 'N/A'}, Loop Iter: ${page.currentLoop + 1}`);

                                    if (kind === 'mood' || kind === 'moods') {
                                        syrinscape.player.controlSystem.startMood(elementId);
                                    } else {
                                        syrinscape.player.controlSystem.startElements([elementId.toString()]);
                                    }
                                    activeSounds[page.id].node = { type: 'syrinscape', elementId: elementId, kind: kind }; // Store minimal info
                                    updatePageItem(page.id);

                                    if (currentSourceDetail.syrinscapePlayDuration && currentSourceDetail.syrinscapePlayDuration > 0) {
                                        const durationMs = currentSourceDetail.syrinscapePlayDuration * 1000;
                                        log(`Syrinscape sound ${elementId} (Kind: ${kind}) will be stopped/looped after ${durationMs}ms. Instance ID: ${timeoutInstanceId}`);

                                        // Clear any PREVIOUS timeout for this page.id before setting a new one.
                                        if (activeSounds[page.id] && activeSounds[page.id].syrinscapeTimeoutId) {
                                            clearTimeout(activeSounds[page.id].syrinscapeTimeoutId);
                                        }
                                        activeSounds[page.id].syrinscapeTimeoutId = setTimeout(() => {
                                            const currentActiveSoundData = activeSounds[page.id];
                                            if (!currentActiveSoundData || currentActiveSoundData.syrinscapeTimeoutInstanceId !== timeoutInstanceId || currentActiveSoundData.sourceDetail !== currentSourceDetail) {
                                                log(`Syrinscape timed duration for Page ID ${page.id}: Stale timeout. Instance: ${timeoutInstanceId}. Current active instance: ${currentActiveSoundData?.syrinscapeTimeoutInstanceId}`);
                                                return;
                                            }
                                            log(`Timed duration reached for Syrinscape Page ID ${page.id} (Instance ${timeoutInstanceId}). Stopping current instance and checking loop.`);
                                            if (syrinscapePlayerReady && syrinscape.player && syrinscape.player.controlSystem) {
                                                const idToStop = parseInt(currentSourceDetail.syrinscapeElementId, 10);
                                                const kindToStop = currentSourceDetail.syrinscapeKind?.toLowerCase();
                                                if (kindToStop === 'mood' || kindToStop === 'moods') {
                                                    syrinscape.player.controlSystem.stopMood(idToStop);
                                                } else {
                                                    syrinscape.player.controlSystem.stopElements([idToStop.toString()]);
                                                }
                                            }
                                            currentActiveSoundData.syrinscapeTimeoutId = null; // Clear the timeout that just fired

                                            if (page.loop) {
                                                // page.currentLoop is number of loops completed (0 for first play if !isInternalLoopIteration)
                                                const shouldContinueLooping = (page.loopCount === -1) || (page.currentLoop < page.loopCount);

                                                if (shouldContinueLooping) {
                                                    page.currentLoop++; // Increment for the loop iteration we are about to start
                                                    log(`Page ${page.id} ("${page.title}") looping after Syrinscape duration. Starting loop iteration ${page.currentLoop} of ${page.loopCount === -1 ? 'Infinite' : page.loopCount}.`);

                                                    const originalCallback = currentActiveSoundData.onEndedCallback;
                                                    const originalIsCompound = currentActiveSoundData.isCompoundSequence;

                                                    let onNextEndCallback = null;
                                                    if (page.loopCount !== -1 && page.currentLoop >= page.loopCount) { // If this iteration IS the last one
                                                        onNextEndCallback = originalCallback;
                                                    } else if (page.loopCount === -1) {
                                                        onNextEndCallback = originalCallback; // For indefinite, callback is for when explicitly stopped
                                                    }
                                                    // Re-call playSound for the next loop iteration
                                                    playSound(page, currentSourceDetail, currentActiveSoundData.startedByAutoplay,
                                                        onNextEndCallback,
                                                        originalIsCompound, currentActiveSoundData.isPlotThreadSound, true, currentActiveSoundData.triggeredByAppendix); // true for isInternalLoopIteration
                                                    return;
                                                }
                                            }
                                            // If not looping or finished loops for timed Syrinscape
                                            log(`Syrinscape timed play finished for Page ID ${page.id}. Not looping further or loop completed.`);
                                            const stoppedPageId = page.id;
                                            const callbackToExecute = currentActiveSoundData.onEndedCallback;
                                            const nextPageToTriggerId = page.nextPageId;
                                            const isCompound = currentActiveSoundData.isCompoundSequence;
                                            delete activeSounds[page.id];
                                            // reEvaluateActiveSounds(stoppedPageId); // Re-evaluate now that this sound has stopped
                                            updatePageItem(page.id);
                                            if (callbackToExecute && typeof callbackToExecute === 'function') {
                                                log(`Executing onEndedCallback for timed Syrinscape Page ID ${page.id}`);
                                                try { callbackToExecute(); } catch (e) { console.error(`Callback error for timed Syrinscape Page ID ${page.id}:`, e); }
                                            } else if (!isCompound && nextPageToTriggerId !== null) {
                                                log(`Triggering page's own nextPageId after timed Syrinscape: ${nextPageToTriggerId}`);
                                                triggerNextPage(nextPageToTriggerId);
                                            }
                                        }, durationMs);
                                    } else { // No specific duration set for this Syrinscape sound
                                        const isNativelyLoopingType = kind === 'mood' || kind === 'moods' || kind === 'music';
                                        if (isNativelyLoopingType) {
                                            log(`Syrinscape sound ${elementId} (Kind: ${kind}) is natively loopable; no Storyteller duration set. Will loop via Syrinscape.`);
                                            // If page.loop is false but it's a mood, Syrinscape will loop it anyway.
                                            // onEndedCallback will likely only fire if explicitly stopped.
                                        } else if (page.loop && (page.loopCount === -1 || page.currentLoop < page.loopCount)) {
                                            // For non-natively looping Syrinscape types (e.g., one-shots) that the user wants to loop via Storyteller
                                            console.warn(`Attempting to loop non-natively-looping Syrinscape element "${currentSourceDetail.fileName}" (Kind: ${kind}) using page settings. This relies on an assumed self-termination or manual re-trigger for subsequent loops if not timed.`);
                                            const assumedDurationForOneShotLoop = 5000; // Arbitrary delay for one-shots before re-triggering
                                            const oneShotTimeoutInstanceId = Date.now() + Math.random();
                                            activeSounds[page.id].syrinscapeTimeoutInstanceId = oneShotTimeoutInstanceId;

                                            if (activeSounds[page.id].syrinscapeTimeoutId) clearTimeout(activeSounds[page.id].syrinscapeTimeoutId);
                                            activeSounds[page.id].syrinscapeTimeoutId = setTimeout(() => {
                                                const currentActiveSoundData = activeSounds[page.id];
                                                if (currentActiveSoundData && currentActiveSoundData.syrinscapeTimeoutInstanceId === oneShotTimeoutInstanceId) {
                                                    if (page.loop && (page.loopCount === -1 || page.currentLoop < page.loopCount)) {
                                                        page.currentLoop++;
                                                        log(`Page ${page.id} ("${page.title}"): Assumed end of non-timed, non-native-looping Syrinscape. Re-triggering for loop ${page.currentLoop} of ${page.loopCount === -1 ? 'Infinite' : page.loopCount}.`);
                                                        playSound(page, currentSourceDetail, currentActiveSoundData.startedByAutoplay,
                                                            (page.loopCount !== -1 && page.currentLoop >= page.loopCount) ? currentActiveSoundData.onEndedCallback : null,
                                                            currentActiveSoundData.isCompoundSequence, currentActiveSoundData.isPlotThreadSound, true, currentActiveSoundData.triggeredByAppendix);
                                                    } else {
                                                        const callbackToExecute = currentActiveSoundData.onEndedCallback;
                                                        delete activeSounds[page.id];
                                                        updatePageItem(page.id);
                                                        if (callbackToExecute && typeof callbackToExecute === 'function') { try { callbackToExecute(); } catch (e) { } }
                                                    }
                                                }
                                            }, assumedDurationForOneShotLoop);
                                        } else {
                                            // One-shot, not set to loop by page. Assume it ends.
                                            log(`Syrinscape sound ${elementId} (Kind: ${kind}) is not natively loopable and not set to loop by page. Will play once.`);
                                            const assumedSelfTerminationDelay = (kind === 'oneshot' || kind === 'oneshots' || kind === 'sfx' || kind === 'element' || kind === 'elements') ? 3000 : 5000; // Shorter for typical one-shots
                                            const selfTermTimeoutInstanceId = Date.now() + Math.random();
                                            activeSounds[page.id].syrinscapeTimeoutInstanceId = selfTermTimeoutInstanceId;

                                            if (activeSounds[page.id].syrinscapeTimeoutId) clearTimeout(activeSounds[page.id].syrinscapeTimeoutId);
                                            activeSounds[page.id].syrinscapeTimeoutId = setTimeout(() => {
                                                const currentActiveSoundData = activeSounds[page.id];
                                                if (currentActiveSoundData && currentActiveSoundData.syrinscapeTimeoutInstanceId === selfTermTimeoutInstanceId && !currentActiveSoundData.syrinscapePlayDuration) {
                                                    const stoppedPageId = page.id;
                                                    log(`Assumed self-termination for Syrinscape Page ID ${stoppedPageId} (Kind: ${kind}).`);
                                                    const callbackToExecute = currentActiveSoundData.onEndedCallback;
                                                    const nextPageToTriggerId = page.nextPageId;
                                                    const isCompound = currentActiveSoundData.isCompoundSequence;
                                                    delete activeSounds[page.id];
                                                    updatePageItem(page.id);
                                                    if (callbackToExecute && typeof callbackToExecute === 'function') { try { callbackToExecute(); } catch (e) { } }
                                                    else if (!isCompound && nextPageToTriggerId !== null) { triggerNextPage(nextPageToTriggerId); }
                                                }
                                            }, assumedSelfTerminationDelay);
                                        }
                                    }
                                } else {
                                    console.error("Syrinscape player not ready or element ID/kind missing for page " + page.id);
                                    const callback = activeSounds[page.id]?.onEndedCallback; delete activeSounds[page.id]; updatePageItem(page.id);
                                    if (callback && typeof callback === 'function') { console.warn(`Executing onEndedCallback immediately for Syrinscape Page ID ${page?.id} due to playback start error.`); try { callback(); } catch (e) { console.error("Error in immediate callback (Syrinscape start error):", e); } }
                                }
                            }
                        };
                        playInstance(sourceDetail);
                    }


                    // --- YouTube Playback Logic ---
                    function playYouTubeVideo(page, sourceDetail, isRestart = false, startedByAutoplay = false, onEndedCallback = null, isCompoundSequence = false, isPlotThreadSound = false, triggeredByAppendix = false) {
                        const videoId = sourceDetail.source;
                        const playerVariationId = `${sourceDetail.name || videoId.replace(/[^a-zA-Z0-9]/g, '')}-${sourceDetail.startTime || 0}-${sourceDetail.endTime || 'end'}`;
                        const playerId = `youtubePlayer-${page.id}-${playerVariationId}`;

                        let player = youtubePlayers[playerId];

                        const playerOptions = {
                            videoId: videoId,
                            playerVars: { 'playsinline': 1, 'controls': 0, 'disablekb': 1, 'fs': 0, 'modestbranding': 1, 'rel': 0, 'showinfo': 0, 'autoplay': 0 }, // Set autoplay to 0
                            startSeconds: sourceDetail.startTime !== null && typeof sourceDetail.startTime === 'number' ? sourceDetail.startTime : 0,
                            endSeconds: sourceDetail.endTime !== null && typeof sourceDetail.endTime === 'number' ? sourceDetail.endTime : undefined,
                        };

                        if (!activeSounds[page.id] || activeSounds[page.id].sourceDetail !== sourceDetail || isPlotThreadSound) {
                            log(`playYouTubeVideo: Updating/Creating activeSounds for Page ${page.id} to Variation: ${sourceDetail.name || sourceDetail.fileName}`);
                            activeSounds[page.id] = { node: null, gainNode: null, sourceDetail: sourceDetail, startedByAutoplay: startedByAutoplay && !isPlotThreadSound, isPlotThreadSound: isPlotThreadSound, onEndedCallback: onEndedCallback, isCompoundSequence: isCompoundSequence };
                        } else {
                            activeSounds[page.id].startedByAutoplay = startedByAutoplay && !isPlotThreadSound;
                            activeSounds[page.id].isPlotThreadSound = isPlotThreadSound;
                            activeSounds[page.id].onEndedCallback = onEndedCallback;
                            activeSounds[page.id].isCompoundSequence = isCompoundSequence;
                        }
                        const pageOrVariationVolume = (typeof sourceDetail.volumeOverride === 'number') ? sourceDetail.volumeOverride : page.volume;
                        const modifier = volumeModifiers[page.id] || 0;
                        const baseVolume = (pageOrVariationVolume / 100) * (currentMasterVolume / 100) * 100; // Volume 0-100
                        const finalYTVolume = Math.round(Math.max(0, Math.min(100, baseVolume + modifier)));
                        log(`LOG (playYouTubeVideo): Setting YT volume for "${page.title}". Page/Var Vol: ${pageOrVariationVolume}, Modifier: ${modifier}, Master: ${currentMasterVolume}%, Final YT Vol: ${finalYTVolume}`);

                        const startPlayback = (p) => {
                            log(`YT startPlayback: Loading video ${playerOptions.videoId} for player ${playerId}`);
                            p.setVolume(finalYTVolume);
                            // Instead of loadVideoById, we use cueVideoById which is more reliable for this flow
                            p.cueVideoById({ videoId: playerOptions.videoId, startSeconds: playerOptions.startSeconds, endSeconds: playerOptions.endSeconds });
                            // The onStateChange handler will catch the CUED event and play the video.
                        };
                        if (!player || !document.getElementById(playerId)) {
                            log(`YT: Creating new player instance for ${playerId}`);
                            if (player) { try { player.destroy(); } catch (e) { } delete youtubePlayers[playerId]; }
                            let playerDiv = document.getElementById(playerId); if (!playerDiv) { playerDiv = document.createElement('div'); playerDiv.id = playerId; youtubePlayersContainer.appendChild(playerDiv); }

                            player = new YT.Player(playerId, {
                                height: '0', width: '0', videoId: playerOptions.videoId, playerVars: playerOptions.playerVars,
                                events: {
                                    'onReady': (event) => {
                                        log(`YT onReady: Player ${playerId} is ready.`);
                                        const readyPlayer = event.target;
                                        youtubePlayers[playerId] = readyPlayer;
                                        const currentActiveSound = activeSounds[page.id];
                                        // Ensure the sound is still supposed to be playing when the player becomes ready
                                        if (currentActiveSound && currentActiveSound.sourceDetail === sourceDetail) {
                                            currentActiveSound.node = readyPlayer; if (!isRestart) startPlayback(readyPlayer);
                                        }
                                        else { console.warn(`YT onReady: Active sound for Page ${page.id} changed or removed before player was ready. Destroying player ${playerId}.`); try { readyPlayer.destroy(); } catch (e) { } delete youtubePlayers[playerId]; if (playerDiv) playerDiv.remove(); }
                                    },
                                    'onError': (event) => {
                                        console.error(`YT Player Error PageID ${page.id}, PlayerID ${playerId}, Code: ${event.data}`); showTemporaryMessage(`Error YT "${page.title}". Code: ${event.data}`, 'error');
                                        const currentPlayer = youtubePlayers[playerId]; if (currentPlayer) { try { currentPlayer.destroy(); } catch (e) { } } delete youtubePlayers[playerId]; const currentActiveSound = activeSounds[page.id];
                                        if (currentActiveSound && currentActiveSound.node === event.target) { const callback = currentActiveSound.onEndedCallback; delete activeSounds[page.id]; if (callback && typeof callback === 'function') { console.warn(`Executing onEndedCallback for YT Page ID ${page.id} due to player error.`); setTimeout(() => { try { callback(); } catch (e) { console.error(`Callback error after YT error Page ID ${page.id}:`, e); } }, COMPOUND_DELAY_MS); } }
                                        if (playerDiv) playerDiv.remove(); updatePageItem(page.id);
                                    },
                                    'onStateChange': (event) => {
                                        const activeData = activeSounds[page.id];
                                        if (!activeData || activeData.node !== event.target || activeData.sourceDetail !== sourceDetail) return;

                                        if (event.data === YT.PlayerState.CUED || (event.data === YT.PlayerState.BUFFERING && event.target.getPlayerState() !== YT.PlayerState.PLAYING)) {
                                            log(`YT State Change: Player ${playerId} CUED/BUFFERING. Playing.`);
                                            event.target.playVideo();
                                            updatePageItem(page.id);
                                        } else if (event.data === YT.PlayerState.PLAYING) {
                                            evaluateAppendixStateTriggers(); // Evaluate state as soon as the sound starts
                                            log(`YT State Change: Player ${playerId} PLAYING.`);
                                            updatePageItem(page.id);
                                        } else if (event.data === YT.PlayerState.ENDED) {
                                            log(`YT State Change: Player ${playerId} ENDED (Variation: ${sourceDetail.name || sourceDetail.fileName})`); let isFinalEnd = false;
                                            if (page.loopCount === -1) {
                                                log(`YT Loop: Indefinite loop for ${playerId}. Seeking and playing.`); event.target.seekTo(playerOptions.startSeconds || 0, true); event.target.playVideo();
                                            } else if (page.loopCount > 0) {
                                                page.currentLoop++; log(`YT Loop: Counted loop for ${playerId}. Loop ${page.currentLoop}/${page.loopCount}`);
                                                if (page.currentLoop >= page.loopCount) isFinalEnd = true;
                                                else { event.target.seekTo(playerOptions.startSeconds || 0, true); event.target.playVideo(); }
                                            } else {
                                                isFinalEnd = true;
                                            }

                                            if (isFinalEnd) {
                                                log(`YT Final End for Page ID ${page.id} ("${page.title}") Variation: ${sourceDetail.name || sourceDetail.fileName}`);
                                                const stoppedPageId = page.id;
                                                const callbackToExecute = activeData.onEndedCallback; const nextPageToTriggerId = page.nextPageId; const isCompound = activeData.isCompoundSequence;
                                                delete activeSounds[page.id]; updatePageItem(page.id);
                                                // reEvaluateActiveSounds(stoppedPageId);
                                                if (callbackToExecute && typeof callbackToExecute === 'function') { log(`Executing onEndedCallback for YT Page ID ${page.id} (with delay)`); setTimeout(() => { try { callbackToExecute(); } catch (e) { console.error(`Callback error YT Page ID ${page.id}:`, e); } }, COMPOUND_DELAY_MS); }
                                                else if (!isCompound && nextPageToTriggerId !== null) { log(`Triggering page's own nextPageId: ${nextPageToTriggerId}`); triggerNextPage(nextPageToTriggerId); }
                                            }
                                        } else if (event.data === YT.PlayerState.PAUSED && activeData.node === event.target) {
                                            if (page.loopCount === 0 || (page.loopCount > 0 && page.currentLoop >= page.loopCount)) {
                                                log(`YT State Change: Player ${playerId} PAUSED and not looping/finished loop. Removing from active sounds.`);
                                                delete activeSounds[page.id];
                                                updatePageItem(page.id);
                                            }
                                        }
                                    }
                                }
                            });
                        } else {
                            log(`YT: Using existing player ${playerId}. Restart: ${isRestart}`);
                            activeSounds[page.id].node = player;
                            if (isRestart) {
                                player.seekTo(playerOptions.startSeconds || 0, true);
                                player.playVideo();
                            } else {
                                startPlayback(player);
                            }
                        }
                    }


                    // --- Trigger Next Page ---
                    function triggerNextPage(nextPageId) {
                        log(`Attempting to trigger next page: ID ${nextPageId}`);
                        const nextPage = book.pages.find(p => p.id === nextPageId);
                        if (nextPage) {
                            if (!checkVariationConditions(nextPage.conditions)) {
                                evaluateAppendixStateTriggers(); // Evaluate state even if next page doesn't play
                                console.warn(`Cannot play chained page "${nextPage.title}" (ID: ${nextPageId}): Conditions not met.`);
                                showTemporaryMessage(`Cannot play chained page "${nextPage.title}": Conditions not met.`, 'warning');
                                return;
                            }
                            const sourceToPlay = findPlayableSourceVariation(nextPage, false);
                            if (sourceToPlay) { // Variation keywords are not checked for chained pages
                                log(`Chaining to page "${nextPage.title}", selected source: ${sourceToPlay.name || sourceToPlay.fileName || sourceToPlay.type}`);
                                setTimeout(() => playSound(nextPage, sourceToPlay, false, null, false, false), 50);
                                evaluateAppendixStateTriggers(); // Evaluate state after successfully starting the next page
                            } else {
                                showTemporaryMessage(`Cannot play chained page "${nextPage.title}": No playable variation for this chapter/time!`, 'error');
                                console.warn(`Cannot play chained page "${nextPage.title}" (ID: ${nextPageId}): No sources for chapter ${book.activeChapterId} / time ${currentTimeOfDay}.`);
                            }
                        } else {
                            console.warn(`Next page ID ${nextPageId} not found.`);
                            showTemporaryMessage(`Chained page not found (ID: ${nextPageId}).`, 'error');
                        }
                    }


                    // --- Stop Single Sound ---
                    function stopSingleSound(pageId, context = 'user') {
                        const activeSoundData = activeSounds[pageId];
                        if (!activeSoundData) return;
                        log(`LOG (stopSingleSound): Stopping Page ID ${pageId} ("${book.pages.find(p => p.id === pageId)?.title}") - Context: ${context}`);

                        const { node, gainNode, sourceDetail } = activeSoundData;

                        // Clear any pending timeouts for this sound
                        if (activeSoundData.syrinscapeTimeoutId) {
                            clearTimeout(activeSoundData.syrinscapeTimeoutId);
                            activeSoundData.syrinscapeTimeoutId = null;
                            activeSoundData.syrinscapeTimeoutInstanceId = null;
                        }
                        if (activeSoundData.fadeTimeoutId) {
                            clearTimeout(activeSoundData.fadeTimeoutId);
                        }
                        activeSoundData.onEndedCallback = null; // Prevent onEnded callbacks from firing after manual stop

                        // Remove from active list immediately so it appears stopped in UI
                        delete activeSounds[pageId];
                        renderPageList();
                        // reEvaluateActiveSounds(pageId); // Re-evaluate other sounds now that this one has stopped

                        // Handle fade-out and stopping based on type
                        if (sourceDetail.type === 'file' && gainNode && audioContext && node instanceof AudioBufferSourceNode) {
                            log(`LOG (stopSingleSound): Fading out FILE Page ID: ${pageId}`);
                            const now = audioContext.currentTime;
                            try {
                                gainNode.gain.cancelScheduledValues(now);
                                gainNode.gain.setValueAtTime(gainNode.gain.value, now);
                                gainNode.gain.linearRampToValueAtTime(MIN_GAIN, now + FADE_DURATION);
                                activeSoundData.fadeTimeoutId = setTimeout(() => {
                                    if (node?.stop) { try { node.stop(); } catch (e) { } }
                                    if (node?.disconnect) { try { node.disconnect(); } catch (e) { } }
                                    if (gainNode?.disconnect) { try { gainNode.disconnect(); } catch (e) { } }
                                }, FADE_DURATION * 1000);
                            } catch (e) {
                                console.error("Error scheduling fade out:", e);
                                if (node?.stop) { try { node.stop(); node.disconnect(); if (gainNode) gainNode.disconnect(); } catch (err) { } }
                            }
                        } else if (sourceDetail.type === 'youtube' && node?.stopVideo) {
                            log(`LOG (stopSingleSound): Fading out YOUTUBE Page ID: ${pageId}`);
                            fadeOutYouTube(node, FADE_DURATION);
                        } else if (sourceDetail.type === 'syrinscape' && syrinscapePlayerReady) {
                            const elementId = sourceDetail.syrinscapeElementId;
                            const kind = sourceDetail.syrinscapeKind?.toLowerCase();
                            if (elementId) {
                                log(`LOG (stopSingleSound): Stopping SYRINSCAPE (no fade): ID=${elementId}, Kind=${kind}`);
                                if (kind === 'mood' || kind === 'moods') {
                                    syrinscape.player.controlSystem.stopMood(parseInt(elementId, 10));
                                } else if (kind !== 'samples' && kind !== 'oneshot' && kind !== 'oneshots' && (!kind || !kind.includes('sample'))) {
                                    syrinscape.player.controlSystem.stopElements([elementId.toString()]);
                                }
                            }
                        }

                        // Add to recent events list for contextual triggers
                        recentPageEvents.events.push({
                            pageId: pageId,
                            event: 'stopped',
                            timestamp: Date.now(),
                            usedBy: new Set() // To track which single-use triggers have used this event
                        });
                        // Trigger 'stopped' event for Appendix
                        triggerAppendixPageEvent(pageId, 'stopped');
                        evaluateAppendixStateTriggers(); // Re-evaluate conditions now that a sound has stopped
                    }


                    // --- Stop All Sounds ---
                    function stopAllSounds() {
                        log("LOG (stopAllSounds): Stopping all sounds...");
                        const activeIds = Object.keys(activeSounds);
                        activeIds.forEach(id => stopSingleSound(parseInt(id, 10)));

                        if (syrinscapePlayerReady && syrinscape.player && syrinscape.player.controlSystem) {
                            log("Calling Syrinscape global stopAll.");
                            syrinscape.player.controlSystem.stopAll();
                        }
                        if (activeSyrinscapePreview && syrinscapePlayerReady && syrinscape.player && syrinscape.player.controlSystem) {
                            // The global stopAll() above should handle this.
                            // Explicitly stopping the preview can sometimes cause issues if stopAll is already queued.
                            if (activeSyrinscapePreview.buttonElement) {
                                activeSyrinscapePreview.buttonElement.classList.remove('playing-preview');
                                activeSyrinscapePreview.buttonElement.innerHTML = '<i class="fas fa-play fa-fw"></i>';
                                activeSyrinscapePreview.buttonElement.title = 'Preview Sound';
                            }
                            activeSyrinscapePreview = null;
                        }

                        // Reset all relative volume modifiers when all sounds are stopped
                        volumeModifiers = {};
                    }

                    // --- Dropdown Population Helper ---
                    function populateNextPageDropdown(selectElement, currentPageIdToExclude = null) {
                        const currentSelection = selectElement.value;
                        selectElement.innerHTML = '<option value="">-- None --</option>';
                        book.pages
                            .filter(page => page.id !== currentPageIdToExclude)
                            .sort((a, b) => a.title.localeCompare(b.title))
                            .forEach(page => {
                                const option = document.createElement('option');
                                option.value = page.id;
                                option.textContent = page.title;
                                selectElement.appendChild(option);
                            });
                        if (currentSelection && selectElement.querySelector(`option[value="${currentSelection}"]`)) {
                            selectElement.value = currentSelection;
                        } else if (currentSelection) {
                            console.warn(`Previous dropdown selection ID ${currentSelection} no longer valid or was the excluded page.`);
                        }
                    }

                    // --- Update Add Page Dropdown ---
                    function updateAddNextPageDropdown() {
                        populateNextPageDropdown(addNextPageIdSelect);
                    }

                    // Re-render a single page's list item in place instead of rebuilding the
                    // whole list (S2/3.3). Sound start/stop fires several times a second while
                    // audio plays; a full renderPageList() there rebuilt and re-bound every item.
                    // This swaps only the affected <li>. No-op if the page isn't in the current view.
                    function updatePageItem(pageId) {
                        if (!pageListUl) return;
                        const existing = pageListUl.querySelector(`li[data-page-id="${pageId}"]`);
                        if (!existing) return;
                        const activeChapter = book.chapters.find(ch => ch.id == book.activeChapterId);
                        if (!activeChapter) return;
                        const page = book.pages.find(p => p.id === pageId);
                        if (!page) { existing.remove(); return; }
                        existing.replaceWith(createPageListItem(page, activeChapter));
                    }

                    // --- Render Page List ---
                    function renderPageList() {
                        pageListUl.innerHTML = '';
                        const activeChapter = book.chapters.find(ch => ch.id == book.activeChapterId);
                        if (!activeChapter) { console.error(`Cannot render: Active chapter ${book.activeChapterId} not found.`); return; }

                        let pagesInView = new Set();
                        let collectionsInView = new Map(); // Map<collectionId, {collection, pages: Set<page>}>

                        // New: Pre-calculate pages from collections that match the active chapter's tags
                        const activeChapterData = book.chapters.find(ch => ch.id == book.activeChapterId);
                        const activeChapterTagIds = new Set(activeChapter?.tagIds || []);
                        const pagesFromTaggedCollections = new Set();

                        (book.collections || []).forEach(collection => {
                            if (Array.isArray(collection.tagIds) && collection.tagIds.length > 0) {
                                const collectionTagIds = new Set(collection.tagIds);
                                const intersection = new Set([...activeChapterTagIds].filter(x => collectionTagIds.has(x)));

                                const match = intersection.size > 0; // Simplified: if ANY tag matches, it's a candidate for inclusion.
                                if (match) {
                                    collection.pageIds.forEach(pageId => pagesFromTaggedCollections.add(pageId));
                                }
                            }
                        });
                        const activeChapterPageIds = new Set(activeChapterData.pageIds);

                        if (activeChapter.isIndex) {
                            book.pages.forEach(p => pagesInView.add(p));
                        } else {
                            activeChapter.pageIds.map(id => book.pages.find(p => p.id === id)).filter(Boolean).forEach(p => pagesInView.add(p));
                            const individuallyStarredPages = book.pages.filter(p => p.isStarred && !activeChapterPageIds.has(p.id));
                            // Add pages from tagged collections
                            pagesFromTaggedCollections.forEach(pageId => {
                                const page = book.pages.find(p => p.id === pageId); if (page) pagesInView.add(page);
                            });
                            individuallyStarredPages.forEach(p => pagesInView.add(p));
                            book.chapters.forEach(ch => {
                                if (ch.isStarred && !ch.isIndex && ch.id != activeChapter.id) {
                                    ch.pageIds.forEach(id => {
                                        const page = book.pages.find(p => p.id === id);
                                        if (page) pagesInView.add(page);
                                    });
                                }
                            });

                            // Add pages from starred collections
                            (book.collections || []).forEach(collection => {
                                if (collection.isStarred) {
                                    collection.pageIds.forEach(pageId => {
                                        const page = book.pages.find(p => p.id === pageId);
                                        // Add page if it's not already in the view
                                        if (page && !pagesInView.has(page)) {
                                            pagesInView.add(page);
                                        }
                                    });
                                }
                            });
                        }

                        const filteredPages = Array.from(pagesInView).filter(page => {
                            if (!currentSearchTerm) return true;
                            const term = currentSearchTerm;
                            const primaryKeysMatch = page.primaryKey ? page.primaryKey.toLowerCase().split(',').some(pk => pk.trim().includes(term)) : false;
                            return page.title.toLowerCase().includes(term) ||
                                primaryKeysMatch ||
                                (page.keywords || []).some(kw => kw.toLowerCase().includes(term)) ||
                                (page.phrases || []).some(ph => ph.toLowerCase().includes(term)) ||
                                (page.endPlayKeywords || []).some(kw => kw.toLowerCase().includes(term));
                        });

                        // Group pages by collection
                        const pagesInCollections = new Set();
                        const pagesInViewIds = new Set(Array.from(pagesInView).map(p => p.id));

                        (book.collections || []).forEach(collection => {
                            // A collection is rendered if all of its pages are currently in view. The `pagesInView` set
                            // already correctly contains pages from the active chapter, starred pages, pages from starred
                            // chapters, and pages from collections with matching tags.
                            // We also need to consider collections that are starred, as they should appear even if their
                            // pages aren't in the current chapter view.
                            const allCollectionPagesInView = collection.pageIds.every(pageId => pagesInViewIds.has(pageId));

                            // If a collection is starred, we want to show it, and we need to ensure its pages are added to the view.
                            if (collection.isStarred) {
                                collection.pageIds.forEach(pageId => { const page = book.pages.find(p => p.id === pageId); if (page) pagesInView.add(page); });
                            }

                            if (allCollectionPagesInView) {
                                // Get the actual page objects for the collection
                                const pagesForCollection = new Set(
                                    collection.pageIds.map(id => book.pages.find(p => p.id === id)).filter(Boolean)
                                );

                                // Add these pages to the set of pages that will be rendered inside a collection group
                                pagesForCollection.forEach(page => pagesInCollections.add(page.id));

                                // Add the collection to the list of collections to be rendered
                                collectionsInView.set(collection.id, { collection, pages: pagesForCollection });
                            }
                            // If not all pages are present, the collection group is not shown, and its pages will be rendered individually if they are in the chapter.
                        });

                        const uncollectedPages = filteredPages.filter(page => !pagesInCollections.has(page.id));

                        // Sort uncollected pages
                        uncollectedPages.sort((a, b) => a.title.localeCompare(b.title));

                        // Sort collections
                        const sortedCollections = Array.from(collectionsInView.values()).sort((a, b) => {
                            if (a.collection.isStarred !== b.collection.isStarred) {
                                return a.collection.isStarred ? -1 : 1; // Starred first
                            }
                            return a.collection.name.localeCompare(b.collection.name);
                        });

                        noPagesMessage.classList.toggle('hidden', uncollectedPages.length > 0 || sortedCollections.length > 0);
                        noSearchResultsMessage.classList.toggle('hidden', !(currentSearchTerm && uncollectedPages.length === 0 && sortedCollections.length === 0));

                        let addedDivider = false;
                        let firstStarredRenderedInGrid = false;

                        // Render uncollected pages first
                        uncollectedPages.forEach(page => {
                            const pageLi = createPageListItem(page, activeChapter);
                            pageListUl.appendChild(pageLi);
                        });

                        // Render collections and their pages
                        sortedCollections.forEach(collectionData => {
                            const { collection, pages } = collectionData;

                            const groupLi = document.createElement('li');
                            groupLi.className = 'collection-group';

                            // Render collection header
                            const collectionLi = document.createElement('div'); // Now a div inside the group
                            collectionLi.className = `collection-header ${collection.isStarred ? 'is-starred' : ''}`;
                            collectionLi.dataset.collectionId = collection.id;
                            collectionLi.draggable = true;
                            // Remove list-style for the header itself if it's a list item
                            collectionLi.style.listStyle = 'none';

                            const collapseIcon = collection.isCollapsed ? 'fa-chevron-right' : 'fa-chevron-down';
                            const starIcon = collection.isStarred ? 'fas fa-star' : 'far fa-star';

                            const isCollectionInChapter = !activeChapter.isIndex && collection.pageIds.every(pid => activeChapterPageIds.has(pid));
                            const removeCollectionButtonHtml = isCollectionInChapter ? `<button class="btn-collection-action" data-action="remove-collection-from-chapter" title="Remove Collection from Chapter"><i class="fas fa-book-open fa-fw"></i></button>` : '';

                            let tagsHtml = '';
                            if (Array.isArray(collection.tagIds) && collection.tagIds.length > 0) {
                                const tagNames = collection.tagIds.map(id => book.settings.chapterTags.find(t => t.id === id)?.name || '???').join(', ');
                                tagsHtml = `<span class="collection-tags" title="Tags: ${tagNames}"><i class="fas fa-tags fa-fw text-sm"></i></span>`;
                            }



                            collectionLi.innerHTML = `
                        <div class="flex justify-between items-center">
                            <div class="collection-title-container" data-action="toggle-collapse">
                                <i class="fas ${collapseIcon} fa-fw text-sm"></i>
                                <span class="collection-title">${escapeHtml(collection.name)}</span>
                                <span class="collection-page-count">(${pages.size} / ${collection.pageIds.length} pages)</span>
                                ${tagsHtml}
                            </div>
                            <div class="flex items-center gap-2">
                                <button class="btn-collection-action" data-action="star-collection" title="${collection.isStarred ? 'Unstar Collection' : 'Star Collection'}"><i class="${starIcon} fa-fw"></i></button>
                                <button class="btn-collection-action" data-action="rename-collection" title="Edit Collection"><i class="fas fa-edit fa-fw"></i></button>
                                <button class="btn-collection-action" data-action="export-collection" title="Export Collection"><i class="fas fa-file-export fa-fw"></i></button>
                                ${removeCollectionButtonHtml}
                                <button class="btn-collection-action hover:!text-red-500" data-action="delete-collection" title="Delete Collection"><i class="fas fa-trash-alt fa-fw"></i></button>
                            </div>
                        </div>
                    `;

                            collectionLi.addEventListener('click', (e) => {
                                const action = e.target.closest('[data-action]')?.dataset.action;
                                if (action === 'toggle-collapse') toggleCollectionCollapse(collection.id);
                                else if (action === 'star-collection') toggleCollectionStar(collection.id);
                                else if (action === 'rename-collection') renameCollection(collection.id);
                                else if (action === 'export-collection') exportSingleCollection(collection.id);
                                else if (action === 'remove-collection-from-chapter') removeCollectionFromChapter(collection.id, activeChapter.id);
                                else if (action === 'delete-collection') deleteCollection(collection.id);
                            });

                            collectionLi.addEventListener('dragstart', (e) => {
                                e.stopPropagation(); // Prevent page drag logic
                                e.dataTransfer.setData('text/plain', `collection:${collection.id}`);
                                e.dataTransfer.effectAllowed = 'move';
                                collectionLi.classList.add('dragging');
                            });
                            collectionLi.addEventListener('dragend', () => collectionLi.classList.remove('dragging'));

                            collectionLi.addEventListener('dragover', (e) => {
                                e.preventDefault();
                                e.dataTransfer.dropEffect = 'move';
                                collectionLi.classList.add('drag-over');
                            });
                            collectionLi.addEventListener('dragleave', () => collectionLi.classList.remove('drag-over'));
                            collectionLi.addEventListener('drop', (e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                collectionLi.classList.remove('drag-over');
                                const pageIdStr = e.dataTransfer.getData('text/plain');
                                if (pageIdStr) {
                                    addPageToCollection(parseInt(pageIdStr, 10), collection.id);
                                }
                            });

                            groupLi.appendChild(collectionLi);

                            // Render pages within the collection if not collapsed
                            if (!collection.isCollapsed) {
                                const sortedPagesInCollection = Array.from(pages).sort((a, b) => a.title.localeCompare(b.title));
                                sortedPagesInCollection.forEach(page => {
                                    const pageLi = createPageListItem(page, activeChapter);
                                    pageLi.classList.add('page-in-collection');
                                    groupLi.appendChild(pageLi);
                                });
                            }
                            pageListUl.appendChild(groupLi);
                        });

                        updateAddNextPageDropdown();
                        updateRelinkButtonVisibility();
                    }

                    function createPageListItem(page, activeChapter) {
                        const li = document.createElement('li');
                        const isPlaying = activeSounds.hasOwnProperty(page.id);
                        const isTimeRestricted = page.timeOfDaySetting && page.timeOfDaySetting !== 'always' && page.timeOfDaySetting !== currentTimeOfDay;
                        const hasVolumeModifier = volumeModifiers[page.id] !== undefined;
                        let volumeModifierIndicator = '';
                        if (hasVolumeModifier) {
                            const modifierValue = volumeModifiers[page.id] || 0;
                            if (modifierValue !== 0) {
                                volumeModifierIndicator = `<i class="fas ${modifierValue > 0 ? 'fa-arrow-up text-green-400' : 'fa-arrow-down text-red-400'} absolute -top-1 -right-1 text-xs" title="Volume modified by Appendix: ${modifierValue > 0 ? '+' : ''}${modifierValue}"></i>`;
                            }
                        }

                        li.className = `page-item ${isPlaying ? 'is-playing' : ''} ${isTimeRestricted ? 'time-restricted' : ''}`;
                        li.dataset.pageId = page.id;
                        li.draggable = true; // Always allow dragging

                        li.addEventListener('dragover', (e) => {
                            e.preventDefault();
                            const draggedPageId = e.dataTransfer.getData('text/plain');
                            // Only show collection drop indicator if dragging a DIFFERENT page
                            if (draggedPageId && draggedPageId != page.id) {
                                e.dataTransfer.dropEffect = 'link';
                                li.classList.add('drag-over-for-collection');
                            }
                        });
                        li.addEventListener('dragleave', () => li.classList.remove('drag-over-for-collection'));
                        li.addEventListener('drop', (e) => {
                            e.preventDefault();
                            e.stopPropagation(); // Prevent chapter drop handler
                            li.classList.remove('drag-over-for-collection');
                            const draggedPageIdStr = e.dataTransfer.getData('text/plain');


                            const targetPageId = page.id;
                            if (draggedPageIdStr && draggedPageIdStr != targetPageId) {
                                createCollectionFromPages(parseInt(draggedPageIdStr, 10), targetPageId);
                            }
                        });

                        const playingSourceDetail = isPlaying ? activeSounds[page.id].sourceDetail : null;
                        const firstSource = playingSourceDetail || page.sources[0] || {};
                        // If not playing, we need to look inside the first variation's sources array for the actual source type.
                        // If playing, playingSourceDetail is the actual source.
                        const sourceForIcon = playingSourceDetail || (firstSource.sources && firstSource.sources[0]) || firstSource;

                        const typeIcon = sourceForIcon.type === 'file' ? '<i class="fas fa-file-audio text-blue-500 fa-fw" title="File"></i>'
                            : (sourceForIcon.type === 'youtube' ? '<i class="fab fa-youtube text-red-400 fa-fw" title="YouTube"></i>'
                                : (sourceForIcon.type === 'syrinscape' ? `<i class="fas fa-headphones-alt text-syrinscape-500 fa-fw" title="Syrinscape (${sourceForIcon.syrinscapeKind || 'Unknown'})"></i>`
                                    : '<i class="fas fa-question-circle text-gray-500 fa-fw"></i>'));

                        const sourceCount = page.sources.length;
                        const sourceCountText = sourceCount > 1 ? `<span class="source-count-indicator">(Variations: ${sourceCount})</span>` : '';

                        let displaySource = '';
                        const missingFileSources = page.sources.filter(s => s.type === 'file' && s.needsFile);
                        // Correctly check for playable sub-sources within any variation
                        const hasPlayableSource = page.sources.some(variation =>
                            variation.sources && variation.sources.some(subSource =>
                                (subSource.type === 'file' && !subSource.needsFile) ||
                                subSource.type === 'youtube' ||
                                (subSource.type === 'syrinscape' && subSource.syrinscapeElementId)
                            ));

                        if (missingFileSources.length > 0 && !hasPlayableSource && firstSource.type === 'file') {
                            const missingNames = escapeHtml(missingFileSources.map(s => s.name || s.fileName).slice(0, 2).join(', '));
                            const missingTitle = escapeHtml(missingFileSources.map(s => s.name || s.fileName).join(', '));
                            displaySource = `<span class="missing-file-indicator" title="Missing: ${missingTitle}">(Missing: ${missingNames}${missingFileSources.length > 2 ? '...' : ''})</span>`;
                        } else if (firstSource.fileName || firstSource.name) {
                            const name = firstSource.name || firstSource.fileName;
                            const truncatedName = name.length > 35 ? name.substring(0, 32) + '...' : name;
                            displaySource = `(${truncatedName}${sourceCount > 1 && !playingSourceDetail ? ', ...' : ''})`;
                        }


                        let loopInfo = '';
                        if (page.loop) {
                            const loopText = page.loopCount === -1 ? 'Inf.' : `${page.loopCount}x`;
                            loopInfo = `<span class="text-green-500 ml-2 flex items-center gap-1" title="Looping ${loopText}"><i class="fas fa-sync-alt fa-fw"></i> ${loopText}</span>`;
                        }
                        const fadeInfo = page.fadeInOut ? `<span class="fade-indicator" title="Fade In/Out Enabled"><i class="fas fa-sliders-h"></i></span>` : '';

                        let chainInfoHtml = '';
                        if (page.nextPageId !== null && page.nextPageId !== undefined) {
                            const nextPage = book.pages.find(p => p.id === page.nextPageId);
                            const nextTitle = nextPage ? nextPage.title : 'Not Found';
                            const iconClass = nextPage ? 'fa-link' : 'fa-unlink';
                            const titleAttr = nextPage ? `Plays next: ${nextTitle}` : `Plays next: Page ID ${page.nextPageId} (Not Found)`;
                            const displayText = nextPage ? (nextTitle.length > 20 ? nextTitle.substring(0, 17) + '...' : nextTitle) : '(Broken)';
                            chainInfoHtml = `<span class="next-page-indicator ml-2" title="${titleAttr}"><i class="fas ${iconClass} fa-fw"></i> ${displayText}</span>`;
                        }

                        let endPlayKeywordInfo = '';
                        if (page.loop && page.endPlayKeywords && page.endPlayKeywords.length > 0) {
                            endPlayKeywordInfo = `<p class="text-xs text-red-400 mt-1 w-full"><i class="fas fa-hand-paper mr-1 fa-fw"></i> End: ${page.endPlayKeywords.join(', ')}</p>`;
                        }

                        const removeChapterButtonHtml = (!activeChapter.isIndex && activeChapter.pageIds.includes(page.id)) ?
                            `<button class="action-button remove-from-chapter-button" title="Remove from Chapter '${escapeHtml(activeChapter.name)}'"><i class="fas fa-book-open fa-fw"></i></button>` : '';

                        let triggerDisplay = '';
                        const phrasesText = (page.phrases || []).join('; ');
                        const hasPhrases = phrasesText.length > 0;

                        if (page.primaryKey) {
                            const pkDisplay = page.primaryKey.length > 50 ? page.primaryKey.substring(0, 47) + '...' : page.primaryKey;
                            triggerDisplay += `<span class="text-primary-key inline-block mr-1 keywords-display" title="Primary Key(s): ${escapeHtml(page.primaryKey)}"><i class="fas fa-key mr-1 fa-fw"></i> ${escapeHtml(pkDisplay)}</span>`;
                            if (hasPhrases) triggerDisplay += ' <span class="text-gray-500 mr-1"><i class="fas fa-arrow-right fa-fw"></i></span> ';
                        }
                        if (hasPhrases) {
                            triggerDisplay += `<span class="text-yellow-500 inline-block keywords-display" title="Phrases: ${escapeHtml(phrasesText)}"><i class="fas fa-quote-left mr-1 fa-fw"></i> ${escapeHtml(phrasesText)}</span>`;
                        } else if (!page.primaryKey) {
                            triggerDisplay = `<i class="fas fa-ban text-gray-500 mr-1 fa-fw" title="No Triggers"></i> No Triggers`;
                        }

                        const starChecked = page.isStarred ? 'checked' : '';
                        const starCheckboxHtml = `<label class="star-label" title="${page.isStarred ? 'Unstar Page (Chapter Specific)' : 'Star Page (Global Trigger)'}"><input type="checkbox" class="star-checkbox action-button" ${starChecked}><i class="${page.isStarred ? 'fas fa-star' : 'far fa-star'} fa-fw"></i></label>`;

                        const collectionThisPageIsIn = (book.collections || []).find(c => c.pageIds.includes(page.id));
                        const removeFromCollectionHtml = collectionThisPageIsIn ?
                            `<button class="remove-from-collection-button" data-collection-id="${collectionThisPageIsIn.id}"><i class="fas fa-layer-group fa-fw"></i> Remove from Collection</button>`
                            : '';


                        let timeOfDayIconHtml = '';
                        if (page.timeOfDaySetting && page.timeOfDaySetting !== 'always') {
                            const iconClass = page.timeOfDaySetting === 'day' ? 'fa-sun day' : 'fa-moon night';
                            const titleText = page.timeOfDaySetting === 'day' ? 'Day Only' : 'Night Only';
                            timeOfDayIconHtml = `<i class="fas ${iconClass} time-of-day-icon" title="${titleText}"></i>`;
                        }

                        const manualPlayDisabled = isPlaying || !hasPlayableSource || isTimeRestricted ? 'disabled' : '';
                        const manualStopDisabled = !isPlaying ? 'disabled' : '';
                        const manualPlayTitle = isTimeRestricted ? `Cannot Play (Time Restricted: ${page.timeOfDaySetting})` : (!hasPlayableSource ? 'Cannot Play (Missing File / No Variation)' : 'Manually Play Sound');

                        const rowViewActionsHtml = `
                            <div class="page-item-actions">
                                <button class="action-button play-toggle-button ${isPlaying ? 'is-playing' : ''}" title="${isPlaying ? 'Manually Stop Sound' : manualPlayTitle}" ${manualPlayDisabled && !isPlaying ? 'disabled' : ''}>
                                    <i class="fas ${isPlaying ? 'fa-stop' : 'fa-play'} fa-fw"></i>
                                </button>
                                <div class="dropdown"> 
                                    <button class="action-button" title="Page Actions"><i class="fas fa-ellipsis-v fa-fw"></i></button>
                                    <div class="dropdown-content">
                                        <button class="edit-button"><i class="fas fa-edit fa-fw"></i> Edit Page</button>
                                        <button class="duplicate-button"><i class="fas fa-copy fa-fw"></i> Duplicate Page</button>
                                        ${removeFromCollectionHtml}
                                        ${!activeChapter.isIndex && activeChapter.pageIds.includes(page.id) ? `<button class="remove-from-chapter-button"><i class="fas fa-book-open fa-fw"></i> Remove from Chapter</button>` : ''}
                                        <button class="delete-button" style="color: var(--danger-color);"><i class="fas fa-trash-alt fa-fw"></i> Delete Page</button>
                                    </div>
                                </div>
                            </div>`;

                        li.innerHTML = `
                            <div class="page-item-main-content"> <div class="page-item-title-row">
                                    <div class="page-item-title-container">
                                        ${starCheckboxHtml}
                                        <span class="page-item-title">${escapeHtml(page.title)}</span>
                                        ${timeOfDayIconHtml}
                                        ${sourceCountText}${fadeInfo}
                                    </div>
                                    ${rowViewActionsHtml}
                                </div>
                                <div class="trigger-info-container">
                                    ${typeIcon}
                                    <div class="flex-1 min-w-0">${triggerDisplay}</div>
                                    ${loopInfo}${chainInfoHtml}
                                </div>
                                ${endPlayKeywordInfo}
                            </div>
                            <div class="page-item-grid-content"> <div class="page-item-grid-title-container">
                                    ${starCheckboxHtml}
                                    <span class="page-item-grid-title">${escapeHtml(page.title)}</span>
                                    ${timeOfDayIconHtml}
                                </div>
                                <div class="page-item-grid-actions">                                    
                                    <button class="action-button play-toggle-button ${isPlaying ? 'is-playing' : ''}" title="${isPlaying ? 'Manually Stop Sound' : manualPlayTitle}" ${manualPlayDisabled && !isPlaying ? 'disabled' : ''}>
                                        <i class="fas ${isPlaying ? 'fa-stop' : 'fa-play'} fa-fw"></i>
                                    </button>
                                    <div class="dropdown">
                                        <button class="action-button" title="Page Actions"><i class="fas fa-ellipsis-v fa-fw"></i></button>
                                        <div class="dropdown-content">
                                            <button class="edit-button"><i class="fas fa-edit fa-fw"></i> Edit Page</button>
                                            <button class="duplicate-button"><i class="fas fa-copy fa-fw"></i> Duplicate Page</button>
                                            ${removeFromCollectionHtml}
                                            ${!activeChapter.isIndex && activeChapter.pageIds.includes(page.id) ? `<button class="remove-from-chapter-button"><i class="fas fa-book-open fa-fw"></i> Remove from Chapter</button>` : ''}
                                            <button class="delete-button" style="color: var(--danger-color);"><i class="fas fa-trash-alt fa-fw"></i> Delete Page</button>
                                        </div>
                                    </div>
                                </div>
                            </div>
                            `;

                        li.addEventListener('dragstart', (e) => {
                            // if (isTimeRestricted) { e.preventDefault(); return; } // Allow dragging even if restricted
                            e.dataTransfer.setData('text/plain', page.id);
                            e.dataTransfer.effectAllowed = 'move';
                            li.classList.add('dragging');
                        });
                        li.addEventListener('dragend', () => { li.classList.remove('dragging'); });

                        li.querySelectorAll('.delete-button').forEach(btn => btn.addEventListener('click', (e) => { e.stopPropagation(); deletePageFromBook(page.id); }));
                        li.querySelectorAll('.edit-button').forEach(btn => btn.addEventListener('click', (e) => { e.stopPropagation(); openEditPageModal(page.id); }));
                        li.querySelectorAll('.duplicate-button').forEach(btn => btn.addEventListener('click', (e) => { e.stopPropagation(); duplicatePage(page.id); }));
                        li.querySelectorAll('.remove-from-chapter-button').forEach(btn => btn.addEventListener('click', (e) => { e.stopPropagation(); removePageFromCurrentChapter(page.id); }));
                        li.querySelectorAll('.remove-from-collection-button').forEach(btn => btn.addEventListener('click', (e) => { e.stopPropagation(); removePageFromCollection(page.id, btn.dataset.collectionId); }));
                        li.querySelectorAll('.star-checkbox').forEach(cb => cb.addEventListener('change', (e) => { e.stopPropagation(); togglePageStar(page.id, e.target); }));
                        li.querySelectorAll('.play-toggle-button').forEach(btn => btn.addEventListener('click', (e) => {
                            e.stopPropagation();
                            const isCurrentlyPlaying = btn.classList.contains('is-playing');
                            if (isCurrentlyPlaying) stopSingleSound(page.id);
                            else playPageManually(page.id, e.shiftKey);
                        }));

                        return li;
                    }
                    // --- Appendix Execution Logic ---
                    function triggerAppendixPageEvent(pageId, eventType) {
                        if (!book.appendix || book.appendix.length === 0) return;

                        for (const entry of book.appendix) {
                            if (entry.trigger.type === 'page_event' && entry.trigger.event === eventType && entry.trigger.pages.includes(pageId)) {
                                log(`Appendix Page Event Triggered: Page ${pageId} ${eventType}`);
                                executeAppendixEntry(entry);
                            }
                        }
                    }

                    function triggerAppendixPageEvent(pageId, eventType) {
                        if (!book.appendix || book.appendix.length === 0) return;

                        const pageIdInt = parseInt(pageId, 10);

                        for (const entry of book.appendix) {
                            // Check activation conditions first
                            if (entry.conditions && entry.conditions.length > 0 && !checkAppendixConditions(entry.conditions)) {
                                continue; // Skip if activation conditions are not met
                            }

                            // Ensure trigger and pages array exist before checking
                            if (entry.trigger?.type === 'page_event' && Array.isArray(entry.trigger.pages) && entry.trigger.event === eventType && entry.trigger.pages.includes(pageIdInt)) {
                                log(`Appendix Page Event Triggered: Page ${pageId} ${eventType}`);
                                executeAppendixEntry(entry);
                            }
                        }
                    }

                    function getConditionsFromBuilder(containerId, otherConditionsContainerId, tagContainerId) {
                        const container = document.getElementById(containerId);
                        const otherContainer = document.getElementById(otherConditionsContainerId);
                        const tagContainer = document.getElementById(tagContainerId);
                        if (!container) return [];
                        // --- DEBUG LOG ---
                        log(`%c[DEBUG] getConditionsFromBuilder: Reading conditions from UI containers.`, 'color: yellow');
                        // --- END DEBUG LOG ---

                        const conditions = [];

                        // 1. Get Page-based conditions
                        if (container) {
                            const pageConditionItems = container.querySelectorAll('.plot-thread-page-item');
                            pageConditionItems.forEach(item => { // Re-using plotter styling
                                const state = item.dataset.state; // This will be 'active' or 'inactive'
                                const pageIdStr = item.dataset.pageId;
                                if (pageIdStr && (state === 'active' || state === 'inactive')) {
                                    const pageId = parseInt(pageIdStr, 10);
                                    conditions.push({ type: `page_${state}`, params: { pageId } });
                                }
                            });
                        }

                        // 2. Get Tag-based conditions
                        const tagConditionItems = tagContainer ? tagContainer.querySelectorAll('.plot-thread-page-item') : [];
                        tagConditionItems.forEach(item => { // Re-using plotter styling
                            const state = item.dataset.state;
                            // --- DEBUG LOG ---
                            log(`%c[DEBUG] getConditionsFromBuilder: Reading tag condition item. Tag ID: ${item.dataset.tagId}, State: ${state}`, 'color: yellow');
                            // --- END DEBUG LOG ---
                            if (state === 'is' || state === 'not') {
                                const tagId = item.dataset.tagId;
                                conditions.push({ type: `tag_${state}`, params: { tagId } });
                            }
                        });
                        // 3. Get "Other" conditions (chapter, time) from the old builder UI
                        const otherConditionItems = (otherContainer || container).querySelectorAll('.condition-item');
                        otherConditionItems.forEach(item => {
                            const type = item.querySelector('.condition-type-select')?.value;
                            const input = item.querySelector('.condition-params select, .condition-params input');
                            if (type && input) {
                                const params = type.startsWith('chapter_') ? { chapterId: input.value } : { time: input.value };
                                conditions.push({ type, params });
                            }
                        });

                        // --- DEBUG LOG ---
                        log(`%c[DEBUG] getConditionsFromBuilder: Final constructed conditions array:`, 'color: yellow', JSON.parse(JSON.stringify(conditions)));
                        // --- END DEBUG LOG ---

                        return conditions;
                    }

                    function checkAppendixConditions(conditions) {
                        if (!conditions || conditions.length === 0) return true;

                        // Separate chapter conditions from others.
                        return conditions.every(cond => {
                            switch (cond.type) {
                                case 'page_active':
                                    return activeSounds.hasOwnProperty(cond.params.pageId);
                                case 'page_inactive':
                                    return !activeSounds.hasOwnProperty(cond.params.pageId);
                                case 'time_is':
                                    return currentTimeOfDay === cond.params.time;
                                default:
                                    return true; // Unknown/unhandled condition type is considered met
                            }
                        });
                    }

                    function evaluateAppendixStateTriggers() {
                        if (!book.appendix || book.appendix.length === 0) return;
                    }


                    function executeAppendixEntry(entry) {
                        if (!entry || !entry.effects) return;

                        const isReversal = arguments[1] || false; // Check for the optional isReversal flag

                        const effectsToExecute = isReversal
                            ? entry.effects.map(eff => {
                                let reversedType = eff.type;
                                switch (eff.type) {

                                    case 'play_soundtrack': reversedType = 'stop_soundtrack'; break;
                                    case 'stop_soundtrack': reversedType = 'play_soundtrack'; break;
                                    case 'start_pages': reversedType = 'end_pages'; break;
                                    case 'end_pages': reversedType = 'start_pages'; break;
                                    case 'increase_volume': reversedType = 'decrease_volume'; break;
                                    case 'decrease_volume': reversedType = 'increase_volume'; break;
                                    // 'reset_volume' reversal does nothing to avoid unexpected state changes.
                                    // 'change_chapter', 'set_time', 'toggle_time' are not reversible.
                                    default: return null; // This effect has no reversal
                                }
                                return { ...eff, type: reversedType };
                            }).filter(Boolean) // Filter out nulls
                            : entry.effects;

                        if (isReversal) {
                            // For reversals, especially volume, we need to clear any existing modifiers
                            // from this entry before applying the reversed effect.
                            const pageIdsToReset = new Set();
                            effectsToExecute.forEach(reversedEffect => {
                                // We only care about page-specific modifiers here.
                                if (reversedEffect.target?.targetType === 'pages' && reversedEffect.target?.pages) {
                                    reversedEffect.target.pages.forEach(pId => pageIdsToReset.add(pId));
                                }
                            });
                            pageIdsToReset.forEach(pId => {
                                log(`Reversal: Clearing volume modifier for page ID ${pId} from entry ${entry.id}`);
                                if (volumeModifiers[pId] !== undefined) {
                                    delete volumeModifiers[pId];
                                }
                            });
                        }

                        effectsToExecute.forEach(effect => {
                            let targetPageIds = new Set();
                            let targetChapterIds = new Set();

                            // Determine target pages
                            if (effect.target?.pages && Array.isArray(effect.target.pages)) {
                                effect.target.pages.forEach(id => targetPageIds.add(id));
                            }
                            if (effect.target?.affectAll) {
                                book.pages.forEach(p => targetPageIds.add(p.id));
                            }
                            if (effect.target?.onlyActive && effect.type !== 'start_pages') { // 'onlyActive' doesn't make sense for starting pages that aren't active yet
                                Object.keys(activeSounds).forEach(id => targetPageIds.add(parseInt(id, 10)));
                            }

                            // Determine target chapters
                            if (effect.target?.chapters) {
                                effect.target.chapters.forEach(id => targetChapterIds.add(id));
                            }
                            if (effect.target?.affectAll) {
                                book.chapters.forEach(c => targetChapterIds.add(c.id));
                            }
                            if (effect.target?.onlyActive && effect.type !== 'change_chapter') {
                                targetChapterIds.add(book.activeChapterId);
                            }

                            log(`Executing Appendix Effect: ${effect.type}`);

                            switch (effect.type) {
                                case 'start_pages':
                                case 'end_pages':
                                    if (effect.params?.playSequentially) {
                                        log(`Executing sequential ${effect.type} effect.`); // This part seems to have an error in the previous diff. Correcting it.
                                        const pagesToPlay = (effect.target.pages || []).map(pData => {
                                            const page = book.pages.find(p => p.id === pData.pageId);
                                            if (!page) return null;
                                            let sourceToPlay = null;
                                            // If a specific variation is selected, find it directly.
                                            if (pData.variationId) {
                                                // Find the variation container
                                                const variationContainer = page.sources.find(s => s.id === pData.variationId);
                                                if (variationContainer && variationContainer.sources && variationContainer.sources.length > 0) {
                                                    // Pick a random playable sub-source from the specified variation
                                                    const playableSubSources = variationContainer.sources.filter(sub => (sub.type === 'file' && !sub.needsFile) || sub.type === 'youtube' || (sub.type === 'syrinscape' && sub.syrinscapeElementId));
                                                    if (playableSubSources.length > 0) {
                                                        sourceToPlay = playableSubSources[Math.floor(Math.random() * playableSubSources.length)];
                                                    }
                                                }
                                            }
                                            return { page, sourceToPlay };
                                        }).filter(Boolean);

                                        let currentIndex = 0;

                                        const playNextInSequence = () => {
                                            if (currentIndex >= pagesToPlay.length) {
                                                log("Sequential play finished.");
                                                return;
                                            }
                                            const pageToPlay = pagesToPlay[currentIndex];
                                            log(`Playing sequential page ${currentIndex + 1}/${pagesToPlay.length}: "${pageToPlay.title}"`);

                                            // The onEndedCallback for playSound will be our function to trigger the next sound
                                            const onSoundEnd = () => {
                                                currentIndex++;
                                                playNextInSequence();
                                            };

                                            // Mark as autoplay, provide the callback, but not as a compound sequence or plot thread sound
                                            playSound(pageToPlay.page, pageToPlay.sourceToPlay, true, onSoundEnd, false, false, false, true);
                                        };

                                        playNextInSequence(); // Start the sequence
                                    } else {
                                        log(`Executing simultaneous ${effect.type} effect.`);
                                        (effect.target.pages || []).forEach(pData => {
                                            const page = book.pages.find(p => p.id === pData.pageId);
                                            if (page) {
                                                let sourceToPlay = null; // This will be the specific sub-source
                                                if (pData.variationId) {
                                                    // Find the variation container
                                                    const variationContainer = page.sources.find(s => s.id === pData.variationId);
                                                    if (variationContainer && variationContainer.sources && variationContainer.sources.length > 0) {
                                                        // Pick a random playable sub-source from the specified variation
                                                        const playableSubSources = variationContainer.sources.filter(sub => (sub.type === 'file' && !sub.needsFile) || sub.type === 'youtube' || (sub.type === 'syrinscape' && sub.syrinscapeElementId));
                                                        if (playableSubSources.length > 0) {
                                                            sourceToPlay = playableSubSources[Math.floor(Math.random() * playableSubSources.length)];
                                                        }
                                                    }
                                                }
                                                if (effect.type === 'start_pages') playSound(page, sourceToPlay, true, null, false, false, false, true);
                                                else if (effect.type === 'end_pages') stopSingleSound(page.id);
                                            }
                                        });
                                    }
                                    break;

                                case 'end_pages':
                                    targetPageIds.forEach(id => stopSingleSound(id));
                                    break;

                                case 'increase_volume':
                                case 'decrease_volume':
                                    const amount = effect.params.amount * (effect.type === 'decrease_volume' ? -1 : 1);
                                    const targetType = effect.target.targetType; // 'pages', 'chapters', or 'global'

                                    if (targetType === 'master') {
                                        // This is a global master volume change, not a temporary modifier.
                                        const newVolume = Math.max(0, Math.min(100, currentMasterVolume + amount));
                                        masterVolumeSlider.value = newVolume;
                                        masterVolumeSlider.dispatchEvent(new Event('input')); // This triggers all adjustments
                                    } else if (targetType === 'pages') {
                                        // For both 'pages' and 'chapters', targetPageIds is already correctly populated.
                                        // We apply the modifier to the volumeModifiers object.
                                        targetPageIds.forEach(pageId => {
                                            volumeModifiers[pageId] = (volumeModifiers[pageId] || 0) + amount;
                                            // Immediately adjust if the sound is already playing
                                            adjustCurrentlyPlayingVolumes([pageId]);
                                        });
                                    } else if (targetType === 'chapters') { /* Chapter-wide volume modifiers can be complex, leaving as future implementation */ }
                                    break;

                                case 'reset_volume':
                                    targetPageIds.forEach(id => delete volumeModifiers[id]);
                                    if (effect.target.affectAll) volumeModifiers = {};
                                    const idsToRestart = Object.keys(activeSounds).map(id => parseInt(id, 10)).filter(id => targetPageIds.has(id));
                                    idsToRestart.forEach(id => {
                                    });
                                    break;

                                case 'change_chapter':
                                    if (effect.params.chapterId) setActiveChapter(effect.params.chapterId, true, 'appendix_effect');
                                    break;

                                case 'set_time':
                                    if (effect.params.time) toggleTimeOfDay(effect.params.time);
                                    break;

                                case 'set_page_title':
                                    if (effect.params.pageId && effect.params.newTitle) {
                                        const pageToRename = book.pages.find(p => p.id == effect.params.pageId);
                                        if (pageToRename) pageToRename.title = effect.params.newTitle;
                                    }
                                    break;
                                case 'toggle_time':
                                    toggleTimeOfDay('toggle');
                                    break;
                                case 'transition_variation':
                                    if (effect.params.pageId && effect.params.toVariationId) {
                                        transitionVariation(effect.params.pageId, effect.params.fromVariationId, effect.params.toVariationId);
                                    }
                                    break;

                                case 'play_soundtrack':
                                    if (effect.params.soundtrackId) {
                                        toggleSoundtrack(effect.params.soundtrackId);
                                    }
                                    break;

                                case 'stop_soundtrack':
                                    stopSoundtrack();
                                    break;

                            }
                        });
                    }
                    function adjustCurrentlyPlayingVolumes(targetPageIds = null) {
                        const idsToAdjust = targetPageIds ? [...targetPageIds] : Object.keys(activeSounds).map(id => parseInt(id, 10));

                        idsToAdjust.forEach(pageIdStr => {
                            const pageId = parseInt(pageIdStr, 10);
                            const soundData = activeSounds[pageId];
                            // *** FIX: Add a guard to ensure soundData exists before trying to access its properties.
                            if (!soundData) {
                                // log(`adjustCurrentlyPlayingVolumes: Skipping page ${pageId}, not in activeSounds.`);
                                return;
                            }
                            if (soundData.gainNode) { // Only for file-based sounds with a gain node
                                const page = book.pages.find(p => p.id === pageId);
                                if (!page) return;

                                const pageOrVariationVolume = (typeof soundData.sourceDetail.volumeOverride === 'number') ? soundData.sourceDetail.volumeOverride : page.volume;
                                const modifier = volumeModifiers[pageId] || 0;
                                const baseGain = (pageOrVariationVolume / 100) * (currentMasterVolume / 100);
                                const finalGain = Math.max(0, Math.min(1.5, baseGain + (modifier / 100))); // Apply modifier after multiplication, cap at 150%
                                soundData.gainNode.gain.setTargetAtTime(finalGain, audioContext.currentTime, 0.02);
                            } else if (soundData.node && soundData.sourceDetail?.type === 'youtube') {
                                const page = book.pages.find(p => p.id === pageId);
                                if (!page) return;
                                const pageOrVariationVolume = (typeof soundData.sourceDetail.volumeOverride === 'number') ? soundData.sourceDetail.volumeOverride : page.volume;
                                const modifier = volumeModifiers[pageId] || 0;
                                const baseVolume = (pageOrVariationVolume / 100) * (currentMasterVolume / 100) * 100; // Volume 0-100
                                const finalYTVolume = Math.round(Math.max(0, Math.min(100, baseVolume + modifier))); // Apply modifier, cap at 100
                                if (soundData.node.setVolume) {
                                    soundData.node.setVolume(finalYTVolume);
                                }
                            }
                        });
                        renderPageList(); // Re-render to show new volume modifier indicators
                    }

                    // --- Duplicate Page Function ---
                    function duplicatePage(pageId) {
                        const originalPage = book.pages.find(p => p.id === pageId);
                        if (!originalPage) {
                            showTemporaryMessage("Error: Original page not found.", "error");
                            return;
                        }

                        log(`Duplicating page: "${originalPage.title}" (ID: ${pageId})`);

                        // Create a deep, serializable copy of the page object.
                        // This correctly copies all properties except for the non-serializable AudioBuffer.
                        const newPageData = JSON.parse(JSON.stringify(originalPage));

                        // Create the new page object from the serialized data
                        const newPage = { ...newPageData };

                        // Manually copy over the non-serializable AudioBuffer from the original sources
                        newPage.sources.forEach((newSource, index) => {
                            const originalSource = originalPage.sources[index];
                            if (originalSource && originalSource.type === 'file' && originalSource.source instanceof AudioBuffer) {
                                newSource.source = originalSource.source;
                            }
                        });

                        // Assign a new unique ID
                        newPage.id = book.nextPageId++;

                        // Find a unique title
                        const baseTitle = originalPage.title.replace(/\s\d+$/, '').trim(); // Remove existing number suffix
                        let counter = 2;
                        let newTitle = `${baseTitle} ${counter}`;
                        const existingTitles = new Set(book.pages.map(p => p.title.toLowerCase()));
                        while (existingTitles.has(newTitle.toLowerCase())) {
                            counter++;
                            newTitle = `${baseTitle} ${counter}`;
                        }
                        newPage.title = newTitle;

                        // Reset properties that shouldn't be chained or carried over directly
                        newPage.nextPageId = null;
                        newPage.currentLoop = 0;

                        book.pages.push(newPage);

                        // Add the new page to the current active chapter (if not Index)
                        const activeChapter = book.chapters.find(ch => ch.id == book.activeChapterId);
                        if (activeChapter && !activeChapter.isIndex) {
                            activeChapter.pageIds.push(newPage.id);
                        }

                        updateFuseIndex();
                        saveToLocalStorage();
                        renderPageList();
                        showTemporaryMessage(`Page "${originalPage.title}" duplicated as "${newPage.title}".`, 'success');
                    }

                    // --- Manual Play Function ---
                    function playPageManually(pageId, asOneShot = false) {
                        log(`Manual play requested for Page ID: ${pageId}`);
                        const page = book.pages.find(p => p.id === pageId);
                        if (!page) {
                            console.error(`Page ${pageId} not found.`);
                            showTemporaryMessage("Error: Page not found.", "error");
                            return;
                        }

                        if (activeSounds[pageId] && activeSounds[pageId].sourceDetail?.type !== 'syrinscape') {
                            log(`Page ${pageId} is already playing. Stopping and restarting for manual play.`);
                            stopSingleSound(pageId);
                        }

                        const sourceToPlay = findPlayableSourceVariation(page, false, null);

                        if (!sourceToPlay) {
                            console.warn(`No playable variations for Page ID: ${pageId} in chapter ${book.activeChapterId} / time ${currentTimeOfDay}`); showTemporaryMessage(`Cannot play "${page.title}": No variation for this chapter/time!`, 'error');
                            return;
                        }
                        log(`Manually playing "${page.title}" (Source: ${sourceToPlay.name || sourceToPlay.fileName || sourceToPlay.type}, Chapter: ${sourceToPlay.chapterIds?.join(',') || 'General'}, Time: ${sourceToPlay.timeOfDay})`);

                        const tempPage = { ...page };
                        if (asOneShot) {
                            tempPage.loop = false;
                            tempPage.loopCount = 0;
                        }
                        playSound(tempPage, sourceToPlay, false, null, false, false);
                    }

                    // --- Toggle Page Star ---
                    function togglePageStar(pageId, checkboxElement) {
                        const page = book.pages.find(p => p.id === pageId);
                        if (page) {
                            page.isStarred = checkboxElement.checked;
                            log(`Page "${page.title}" starred state: ${page.isStarred}`);
                            const label = checkboxElement.closest('.star-label');
                            if (label) {
                                const icon = label.querySelector('i');
                                if (icon) icon.className = `fa-fw ${page.isStarred ? 'fas fa-star' : 'far fa-star'}`;
                                label.title = page.isStarred ? 'Unstar Page (Chapter Specific)' : 'Star Page (Global Trigger)';
                            }
                            saveToLocalStorage();
                            renderPageList();
                            showTemporaryMessage(`Page "${page.title}" ${page.isStarred ? 'starred' : 'unstarred'}.`, 'info');
                        }
                    }

                    // --- Delete Page Function ---
                    // --- Delete Page Function ---
                    // --- Delete Page Function ---
                    function deletePageFromBook(pageId) {
                        const pageIndex = book.pages.findIndex(p => p.id === pageId);
                        if (pageIndex === -1) return;

                        const deletedPage = book.pages[pageIndex];
                        const deletedTitle = deletedPage.title;

                        // User confirmation for deletion
                        if (!confirm(`Are you sure you want to permanently delete page "${deletedTitle}" from the book? This cannot be undone.`)) return;

                        log(`Deleting Page ID: ${pageId} ("${deletedTitle}")`);
                        stopSingleSound(pageId); // Stop sound if playing
                        if (soundCooldowns[pageId]) { clearTimeout(soundCooldowns[pageId]); delete soundCooldowns[pageId]; }

                        // Remove page from any collections
                        (book.collections || []).forEach(collection => {
                            const pageIndex = collection.pageIds.indexOf(pageId);
                            if (pageIndex > -1) collection.pageIds.splice(pageIndex, 1);
                        });

                        // Clean up potential YouTube players associated with any variation of this page
                        deletedPage.sources.forEach(source => {
                            if (source.type === 'youtube' && source.source) { // source.source is the videoId
                                // Construct player ID based on how it was created in playYouTubeVideo
                                const playerVariationId = `${source.name || source.source.replace(/[^a-zA-Z0-9]/g, '')}-${source.startTime || 0}-${source.endTime || 'end'}`;
                                const playerId = `youtubePlayer-${pageId}-${playerVariationId}`;
                                const player = youtubePlayers[playerId];
                                if (player?.destroy) {
                                    try { player.destroy(); } catch (e) { console.warn(`Error destroying YT player ${playerId}:`, e); }
                                }
                                delete youtubePlayers[playerId];
                                const playerDiv = document.getElementById(playerId);
                                if (playerDiv) playerDiv.remove();
                            }
                        });


                        book.pages.splice(pageIndex, 1); // Remove page from the book

                        // Remove page ID from all chapters' pageIds, autoPlayPageIds, and leaveSoundPageIds lists
                        book.chapters.forEach(chapter => {
                            const idxPage = chapter.pageIds.indexOf(pageId);
                            if (idxPage > -1) chapter.pageIds.splice(idxPage, 1);

                            const idxAuto = (chapter.autoPlayPageIds || []).indexOf(pageId);
                            if (idxAuto > -1) chapter.autoPlayPageIds.splice(idxAuto, 1);

                            const idxLeave = (chapter.leaveSoundPageIds || []).indexOf(pageId);
                            if (idxLeave > -1) chapter.leaveSoundPageIds.splice(idxLeave, 1);
                        });

                        // Remove page ID from all plot threads' soundPageIds
                        (book.storyPlot.threads || []).forEach(thread => {
                            if (thread.soundPageIds && thread.soundPageIds.includes(pageId)) {
                                thread.soundPageIds = thread.soundPageIds.filter(id => id !== pageId);
                            }
                        });


                        // Clear any "nextPageId" references to this deleted page from other pages
                        let chainsBroken = 0;
                        book.pages.forEach(page => {
                            if (page.nextPageId === pageId) {
                                page.nextPageId = null;
                                chainsBroken++;
                            }
                        });

                        updateFuseIndex(); // Update search index
                        updateChapterKeywordList(); // Update chapter keywords
                        saveToLocalStorage(); // Persist changes
                        renderPageList(); // Re-render the page list
                        showTemporaryMessage(`Page "${deletedTitle}" deleted.${chainsBroken > 0 ? ` (${chainsBroken} chain link(s) cleared.)` : ''}`, 'info');
                    }

                    // --- Remove Page from Current Chapter ---
                    function removePageFromCurrentChapter(pageId) {
                        const activeChapter = book.chapters.find(ch => ch.id == book.activeChapterId); // Use == for loose comparison due to potential string/number IDs
                        if (!activeChapter || activeChapter.isIndex) {
                            showTemporaryMessage("Pages cannot be removed from Index.", "info");
                            return;
                        }

                        const indexInChapter = activeChapter.pageIds.indexOf(pageId);
                        if (indexInChapter > -1) {
                            const page = book.pages.find(p => p.id === pageId);
                            activeChapter.pageIds.splice(indexInChapter, 1);
                            log(`Removed page ${pageId} from chapter "${activeChapter.name}"`);
                            saveToLocalStorage();
                            showTemporaryMessage(`Page "${page?.title || pageId}" removed from chapter "${activeChapter.name}".`, "success");
                            renderPageList(); // Re-render to reflect change
                        }
                        // Also remove from autoplay if it was there for this chapter
                        const indexInAutoplay = (activeChapter.autoPlayPageIds || []).indexOf(pageId);
                        if (indexInAutoplay > -1) {
                            activeChapter.autoPlayPageIds.splice(indexInAutoplay, 1);
                            saveToLocalStorage(); // Save again if autoplay was modified
                        }
                    }

                    function getPagesForDataTypes(data, includeChapters, includeCollections) {
                        const pageIds = new Set();
                        if (includeChapters && data.chapters) {
                            data.chapters.forEach(chapter => {
                                (chapter.pageIds || []).forEach(id => pageIds.add(id));
                                (chapter.autoPlayPageIds || []).forEach(id => pageIds.add(id));
                                (chapter.leaveSoundPageIds || []).forEach(id => pageIds.add(id));
                            });
                        }
                        if (includeCollections && data.collections) {
                            data.collections.forEach(collection => {
                                (collection.pageIds || []).forEach(id => pageIds.add(id));
                            });
                        }
                        // Also get pages from plot threads if chapters are included
                        if (includeChapters && data.storyPlot?.threads) {
                            data.storyPlot.threads.forEach(thread => {
                                (thread.soundPageIds || []).forEach(id => pageIds.add(id));
                            });
                        }
                        // Also get pages from appendix if appendix is included
                        if (data.appendix) {
                            data.appendix.forEach(entry => {
                                (entry.effects || []).forEach(effect => {
                                    if (effect.target?.pages) {
                                        effect.target.pages.forEach(pData => pageIds.add(pData.pageId));
                                    }
                                });
                            });
                        }


                        return (data.pages || []).filter(page => pageIds.has(page.id));
                    }

                    // --- Save Book To File ---
                    function saveFileFromModal() {
                        const fileName = saveFileNameInput.value.trim() || 'storyteller-book.story';
                        const includeChapters = saveSwitchChapters.checked;
                        const includeCollections = saveSwitchCollections.checked;
                        const includePages = saveSwitchPages.checked;
                        const includeAppendix = saveSwitchAppendix.checked;
                        const includeSettings = saveSwitchSettings.checked;
                        const includeSoundtracks = document.getElementById('saveSwitchSoundtracks') ? document.getElementById('saveSwitchSoundtracks').checked : true;

                        log("Saving to file with options:", { fileName, includeChapters, includeCollections, includePages, includeAppendix, includeSettings });

                        try {
                            saveToLocalStorage(); // Ensure current state is in localStorage before stringifying for download
                            const fullBook = JSON.parse(localStorage.getItem(LOCAL_STORAGE_KEY) || '{}');
                            if (!fullBook) throw new Error("Could not retrieve book data for saving.");

                            const partialBook = {};
                            const pagesToInclude = new Set();

                            // Always include these for basic structure
                            partialBook.nextPageId = fullBook.nextPageId;
                            partialBook.nextChapterId = fullBook.nextChapterId;
                            partialBook.nextTagId = fullBook.nextTagId;
                            partialBook.nextCollectionId = fullBook.nextCollectionId;
                            partialBook.activeChapterId = fullBook.activeChapterId;
                            partialBook.currentTimeOfDay = fullBook.currentTimeOfDay;

                            if (includeChapters) {
                                partialBook.chapters = fullBook.chapters;
                                partialBook.storyPlot = fullBook.storyPlot; // Story Plot data is saved with Chapters
                            }
                            if (includeCollections) {
                                partialBook.collections = fullBook.collections;
                            }
                            if (includeAppendix) {
                                partialBook.appendix = fullBook.appendix;
                            }
                            if (includeSoundtracks) {
                                partialBook.soundtracks = fullBook.soundtracks;
                            }
                            if (includeSettings) {
                                partialBook.settings = fullBook.settings;
                            }

                            // Add pages associated with selected components
                            if (includeChapters) {
                                (fullBook.storyPlot?.threads || []).forEach(t => (t.soundPageIds || []).forEach(id => pagesToInclude.add(id)));
                            }
                            if (includeCollections) {
                                (fullBook.collections || []).forEach(c => (c.pageIds || []).forEach(id => pagesToInclude.add(id)));
                            }
                            if (includeAppendix) {
                                (fullBook.appendix || []).forEach(entry => (entry.effects || []).forEach(effect => {
                                    if (effect.target?.pages) effect.target.pages.forEach(pData => pagesToInclude.add(pData.pageId));
                                }));
                            }

                            // If the "Pages" switch is on, include all pages
                            if (includePages) {
                                (fullBook.pages || []).forEach(p => pagesToInclude.add(p.id));
                            }

                            partialBook.pages = (fullBook.pages || []).filter(p => pagesToInclude.has(p.id));

                            if (Object.keys(partialBook).length <= 6) { // Only contains the basic structure fields
                                showTemporaryMessage("Nothing selected to save.", "info");
                                return;
                            }

                            const jsonString = JSON.stringify(partialBook, null, 2);
                            const blob = new Blob([jsonString], { type: 'application/json' });
                            const url = URL.createObjectURL(blob);
                            const a = document.createElement('a');
                            a.href = url;
                            a.download = fileName.endsWith('.story') ? fileName : `${fileName}.story`;
                            document.body.appendChild(a);
                            a.click();
                            document.body.removeChild(a);
                            URL.revokeObjectURL(url);
                            showTemporaryMessage("Book saved to file!", "success");
                        } catch (error) {
                            console.error("Error during save book to file:", error);
                            showTemporaryMessage("Failed to save book file.", "error");
                        }
                    }

                    // --- Load Book From File ---
                    function handleFileLoad(event) {
                        log("Load book from file triggered.");
                        const file = event.target.files[0];
                        if (!file) return;

                        const reader = new FileReader();
                        reader.onload = (e) => {
                            try {
                                const loadedData = JSON.parse(e.target.result);
                                if (!loadedData || typeof loadedData !== 'object') {
                                    throw new Error("Invalid file format.");
                                }

                                const contents = [];
                                if (loadedData.chapters) contents.push('Chapters & Collections');
                                if (loadedData.pages) contents.push('Pages');
                                if (loadedData.appendix) contents.push('Appendix Entries');
                                if (loadedData.settings) contents.push('Settings');

                                if (contents.length === 0) {
                                    showTemporaryMessage("The selected file does not contain any recognizable Storyteller data.", "error", 5000);
                                    return;
                                }

                                // New granular import modal
                                const confirmationModal = document.getElementById('loadFileConfirmationModal');
                                let importOptionsHTML = '';
                                const detectedParts = {};

                                if (loadedData.pages && loadedData.pages.length > 0) detectedParts.pages = true;
                                if (loadedData.chapters && loadedData.chapters.length > 0) detectedParts.chapters = true;
                                if (loadedData.collections && loadedData.collections.length > 0) detectedParts.collections = true;
                                if (loadedData.appendix && loadedData.appendix.length > 0) detectedParts.appendix = true;
                                if (loadedData.soundtracks && loadedData.soundtracks.length > 0) detectedParts.soundtracks = true;
                                if (loadedData.settings) detectedParts.settings = true;

                                for (const part in detectedParts) {
                                    const partTitle = part.charAt(0).toUpperCase() + part.slice(1);
                                    importOptionsHTML += `
                                <div class="border-t border-stone-700 pt-3 mt-3">
                                    <h4 class="text-sm font-semibold text-[var(--accent-gold-light)] mb-2">${partTitle}</h4>
                                    <div class="flex items-center space-x-4 text-sm">
                                        <label><input type="radio" name="import_${part}" value="merge" checked> Merge/Add</label>
                                        <label><input type="radio" name="import_${part}" value="overwrite"> Overwrite All</label>
                                        <label><input type="radio" name="import_${part}" value="skip"> Skip</label>
                                    </div>
                                </div>
                            `;
                                }

                                confirmationModal.innerHTML = `
                            <div class="modal-body">
                                <h3 class="modal-title"><i class="fas fa-exclamation-triangle mr-2 text-yellow-400"></i>Confirm Load</h3>
                                <div class="modal-content space-y-3">
                                    <p>This file contains the following data. Choose how to import each part.</p>
                                    ${importOptionsHTML}
                                    <p class="text-xs text-gray-400 mt-3">
                                        <b>Merge/Add:</b> Adds new items. For items with the same name/ID, you may be prompted to resolve conflicts.<br>
                                        <b>Overwrite All:</b> Deletes all existing data of this type and replaces it with the data from the file.<br>
                                        <b>Skip:</b> Ignores this data type from the file completely.
                                    </p>
                                </div>
                            </div>
                            <div class="modal-actions">
                                <button id="cancelLoadButton" type="button" class="btn-rpg-sm">Cancel</button>
                                <button id="confirmLoadButton" type="button" class="btn-rpg">Import File</button>
                            </div>
                        `;
                                modalOverlay.style.display = 'block';
                                confirmationModal.style.display = 'flex';

                                confirmationModal.querySelector('#cancelLoadButton').onclick = () => {
                                    confirmationModal.style.display = 'none';
                                    modalOverlay.style.display = 'none';
                                    event.target.value = ''; // Clear file input
                                };

                                confirmationModal.querySelector('#confirmLoadButton').onclick = () => {
                                    confirmationModal.style.display = 'none';
                                    modalOverlay.style.display = 'none';

                                    const importChoices = {};
                                    for (const part in detectedParts) {
                                        const choice = confirmationModal.querySelector(`input[name="import_${part}"]:checked`)?.value;
                                        if (choice) {
                                            importChoices[part] = choice;
                                        }
                                    }

                                    loadBookFromFile(loadedData, event, importChoices);
                                };

                            } catch (error) {
                                showTemporaryMessage(`Error reading file: ${error.message}`, 'error');
                                event.target.value = '';
                            }
                        };
                        reader.readAsText(file);
                    }

                    function loadBookFromFile(loadedData, event, importChoices) {
                        if (!initAudioContext()) { showTemporaryMessage("Audio system not ready.", "error"); event.target.value = ''; return; }

                        try {
                            stopListening(true); // Force stop SR
                            stopAllSounds();
                            clearAllCooldowns();

                            // Only clear players if we are overwriting pages
                            if (importChoices.pages === 'overwrite') {
                                activeSounds = {};
                                youtubePlayers = {};
                                youtubePlayersContainer.innerHTML = '';
                            }

                            const defaultBookData = getDefaultBook();
                            let pagesAdded = 0, pagesOverwritten = 0, pagesSkipped = 0;
                            let chaptersAdded = 0, chaptersOverwritten = 0;
                            let collectionsAdded = 0, collectionsOverwritten = 0;
                            let appendixAdded = 0, appendixOverwritten = 0;

                            // Carefully merge settings, prioritizing loaded data but ensuring all defaults are present
                            const defaultSettings = getDefaultBook().settings;
                            if (loadedData.settings) {
                                book.settings = { ...book.settings, ...loadedData.settings };
                            }

                            // Data migration and validation for settings
                            if (typeof book.settings.accuracyThreshold !== 'number' || isNaN(book.settings.accuracyThreshold)) book.settings.accuracyThreshold = defaultSettings.accuracyThreshold;
                            book.settings.accuracyThreshold = Math.max(0.5, Math.min(1, book.settings.accuracyThreshold));
                            if (typeof book.settings.stopAudioOnChapterChange === 'boolean') {
                                book.settings.stopAudioMode = book.settings.stopAudioOnChapterChange ? 'all' : 'autoplay';
                                delete book.settings.stopAudioOnChapterChange;
                            }
                            const validStopModes = ['all', 'autoplay', 'smart', 'indexContinue'];
                            if (!validStopModes.includes(book.settings.stopAudioMode)) {
                                book.settings.stopAudioMode = defaultSettings.stopAudioMode;
                            }
                            delete book.settings.compoundFunction;
                            delete book.settings.customCompoundWords;
                            book.settings.stopPhrases = book.settings.stopPhrases || book.settings.masterStopKeywords || [];
                            book.settings.customEnterPhrases = book.settings.customEnterPhrases || book.settings.customTransitionCues || [];
                            book.settings.customExitPhrases = book.settings.customExitPhrases || book.settings.customEndPhrases || [];
                            book.settings.daytimeTransitionPhrases = book.settings.daytimeTransitionPhrases || book.settings.dayTransitionPhrases || [];
                            book.settings.nighttimeTransitionPhrases = book.settings.nighttimeTransitionPhrases || book.settings.nightTransitionPhrases || [];
                            book.settings.autoplayOnClick = book.settings.autoplayOnClick || 'listening';
                            book.settings.masterVolume = typeof book.settings.masterVolume === 'number' ? Math.max(0, Math.min(100, book.settings.masterVolume)) : defaultSettings.masterVolume;
                            book.settings.syrinscapeAuthToken = loadedData.settings?.syrinscapeAuthToken || null;


                            delete book.settings.masterStopKeywords;
                            delete book.settings.customTransitionCues;
                            delete book.settings.customEndPhrases;
                            delete book.settings.dayTransitionPhrases;
                            delete book.settings.nightTransitionPhrases;


                            // Update global state variables from the newly merged settings
                            currentListeningMode = book.settings.listeningMode;
                            isCompoundPhrasingEnabled = book.settings.compoundPhrasing;
                            currentKeywordConfidenceThreshold = book.settings.accuracyThreshold;
                            stopAudioMode = book.settings.stopAudioMode;
                            currentMasterVolume = book.settings.masterVolume;
                            masterVolumeSlider.value = currentMasterVolume;
                            masterVolumeValueSpan.textContent = `${currentMasterVolume}`;
                            stopPhrases = book.settings.stopPhrases;
                            customEnterPhrases = book.settings.customEnterPhrases;
                            customExitPhrases = book.settings.customExitPhrases;
                            daytimeTransitionPhrases = book.settings.daytimeTransitionPhrases;
                            nighttimeTransitionPhrases = book.settings.nighttimeTransitionPhrases;
                            autoplayOnClickSetting = book.settings.autoplayOnClick;
                            syrinscapeAuthToken = book.settings.syrinscapeAuthToken;
                            syrinscapePlayerReady = false; // Reset player readiness on load


                            // Process Pages
                            if (importChoices.pages && importChoices.pages !== 'skip') {
                                if (importChoices.pages === 'overwrite') {
                                    book.pages = [];
                                    book.nextPageId = 0;
                                }

                                const loadedPages = [];
                                (loadedData.pages || []).forEach(item => {
                                    // Conflict check
                                    const existingPageIndex = book.pages.findIndex(p => p.title.toLowerCase() === item.title.toLowerCase());
                                    if (existingPageIndex > -1 && importChoices.pages === 'merge') {
                                        // For a full file import, we'll just overwrite on merge to keep it simple.
                                        // A more complex UI could prompt for each.
                                        book.pages[existingPageIndex] = item; // Overwrite
                                        pagesOverwritten++;
                                        if (item.id >= book.nextPageId) book.nextPageId = item.id + 1;
                                        return; // continue to next item
                                    }


                                    if (!item || typeof item.title !== 'string' || item.id === undefined || item.id === null) return;

                                    let loopCount = 0;
                                    if (typeof item.loopCount === 'number') {
                                        loopCount = item.loopCount;
                                    } else if (item.loop === true) {
                                        loopCount = -1;
                                    }

                                    let sourcesData = [];
                                    if (Array.isArray(item.sources)) {
                                        log(`[loadBookFromFile] Processing sources for page "${item.title}" (ID: ${item.id})`);
                                        sourcesData = item.sources.map((variationContainer, index) => {
                                            log(`[loadBookFromFile] -> Variation #${index}:`, JSON.parse(JSON.stringify(variationContainer)));
                                            if (variationContainer.type && variationContainer.sources === undefined) {
                                                log(`[loadBookFromFile] -> -> Detected old format source. Wrapping in variation container.`);
                                                const subSource = { ...variationContainer, needsFile: variationContainer.type === 'file' };
                                                return { id: `var_${generateUUID()}`, name: variationContainer.name || null, isDefault: variationContainer.isDefault || false, conditions: variationContainer.conditions || null, variationKeywords: variationContainer.variationKeywords || [], sources: [subSource] };
                                            }
                                            if (Array.isArray(variationContainer.sources)) {
                                                log(`[loadBookFromFile] -> -> Detected new format with ${variationContainer.sources.length} sub-sources. Processing them.`);
                                                const processedSubSources = variationContainer.sources.map(subSource => ({
                                                    ...subSource, // Keep all existing properties from the sub-source (incl. audioHash)
                                                    source: subSource.type === 'youtube' ? (subSource.source || extractYouTubeVideoId(subSource.fileName || '')) : null,
                                                    // Files with cached bytes (audioHash) are rehydrated from IndexedDB, no relink (B3)
                                                    needsFile: subSource.type === 'file' && !subSource.audioHash
                                                }));
                                                return { ...variationContainer, sources: processedSubSources };
                                            }
                                            console.warn(`[loadBookFromFile] -> -> Variation container for page "${item.title}" is in an unknown format or has no sources array.`, variationContainer);
                                            return { ...variationContainer, sources: [] };
                                        });
                                    }

                                    const newPage = {
                                        id: item.id, title: item.title, primaryKey: item.primaryKey || null,
                                        keywords: Array.isArray(item.keywords) ? item.keywords : [],
                                        phrases: Array.isArray(item.phrases) ? item.phrases : [],
                                        isStarred: item.isStarred || false,
                                        volume: typeof item.volume === 'number' ? item.volume : 80,
                                        loop: loopCount !== 0, loopCount: loopCount,
                                        fadeInOut: typeof item.fadeInOut === 'boolean' ? item.fadeInOut : false,
                                        endPlayKeywords: Array.isArray(item.endPlayKeywords) ? item.endPlayKeywords : [],
                                        nextPageId: item.nextPageId ?? null,
                                        timeOfDaySetting: ['day', 'night', 'always'].includes(item.timeOfDaySetting) ? item.timeOfDaySetting : 'always',
                                        currentLoop: 0, sources: sourcesData
                                    };
                                    loadedPages.push(newPage);
                                    if (typeof item.id === 'number' && item.id >= book.nextPageId) {
                                        book.nextPageId = item.id + 1;
                                    }
                                });
                                book.pages.push(...loadedPages);
                                pagesAdded += loadedPages.length;
                                book.nextPageId = Math.max(book.nextPageId, loadedData.nextPageId ?? 0);
                            }

                            // Process Chapters
                            if (importChoices.chapters && importChoices.chapters !== 'skip') {
                                if (importChoices.chapters === 'overwrite') {
                                    book.chapters = [];
                                    book.nextChapterId = 1;
                                }

                                const loadedChapters = [];
                                let indexChapterFound = false;
                                if (Array.isArray(loadedData.chapters)) {
                                    loadedData.chapters.forEach(item => {
                                        const existingChapterIndex = book.chapters.findIndex(c => c.name.toLowerCase() === item.name.toLowerCase());
                                        if (existingChapterIndex > -1 && importChoices.chapters === 'merge') {
                                            book.chapters[existingChapterIndex] = item;
                                            chaptersOverwritten++;
                                            return;
                                        }

                                        if (!item || typeof item.name !== 'string' || item.id === undefined || item.id === null) return;
                                        const newChapter = {
                                            id: item.id, name: item.name, isIndex: item.isIndex || false,
                                            isStarred: item.isStarred || false,
                                            pageIds: Array.isArray(item.pageIds) ? item.pageIds.filter(id => book.pages.some(p => p.id === id)) : [],
                                            chapterKeywords: Array.isArray(item.chapterKeywords || item.transitionWords) ? (item.chapterKeywords || item.transitionWords) : [],
                                            tagIds: Array.isArray(item.tagIds) ? item.tagIds : [],
                                            autoPlayPageIds: Array.isArray(item.autoPlayPageIds) ? item.autoPlayPageIds.filter(id => book.pages.some(p => p.id === id)) : [],
                                            leaveSoundPageIds: Array.isArray(item.leaveSoundPageIds) ? item.leaveSoundPageIds.filter(id => book.pages.some(p => p.id === id)) : [],
                                            leaveTransitionTargetId: item.leaveTransitionTargetId || 'index'
                                        };
                                        loadedChapters.push(newChapter);
                                        if (newChapter.isIndex) indexChapterFound = true;
                                        if (typeof item.id === 'number' && item.id >= book.nextChapterId) {
                                            book.nextChapterId = item.id + 1;
                                        } else if (typeof item.id === 'string' && item.id !== 'index') {
                                            const numericPart = parseInt(item.id.replace(/[^0-9]/g, ''), 10);
                                            if (!isNaN(numericPart) && numericPart >= book.nextChapterId) {
                                                book.nextChapterId = numericPart + 1;
                                            }
                                        }
                                    });
                                }
                                if (!indexChapterFound && loadedChapters.every(ch => ch.id !== 'index')) {
                                    loadedChapters.unshift({ ...getDefaultBook().chapters[0] });
                                }
                                book.chapters.push(...loadedChapters);
                                chaptersAdded += loadedChapters.length;
                                book.nextChapterId = Math.max(book.nextChapterId, loadedData.nextChapterId ?? 1);
                            }

                            // Process Collections
                            if (importChoices.collections && importChoices.collections !== 'skip') {
                                if (importChoices.collections === 'overwrite') {
                                    book.collections = [];
                                    book.nextCollectionId = 0;
                                }
                                (loadedData.collections || []).forEach(item => {
                                    const existingCollIndex = (book.collections || []).findIndex(c => c.name.toLowerCase() === item.name.toLowerCase());
                                    if (existingCollIndex > -1 && importChoices.collections === 'merge') {
                                        book.collections[existingCollIndex] = item;
                                        collectionsOverwritten++;
                                    } else {
                                        book.collections.push({ ...item, id: `coll_${book.nextCollectionId++}` });
                                        collectionsAdded++;
                                    }
                                });
                                book.nextCollectionId = Math.max(book.nextCollectionId, loadedData.nextCollectionId ?? 0);
                            }

                            // Process Appendix

                            // Process Soundtracks
                            if (importChoices.soundtracks && importChoices.soundtracks !== 'skip') {
                                if (importChoices.soundtracks === 'overwrite') {
                                    book.soundtracks = [];
                                } else if (!book.soundtracks) {
                                    book.soundtracks = [];
                                }
                                (loadedData.soundtracks || []).forEach(loadedSt => {
                                    // Ensure structure is correct
                                    const sanitizedSt = {
                                        ...loadedSt,
                                        chapters: loadedSt.chapters || (loadedSt.chapter && loadedSt.chapter !== 'none' ? [loadedSt.chapter] : []),
                                        songs: (loadedSt.songs || []).map(song => ({
                                            ...song,
                                            needsFile: song.type === 'file'
                                        }))
                                    };
                                    const existingIndex = book.soundtracks.findIndex(s => s.id === sanitizedSt.id || s.name.toLowerCase() === sanitizedSt.name.toLowerCase());
                                    if (existingIndex > -1 && importChoices.soundtracks === 'merge') {
                                        book.soundtracks[existingIndex] = sanitizedSt;
                                    } else {
                                        book.soundtracks.push(sanitizedSt);
                                    }
                                });
                            }

                            if (importChoices.appendix && importChoices.appendix !== 'skip') {
                                if (importChoices.appendix === 'overwrite') {
                                    book.appendix = [];
                                }
                                (loadedData.appendix || []).forEach(item => {
                                    const existingAppendixIndex = (book.appendix || []).findIndex(a => a.name && a.name.toLowerCase() === item.name.toLowerCase());
                                    if (existingAppendixIndex > -1 && importChoices.appendix === 'merge') {
                                        book.appendix[existingAppendixIndex] = item;
                                        appendixOverwritten++;
                                    } else {
                                        book.appendix.push({ ...item, id: `appendix_${generateUUID()}` });
                                        appendixAdded++;
                                    }
                                });
                            }

                            // Process Settings
                            if (importChoices.settings && importChoices.settings !== 'skip') {
                                if (importChoices.settings === 'overwrite') {
                                    book.settings = { ...defaultBookData.settings, ...loadedData.settings };
                                } else { // Merge
                                    book.settings = { ...book.settings, ...loadedData.settings };
                                }
                            }

                            // Set active chapter and time
                            const validActiveId = book.chapters.some(ch => ch.id == loadedData.activeChapterId);
                            book.activeChapterId = validActiveId ? loadedData.activeChapterId : 'index';
                            book.currentTimeOfDay = ['day', 'night'].includes(loadedData.currentTimeOfDay) ? loadedData.currentTimeOfDay : 'day';
                            currentTimeOfDay = book.currentTimeOfDay;

                            book.nextPageId = loadedData.nextPageId ?? book.nextPageId;
                            book.nextChapterId = loadedData.nextChapterId ?? book.nextChapterId;

                            if (loadedData.storyPlot && typeof loadedData.storyPlot === 'object') {
                                book.storyPlot.nodes = Array.isArray(loadedData.storyPlot.nodes) ? loadedData.storyPlot.nodes.filter(n => n && n.id && n.chapterId !== undefined) : [];
                                book.storyPlot.threads = Array.isArray(loadedData.storyPlot.threads) ? loadedData.storyPlot.threads.filter(t => t && t.id && t.fromNodeId && t.toNodeId) : [];
                                book.storyPlot.nextPlotNodeId = typeof loadedData.storyPlot.nextPlotNodeId === 'number' ? loadedData.storyPlot.nextPlotNodeId : 0;
                                book.storyPlot.nextPlotThreadId = typeof loadedData.storyPlot.nextPlotThreadId === 'number' ? loadedData.storyPlot.nextPlotThreadId : 0;
                                book.storyPlot.viewTransform = (loadedData.storyPlot.viewTransform && typeof loadedData.storyPlot.viewTransform.scale === 'number') ?
                                    { ...loadedData.storyPlot.viewTransform } :
                                    { x: 0, y: 0, scale: 1.0 };
                            } else {
                                book.storyPlot = getDefaultBook().storyPlot;
                            }
                            plotBoardView = { ...book.storyPlot.viewTransform };


                            updateFuseIndex();
                            updateChapterKeywordList();
                            saveToLocalStorage();
                            renderChapterTabs();
                            renderPageList();
                            renderSoundtrackIcons();
                            updateUIState();

                            let summary = `Import complete. Pages: +${pagesAdded}, ~${pagesOverwritten}. Chapters: +${chaptersAdded}, ~${chaptersOverwritten}. Collections: +${collectionsAdded}, ~${collectionsOverwritten}. Appendix: +${appendixAdded}, ~${appendixOverwritten}.`;
                            showTemporaryMessage(summary, "success", 8000);

                            const needsRelink = book.pages.some(p => p.sources.some(s => s.type === 'file' && s.needsFile));
                            if (needsRelink) {
                                showTemporaryMessage("Some imported files need to be relinked.", "info", 5000);
                            }

                            if (syrinscapeAuthToken) {
                                initializeSyrinscapePlayer();
                            }
                        } catch (error) {
                            console.error("Error loading book from file:", error);
                            showTemporaryMessage(`Load failed: ${error.message}`, 'error', 5000);
                        } finally {
                            event.target.value = '';
                        }
                    }


                    // --- Handle Directory Selection for Relinking ---
                    async function handleDirectorySelection(event) {
                        const files = event.target.files;
                        if (!files || files.length === 0) return;
                        if (!initAudioContext()) { showTemporaryMessage("Audio system not ready.", "error"); event.target.value = ''; return; }

                        log(`Processing ${files.length} files for relinking...`);
                        showTemporaryMessage(`Scanning ${files.length} files...`, 'info', 5000);

                        let relinkedCount = 0;
                        let errorCount = 0;
                        const promises = [];
                        const fileMap = new Map(); // For quick lookup by filename
                        for (const file of files) {
                            if (file.name) fileMap.set(file.name.toLowerCase(), file);
                        }

                        for (const page of book.pages) {
                            for (const source of page.sources) {
                                if (source.type === 'file' && source.needsFile && source.fileName) {
                                    const lowerCaseFileName = source.fileName.toLowerCase();
                                    const matchingFile = fileMap.get(lowerCaseFileName);
                                    if (matchingFile) {
                                        log(`Found match for "${source.fileName}". Decoding...`);
                                        promises.push(
                                            (async () => { // IIFE to handle async operations per file
                                                try {
                                                    const arrayBuffer = await matchingFile.arrayBuffer();
                                                    const bytesForStore = arrayBuffer.slice(0); // decodeAudioData detaches arrayBuffer
                                                    const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
                                                    source.source = audioBuffer; // Store AudioBuffer
                                                    source.needsFile = false; // Mark as relinked
                                                    await persistAudioSource(source, matchingFile, bytesForStore); // B3: cache so no relink next time
                                                    relinkedCount++;
                                                    log(`Relinked: ${source.fileName}`);
                                                } catch (decodeError) {
                                                    errorCount++;
                                                    console.error(`Error decoding "${matchingFile.name}" for page "${page.title}":`, decodeError);
                                                    source.needsFile = true; // Keep it marked as needing file
                                                    source.source = null;   // Ensure source is null if decode fails
                                                }
                                            })()
                                        );
                                    }
                                }
                            }
                        }

                        await Promise.all(promises); // Wait for all decoding attempts
                        saveToLocalStorage(); // Save changes after relinking attempts
                        renderPageList(); // Update UI to reflect relinked status

                        if (errorCount > 0) {
                            showTemporaryMessage(`Relinked ${relinkedCount} file(s). ${errorCount} decoding error(s).`, 'error', 7000);
                        } else if (relinkedCount > 0) {
                            showTemporaryMessage(`Successfully relinked ${relinkedCount} file(s)!`, 'success', 5000);
                        } else {
                            const stillMissing = book.pages.some(p => p.sources.some(s => s.type === 'file' && s.needsFile));
                            if (stillMissing) {
                                showTemporaryMessage("No matching files found for some sounds.", 'info', 5000);
                            } else {
                                showTemporaryMessage("No missing files needed relinking or all found.", 'info', 4000);
                            }
                        }
                        event.target.value = ''; // Clear the directory input
                        log("Relinking finished.");
                    }


                    // --- Chapter Management Functions ---
                    function renderChapterTabs() {
                        chapterTabsContainer.innerHTML = ''; // Clear existing tabs
                        // Sort chapters alphabetically, but ensure Index is always first.
                        const indexChapter = book.chapters.find(ch => ch.isIndex);
                        const otherChapters = book.chapters.filter(ch => !ch.isIndex);
                        // Sort other chapters alphabetically by name
                        otherChapters.sort((a, b) => a.name.localeCompare(b.name));
                        const sortedChapters = indexChapter ? [indexChapter, ...otherChapters] : otherChapters;


                        sortedChapters.forEach(chapter => {
                            const tab = document.createElement('div'); // Use a div as a container for the tab and dropdown
                            tab.className = `chapter-tab ${chapter.id == book.activeChapterId ? 'active' : ''} ${chapter.isIndex ? 'index-tab' : ''} ${chapter.isStarred ? 'starred' : ''}`;
                            tab.style.position = 'relative'; // For dropdown positioning

                            // Main clickable part of the tab
                            const tabButton = document.createElement('button');
                            // If it's the index tab, make it icon-only. Otherwise, show the name.
                            tabButton.className = chapter.isIndex ? 'flex-grow text-center' : 'flex-grow text-center';
                            tabButton.innerHTML = `<span class="tab-title">${escapeHtml(chapter.name)}</span>`;
                            tabButton.title = chapter.name;
                            tabButton.onclick = () => {
                                let shouldTriggerAutoplay = false;
                                if (autoplayOnClickSetting === 'on') {
                                    shouldTriggerAutoplay = true;
                                } else if (autoplayOnClickSetting === 'listening' && isListening) {
                                    shouldTriggerAutoplay = true;
                                }
                                setActiveChapter(chapter.id, shouldTriggerAutoplay, 'tab_click');
                            };

                            if (chapter.isIndex) {
                                tabButton.innerHTML = '<i class="fas fa-atlas fa-fw"></i>';
                                tabButton.title = "Index (Show All Pages)";
                            }

                            tab.appendChild(tabButton);

                            if (!chapter.isIndex) { // Add edit/delete buttons only for non-Index chapters
                                const dropdownDiv = document.createElement('div');
                                dropdownDiv.className = 'dropdown ml-2';
                                dropdownDiv.innerHTML = `
                            <button class="action-button !p-1" title="Chapter Actions"><i class="fas fa-book-open fa-fw"></i></button>
                            <div class="dropdown-content">
                                <button class="edit-chapter-btn"><i class="fas fa-edit fa-fw"></i> Edit</button>
                                <button class="export-chapter-btn"><i class="fas fa-file-export fa-fw"></i> Export</button>
                                <button class="delete-chapter-btn" style="color: var(--danger-color);"><i class="fas fa-trash-alt fa-fw"></i> Delete</button>
                            </div>
                        `;
                                tab.appendChild(dropdownDiv);
                            }

                            // Drag and drop event listeners for adding pages to chapters
                            tab.addEventListener('dragover', (e) => {
                                e.preventDefault(); // Necessary to allow drop
                                if (chapter.isIndex) {
                                    e.dataTransfer.dropEffect = 'none'; // Don't allow dropping on Index
                                    tab.classList.add('drag-over', 'index-tab'); // Visual feedback for invalid drop
                                } else {
                                    e.dataTransfer.dropEffect = 'move';
                                    tab.classList.add('drag-over'); // Visual feedback for valid drop
                                }
                            });
                            tab.addEventListener('dragleave', () => { tab.classList.remove('drag-over'); });
                            tab.addEventListener('drop', (e) => {
                                e.preventDefault();
                                tab.classList.remove('drag-over');
                                if (chapter.isIndex) {
                                    showTemporaryMessage("Cannot add pages to Index via drag and drop.", "info");
                                    return;
                                }
                                const data = e.dataTransfer.getData('text/plain');
                                const targetChapterId = chapter.id;

                                if (data.startsWith('collection:')) {
                                    // Handle collection drop
                                    const collectionId = data.split(':')[1];
                                    addCollectionToChapter(collectionId, targetChapterId);
                                } else if (data) {
                                    // Handle single page drop
                                    const pageId = parseInt(data, 10);
                                    addPageToChapter(pageId, targetChapterId);
                                }

                            });
                            chapterTabsContainer.appendChild(tab);

                            // Add event listeners for the new dropdown buttons
                            if (!chapter.isIndex) {
                                tab.querySelector('.edit-chapter-btn').addEventListener('click', (e) => { e.stopPropagation(); openEditChapterModal(chapter.id); });
                                tab.querySelector('.export-chapter-btn').addEventListener('click', (e) => { e.stopPropagation(); exportChapterById(chapter.id); });
                                tab.querySelector('.delete-chapter-btn').addEventListener('click', (e) => { e.stopPropagation(); deleteChapter(chapter.id); });
                            }
                        });

                        // Add the "Add Chapter" tab at the end
                        const addChapterTab = document.createElement('button');
                        addChapterTab.className = 'chapter-tab add-chapter-tab';
                        addChapterTab.innerHTML = '<i class="fas fa-plus fa-fw"></i>';
                        addChapterTab.title = "Add New Chapter";
                        addChapterTab.addEventListener('click', createNewChapter);
                        chapterTabsContainer.appendChild(addChapterTab);
                    }

                    function setActiveChapter(newChapterId, triggeredByVoiceOrPlotterOrTab = false, transitionContext = 'unknown', soundsFromPlotThread = [], thread = null) {
                        const oldChapterId = book.activeChapterId;
                        // Avoid redundant processing if chapter isn't actually changing, unless it's a specific re-trigger context
                        if (oldChapterId == newChapterId && transitionContext === 'tab_click' && !triggeredByVoiceOrPlotterOrTab) {
                            log(`Chapter ${newChapterId} is already active and not a voice/plotter/tab transition. No change.`);
                            return;
                        }


                        const newActiveChapter = book.chapters.find(ch => ch.id == newChapterId); // Use == for loose comparison
                        if (!newActiveChapter) { console.error(`Chapter ID ${newChapterId} not found.`); return; }

                        const oldChapter = book.chapters.find(ch => ch.id == oldChapterId);
                        log(`Changing chapter from ${oldChapterId} ("${oldChapter?.name}") to ${newChapterId} ("${newActiveChapter.name}"). Stop Mode: '${stopAudioMode}', Context: ${transitionContext}`, thread ? `via Thread ${thread.id}` : '');

                        // Handle return context
                        if (transitionContext === 'plot_thread' && thread && thread.enableReturn) {
                            lookBehindContext.returnChapterContext = { fromChapterId: oldChapterId, viaThreadId: thread.id };
                            log(`Return context SET to chapter ${oldChapterId} via thread ${thread.id}.`);
                        } else {
                            lookBehindContext.returnChapterContext = null; // Clear context on any other transition
                        }

                        const soundsToPotentiallyKeep = new Map(); // pageId -> { page, soundData }

                        // New: Determine all pages that are considered "in" the destination chapter for 'smart' mode.
                        const newChapterPageIds = new Set(newActiveChapter.pageIds || []);
                        if (!newActiveChapter.isIndex) {
                            // Add pages from collections that have a matching tag with the new chapter
                            const newChapterTagIds = new Set(newActiveChapter.tagIds || []);
                            if (newChapterTagIds.size > 0) {
                                (book.collections || []).forEach(collection => {
                                    const hasMatchingTag = (collection.tagIds || []).some(tagId => newChapterTagIds.has(tagId));
                                    if (hasMatchingTag) collection.pageIds.forEach(pid => newChapterPageIds.add(pid));
                                });
                            }
                        }

                        // Determine which sounds to stop based on stopAudioMode setting
                        const skipInitialStopping = (stopAudioMode === 'indexContinue' && newActiveChapter.isIndex && transitionContext !== 'plot_thread');

                        if (!skipInitialStopping) {
                            switch (stopAudioMode) {
                                case 'autoplay':
                                    log(`LOG (setActiveChapter): Stop Mode 'autoplay': Stopping only autoplay/leave/plotter sounds.`);
                                    Object.entries(activeSounds).forEach(([pageIdStr, soundData]) => {
                                        const pageId = parseInt(pageIdStr, 10);
                                        if (soundData.startedByAutoplay || soundData.isPlotThreadSound) {
                                            // If this is a plot thread transition, and the sound is part of what the new thread will play,
                                            // it will be restarted by playSoundsFromPlotThread. Stop it for now.
                                            if (transitionContext === 'plot_thread' && soundsFromPlotThread.includes(pageId)) {
                                                log(` -> Plotter sound Page ${pageId} will be handled by subsequent playSoundsFromPlotThread. Stopping for now.`);
                                                stopSingleSound(pageId, 'chapter_change_plotter_sound');
                                            } else {
                                                log(` -> Stopping Page ${pageId}: Started by Autoplay (${soundData.startedByAutoplay}) or Plot Thread Sound (${soundData.isPlotThreadSound}).`);
                                                stopSingleSound(pageId, 'chapter_change_autoplay');
                                            }
                                        } else { // Manually played sounds
                                            const page = book.pages.find(p => p.id === pageId);
                                            if (page) soundsToPotentiallyKeep.set(pageId, { page, soundData });
                                        }
                                    });
                                    break;
                                case 'all': // 'all' is now handled like 'smart' but with different keep criteria
                                case 'smart': case 'indexContinue': // 'indexContinue' behaves like 'smart' unless going to Index
                                    log(`LOG (setActiveChapter): Stop Mode '${stopAudioMode}': Smart stopping/keeping...`);
                                    Object.entries(activeSounds).forEach(([pageIdStr, soundData]) => {
                                        const pageId = parseInt(pageIdStr, 10);
                                        const page = book.pages.find(p => p.id === pageId);
                                        if (!page) { stopSingleSound(pageId); return; } // Should not happen

                                        // If this is a plot thread transition, and the sound is part of what the new thread will play,
                                        // it will be restarted by playSoundsFromPlotThread. Stop it for now.
                                        if (transitionContext === 'plot_thread' && soundsFromPlotThread.includes(pageId)) {
                                            log(` -> Plotter sound Page ${pageId} ("${page.title}") will be handled by subsequent play. Stopping for now.`);
                                            stopSingleSound(pageId, 'chapter_change_plotter_sound');
                                        } else {
                                            const isStarred = page.isStarred;
                                            const isInDestination = newChapterPageIds.has(pageId);
                                            const shouldKeep = stopAudioMode === 'all' ? false : (isStarred || isInDestination);
                                            if (!shouldKeep) {
                                                log(` -> Stopping Page ${pageId} ("${page.title}"): Does not meet keep criteria for mode '${stopAudioMode}'.`);
                                                stopSingleSound(pageId, 'chapter_change_stop');
                                            } else {
                                                log(` -> Potentially Keeping Page ${pageId} ("${page.title}"): Starred (${isStarred}) or in destination (${isInDestination}).`);
                                                soundsToPotentiallyKeep.set(pageId, { page, soundData });
                                            }
                                        }
                                    });
                                    break;
                            }
                        } else {
                            log(`LOG (setActiveChapter): Stop Mode 'indexContinue' to Index (non-plotter): Keeping all sounds initially.`);
                            Object.entries(activeSounds).forEach(([pageIdStr, soundData]) => {
                                const pageId = parseInt(pageIdStr, 10);
                                const page = book.pages.find(p => p.id === pageId);
                                if (page) soundsToPotentiallyKeep.set(pageId, { page, soundData });
                            });
                        }
                        book.activeChapterId = newChapterId; saveToLocalStorage();
                        if (typeof evaluateSoundtrackTriggers === 'function') evaluateSoundtrackTriggers(newChapterId, 'chapter');
                        // reEvaluateActiveSounds(); // This is now handled by the logic below, making it redundant.
                        log(`LOG (setActiveChapter): Active chapter set to: ${newChapterId} ("${newActiveChapter.name}"), Triggered by voice/plotter/tab: ${triggeredByVoiceOrPlotterOrTab}, Context: ${transitionContext}`);
                        renderChapterTabs(); renderPageList(); // Update UI for new chapter

                        // Now, handle sounds that were potentially kept: check for variation switches
                        log(`LOG (setActiveChapter): Checking ${soundsToPotentiallyKeep.size} potentially continuing sounds for variation switch...`);
                        soundsToPotentiallyKeep.forEach(({ page, soundData }, pageId) => {
                            // If the sound was stopped in the switch block above (e.g. for plot thread sounds), it won't be in activeSounds anymore
                            if (!activeSounds[pageId] && !soundsFromPlotThread.includes(pageId)) { // Also check if it's not about to be played by plot thread
                                log(` -> Sound ${pageId} was already stopped or handled. Skipping variation check.`);
                                return;
                            }

                            // Check if the page itself is still valid for the current time of day
                            if (page.timeOfDaySetting !== 'always' && page.timeOfDaySetting !== currentTimeOfDay) {
                                log(` -> Stopping Page ${pageId} ("${page.title}"): Page time restriction (${page.timeOfDaySetting}) doesn't match current time (${currentTimeOfDay}).`);
                                if (activeSounds[pageId]) stopSingleSound(pageId, 'chapter_change_time_restriction');
                                return;
                            }
                            const currentVariation = soundData.sourceDetail;
                            const newAppropriateVariation = findPlayableSourceVariation(page, transitionContext === 'plot_thread'); // Pass plotter context for variation selection

                            if (!newAppropriateVariation) {
                                log(` -> Stopping Page ${pageId} ("${page.title}"): No playable variation for new chapter "${newActiveChapter.name}" / time ${currentTimeOfDay}.`);
                                if (activeSounds[pageId]) stopSingleSound(pageId, 'chapter_change_no_variation');
                            } else if (newAppropriateVariation !== currentVariation) {
                                log(`LOG (setActiveChapter): Switching Variation for Page ${pageId} ("${page.title}")`);
                                if (activeSounds[pageId]) stopSingleSound(pageId, 'chapter_change_variation_switch'); // Stop old variation
                                // Re-play with new variation, preserving original intent (autoplay, callback, etc.)
                                setTimeout(() => {
                                    playSound(page, newAppropriateVariation, soundData.startedByAutoplay, soundData.onEndedCallback, soundData.isCompoundSequence, soundData.isPlotThreadSound);
                                }, 50); // Small delay to allow stop to process
                            } else {
                                log(` -> Keeping Page ${pageId} ("${page.title}"): Current variation is still appropriate.`);
                                // If it was stopped for plot_thread but is now being kept, ensure it's back in activeSounds
                                if (!activeSounds[pageId]) activeSounds[pageId] = soundData;
                            }
                        });

                        // Trigger autoplay pages for the new chapter if appropriate
                        if (triggeredByVoiceOrPlotterOrTab && !newActiveChapter.isIndex) {
                            if (transitionContext === 'plot_thread') { // For plot threads, the flag directly controls autoplay
                                log(`Plot thread transition to "${newActiveChapter.name}". Chapter autoplay is ${triggeredByVoiceOrPlotterOrTab ? 'ENABLED' : 'DISABLED'}.`);
                                playAutoplayPages(newActiveChapter.id);
                            } else if (['enter_phrase', 'exit_phrase', 'exit_phrase_return', 'tab_click'].includes(transitionContext)) {
                                // For other triggered transitions (including plot thread returns), play autoplay pages for the new chapter.
                                playAutoplayPages(newActiveChapter.id);
                            }
                            evaluateAppendixStateTriggers(); // Re-evaluate conditions after chapter change
                        }
                    }

                    function createNewChapter() {
                        // Find a unique default name
                        let defaultName = "New Chapter";
                        let counter = 1;
                        while (book.chapters.some(ch => ch.name.toLowerCase() === defaultName.toLowerCase())) {
                            counter++;
                            defaultName = `New Chapter ${counter}`;
                        }
                        const trimmedName = defaultName;

                        const newChapterId = `ch_${book.nextChapterId++}`; // Ensure unique ID
                        const newChapter = {
                            id: newChapterId, name: trimmedName, isIndex: false, isStarred: false,
                            pageIds: [], chapterKeywords: [], autoPlayPageIds: [], leaveSoundPageIds: [],
                            leaveTransitionTargetId: 'index', // Default leave target
                            tagIds: [] // Initialize with empty tags
                        };
                        book.chapters.push(newChapter);
                        updateChapterKeywordList(); // Update list for transitions
                        saveToLocalStorage();
                        setActiveChapter(newChapterId, false, 'manual_creation'); // Switch to the new chapter
                        showTemporaryMessage(`Chapter "${trimmedName}" created.`, "success");
                        // If plotter is open, ensure this new chapter appears as a node
                        if (storyPlotterModal.style.display === 'flex') {
                            ensureAllChaptersArePlotNodes();
                            renderPlotBoard();
                        }



                        // Open the edit modal for the newly created chapter
                        openEditChapterModal(newChapterId);

                    }

                    function deleteChapter(chapterId) {
                        const chapterIndex = book.chapters.findIndex(ch => ch.id === chapterId);
                        if (chapterIndex === -1) { console.error(`deleteChapter failed, chapterId ${chapterId} not found.`); return; } // Chapter not found
                        const chapterToDelete = book.chapters[chapterIndex];
                        if (chapterToDelete.isIndex) {
                            showTemporaryMessage("Cannot delete Index chapter.", "error");
                            return;
                        }
                        if (!confirm(`Delete chapter "${chapterToDelete.name}"? Pages within this chapter will NOT be deleted from the book but will be unassigned from this chapter.`)) return;

                        log(`Deleting chapter: "${chapterToDelete.name}" (ID: ${chapterId})`);

                        // Remove this chapterId from any page source variations that were specifically assigned to it
                        book.pages.forEach(page => {
                            page.sources.forEach(source => {
                                if (Array.isArray(source.chapterIds)) {
                                    const index = source.chapterIds.indexOf(chapterId);
                                    if (index > -1) source.chapterIds.splice(index, 1);
                                    if (source.chapterIds.length === 0) source.chapterIds = null; // If no chapters left, make it general
                                }
                            });
                        });

                        // Remove chapter node and connected threads from story plotter
                        const nodesToDelete = book.storyPlot.nodes.filter(node => node.chapterId === chapterId);
                        const nodeIdsToDelete = nodesToDelete.map(node => node.id);

                        book.storyPlot.nodes = book.storyPlot.nodes.filter(node => node.chapterId !== chapterId);
                        book.storyPlot.threads = book.storyPlot.threads.filter(thread =>
                            !nodeIdsToDelete.includes(thread.fromNodeId) && !nodeIdsToDelete.includes(thread.toNodeId)
                        );


                        book.chapters.splice(chapterIndex, 1); // Remove chapter from book
                        updateChapterKeywordList(); // Update list
                        saveToLocalStorage();

                        if (book.activeChapterId === chapterId) { // If deleted chapter was active
                            setActiveChapter('index', false, 'deletion_fallback'); // Switch to Index
                        } else {
                            renderChapterTabs(); // Just re-render tabs
                        }
                        // If plotter is open, re-render it
                        if (storyPlotterModal.style.display === 'flex') {
                            renderPlotBoard();
                        }
                        showTemporaryMessage(`Chapter "${chapterToDelete.name}" deleted.`, "info");
                    }

                    function addPageToChapter(pageId, chapterId) {
                        const chapter = book.chapters.find(ch => ch.id == chapterId);
                        const page = book.pages.find(p => p.id === pageId);
                        if (!chapter || chapter.isIndex) { // Cannot add to Index this way
                            showTemporaryMessage("Cannot add pages to Index via drag and drop.", "info");
                            return;
                        }
                        if (!page) return; // Page not found

                        if (chapter.pageIds.includes(pageId)) {
                            showTemporaryMessage(`Page "${page.title}" already in chapter "${chapter.name}".`, "info");
                        } else {
                            chapter.pageIds.push(pageId);
                            saveToLocalStorage();
                            showTemporaryMessage(`Page "${page.title}" added to chapter "${chapter.name}".`, "success");
                            if (book.activeChapterId === chapterId) { // If dropped onto active chapter, re-render list
                                renderPageList();
                            }
                        }
                    }

                    function createCollectionFromPages(draggedPageId, targetPageId) {
                        const draggedPage = book.pages.find(p => p.id === draggedPageId);
                        const targetPage = book.pages.find(p => p.id === targetPageId);
                        if (!draggedPage || !targetPage) return;

                        // Auto-generate a unique default name
                        let defaultName = "New Collection";
                        let counter = 1;
                        const existingNames = new Set((book.collections || []).map(c => c.name.toLowerCase()));
                        while (existingNames.has(defaultName.toLowerCase())) {
                            counter++;
                            defaultName = `New Collection ${counter}`;
                        }

                        if (!book.collections) book.collections = [];

                        // Remove both pages from any existing collections
                        [draggedPageId, targetPageId].forEach(pageId => {
                            (book.collections || []).forEach(c => {
                                const index = c.pageIds.indexOf(pageId);
                                if (index > -1) {
                                    c.pageIds.splice(index, 1);
                                    log(`Removed page ${pageId} from existing collection "${c.name}"`);
                                }
                            });
                        });

                        const newCollection = {
                            id: `coll_${book.nextCollectionId++}`, name: defaultName, isStarred: false,
                            isCollapsed: false, pageIds: [draggedPageId, targetPageId],
                            tagIds: []
                        };
                        book.collections.push(newCollection);
                        saveToLocalStorage();
                        renderPageList();
                        openEditCollectionModal(newCollection.id); // Open the edit modal immediately
                    }

                    function addCollectionToChapter(collectionId, chapterId) {
                        const collection = (book.collections || []).find(c => c.id === collectionId);
                        const chapter = book.chapters.find(ch => ch.id === chapterId);

                        if (!collection || !chapter || chapter.isIndex) {
                            showTemporaryMessage("Invalid collection or chapter.", "error");
                            return;
                        }

                        let addedCount = 0;
                        collection.pageIds.forEach(pageId => {
                            if (!chapter.pageIds.includes(pageId)) {
                                chapter.pageIds.push(pageId);
                                addedCount++;
                            }
                        });

                        saveToLocalStorage();
                        showTemporaryMessage(`Added ${addedCount} new page(s) from "${collection.name}" to chapter "${chapter.name}".`, "success");
                        if (book.activeChapterId === chapterId) {
                            renderPageList();
                        }
                    }

                    function addPageToCollection(pageId, collectionId) {
                        const collection = (book.collections || []).find(c => c.id === collectionId);
                        const page = book.pages.find(p => p.id === pageId);
                        if (!collection || !page) return;

                        // Remove from any other collection first
                        (book.collections || []).forEach(c => {
                            const index = c.pageIds.indexOf(pageId);
                            if (index > -1) c.pageIds.splice(index, 1);
                        });

                        if (!collection.pageIds.includes(pageId)) {
                            collection.pageIds.push(pageId);
                            saveToLocalStorage();
                            renderPageList();
                            showTemporaryMessage(`Page "${page.title}" added to collection "${collection.name}".`, "success");
                        }
                    }

                    function removePageFromCollection(pageId, collectionId) {
                        const collection = (book.collections || []).find(c => c.id === collectionId);
                        const page = book.pages.find(p => p.id === pageId);

                        if (!collection || !page) {
                            showTemporaryMessage("Error: Page or collection not found.", "error");
                            return;
                        }

                        const pageIndex = collection.pageIds.indexOf(pageId);
                        if (pageIndex > -1) {
                            collection.pageIds.splice(pageIndex, 1);
                            saveToLocalStorage();
                            renderPageList();
                            showTemporaryMessage(`Page "${page.title}" removed from collection "${collection.name}".`, "success");
                        }
                    }

                    function removeCollectionFromChapter(collectionId, chapterId) {
                        const collection = (book.collections || []).find(c => c.id === collectionId);
                        const chapter = book.chapters.find(ch => ch.id === chapterId);
                        if (!collection || !chapter || chapter.isIndex) return;

                        chapter.pageIds = chapter.pageIds.filter(pid => !collection.pageIds.includes(pid));
                        saveToLocalStorage();
                        renderPageList();
                        showTemporaryMessage(`Collection "${collection.name}" removed from chapter "${chapter.name}".`, "success");
                    }

                    function toggleCollectionCollapse(collectionId) {
                        const collection = (book.collections || []).find(c => c.id === collectionId);
                        if (collection) {
                            collection.isCollapsed = !collection.isCollapsed;
                            saveToLocalStorage();
                            renderPageList();
                        }
                    }

                    function toggleCollectionStar(collectionId) {
                        const collection = (book.collections || []).find(c => c.id === collectionId);
                        if (collection) {
                            collection.isStarred = !collection.isStarred;
                            saveToLocalStorage();
                            renderPageList();
                            showTemporaryMessage(`Collection "${collection.name}" ${collection.isStarred ? 'starred' : 'unstarred'}.`, 'info');
                        }
                    }


                    // --- Autoplay Logic ---
                    function playAutoplayPages(chapterId) {
                        const chapter = book.chapters.find(ch => ch.id == chapterId);
                        if (!chapter || chapter.isIndex || !chapter.autoPlayPageIds || chapter.autoPlayPageIds.length === 0) {
                            log(`Autoplay: No pages or not eligible for chapter ${chapterId}`);
                            return;
                        }

                        log(`Triggering autoplay for chapter "${chapter.name}" (Time: ${currentTimeOfDay})`);
                        const pagesToPlay = chapter.autoPlayPageIds.map(id => book.pages.find(p => p.id === id)).filter(Boolean);

                        pagesToPlay.forEach((page, index) => {
                            // When autoplay is triggered by a time-of-day change, apply special rules.  We do not
                            // retrigger pages that are unrestricted (timeOfDaySetting === 'always') because these
                            // typically correspond to generic effects like door creaks.  For pages restricted to
                            // 'day' or 'night', we will only retrigger them if they have a variation that is suitable
                            // for the new time: either a variation whose timeOfDay matches the current time or an
                            // 'always' variation.  If none of these conditions are met, skip the page.
                            if (isTimeChangeAutoplay) {
                                // Only re-trigger if the page's time setting is NOT 'always'.
                                // This prevents one-shots from re-triggering on every time change.
                                if (page.timeOfDaySetting === 'always') { // Stricter check
                                    log(`Time-change autoplay skip: "${page.title}" is an 'always' page and should not retrigger on time change.`);
                                    return;
                                }
                            }

                            // Check the page's overall time restriction against the CURRENT time of day.  Only pages
                            // restricted to the current time (or unrestricted) are eligible for autoplay.
                            if (page.timeOfDaySetting === 'always' || page.timeOfDaySetting === currentTimeOfDay) {
                                const sourceToPlay = findPlayableSourceVariation(page, false);
                                if (sourceToPlay) {
                                    // Stagger playback slightly for multiple autoplay pages
                                    setTimeout(() => {
                                        log(`Autoplaying page "${page.title}" (Index ${index}) Variation: ${sourceToPlay.name || sourceToPlay.fileName}`);
                                        playSound(page, sourceToPlay, true, null, false, false);
                                    }, index * 150);
                                } else {
                                    console.warn(`Skipping autoplay for "${page.title}": No playable variations for chapter ${chapterId} / time ${currentTimeOfDay}.`);
                                    showTemporaryMessage(`Cannot autoplay "${page.title}": No variation for this chapter/time!`, 'warning');
                                }
                            } else {
                                log(`Skipping autoplay for "${page.title}" due to page time restriction (${page.timeOfDaySetting} vs ${currentTimeOfDay}).`);
                            }
                        });
                    }


                    // --- Add Page Modal Functions ---
                    function openAddPageModal() {
                        log("Opening Add Page modal.");
                        tempPageForAddModal = {
                            id: -1, // Temporary ID
                            sources: []
                        };
                        currentlyEditingPageId = -1; // Use the temp ID for context
                        clearAddForm();
                        updateAddNextPageDropdown();
                        addSyrinscapeInputContainer.classList.add('hidden');
                        document.querySelector('input[name="addSourceType"][value="file"]').checked = true;
                        addFileInputContainer.classList.remove('hidden');
                        addYoutubeInputContainer.classList.add('hidden');
                        addFadeInOutCheckbox.disabled = false;

                        // Disable YouTube search button if no keys are set
                        const hasApiKeys = book.settings.youtubeApiKeys && book.settings.youtubeApiKeys.length > 0;
                        addYoutubeSearchButton.disabled = !hasApiKeys;

                        evaluateSyrinscapeLoopControls(
                            'file', // Default source type
                            null,   // No kind initially
                            null,   // No duration initially
                            addLoopSoundCheckbox,
                            addLoopIndefinitelyCheckbox,
                            addLoopCountInput,
                            addLoopOptionsContainer,
                            addEndPlayKeywordsContainer
                        );

                        modalOverlay.style.display = 'block';
                        addPageModal.style.display = 'flex';
                        currentSyrinscapeSearchContext = 'add';
                    }

                    function openSaveFileModal() {
                        saveFileNameInput.value = 'storyteller-book';
                        saveSwitchChapters.checked = true;
                        saveSwitchCollections.checked = true;
                        saveSwitchPages.checked = true;
                        saveSwitchAppendix.checked = true;
                        saveSwitchSettings.checked = true;
                        if (document.getElementById('saveSwitchSoundtracks')) {
                            document.getElementById('saveSwitchSoundtracks').checked = true;
                        }
                        modalOverlay.style.display = 'block';
                        saveFileModal.style.display = 'flex';
                    }
                    function closeSaveFileModal() {
                        saveFileModal.style.display = 'none';
                        modalOverlay.style.display = 'none';
                    }
                    function closeAddPageModal() {
                        modalOverlay.style.display = 'none';
                        addPageModal.style.display = 'none';
                        if (activePreviewContext?.container === addPageFilePreviewContainer || activePreviewContext?.container === addPageYouTubePreviewContainer) {
                            stopModalPreview();
                        }
                        tempPageForAddModal = null;
                        currentSyrinscapeSearchContext = null;
                    }

                    // --- Edit Chapter Modal Functions ---
                    function openEditChapterModal(chapterId) {
                        const chapter = book.chapters.find(ch => ch.id === chapterId);
                        if (!chapter || chapter.isIndex) { // This check is correct
                            showTemporaryMessage("Cannot edit the Index chapter.", "info");
                            return;
                        }
                        log(`[openEditChapterModal] Opening for chapter: "${chapter.name}" (ID: ${chapterId})`);

                        editChapterIdInput.value = chapter.id;
                        editChapterNameInput.value = chapter.name;
                        editChapterKeywordsInput.value = (chapter.chapterKeywords || []).join(', ');
                        editChapterIsStarredCheckbox.checked = chapter.isStarred || false;

                        // --- DEBUG LOGS ---
                        log(`[openEditChapterModal] Chapter data from book object:`, JSON.parse(JSON.stringify(chapter)));
                        log(`[openEditChapterModal] Chapter tagIds being loaded:`, chapter.tagIds);
                        log(`[openEditChapterModal] All available tags from book.settings:`, JSON.parse(JSON.stringify(book.settings.chapterTags)));
                        // --- END DEBUG LOGS ---

                        // Autoplay Pages
                        editChapterAutoplayPagesSelect.innerHTML = '';
                        const pagesInChapter = chapter.pageIds.map(id => book.pages.find(p => p.id === id)).filter(Boolean).sort((a, b) => a.title.localeCompare(b.title));
                        if (pagesInChapter.length === 0) {
                            const option = document.createElement('option');
                            option.textContent = "No pages in this chapter";
                            option.disabled = true;
                            editChapterAutoplayPagesSelect.appendChild(option);
                        } else {
                            pagesInChapter.forEach(page => {
                                const option = document.createElement('option');
                                option.value = page.id;
                                option.textContent = page.title;
                                if (chapter.autoPlayPageIds && chapter.autoPlayPageIds.includes(page.id)) {
                                    option.selected = true;
                                }
                                editChapterAutoplayPagesSelect.appendChild(option);
                            });
                        }

                        // Tags
                        editChapterTagsContainer.innerHTML = ''; // Clear previous
                        const allTags = book.settings.chapterTags || [];
                        const chapterTags = (chapter.tagIds || []).map(id => allTags.find(t => t.id === id)).filter(Boolean);
                        activeTagInput = createTagInput(editChapterTagsContainer, chapterTags, allTags);

                        // Leave Sounds
                        editChapterLeaveSoundsSelect.innerHTML = '';
                        book.pages.sort((a, b) => a.title.localeCompare(b.title)).forEach(page => {
                            const option = document.createElement('option');
                            option.value = page.id;
                            option.textContent = page.title;
                            if (chapter.leaveSoundPageIds && chapter.leaveSoundPageIds.includes(page.id)) {
                                option.selected = true;
                            }
                            editChapterLeaveSoundsSelect.appendChild(option);
                        });

                        // Leave Transition
                        editChapterLeaveTransitionSelect.innerHTML = '';
                        book.chapters.sort((a, b) => { if (a.isIndex) return -1; if (b.isIndex) return 1; return a.name.localeCompare(b.name); }).forEach(ch => {
                            const option = document.createElement('option');
                            option.value = ch.id;
                            option.textContent = ch.name;
                            if ((chapter.leaveTransitionTargetId || 'index') == ch.id) {
                                option.selected = true;
                            }
                            editChapterLeaveTransitionSelect.appendChild(option);
                        });

                        modalOverlay.style.display = 'block';
                        editChapterModal.style.display = 'flex';
                    }
                    function closeEditChapterModal() {
                        modalOverlay.style.display = 'none';
                        editChapterModal.style.display = 'none';
                        activeTagInput = null; // Clear active tag input reference
                    }
                    function saveChapterChanges() {
                        const chapterId = editChapterIdInput.value;
                        const chapter = book.chapters.find(ch => ch.id == chapterId);
                        if (!chapter || chapter.isIndex) return;

                        const newName = editChapterNameInput.value.trim();
                        const newIsStarred = editChapterIsStarredCheckbox.checked;
                        const newChapterKeywordsRaw = editChapterKeywordsInput.value.trim();
                        const selectedAutoplayOptions = Array.from(editChapterAutoplayPagesSelect.selectedOptions);
                        const selectedLeaveSoundOptions = Array.from(editChapterLeaveSoundsSelect.selectedOptions);
                        const newLeaveSoundPageIds = selectedLeaveSoundOptions.map(opt => parseInt(opt.value, 10)).filter(id => !isNaN(id));
                        const newLeaveTransitionTargetId = editChapterLeaveTransitionSelect.value || 'index';
                        const newTags = activeTagInput ? activeTagInput.getTags() : [];
                        const newTagIds = newTags.map(t => t.id);

                        // --- DEBUG LOGS ---
                        log(`[saveChapterChanges] Saving tags for chapter ${chapterId}:`, { tags: newTags, tagIds: newTagIds });
                        // --- END DEBUG LOGS ---


                        if (!newName) { showTemporaryMessage("Chapter name cannot be empty.", "error"); return; }
                        if (book.chapters.some(ch => ch.id != chapterId && ch.name.toLowerCase() === newName.toLowerCase())) {
                            showTemporaryMessage(`Another chapter named "${newName}" exists.`, "error");
                            return;
                        }

                        const newAutoplayPageIds = selectedAutoplayOptions.map(opt => parseInt(opt.value, 10)).filter(id => !isNaN(id));
                        const newChapterKeywords = newChapterKeywordsRaw === '' ? [] : newChapterKeywordsRaw.toLowerCase().split(',').map(k => k.trim()).filter(Boolean);

                        chapter.name = newName;
                        chapter.isStarred = newIsStarred;
                        chapter.chapterKeywords = newChapterKeywords;
                        chapter.tagIds = newTagIds;
                        chapter.autoPlayPageIds = newAutoplayPageIds;
                        chapter.leaveSoundPageIds = newLeaveSoundPageIds;
                        chapter.leaveTransitionTargetId = newLeaveTransitionTargetId;

                        log(`Chapter ${chapterId} updated:`, chapter);
                        updateChapterKeywordList();
                        saveToLocalStorage();
                        renderChapterTabs();
                        renderPageList();
                        if (storyPlotterModal.style.display === 'flex') {
                            renderPlotBoard();
                        }
                        closeEditChapterModal();
                        showTemporaryMessage(`Chapter "${newName}" updated successfully.`, "success");
                    }

                    function renameCollection(collectionId) {
                        openEditCollectionModal(collectionId);
                    }

                    function deleteCollection(collectionId) {
                        if (!confirm("Are you sure you want to delete this collection? The pages inside will become uncollected.")) return;
                        book.collections = (book.collections || []).filter(c => c.id !== collectionId);
                        saveToLocalStorage();
                        renderPageList();
                    }

                    function openEditCollectionModal(collectionId) {
                        const collection = (book.collections || []).find(c => c.id === collectionId);
                        if (!collection) return;
                        log(`Opening edit modal for collection: "${collection.name}" (ID: ${collectionId})`);

                        editCollectionIdInput.value = collection.id;
                        editCollectionNameInput.value = collection.name;

                        // Populate tags
                        editCollectionTagsSelect.innerHTML = '';
                        const allTags = (book.settings.chapterTags || []).sort((a, b) => a.name.localeCompare(b.name));
                        if (allTags.length === 0) {
                            editCollectionTagsSelect.innerHTML = '<option disabled>No tags exist in the book.</option>';
                        } else {
                            allTags.forEach(tag => {
                                const option = document.createElement('option');
                                option.value = tag.id;
                                option.textContent = tag.name;
                                if ((collection.tagIds || []).includes(tag.id)) option.selected = true;
                                editCollectionTagsSelect.appendChild(option);
                            });
                        }
                        modalOverlay.style.display = 'block';
                        editCollectionModal.style.display = 'flex';
                    }

                    function closeEditCollectionModal() {
                        modalOverlay.style.display = 'none';
                        editCollectionModal.style.display = 'none';
                    }

                    function saveCollectionChanges() {
                        const collectionId = editCollectionIdInput.value;
                        const collectionIndex = (book.collections || []).findIndex(c => c.id === collectionId);
                        if (collectionIndex === -1) {
                            showTemporaryMessage("Error: Collection not found to save changes.", "error");
                            return;
                        }

                        const newName = editCollectionNameInput.value.trim();
                        if (!newName) { showTemporaryMessage("Collection name cannot be empty.", "error"); return; }
                        if ((book.collections || []).some((c, index) => index !== collectionIndex && c.name.toLowerCase() === newName.toLowerCase())) {
                            showTemporaryMessage(`Another collection named "${newName}" already exists.`, "error"); return;
                        }

                        book.collections[collectionIndex].name = newName;
                        book.collections[collectionIndex].tagIds = Array.from(editCollectionTagsSelect.selectedOptions).map(opt => opt.value);

                        saveToLocalStorage();
                        renderPageList();
                        closeEditCollectionModal(); // This call is now valid
                        showTemporaryMessage(`Collection "${newName}" updated.`, 'success');
                    }

                    function createTagInput(container, initialTags = [], allAvailableTags = []) {
                        container.innerHTML = `
                    <div class="tag-input-container">
                        <input type="text" class="tag-input-field" placeholder="Add a tag...">
                    </div>
                    <div class="tag-suggestions"></div>
                `;

                        const tagInputContainer = container.querySelector('.tag-input-container');
                        const inputField = container.querySelector('.tag-input-field');
                        const suggestionsContainer = container.querySelector('.tag-suggestions');
                        let currentTags = [...initialTags];
                        let allTags = [...allAvailableTags];

                        const renderTags = () => {
                            // Remove all existing tag pills
                            tagInputContainer.querySelectorAll('.tag-pill').forEach(pill => pill.remove());
                            // Render current tags
                            currentTags.forEach(tag => {
                                const pill = document.createElement('span');
                                pill.className = 'tag-pill';
                                pill.textContent = tag.name;
                                const removeBtn = document.createElement('button');
                                removeBtn.className = 'tag-pill-remove';
                                removeBtn.innerHTML = '&times;';
                                removeBtn.title = `Remove ${tag.name}`;
                                removeBtn.onclick = () => removeTag(tag.id);
                                pill.appendChild(removeBtn);
                                tagInputContainer.insertBefore(pill, inputField);
                            });
                        };

                        const addTag = (tag) => {
                            if (tag && !currentTags.some(t => t.id === tag.id)) {
                                currentTags.push(tag);
                                renderTags();
                            }
                        };

                        const removeTag = (tagId) => {
                            currentTags = currentTags.filter(t => t.id !== tagId);
                            renderTags();
                        };

                        const showSuggestions = (query) => {
                            suggestionsContainer.innerHTML = '';
                            if (!query) {
                                suggestionsContainer.style.display = 'none';
                                return;
                            }

                            const filtered = allTags.filter(tag =>
                                tag.name.toLowerCase().includes(query.toLowerCase()) &&
                                !currentTags.some(ct => ct.id === tag.id)
                            );

                            // Check if the exact query exists as a tag already
                            const exactMatchExists = allTags.some(tag => tag.name.toLowerCase() === query.toLowerCase());

                            if (!exactMatchExists) {
                                const newItem = document.createElement('div');
                                newItem.className = 'tag-suggestion-item';
                                newItem.innerHTML = `Create new tag: <span class="suggestion-match">${query}</span>`;
                                newItem.onclick = () => {
                                    const newTag = { id: `tag_${book.nextTagId++}`, name: query };
                                    allTags.push(newTag); // Add to master list for this session
                                    book.settings.chapterTags.push(newTag); // Add to global book settings
                                    addTag(newTag);
                                    inputField.value = '';
                                    showSuggestions('');
                                };
                                suggestionsContainer.appendChild(newItem);
                            }

                            filtered.forEach(tag => {
                                const item = document.createElement('div');
                                item.className = 'tag-suggestion-item';
                                item.textContent = tag.name;
                                item.onclick = () => {
                                    addTag(tag);
                                    inputField.value = '';
                                    showSuggestions('');
                                };
                                suggestionsContainer.appendChild(item);
                            });

                            suggestionsContainer.style.display = filtered.length > 0 || !exactMatchExists ? 'block' : 'none';
                        };

                        inputField.addEventListener('input', () => showSuggestions(inputField.value));
                        inputField.addEventListener('focus', () => showSuggestions(inputField.value));
                        inputField.addEventListener('keydown', (e) => {
                            if (e.key === 'Enter' && inputField.value.trim() !== '') {
                                e.preventDefault();
                                const query = inputField.value.trim();
                                const existingTag = allTags.find(t => t.name.toLowerCase() === query.toLowerCase());
                                if (existingTag) {
                                    addTag(existingTag);
                                } else {
                                    const newTag = { id: `tag_${book.nextTagId++}`, name: query };
                                    allTags.push(newTag);
                                    book.settings.chapterTags.push(newTag);
                                    addTag(newTag);
                                }
                                inputField.value = '';
                                showSuggestions('');
                            }
                        });

                        document.addEventListener('click', (e) => {
                            if (!container.contains(e.target)) {
                                suggestionsContainer.style.display = 'none';
                            }
                        });

                        renderTags();

                        return { getTags: () => currentTags };
                    }

                    // --- Edit Page Modal Functions ---
                    function openEditPageModal(pageId, forAddPage = false) {
                        const page = book.pages.find(p => p.id === pageId);
                        if (!page) { console.error(`Page ID ${pageId} not found.`); return; }
                        log(`DEBUG: Opening edit modal for page:`, JSON.parse(JSON.stringify(page)));
                        const modal = forAddPage ? addPageModal : editPageModal;
                        log(`Opening edit modal for page: "${page.title}" (ID: ${pageId})`);
                        currentlyEditingPageId = pageId;

                        editPageIdInput.value = page.id;
                        editPageTitleInput.value = page.title;
                        editPrimaryKeyInput.value = page.primaryKey || "";
                        editIsStarredCheckbox.checked = page.isStarred || false;
                        editKeywordsInput.value = (page.keywords || []).join(', ');
                        editPhrasesInput.value = (page.phrases || []).join('\n');
                        editEndPlayKeywordsInput.value = (page.endPlayKeywords || []).join(', ');
                        editVolumeInput.value = page.volume;
                        editVolumeValueSpan.textContent = page.volume;
                        editFadeInOutCheckbox.checked = page.fadeInOut;
                        editFadeInOutCheckbox.disabled = !page.sources.every(s => s.type === 'file'); // Disable if any non-file source

                        // Set the initial state of the loop checkboxes directly from page data
                        editLoopSoundCheckbox.checked = page.loop;
                        editLoopIndefinitelyCheckbox.checked = page.loop && page.loopCount === -1;

                        // Determine the primary Syrinscape kind and duration from the first Syrinscape source if any
                        const firstSyrinscapeSource = page.sources.find(s => s.type === 'syrinscape');
                        const syrinscapeKindForLoopEval = firstSyrinscapeSource ? firstSyrinscapeSource.syrinscapeKind : null;
                        const syrinscapeDurationForLoopEval = firstSyrinscapeSource ? firstSyrinscapeSource.syrinscapePlayDuration : null;
                        const effectiveSourceTypeForLoopEval = firstSyrinscapeSource ? 'syrinscape' : (page.sources[0]?.type || 'file');

                        evaluateSyrinscapeLoopControls(
                            effectiveSourceTypeForLoopEval,
                            syrinscapeKindForLoopEval,
                            syrinscapeDurationForLoopEval,
                            editLoopSoundCheckbox,
                            editLoopIndefinitelyCheckbox,
                            editLoopCountInput,
                            editLoopOptionsContainer,
                            editEndPlayKeywordsContainer,
                            page.loop // Pass the page's current loop state
                        );
                        // After evaluateSyrinscapeLoopControls, ensure loop count is correctly displayed if not indefinite
                        if (page.loop && page.loopCount !== -1 && editLoopCountInput) {
                            editLoopCountInput.value = page.loopCount > 0 ? page.loopCount : 1;
                        } else if (editLoopCountInput) {
                            editLoopCountInput.value = ''; // Clear if indefinite or not looping
                        }


                        populateNextPageDropdown(editNextPageIdSelect, page.id);
                        editNextPageIdSelect.value = page.nextPageId ?? "";

                        const timeSetting = page.timeOfDaySetting || 'always';
                        document.querySelector(`input[name="editTimeOfDaySetting"][value="${timeSetting}"]`).checked = true;

                        renderVariationList(page, forAddPage);

                        modalOverlay.style.display = 'block';
                        editPageModal.style.display = 'flex';
                    }

                    function renderVariationList(page) {
                        log(`DEBUG: Rendering variation list for page "${page.title}". Page.sources data:`, JSON.parse(JSON.stringify(page.sources)));
                        const listUl = (page.id === -1) ? addSourceListUl : editSourceListUl;
                        listUl.innerHTML = '';
                        if (!page.sources || page.sources.length === 0) {
                            listUl.innerHTML = '<li class="italic text-sm text-center py-2">No sources found. Add one!</li>';
                            return;
                        }
                        page.sources.forEach((source, index) => {
                            const li = document.createElement('li');
                            li.dataset.sourceIndex = index;

                            const variation = source; // For clarity, as we are refactoring
                            const displayName = variation.name || `Variation ${index + 1}`;
                            const truncatedName = displayName.length > 25 ? displayName.substring(0, 22) + '...' : displayName;
                            log(`DEBUG: Variation #${index} ("${displayName}") has sub-sources:`, variation.sources);
                            const subSourceCount = variation.sources?.length || 0;
                            const missingIndicator = subSourceCount === 0 ? '<span class="missing-file-indicator ml-2">(No Sources)</span>' : '';
                            const defaultIndicator = source.isDefault ? `<i class="fas fa-star source-default-indicator" title="Default Variation"></i>` : '';

                            const volumeIndicator = typeof source.volumeOverride === 'number' ? `<span class="text-xs text-gray-400 ml-2">(Vol: ${source.volumeOverride})</span>` : '';

                            const conditionCount = variation.conditions?.length || 0;
                            const conditionIndicator = conditionCount > 0 ? `<span class="text-xs text-gray-400 ml-2" title="${conditionCount} condition(s) set"><i class="fas fa-check-double"></i></span>` : '';

                            li.innerHTML = `
                        <div class="source-details">
                            ${defaultIndicator}
                            <span class="source-name" title="${displayName}">${truncatedName}</span>
                            <span class="text-xs text-gray-400 ml-2">(${subSourceCount} source${subSourceCount !== 1 ? 's' : ''})</span>
                            ${volumeIndicator}
                            ${conditionIndicator}
                            ${missingIndicator}
                        </div>
                        <div class="source-buttons">
                            <button class="btn-rpg-sm-icon manage-sources-button" title="Manage Sources"> <i class="fas fa-list-ul"></i> </button>
                            <button class="btn-rpg-sm-icon edit-source-button" title="Edit Variation Settings"> <i class="fas fa-pencil-alt"></i> </button>
                            <button class="btn-rpg-sm-icon btn-danger-sm remove-source-button" title="Remove Variation"> <i class="fas fa-times"></i> </button>
                        </div>`;

                            li.querySelector('.edit-source-button').addEventListener('click', (e) => {
                                e.stopPropagation();
                                openVariationSettingsModal(page.id, index, page.id === -1);
                            });
                            li.querySelector('.manage-sources-button').addEventListener('click', (e) => {
                                e.stopPropagation();
                                openManageSourcesModal(page.id, index, false, page.id === -1);
                            });
                            li.querySelector('.remove-source-button').addEventListener('click', handleRemoveSourceClick);
                            listUl.appendChild(li);
                        });
                    }

                    function closeEditModal() {
                        modalOverlay.style.display = 'none';
                        editPageModal.style.display = 'none';
                        if (activePreviewContext) {
                            stopModalPreview();
                        }
                        currentlyEditingPageId = null;
                    }

                    function handleRemoveSourceClick(event) {
                        const button = event.currentTarget;
                        const listItem = button.closest('li');
                        if (listItem) {
                            listItem.classList.toggle('removed');
                            const editButton = listItem.querySelector('.edit-source-button');
                            if (editButton) editButton.disabled = listItem.classList.contains('removed');
                        }
                    }

                    function saveEditChanges() {
                        const pageId = parseInt(editPageIdInput.value, 10);
                        const page = book.pages.find(p => p.id === pageId);
                        if (!page) return;

                        log(`Saving changes for page: "${page.title}" (ID: ${pageId})`);
                        const newTitle = editPageTitleInput.value.trim();
                        const newPrimaryKeyRaw = editPrimaryKeyInput.value.trim();
                        const newPrimaryKey = newPrimaryKeyRaw ? newPrimaryKeyRaw.toLowerCase() : null;
                        const newKeywordsRaw = editKeywordsInput.value.trim();
                        const newPhrasesRaw = editPhrasesInput.value.trim();
                        const newEndPlayKeywordsRaw = editEndPlayKeywordsInput.value.trim();
                        const newIsStarred = editIsStarredCheckbox.checked;
                        const newVolume = parseInt(editVolumeInput.value, 10);
                        const newLoop = editLoopSoundCheckbox.checked;

                        // Determine loop settings based on current UI state, which should be accurate
                        // due to evaluateSyrinscapeLoopControls being called on modal open and control changes.
                        let finalLoop = newLoop;
                        const newLoopIndefinitely = editLoopIndefinitelyCheckbox.checked;
                        const newLoopCountValue = parseInt(editLoopCountInput.value, 10);
                        let finalLoopCount = newLoop ? (newLoopIndefinitely ? -1 : (isNaN(newLoopCountValue) || newLoopCountValue < 1 ? 0 : newLoopCountValue)) : 0;


                        const newFadeInOut = !editFadeInOutCheckbox.disabled && editFadeInOutCheckbox.checked;
                        const newNextPageId = editNextPageIdSelect.value ? parseInt(editNextPageIdSelect.value, 10) : null;
                        const newTimeOfDaySetting = document.querySelector('input[name="editTimeOfDaySetting"]:checked')?.value || 'always';

                        if (!newTitle) { showTemporaryMessage('Page Title cannot be empty.', 'error'); return; }
                        if (finalLoop && finalLoopCount === 0 && !newLoopIndefinitely && !page.sources.some(s => s.type === 'syrinscape' && s.syrinscapePlayDuration)) {
                            showTemporaryMessage('Invalid Loop Count specified.', 'error'); return;
                        }
                        const duplicateTitle = book.pages.some(p => p.id !== pageId && p.title.toLowerCase() === newTitle.toLowerCase());
                        if (duplicateTitle) { showTemporaryMessage(`Another page named "${newTitle}" exists.`, 'error', 5000); return; }

                        page.title = newTitle;
                        page.primaryKey = newPrimaryKey;
                        page.phrases = newPhrasesRaw === '' ? [] : newPhrasesRaw.split('\n').map(p => p.trim().toLowerCase()).filter(Boolean);
                        page.isStarred = newIsStarred;
                        page.volume = newVolume;
                        page.loop = finalLoop;
                        page.loopCount = finalLoopCount;
                        page.fadeInOut = newFadeInOut;
                        page.endPlayKeywords = finalLoop ? (newEndPlayKeywordsRaw === '' ? [] : newEndPlayKeywordsRaw.toLowerCase().split(',').map(k => k.trim()).filter(Boolean)) : [];
                        page.nextPageId = newNextPageId;
                        page.timeOfDaySetting = newTimeOfDaySetting;

                        const finalSources = [];
                        const sourceListItems = editSourceListUl.querySelectorAll('li');
                        sourceListItems.forEach(li => {
                            if (li.classList.contains('removed')) return;
                            const sourceIndex = parseInt(li.dataset.sourceIndex, 10);
                            if (!isNaN(sourceIndex) && page.sources[sourceIndex]) {
                                finalSources.push(page.sources[sourceIndex]);
                            }
                        });

                        if (finalSources.length === 0) {
                            if (!confirm(`This will remove all sound sources for "${page.title}", effectively deleting the page. Continue?`)) {
                                return;
                            }
                            closeEditModal();
                            deletePageFromBook(page.id);
                            showTemporaryMessage(`Page "${page.title}" deleted as all sources were removed.`, 'info');
                            return;
                        }
                        page.sources = finalSources;
                        page.fadeInOut = page.fadeInOut && !page.sources.some(s => s.type !== 'file');

                        // // Ensure there is always one default variation - REMOVED to allow for no default
                        // if (page.sources.length > 0 && !page.sources.some(s => s.isDefault)) {
                        //     page.sources[0].isDefault = true;
                        //     showTemporaryMessage("No default variation was set. The first variation has been marked as default.", "info", 4000);
                        // }
                        if (editFadeInOutCheckbox) editFadeInOutCheckbox.disabled = page.sources.some(s => s.type !== 'file');


                        log("Page updated:", page);
                        updateFuseIndex();
                        saveToLocalStorage();
                        renderPageList();
                        closeEditModal();
                        showTemporaryMessage(`Page "${page.title}" updated.`, 'success');
                    }


                    // --- Add/Edit Source Variation Modal Functions ---
                    function openVariationSettingsModal(pageId, sourceIndex = null, forAddPage = false) {
                        const page = forAddPage ? tempPageForAddModal : book.pages.find(p => p.id === pageId);
                        if (!page) { console.error("Cannot open variation modal: Page not found."); return; }
                        currentlyEditingPageId = pageId;
                        const chapters = book.chapters.filter(ch => !ch.isIndex).sort((a, b) => a.name.localeCompare(b.name)); // This logic seems to be for a different feature and can be removed if not used.
                        if (chapters.length > 0) {
                            chapters.forEach(ch => {
                                const label = document.createElement('label');
                                const checkbox = document.createElement('input');
                                checkbox.type = 'checkbox';
                                checkbox.value = ch.id;
                                checkbox.id = `var-chapter-${ch.id}`;
                                checkbox.name = 'sourceVariationChapters';
                                label.htmlFor = checkbox.id;
                                label.appendChild(checkbox);
                                label.appendChild(document.createTextNode(` ${ch.name}`));
                            });
                        }

                        editingSourceVariationIndexInput.value = sourceIndex !== null ? sourceIndex : '';
                        sourceVariationNameInput.value = '';
                        sourceVariationVolumeInput.value = 80;
                        sourceVariationKeywordsInput.value = '';
                        sourceVariationVolumeValueSpan.textContent = '80';
                        if (sourceVariationEnableVolumeOverrideCheckbox) {
                            sourceVariationEnableVolumeOverrideCheckbox.checked = false;
                        }
                        if (sourceVariationVolumeContainer) sourceVariationVolumeContainer.classList.add('hidden');



                        sourceVariationIsDefaultCheckbox.checked = page.sources.length === 0; // Default if it's the first one

                        if (sourceIndex !== null && page.sources[sourceIndex]) {
                            const source = page.sources[sourceIndex];
                            sourceVariationModalTitle.textContent = 'Edit Variation Settings';
                            // --- DEBUG LOG ---
                            log(`%c[DEBUG] openVariationSettingsModal: Loading conditions for variation "${source.name || `index ${sourceIndex}`}"`, 'color: cyan', JSON.parse(JSON.stringify(source.conditions || [])));
                            // --- END DEBUG LOG ---

                            const hasVolumeOverride = typeof source.volumeOverride === 'number' && source.volumeOverride !== null;
                            if (sourceVariationEnableVolumeOverrideCheckbox) {
                                sourceVariationEnableVolumeOverrideCheckbox.checked = hasVolumeOverride;
                            }
                            if (sourceVariationVolumeContainer) sourceVariationVolumeContainer.classList.toggle('hidden', !hasVolumeOverride);

                            sourceVariationNameInput.value = source.name || '';
                            // Set slider to override value if it exists, otherwise default to 80
                            sourceVariationVolumeInput.value = hasVolumeOverride ? source.volumeOverride : 80;
                            sourceVariationKeywordsInput.value = (source.variationKeywords || []).join(', ');
                            sourceVariationVolumeValueSpan.textContent = sourceVariationVolumeInput.value;
                            sourceVariationIsDefaultCheckbox.checked = source.isDefault || false;

                            initializeConditionBuilder(
                                'sourceVariationPageConditionsList',      // pageListContainerId
                                'sourceVariationOtherConditions',         // otherConditionsContainerId
                                'sourceVariationTagConditionsList',       // tagListContainerId
                                source.conditions || [],                  // conditions
                                'sourceVariationPageConditionSearchInput',// pageSearchInputId
                                'sourceVariationTagConditionSearchInput'  // tagSearchInputId
                            );
                        } else {
                            sourceVariationModalTitle.textContent = 'Add Source Variation';
                            initializeConditionBuilder(
                                'sourceVariationPageConditionsList',      // pageListContainerId
                                'sourceVariationOtherConditions',         // otherConditionsContainerId
                                'sourceVariationTagConditionsList',       // tagListContainerId
                                [],                                       // conditions (empty for new)
                                'sourceVariationPageConditionSearchInput',// pageSearchInputId
                                'sourceVariationTagConditionSearchInput'  // tagSearchInputId
                            );
                        }
                        currentSyrinscapeSearchContext = 'variation';
                        variationSettingsModal.style.display = 'flex';
                    }

                    function closeVariationSettingsModal() {
                        if (variationSettingsModal) variationSettingsModal.style.display = 'none';
                        currentSyrinscapeSearchContext = null;
                    }

                    // --- Manage Sources (Sub-Variations) Modal Functions ---
                    function openManageSourcesModal(pageId, variationIndex, autoOpenAdd = false, forAddPage = false) {
                        const page = (pageId === -1 || forAddPage) ? tempPageForAddModal : book.pages.find(p => p.id === pageId);
                        if (!page) { console.error("Cannot open manage sources: Page not found."); return; }
                        const variation = page.sources[variationIndex];
                        if (!variation) { console.error("Cannot open manage sources: Variation not found."); return; }

                        currentlyEditingPageId = pageId;
                        managingSourcesVariationIndexInput.value = variationIndex;

                        const variationName = variation.name || `Variation ${variationIndex + 1}`;
                        manageSourcesModalTitle.textContent = `Manage Sources for "${variationName}"`;

                        renderSubVariationList(variation);

                        modalOverlay.style.display = 'block';
                        manageSourcesModal.style.display = 'flex';

                        if (autoOpenAdd) {
                            // Use a timeout to ensure the manage sources modal is fully rendered before opening the next one
                            setTimeout(() => openAddEditSourceModal(), 50);
                        }
                    }

                    function closeManageSourcesModal() {
                        if (manageSourcesModal) manageSourcesModal.style.display = 'none';
                        // Re-render the main variation list to update source counts
                        const page = book.pages.find(p => p.id === currentlyEditingPageId) || tempPageForAddModal;
                        if (page) renderVariationList(page);
                    }

                    function renderSubVariationList(variation) {
                        subVariationSourceListUl.innerHTML = '';
                        if (!variation.sources || variation.sources.length === 0) {
                            subVariationSourceListUl.innerHTML = '<li class="italic text-sm text-center py-2">No sources found. Add one!</li>';
                            return;
                        }

                        variation.sources.forEach((source, index) => {
                            const li = document.createElement('li');
                            li.className = 'page-item !cursor-default !py-2 !px-3';
                            const typeIconClass = source.type === 'file' ? 'fas fa-file-audio text-blue-500'
                                : (source.type === 'youtube' ? 'fab fa-youtube text-red-500'
                                    : (source.type === 'syrinscape' ? 'fas fa-headphones-alt text-syrinscape-500'
                                        : 'fas fa-question-circle text-gray-400')); const displayName = source.videoTitle || source.fileName || (source.type === 'youtube' ? `YT: ${source.source}` : `Syrin: ${source.syrinscapeElementId}`);
                            const truncatedName = displayName.length > 40 ? displayName.substring(0, 37) + '...' : displayName;
                            const durationIndicator = (source.type === 'syrinscape' && source.syrinscapePlayDuration) ? `<span class="text-xs text-gray-400 ml-2">(Dur: ${source.syrinscapePlayDuration}s)</span>` : '';

                            li.innerHTML = `
                        <div class="flex justify-between items-center">
                            <div class="flex-grow min-w-0 flex items-center">
                                <i class="${typeIconClass} fa-fw mr-3"></i>
                                <span class="text-sm truncate" title="${displayName}">${truncatedName}</span>
                                ${durationIndicator}
                            </div>
                            <div class="flex-shrink-0 ml-4 space-x-2">
                                <button class="btn-rpg-sm-icon edit-sub-variation-button" data-index="${index}" title="Edit Source"><i class="fas fa-pencil-alt"></i></button>
                                <button class="btn-rpg-sm-icon btn-danger-sm remove-sub-variation-button" data-index="${index}" title="Remove Source"><i class="fas fa-times"></i></button>
                            </div>
                        </div>
                    `;

                            li.querySelector('.remove-sub-variation-button').addEventListener('click', (e) => {
                                const sourceIndexToRemove = parseInt(e.currentTarget.dataset.index, 10);
                                variation.sources.splice(sourceIndexToRemove, 1);
                                renderSubVariationList(variation); // Re-render the list
                                showTemporaryMessage('Source removed. Save page changes to confirm.', 'info');
                            });
                             li.querySelector('.edit-sub-variation-button').addEventListener('click', (e) => {
                                 const sourceIndexToEdit = parseInt(e.currentTarget.dataset.index, 10);
                                 openAddEditSourceModal(sourceIndexToEdit, currentlyEditingPageId === -1);
                             });

                            subVariationSourceListUl.appendChild(li);
                        });
                    }

                    // --- Add/Edit Source (Sub-Variation) Modal Functions ---
                    function openAddEditSourceModal(sourceIndex = null, forAddPage = false) {
                        const isEditing = sourceIndex !== null;
                        sourceModalTitle.textContent = isEditing ? 'Edit Source' : 'Add Source';
                        editingSourceIndexInput.value = isEditing ? sourceIndex : '';

                        // Reset form
                        document.querySelector('input[name="sourceType"][value="file"]').checked = true;
                        sourceFileInputContainer.classList.remove('hidden');
                        sourceYoutubeInputContainer.classList.add('hidden');
                        sourceSyrinscapeInputContainer.classList.add('hidden');

                        sourceFileInput.value = '';
                        existingSourceFileSpan.textContent = '';
                        sourceYoutubeUrlInput.value = '';
                        sourceStartTimeInput.value = '';
                        sourceEndTimeInput.value = '';
                        sourceSyrinscapeSearchInput.value = '';
                        sourceSyrinscapeElementIdInput.value = '';
                        sourceSyrinscapeKindInput.value = '';
                        sourceSyrinscapeSelectedSoundSpan.textContent = 'No Syrinscape sound selected.';
                        sourceSyrinscapePlayDurationInput.value = '';

                        // Hide previewers on open
                        sourceFilePreviewContainer.classList.add('hidden');
                        sourceYouTubePreviewContainer.classList.add('hidden');

                        if (isEditing) {
                            const page = forAddPage ? tempPageForAddModal : book.pages.find(p => p.id === currentlyEditingPageId);
                            const variationIndex = parseInt(managingSourcesVariationIndexInput.value, 10);
                            const source = page?.sources[variationIndex]?.sources[sourceIndex];
                            if (!source) {
                                showTemporaryMessage("Error: Could not find source to edit.", "error");
                                return;
                            }

                            document.querySelector(`input[name="sourceType"][value="${source.type}"]`).checked = true;
                            // Manually trigger the change event to update UI visibility
                            document.querySelector(`input[name="sourceType"][value="${source.type}"]`).dispatchEvent(new Event('change'));

                            if (source.type === 'file') {
                                existingSourceFileSpan.textContent = `Current: ${source.fileName}`;
                                // No preview for existing file as we don't store the File object
                            } else if (source.type === 'youtube') {
                                sourceYoutubeUrlInput.value = source.fileName || '';
                                sourceStartTimeInput.value = source.startTime !== null ? formatTimeForInput(source.startTime) : '';
                                sourceEndTimeInput.value = source.endTime !== null ? formatTimeForInput(source.endTime) : '';

                                if (source.fileName) {
                                    // Stop any existing preview and clear the context *before* setting up the new one.
                                    // This ensures the onYtPreviewPlayerReady callback doesn't use stale context.
                                    if (activePreviewContext) {
                                        stopModalPreview();
                                    }
                                    setupYouTubePreview(
                                        source.fileName,
                                        sourceYouTubePreviewContainer,
                                        false, // Don't autoplay
                                        source.startTime,
                                        source.endTime
                                    );
                                }
                            } else if (source.type === 'syrinscape') {
                                sourceSyrinscapeElementIdInput.value = source.syrinscapeElementId || '';
                                sourceSyrinscapeKindInput.value = source.syrinscapeKind || '';
                                sourceSyrinscapeSelectedSoundSpan.textContent = source.fileName || 'No Syrinscape sound selected.';
                                sourceSyrinscapeSelectedSoundSpan.dataset.syrinscapeName = source.fileName || '';
                                sourceSyrinscapeSelectedSoundSpan.dataset.syrinscapeKind = source.syrinscapeKind || '';
                                sourceSyrinscapeSearchInput.value = source.fileName || '';
                                sourceSyrinscapePlayDurationInput.value = source.syrinscapePlayDuration || '';
                            }
                        }

                        currentSyrinscapeSearchContext = 'sub-variation';
                        addEditSourceModal.style.display = 'flex';
                        manageSourcesModal.style.zIndex = '1005'; // Hide behind
                    }

                    function closeAddEditSourceModal() {
                        if (addEditSourceModal) addEditSourceModal.style.display = 'none';
                        if (manageSourcesModal) manageSourcesModal.style.zIndex = '1010'; // Restore
                        currentSyrinscapeSearchContext = null;
                        if (activePreviewContext?.container === sourceFilePreviewContainer || activePreviewContext?.container === sourceYouTubePreviewContainer) {
                            stopModalPreview();
                        }
                    }

                    async function saveSourceChanges() {
                        const pageId = currentlyEditingPageId;
                        const variationIndex = parseInt(managingSourcesVariationIndexInput.value, 10);
                        const sourceIndexStr = editingSourceIndexInput.value;
                        const isEditing = sourceIndexStr !== '';
                        const sourceIndex = isEditing ? parseInt(sourceIndexStr, 10) : null;
                        const page = (pageId === -1) ? tempPageForAddModal : book.pages.find(p => p.id === pageId);
                        if (!page || isNaN(variationIndex) || !page.sources || !page.sources[variationIndex]) {
                            showTemporaryMessage("Error: Could not find variation to save source to.", "error");
                            return;
                        }
                        const variation = page.sources[variationIndex];

                        const sourceType = document.querySelector('input[name="sourceType"]:checked')?.value;
                        const syrinscapePlayDurationRaw = sourceSyrinscapePlayDurationInput.value.trim();
                        const syrinscapePlayDuration = (sourceType === 'syrinscape' && syrinscapePlayDurationRaw) ? parseInt(syrinscapePlayDurationRaw, 10) : null;

                        let newSourceDetail = {
                            type: sourceType, source: null, fileName: null,
                            syrinscapeElementId: null, syrinscapeKind: null, syrinscapePlayDuration: syrinscapePlayDuration, videoTitle: null,
                            startTime: null, endTime: null, needsFile: false,
                        };

                        if (sourceType === 'syrinscape' && syrinscapePlayDurationRaw && (isNaN(syrinscapePlayDuration) || syrinscapePlayDuration < 1)) {
                            showTemporaryMessage('Invalid Syrinscape Play Duration. Must be a positive number.', 'error'); return;
                        }

                        saveSourceButton.disabled = true;
                        saveSourceButton.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Saving...';

                        try {
                            if (sourceType === 'file') {
                                const file = sourceFileInput.files[0];
                                if (!file && isEditing && variation.sources[sourceIndex]?.type === 'file') {
                                    // Keep existing file data if not changed
                                    const oldSource = variation.sources[sourceIndex];
                                    newSourceDetail.fileName = oldSource.fileName;
                                    newSourceDetail.source = oldSource.source;
                                    newSourceDetail.needsFile = oldSource.needsFile;
                                } else if (file) {
                                    newSourceDetail.fileName = file.name;
                                    const arrayBuffer = await file.arrayBuffer();
                                    const bytesForStore = arrayBuffer.slice(0); // decodeAudioData detaches arrayBuffer
                                    if (!initAudioContext()) throw new Error("Audio system not ready.");
                                    newSourceDetail.source = await audioContext.decodeAudioData(arrayBuffer);
                                    newSourceDetail.needsFile = false;
                                    await persistAudioSource(newSourceDetail, file, bytesForStore); // B3
                                } else {
                                    throw new Error('Please select a sound file.');
                                }
                            } else if (sourceType === 'youtube') {
                                if (!youtubeApiReady) { await new Promise(resolve => setTimeout(resolve, 500)); if (!youtubeApiReady) throw new Error('YouTube API not ready.'); }
                                const url = sourceYoutubeUrlInput.value.trim();
                                if (!url) throw new Error('Please enter a YouTube URL.');
                                const videoTitle = await getYouTubeVideoTitle(extractYouTubeVideoId(url));
                                const videoId = extractYouTubeVideoId(url);
                                if (!videoId) throw new Error('Invalid YouTube URL.');
                                newSourceDetail.source = videoId;
                                newSourceDetail.fileName = url;
                                const startTimeRaw = sourceStartTimeInput.value.trim();
                                const endTimeRaw = sourceEndTimeInput.value.trim();
                                newSourceDetail.startTime = startTimeRaw ? parseTimeHms(startTimeRaw) : null;
                                newSourceDetail.endTime = endTimeRaw ? parseTimeHms(endTimeRaw) : null;
                                if (startTimeRaw && newSourceDetail.startTime === null) throw new Error('Invalid Start Time.');
                                if (endTimeRaw && newSourceDetail.endTime === null) throw new Error('Invalid End Time.');
                                if (newSourceDetail.startTime !== null && newSourceDetail.endTime !== null && newSourceDetail.endTime <= newSourceDetail.startTime) {
                                    throw new Error('End Time must be after Start Time.');
                                }
                                newSourceDetail.videoTitle = videoTitle;
                            } else if (sourceType === 'syrinscape') {
                                if (!syrinscapePlayerReady && !syrinscapeAuthToken) { showTemporaryMessage('Syrinscape player not active.', 'warning', 5000); }
                                else if (!syrinscapeAuthToken) { throw new Error('Syrinscape Auth Token not set.'); }
                                const elementId = sourceSyrinscapeElementIdInput.value;
                                const selectedName = sourceSyrinscapeSelectedSoundSpan.dataset.syrinscapeName;
                                const selectedKind = sourceSyrinscapeKindInput.value;
                                if (!elementId || !selectedName || !selectedKind) throw new Error('No Syrinscape sound selected.');
                                newSourceDetail.syrinscapeElementId = elementId;
                                newSourceDetail.syrinscapeKind = selectedKind;
                                newSourceDetail.fileName = selectedName;
                            }

                            if (isEditing) {
                                // Merge new details with old, preserving properties not in newSourceDetail
                                variation.sources[sourceIndex] = { ...variation.sources[sourceIndex], ...newSourceDetail };
                                log(`Sub-variation source at index ${sourceIndex} updated.`);
                            } else {
                                variation.sources.push(newSourceDetail);
                                log("New sub-variation source added.");
                            }

                            renderSubVariationList(variation);
                            closeAddEditSourceModal();
                            showTemporaryMessage(`Source ${isEditing ? 'updated' : 'added'}. Save page changes to confirm.`, 'success', 4000);

                        } catch (error) {
                            console.error("Error saving source:", error);
                            showTemporaryMessage(`Error: ${error.message}`, 'error', 5000);
                        } finally {
                            saveSourceButton.disabled = false;
                            saveSourceButton.innerHTML = 'Save Source';
                        }
                    }

                    async function saveSourceVariationChanges() {
                        const pageId = currentlyEditingPageId; // Can be -1 for the temp page
                        const page = book.pages.find(p => p.id === pageId);
                        if (!page) { showTemporaryMessage("Error: Page not found.", "error"); closeAddEditSourceVariationModal(); return; }

                        const sourceIndexStr = editingSourceVariationIndexInput.value;
                        const isEditing = sourceIndexStr !== '';
                        const sourceIndex = isEditing ? parseInt(sourceIndexStr, 10) : null;
                        let isDefault = sourceVariationIsDefaultCheckbox.checked;

                        // LOG: Log the state of the 'isDefault' checkbox when saving
                        log(`LOG (saveSourceVariationChanges): 'isDefault' checkbox is checked: ${isDefault}`);

                        const sourceType = document.querySelector('input[name="sourceVariationSourceType"]:checked')?.value;
                        const name = sourceVariationNameInput.value.trim() || null;

                        const enableOverride = sourceVariationEnableVolumeOverrideCheckbox.checked;
                        const volumeValue = parseInt(sourceVariationVolumeInput.value, 10);
                        const volumeOverride = (enableOverride && !isNaN(volumeValue)) ? volumeValue : null;
                        const variationKeywords = sourceVariationKeywordsInput.value.trim().toLowerCase().split(',').map(k => k.trim()).filter(Boolean);

                        const conditions = getConditionsFromBuilder('sourceVariationPageConditionsList', 'sourceVariationOtherConditions', 'sourceVariationTagConditionsList');
                        // --- DEBUG LOG ---
                        log(`%c[DEBUG] saveSourceVariationChanges: Conditions retrieved from builder:`, 'color: lightgreen', JSON.parse(JSON.stringify(conditions)));
                        // --- END DEBUG LOG ---

                        // If this variation is being set as default, unset the old default
                        if (isDefault) {
                            page.sources.forEach((s, idx) => {
                                // LOG: Log which other variations are being unset as default
                                if (s.isDefault && (!isEditing || idx !== sourceIndex)) {
                                    log(`LOG (saveSourceVariationChanges): Unsetting 'isDefault' on variation index ${idx}.`);
                                }
                                if (!isEditing || idx !== sourceIndex) {
                                    s.isDefault = false;
                                }
                            });
                        } else if (!isDefault && isEditing && page.sources[sourceIndex].isDefault) {
                            // If we are unchecking the default, we need to ensure another one becomes default
                            isDefault = false; // Explicitly set to false for this variation
                            // LOG: Log that the current default is being unchecked
                            log(`LOG (saveSourceVariationChanges): The current default variation (index ${sourceIndex}) is being unchecked.`);
                        }

                        try {
                            let newVariationData = {
                                id: isEditing ? page.sources[sourceIndex].id : `var_${generateUUID()}`,
                                // Preserve existing sources array when editing
                                sources: isEditing ? page.sources[sourceIndex].sources : [],
                                // New properties being set/updated
                                name: name,
                                volumeOverride: volumeOverride,
                                isDefault: isDefault,
                                variationKeywords: variationKeywords,
                                conditions: conditions.length > 0 ? conditions : null,
                                sources: isEditing ? page.sources[sourceIndex].sources : [] // Keep existing sources if editing
                            };
                            // --- DEBUG LOG ---
                            log(`%c[DEBUG] saveSourceVariationChanges: Final variation data object being saved:`, 'color: lightgreen', JSON.parse(JSON.stringify(newVariationData)));
                            // --- END DEBUG LOG ---

                            if (isEditing && sourceIndex !== null && page.sources[sourceIndex]) {
                                page.sources[sourceIndex] = { ...page.sources[sourceIndex], ...newVariationData };
                                log(`Source variation at index ${sourceIndex} updated.`);
                            } else {
                                page.sources.push(newVariationData);
                                log("New source variation added.");
                            }

                            // After all changes, if no variation is default and the user didn't just uncheck the last one, make the first one default.
                            // if (page.sources.length > 0 && !page.sources.some(s => s.isDefault)) {
                            //     page.sources[0].isDefault = true;
                            //     // LOG: Log that a new default has been automatically assigned
                            //     log(`LOG (saveSourceVariationChanges): No default variation found after changes. Automatically setting variation index 0 as default.`);
                            //     showTemporaryMessage("No default variation was set. The first variation has been marked as default.", "info", 4000);
                            // }

                            // After saving, if it was a NEW variation, open the 'Add Source' modal automatically.
                            if (!isEditing) {
                                const newVariationIndex = page.sources.length - 1;
                                openManageSourcesModal(page.id, newVariationIndex, true, page.id === -1); // Pass true to auto-open the add source modal
                            }

                            page.fadeInOut = page.fadeInOut && !page.sources.some(s => s.type !== 'file');
                            if (editFadeInOutCheckbox) editFadeInOutCheckbox.disabled = page.sources.some(s => s.type !== 'file');

                        } catch (error) {
                            console.error("Error saving source variation:", error);
                            showTemporaryMessage(`Error: ${error.message}`, 'error', 5000);
                        } finally {
                            saveSourceVariationButton.disabled = false;
                            saveSourceVariationButton.innerHTML = 'Save Variation Settings';
                        }

                        renderVariationList(page, page.id === -1);
                        closeVariationSettingsModal();
                        showTemporaryMessage(`Source variation ${isEditing ? 'updated' : 'added'}. Save page changes to confirm.`, 'success', 4000);
                    }


                    function formatTimeForInput(totalSeconds) {
                        if (totalSeconds === null || totalSeconds === undefined) return '';
                        const minutes = Math.floor(totalSeconds / 60);
                        const seconds = Math.floor(totalSeconds % 60);
                        return `${minutes}:${seconds.toString().padStart(2, '0')}`;
                    }

                    // --- Helper function to manage loop control UI based on Syrinscape type/duration ---
                    function evaluateSyrinscapeLoopControls(sourceType, syrinscapeKind, syrinscapeDurationValue, loopCb, indefCb, countIn, loopOptionsDiv, endKeywordsDiv, currentLoopCheckboxState = null) {
                        const isSyrinscape = sourceType === 'syrinscape';
                        const isLoopableSyrinscapeType = isSyrinscape && (syrinscapeKind?.toLowerCase().includes('mood') || syrinscapeKind?.toLowerCase().includes('music'));

                        let durationIsEffectivelySet = false;
                        if (syrinscapeDurationValue !== null && syrinscapeDurationValue !== undefined) {
                            if (typeof syrinscapeDurationValue === 'string') {
                                const trimmedDuration = syrinscapeDurationValue.trim();
                                if (trimmedDuration !== '') {
                                    const parsedNum = parseInt(trimmedDuration, 10);
                                    durationIsEffectivelySet = !isNaN(parsedNum) && parsedNum > 0;
                                }
                            } else if (typeof syrinscapeDurationValue === 'number') {
                                durationIsEffectivelySet = syrinscapeDurationValue > 0;
                            }
                        }

                        const loopCheckboxIsCurrentlyChecked = (currentLoopCheckboxState !== null) ? currentLoopCheckboxState : loopCb.checked;

                        if (isSyrinscape && isLoopableSyrinscapeType && !durationIsEffectivelySet) {
                            // Auto-loop for moods/music if no duration
                            loopCb.checked = true;
                            loopCb.disabled = true;
                            indefCb.checked = true;
                            indefCb.disabled = true;
                            if (countIn) { countIn.value = ''; countIn.disabled = true; }
                            loopOptionsDiv.classList.remove('hidden');
                            endKeywordsDiv.classList.remove('hidden');
                        } else { // Covers: Not Syrinscape OR (Syrinscape BUT NOT (mood/music without duration that would force loop))
                            // This means all file/YT, and Syrinscape one-shots, or Syrinscape moods/music WITH a duration.
                            // In these cases, loop controls are user-configurable.
                            loopCb.disabled = false;
                            const showOptions = loopCheckboxIsCurrentlyChecked;

                            indefCb.disabled = !showOptions;
                            if (countIn) {
                                countIn.disabled = !showOptions || indefCb.checked;
                            }

                            if (showOptions) {
                                loopOptionsDiv.classList.remove('hidden');
                                endKeywordsDiv.classList.remove('hidden');
                                if (indefCb.checked && countIn) {
                                    countIn.value = ''; // Clear count if indefinite
                                } else if (countIn && (countIn.value === '' || parseInt(countIn.value, 10) < 1)) {
                                    // If not indefinite and loop is on, ensure count is at least 1
                                    // If countIn.value was empty due to indefinite, and indefinite is unchecked, default to 1
                                    // If countIn.value is already a valid number, keep it.
                                    if (countIn.value === '' || parseInt(countIn.value, 10) < 1) countIn.value = 1;
                                }
                            } else {
                                loopOptionsDiv.classList.add('hidden');
                                endKeywordsDiv.classList.add('hidden');
                                if (countIn) countIn.value = 1; // Reset count to 1 if master loop is off
                                indefCb.checked = false;    // Uncheck if master loop is off
                            }
                        }
                    }


                    // --- Edit Page Modal & Sub-Modal Event Listeners ---
                    editVolumeInput.addEventListener('input', () => { editVolumeValueSpan.textContent = editVolumeInput.value; });
                    editLoopSoundCheckbox.addEventListener('change', (event) => {
                        // Stop any active preview when changing loop settings
                        if (activePreviewContext) {
                            stopModalPreview();
                        }
                        const page = book.pages.find(p => p.id == currentlyEditingPageId);
                        const firstSyrinscapeSource = page?.sources.find(s => s.type === 'syrinscape');
                        const syrinscapeKindForLoopEval = firstSyrinscapeSource ? firstSyrinscapeSource.syrinscapeKind : null;
                        const syrinscapeDurationForLoopEval = firstSyrinscapeSource?.sources[0] ? firstSyrinscapeSource.sources[0].syrinscapePlayDuration : null;
                        const effectiveSourceTypeForLoopEval = firstSyrinscapeSource ? 'syrinscape' : (page?.sources[0]?.type || 'file');

                        evaluateSyrinscapeLoopControls(
                            effectiveSourceTypeForLoopEval,
                            syrinscapeKindForLoopEval,
                            syrinscapeDurationForLoopEval,
                            editLoopSoundCheckbox,
                            editLoopIndefinitelyCheckbox,
                            editLoopCountInput,
                            editLoopOptionsContainer,
                            editEndPlayKeywordsContainer,
                            event.target.checked // Pass current state of loop checkbox
                        );
                        if (!event.target.checked) {
                            editEndPlayKeywordsInput.value = '';
                        }
                    });

                    editLoopIndefinitelyCheckbox.addEventListener('change', (event) => {
                        // Stop any active preview when changing loop settings
                        if (activePreviewContext) {
                            stopModalPreview();
                        }
                        const page = book.pages.find(p => p.id == currentlyEditingPageId);
                        const firstSyrinscapeSource = page?.sources.find(s => s.type === 'syrinscape');
                        const syrinscapeKindForLoopEval = firstSyrinscapeSource ? firstSyrinscapeSource.syrinscapeKind : null;
                        const syrinscapeDurationForLoopEval = firstSyrinscapeSource?.sources[0] ? firstSyrinscapeSource.sources[0].syrinscapePlayDuration : null;
                        const effectiveSourceTypeForLoopEval = firstSyrinscapeSource ? 'syrinscape' : (page?.sources[0]?.type || 'file');

                        evaluateSyrinscapeLoopControls(
                            effectiveSourceTypeForLoopEval,
                            syrinscapeKindForLoopEval,
                            syrinscapeDurationForLoopEval,
                            editLoopSoundCheckbox,
                            editLoopIndefinitelyCheckbox,
                            editLoopCountInput,
                            editLoopOptionsContainer,
                            editEndPlayKeywordsContainer
                        );
                    });


                    if (editLoopCountInput) {
                        editLoopCountInput.addEventListener('input', () => {
                            if (!editLoopCountInput.disabled && parseInt(editLoopCountInput.value) < 1) editLoopCountInput.value = 1;
                        });
                    }

                    cancelEditButton.addEventListener('click', closeEditModal);
                    modalOverlay.addEventListener('click', (e) => { // Close any open modal on overlay click
                        if (e.target === modalOverlay) {
                            closeEditModal(); closeEditChapterModal(); closeAddPageModal();
                            closeSettingsModal(); closeGuidebookModal(); closeVariationSettingsModal();
                            if (activePreviewContext) {
                                stopModalPreview();
                            }
                            closeStoryPlotterModal(); closeSyrinscapeSearchModal(); closeAppendixModal(); closeAddEditAppendixEntryModal(); closeAppendixEffectModal(); // closePlotThreadMenu is called inside closeStoryPlotterModal
                            closeManageSourcesModal(); closeAddEditSourceModal();
                        }
                    });
                    saveEditButton.addEventListener('click', saveEditChanges);
                    openAddSourceVariationModalButton.addEventListener('click', () => {
                        openVariationSettingsModal(currentlyEditingPageId, null); // Pass current page ID, null for new
                    });


                    // --- Variation Settings Modal Listeners ---
                    cancelSourceVariationButton.addEventListener('click', closeVariationSettingsModal);
                    saveSourceVariationButton.addEventListener('click', saveSourceVariationChanges);

                    sourceVariationVolumeInput.addEventListener('input', () => { sourceVariationVolumeValueSpan.textContent = sourceVariationVolumeInput.value; });
                    if (sourceVariationEnableVolumeOverrideCheckbox) {
                        sourceVariationEnableVolumeOverrideCheckbox.addEventListener('change', (e) => {
                            if (sourceVariationVolumeContainer) sourceVariationVolumeContainer.classList.toggle('hidden', !e.target.checked);
                        });
                    }

                    // --- Manage Sources & Add/Edit Source Modal Listeners ---
                    closeManageSourcesModalButton.addEventListener('click', closeManageSourcesModal);
                    openAddSourceModalButton.addEventListener('click', () => openAddEditSourceModal());
                    // New previewer listeners for the source modal
                    document.getElementById('sourceFile').addEventListener('change', (e) => setupFilePreview(e.target.files[0], sourceFilePreviewContainer));
                    document.getElementById('sourceYoutubeUrl').addEventListener('input', (e) => setupYouTubePreview(e.target.value, sourceYouTubePreviewContainer));

                    sourceSyrinscapeSearchButton.addEventListener('click', () => openSyrinscapeSearchModal('sub-variation'));

                    document.querySelectorAll('input[name="sourceType"]').forEach(radio => {
                        radio.addEventListener('change', (event) => {
                            const selectedType = event.target.value;
                            sourceFileInputContainer.classList.toggle('hidden', selectedType !== 'file');
                            sourceYoutubeInputContainer.classList.toggle('hidden', selectedType !== 'youtube');
                            sourceSyrinscapeInputContainer.classList.toggle('hidden', selectedType !== 'syrinscape');
                            // Hide previewers on type change
                            if (sourceFilePreviewContainer) sourceFilePreviewContainer.classList.add('hidden');
                            if (sourceYouTubePreviewContainer) sourceYouTubePreviewContainer.classList.add('hidden');
                        });
                    });

                    cancelSourceButton.addEventListener('click', closeAddEditSourceModal);
                    saveSourceButton.addEventListener('click', saveSourceChanges);
                    sourceYoutubeUrlInput.addEventListener('input', () => checkYouTubeEmbeddability(sourceYoutubeUrlInput, document.getElementById('sourceYoutubeUrlStatus')));


                    // --- Import / Export Chapter Functions ---
                    // --- Import / Export Chapter Functions ---
                    /** Imports a chapter from a selected JSON file. */
                    function importChapter(event) {
                        if (!event.target.files.length) return;
                        log("Import chapter triggered.");
                        const file = event.target.files[0];
                        if (!file) return;

                        const reader = new FileReader();
                        reader.onload = (e) => {
                            try {
                                const loadedData = JSON.parse(e.target.result);
                                if (!loadedData || typeof loadedData !== 'object' || !loadedData.chapter || !Array.isArray(loadedData.pages)) {
                                    throw new Error("Invalid chapter file format.");
                                }
                                const importedChapterData = loadedData.chapter;
                                const importedPagesData = loadedData.pages;
                                if (typeof importedChapterData.name !== 'string' || importedChapterData.name.trim() === '') {
                                    throw new Error("Imported chapter missing name.");
                                }

                                let finalChapterName = importedChapterData.name.trim();
                                // Handle name conflicts
                                while (book.chapters.some(ch => ch.name.toLowerCase() === finalChapterName.toLowerCase())) {
                                    const newName = prompt(`Chapter "${finalChapterName}" exists. New name or Cancel:`, `${finalChapterName} (Imported)`);
                                    if (newName === null) throw new Error("Import cancelled by user (chapter name conflict).");
                                    if (newName.trim() === '') showTemporaryMessage("Chapter name cannot be empty.", "error"); // Stay in loop
                                    else finalChapterName = newName.trim();
                                }

                                const pagesToAdd = [];
                                const idMap = {}; // Maps original imported page ID to new/existing page ID in the book
                                const existingPagesLinkedTitles = [];

                                for (const importedPage of importedPagesData) {
                                    let pageToAdd = { ...importedPage }; // Clone
                                    let originalId = pageToAdd.id;
                                    let finalPageId = null;

                                    const existingPageWithTitle = book.pages.find(p => p.title.toLowerCase() === pageToAdd.title.toLowerCase());
                                    if (existingPageWithTitle) {
                                        finalPageId = existingPageWithTitle.id;
                                        const userChoice = confirm(`Page "${pageToAdd.title}" already exists. Overwrite it with the imported version? Click 'Cancel' to keep both (renaming the imported one).`);
                                        if (userChoice) { // Overwrite
                                            const pageIndex = book.pages.findIndex(p => p.id === finalPageId);
                                            if (pageIndex > -1) {
                                                pageToAdd.id = finalPageId; // Keep the ID
                                                book.pages[pageIndex] = pageToAdd;
                                            }
                                        } else { // Keep both, rename imported
                                            let counter = 2;
                                            let newTitle = `${pageToAdd.title} (Imported)`;
                                            while (book.pages.some(p => p.title.toLowerCase() === newTitle.toLowerCase())) {
                                                newTitle = `${pageToAdd.title} (Imported ${counter++})`;
                                            }
                                            pageToAdd.title = newTitle;
                                            finalPageId = book.nextPageId++;
                                            pageToAdd.id = finalPageId;
                                            pagesToAdd.push(pageToAdd);
                                        }
                                        idMap[originalId] = finalPageId; // Map original ID to the final ID used
                                    } else {
                                        const existingPageWithId = book.pages.find(p => p.id === originalId);
                                        if (existingPageWithId || originalId === undefined || originalId === null || idMap[originalId] !== undefined || typeof originalId !== 'number') {
                                            finalPageId = book.nextPageId++;
                                        } else {
                                            finalPageId = originalId;
                                            if (originalId >= book.nextPageId) book.nextPageId = originalId + 1;
                                        }
                                        pageToAdd.id = finalPageId;
                                        idMap[originalId] = finalPageId;

                                        pageToAdd.primaryKey = pageToAdd.primaryKey || null;
                                        pageToAdd.sources = (pageToAdd.sources || []).map(s => ({
                                            name: s.name || null,
                                            type: ['file', 'youtube', 'syrinscape'].includes(s.type) ? s.type : 'file',
                                            fileName: s.fileName || null,
                                            source: s.type === 'youtube' ? (s.source || extractYouTubeVideoId(s.fileName || '')) : null,
                                            syrinscapeElementId: s.type === 'syrinscape' ? s.syrinscapeElementId : null,
                                            syrinscapeKind: s.type === 'syrinscape' ? (s.syrinscapeKind || 'Element') : null,
                                            syrinscapePlayDuration: s.type === 'syrinscape' ? (s.syrinscapePlayDuration === undefined ? null : s.syrinscapePlayDuration) : null,
                                            startTime: s.startTime !== undefined ? s.startTime : null,
                                            videoTitle: s.videoTitle || null,
                                            endTime: s.endTime !== undefined ? s.endTime : null,
                                            needsFile: s.type === 'file', // Files always need relink on import
                                            volumeOverride: typeof s.volumeOverride === 'number' ? s.volumeOverride : null,
                                            chapterIds: Array.isArray(s.chapterIds) ? s.chapterIds : (s.chapterId ? [s.chapterId] : null), // Support old chapterId
                                            timeOfDay: ['day', 'night', 'always'].includes(s.timeOfDay) ? s.timeOfDay : 'always',
                                            conditions: s.conditions || null
                                        }));
                                        pageToAdd.keywords = pageToAdd.keywords || [];
                                        pageToAdd.phrases = pageToAdd.phrases || [];
                                        pageToAdd.isStarred = pageToAdd.isStarred || false;
                                        pageToAdd.timeOfDaySetting = ['day', 'night', 'always'].includes(pageToAdd.timeOfDaySetting) ? pageToAdd.timeOfDaySetting : 'always';
                                        pagesToAdd.push(pageToAdd);
                                    }
                                }
                                book.pages.push(...pagesToAdd);

                                // Update nextPageId for chained pages within the imported chapter
                                pagesToAdd.forEach(page => {
                                    if (page.nextPageId !== null && idMap[page.nextPageId] !== undefined) {
                                        page.nextPageId = idMap[page.nextPageId];
                                    } else if (page.nextPageId !== null && !book.pages.some(p => p.id === page.nextPageId) && !pagesToAdd.some(np => np.id === page.nextPageId)) {
                                        // If the original nextPageId doesn't map to a new ID and doesn't exist elsewhere, clear it
                                        page.nextPageId = null;
                                    }
                                });

                                const newChapterId = `ch_${book.nextChapterId++}`;
                                const finalNewChapter = {
                                    id: newChapterId, name: finalChapterName, isIndex: false,
                                    isStarred: importedChapterData.isStarred || false,
                                    pageIds: (importedChapterData.pageIds || []).map(originalId => idMap[originalId]).filter(finalId => finalId !== undefined),
                                    chapterKeywords: importedChapterData.chapterKeywords || importedChapterData.transitionWords || [], // Support old transitionWords
                                    tagIds: importedChapterData.tagIds || [],
                                    autoPlayPageIds: (importedChapterData.autoPlayPageIds || []).map(originalId => idMap[originalId]).filter(finalId => finalId !== undefined),
                                    leaveSoundPageIds: (importedChapterData.leaveSoundPageIds || []).map(originalId => idMap[originalId]).filter(finalId => finalId !== undefined),
                                    leaveTransitionTargetId: importedChapterData.leaveTransitionTargetId || 'index'
                                };
                                book.chapters.push(finalNewChapter);


                                updateFuseIndex();
                                updateChapterKeywordList();
                                saveToLocalStorage();
                                setActiveChapter(newChapterId, false, 'import_chapter'); // Context: import chapter

                                let successMsg = `Chapter "${finalChapterName}" imported. Added ${pagesToAdd.length} new pages.`;
                                if (existingPagesLinkedTitles.length > 0) {
                                    successMsg += ` Linked ${existingPagesLinkedTitles.length} existing pages: ${existingPagesLinkedTitles.slice(0, 3).join(', ')}${existingPagesLinkedTitles.length > 3 ? '...' : ''}.`;
                                }
                                showTemporaryMessage(successMsg, "success", 7000);

                            } catch (error) {
                                console.error("Error importing chapter:", error);
                                showTemporaryMessage(`Import failed: ${error.message}`, 'error', 6000);
                            } finally {
                                event.target.value = ''; // Clear file input
                            }
                        };
                        reader.onerror = () => {
                            showTemporaryMessage("Error reading chapter file.", "error");
                            event.target.value = ''; // Clear file input
                        };
                        reader.readAsText(file);
                    }

                    /** Exports the currently active (non-Index) chapter and its pages to a JSON file. */
                    function exportChapterById(chapterId) {
                        const chapterToExport = book.chapters.find(ch => ch.id == chapterId); // Use chapterId
                        if (!chapterToExport || chapterToExport.isIndex) {
                            showTemporaryMessage("Cannot export the Index chapter.", "error");
                            return;
                        }
                        log(`Exporting chapter: "${chapterToExport.name}" (ID: ${chapterToExport.id})`);
                        try {
                            const pagesInData = chapterToExport.pageIds // Use chapterToExport
                                .map(pageId => book.pages.find(p => p.id === pageId))
                                .filter(Boolean) // Filter out undefined if a pageId was invalid
                                .map(page => { // Create a savable version of each page
                                    const savableSources = (page.sources || []).map(s => ({
                                        name: s.name || null, type: s.type, fileName: s.fileName,
                                        syrinscapeElementId: s.syrinscapeElementId || null,
                                        syrinscapeKind: s.syrinscapeKind || null,
                                        syrinscapePlayDuration: s.syrinscapePlayDuration === undefined ? null : s.syrinscapePlayDuration,
                                        startTime: s.startTime, endTime: s.endTime,
                                        source: s.type === 'youtube' ? s.source : null, // Don't save AudioBuffer
                                        variationKeywords: s.variationKeywords || [],
                                        isDefault: s.isDefault || false,
                                        variationKeywords: s.variationKeywords || [],
                                        needsFile: s.type === 'file', // Mark files as needing relink on import
                                        volumeOverride: s.volumeOverride || null,
                                        chapterIds: s.chapterIds || null, // Corrected from s.chapterId
                                        timeOfDay: s.timeOfDay || 'always',
                                        conditions: s.conditions || null
                                    }));
                                    return {
                                        id: page.id, title: page.title || "", primaryKey: page.primaryKey || null,
                                        keywords: page.keywords || [], phrases: page.phrases || [], isStarred: page.isStarred || false,
                                        volume: page.volume ?? 80, loop: page.loop || false, loopCount: page.loopCount ?? 0,
                                        fadeInOut: page.fadeInOut || false, endPlayKeywords: page.endPlayKeywords || [],
                                        nextPageId: page.nextPageId ?? null, timeOfDaySetting: page.timeOfDaySetting || 'always',
                                        sources: savableSources
                                    };
                                });

                            const exportData = {
                                chapter: { // Chapter metadata
                                    originalId: chapterToExport.id, name: chapterToExport.name, isIndex: false,
                                    isStarred: chapterToExport.isStarred || false,
                                    pageIds: pagesInData.map(p => p.id), // Store original IDs for re-linking within chapter
                                    chapterKeywords: chapterToExport.chapterKeywords || [],
                                    autoPlayPageIds: chapterToExport.autoPlayPageIds || [],
                                    leaveSoundPageIds: chapterToExport.leaveSoundPageIds || [],
                                    leaveTransitionTargetId: chapterToExport.leaveTransitionTargetId || 'index',
                                    tagIds: chapterToExport.tagIds || []
                                },
                                tags: (book.settings.chapterTags || []).filter(tag => (chapterToExport.tagIds || []).includes(tag.id)),
                                pages: pagesInData // The actual page data
                            };

                            const jsonString = JSON.stringify(exportData, null, 2);
                            const blob = new Blob([jsonString], { type: 'application/json;charset=utf-8' });
                            const url = URL.createObjectURL(blob);
                            const a = document.createElement('a');
                            const safeChapterName = chapterToExport.name.replace(/[^a-z0-9]/gi, '_').toLowerCase();
                            a.download = `chapter-${safeChapterName}.json`;
                            a.href = url;
                            document.body.appendChild(a);
                            a.click();
                            document.body.removeChild(a);
                            URL.revokeObjectURL(url);
                            showTemporaryMessage(`Chapter "${chapterToExport.name}" exported!`, 'success');
                        } catch (error) {
                            console.error("Error exporting chapter:", error);
                            showTemporaryMessage("Failed to export chapter.", "error");
                        }
                    }

                    function exportSingleCollection(collectionId) {
                        const collectionToExport = (book.collections || []).find(c => c.id === collectionId);
                        if (!collectionToExport) {
                            showTemporaryMessage("Cannot export: Collection not found.", "error");
                            return;
                        }
                        log(`Exporting collection: "${collectionToExport.name}" (ID: ${collectionToExport.id})`);
                        try {
                            const pagesInData = collectionToExport.pageIds
                                .map(pageId => book.pages.find(p => p.id === pageId))
                                .filter(Boolean)
                                .map(page => {
                                    const savableSources = (page.sources || []).map(variation => ({
                                        ...variation, // Copy all variation properties
                                        sources: (variation.sources || []).map(subSource => ({
                                            ...subSource,
                                            source: subSource.type === 'youtube' ? subSource.source : null, // Don't save AudioBuffer
                                            needsFile: subSource.type === 'file'
                                        }))
                                    }));
                                    return {
                                        ...page, // Copy all page properties
                                        sources: savableSources
                                    };
                                });

                            const exportData = {
                                collections: [{
                                    name: collectionToExport.name,
                                    isStarred: collectionToExport.isStarred || false,
                                    isCollapsed: collectionToExport.isCollapsed,
                                    pageIds: collectionToExport.pageIds,
                                    tagIds: collectionToExport.tagIds || []
                                }],
                                pages: pagesInData
                            };

                            const jsonString = JSON.stringify(exportData, null, 2);
                            const blob = new Blob([jsonString], { type: 'application/json;charset=utf-8' });
                            const url = URL.createObjectURL(blob);
                            const a = document.createElement('a');
                            const safeCollName = collectionToExport.name.replace(/[^a-z0-9]/gi, '_').toLowerCase();
                            a.download = `collection-${safeCollName}.json`;
                            a.href = url;
                            document.body.appendChild(a);
                            a.click();
                            document.body.removeChild(a);
                            URL.revokeObjectURL(url);
                            showTemporaryMessage(`Collection "${collectionToExport.name}" exported!`, 'success');
                        } catch (error) {
                            console.error("Error exporting collection:", error);
                            showTemporaryMessage("Failed to export collection.", "error");
                        }
                    }

                    function importCollections(event) {
                        if (!event.target.files.length) return;
                        const file = event.target.files[0];
                        if (!file) return;

                        const reader = new FileReader();
                        reader.onload = (e) => {
                            try {
                                const loadedData = JSON.parse(e.target.result);
                                if (!loadedData || !Array.isArray(loadedData.collections) || !Array.isArray(loadedData.pages)) {
                                    throw new Error("Invalid collection file format.");
                                }

                                const idMap = {}; // Maps original imported page ID to new/existing page ID
                                const pagesToAdd = [];
                                let linkedPageCount = 0;

                                // First, process and map the pages
                                loadedData.pages.forEach(importedPage => {
                                    const originalId = importedPage.id;
                                    const existingPageWithTitle = book.pages.find(p => p.title.toLowerCase() === (importedPage.title || '').toLowerCase());

                                    if (existingPageWithTitle) {
                                        idMap[originalId] = existingPageWithTitle.id;
                                        linkedPageCount++;
                                    } else {
                                        const existingPageWithId = book.pages.find(p => p.id === originalId);
                                        const finalPageId = (existingPageWithId || originalId === undefined || typeof originalId !== 'number') ? book.nextPageId++ : originalId;
                                        if (originalId >= book.nextPageId) book.nextPageId = originalId + 1;

                                        idMap[originalId] = finalPageId;
                                        importedPage.id = finalPageId;
                                        importedPage.sources = (importedPage.sources || []).map(s => ({
                                            ...s,
                                            needsFile: s.type === 'file',
                                            source: s.type === 'youtube' ? (s.source || extractYouTubeVideoId(s.fileName || '')) : null
                                        }));
                                        pagesToAdd.push(importedPage);
                                    }
                                });

                                // Update nextPageId references within the newly added pages
                                pagesToAdd.forEach(page => {
                                    if (page.nextPageId !== null && idMap[page.nextPageId] !== undefined) {
                                        page.nextPageId = idMap[page.nextPageId];
                                    } else {
                                        page.nextPageId = null; // Clear broken links
                                    }
                                });

                                book.pages.push(...pagesToAdd);

                                // Now, process the collections
                                let addedCollCount = 0;
                                let overwrittenCollCount = 0;
                                loadedData.collections.forEach(importedColl => {
                                    const finalPageIds = (importedColl.pageIds || []).map(id => idMap[id]).filter(id => id !== undefined);
                                    const existingColl = (book.collections || []).find(c => c.name.toLowerCase() === importedColl.name.toLowerCase());

                                    if (existingColl) {
                                        const choice = prompt(`Collection "${importedColl.name}" already exists. Type 'overwrite' to replace it, or 'merge' to add new pages to it. Any other input will skip.`, 'merge');
                                        if (choice?.toLowerCase() === 'overwrite') {
                                            existingColl.pageIds = finalPageIds;
                                            existingColl.isStarred = importedColl.isStarred || false;
                                            existingColl.isCollapsed = importedColl.isCollapsed || false;
                                            existingColl.tagIds = importedColl.tagIds || [];
                                            overwrittenCollCount++;
                                        } else if (choice?.toLowerCase() === 'merge') {
                                            const newPages = finalPageIds.filter(id => !existingColl.pageIds.includes(id));
                                            existingColl.pageIds.push(...newPages);
                                            // Don't overwrite star/collapse status on merge
                                            overwrittenCollCount++; // Count as a modification
                                        }
                                    } else {
                                        const newCollection = { id: `coll_${book.nextCollectionId++}`, name: importedColl.name, isStarred: importedColl.isStarred || false, isCollapsed: importedColl.isCollapsed || false, pageIds: finalPageIds, tagIds: importedColl.tagIds || [] };
                                        if (!book.collections) book.collections = [];
                                        book.collections.push(newCollection);
                                        addedCollCount++;
                                    }
                                });

                                updateFuseIndex();
                                saveToLocalStorage();
                                renderPageList();
                                showTemporaryMessage(`Import complete: ${pagesToAdd.length} pages added, ${linkedPageCount} linked. ${addedCollCount} collections added, ${overwrittenCollCount} overwritten.`, 'success', 7000);
                            } catch (error) {
                                showTemporaryMessage(`Collection import failed: ${error.message}`, 'error');
                            } finally {
                                event.target.value = '';
                            }
                        };
                        reader.readAsText(file);
                    }

                    function exportCollections() {
                        if (!book.collections || book.collections.length === 0) {
                            showTemporaryMessage("No collections to export.", "info");
                            return;
                        }
                        log("Exporting collections...");
                        try {
                            const allPageIdsInCollections = new Set();
                            (book.collections || []).forEach(c => {
                                c.pageIds.forEach(id => allPageIdsInCollections.add(id));
                            });

                            const pagesToExport = Array.from(allPageIdsInCollections)
                                .map(pageId => book.pages.find(p => p.id === pageId))
                                .filter(Boolean) // Filter out undefined if a pageId was invalid
                                .map(page => { // Create a savable version of each page
                                    const savableSources = (page.sources || []).map(s => ({
                                        name: s.name || null, type: s.type, fileName: s.fileName,
                                        syrinscapeElementId: s.syrinscapeElementId || null,
                                        syrinscapeKind: s.syrinscapeKind || null,
                                        syrinscapePlayDuration: s.syrinscapePlayDuration === undefined ? null : s.syrinscapePlayDuration,
                                        startTime: s.startTime, endTime: s.endTime,
                                        videoTitle: s.videoTitle || null,
                                        source: s.type === 'youtube' ? s.source : null, // Don't save AudioBuffer
                                        needsFile: s.type === 'file', // Mark files as needing relink on import
                                        volumeOverride: s.volumeOverride || null,
                                        chapterIds: s.chapterIds || null,
                                        timeOfDay: s.timeOfDay || 'always',
                                        conditions: s.conditions || null
                                    }));
                                    return {
                                        id: page.id, title: page.title || "", primaryKey: page.primaryKey || null,
                                        keywords: page.keywords || [], phrases: page.phrases || [], isStarred: page.isStarred || false,
                                        volume: page.volume ?? 80, loop: page.loop || false, loopCount: page.loopCount ?? 0,
                                        fadeInOut: page.fadeInOut || false, endPlayKeywords: page.endPlayKeywords || [],
                                        nextPageId: page.nextPageId ?? null, timeOfDaySetting: page.timeOfDaySetting || 'always',
                                        sources: savableSources
                                    };
                                });

                            const exportData = {
                                collections: book.collections.map(c => ({
                                    name: c.name, isStarred: c.isStarred, isCollapsed: c.isCollapsed, pageIds: c.pageIds
                                })),
                                pages: pagesToExport
                            };
                            const jsonString = JSON.stringify(exportData, null, 2);
                            const blob = new Blob([jsonString], { type: 'application/json;charset=utf-8' });
                            const url = URL.createObjectURL(blob);
                            const a = document.createElement('a');
                            a.href = url;
                            a.download = 'storyteller-collections.story';
                            document.body.appendChild(a);
                            a.click();
                            document.body.removeChild(a);
                            URL.revokeObjectURL(url);
                            showTemporaryMessage("Collections exported!", "success");
                        } catch (error) {
                            console.error("Error exporting collections:", error);
                            showTemporaryMessage("Failed to export collections.", "error");
                        }
                    }

                    function importCollections(event) {
                        if (!event.target.files.length) return;
                        const file = event.target.files[0];
                        if (!file) return;

                        const reader = new FileReader();
                        reader.onload = (e) => {
                            try {
                                const loadedData = JSON.parse(e.target.result);
                                if (!loadedData || !Array.isArray(loadedData.collections) || !Array.isArray(loadedData.pages)) {
                                    throw new Error("Invalid collections file format.");
                                }

                                const idMap = {}; // Maps original imported page ID to new/existing page ID
                                const pagesToAdd = [];
                                let linkedPageCount = 0;

                                // First, process and map the pages
                                loadedData.pages.forEach(importedPage => {
                                    const originalId = importedPage.id;
                                    const existingPageWithTitle = book.pages.find(p => p.title.toLowerCase() === importedPage.title.toLowerCase());

                                    if (existingPageWithTitle) {
                                        idMap[originalId] = existingPageWithTitle.id;
                                        linkedPageCount++;
                                    } else {
                                        const existingPageWithId = book.pages.find(p => p.id === originalId);
                                        const finalPageId = (existingPageWithId || originalId === undefined || typeof originalId !== 'number') ? book.nextPageId++ : originalId;
                                        if (originalId >= book.nextPageId) book.nextPageId = originalId + 1;

                                        idMap[originalId] = finalPageId;
                                        importedPage.id = finalPageId;
                                        importedPage.sources = (importedPage.sources || []).map(s => ({
                                            ...s,
                                            needsFile: s.type === 'file',
                                            source: s.type === 'youtube' ? (s.source || extractYouTubeVideoId(s.fileName || '')) : null
                                        }));
                                        pagesToAdd.push(importedPage);
                                    }
                                });

                                // Update nextPageId references within the newly added pages
                                pagesToAdd.forEach(page => {
                                    if (page.nextPageId !== null && idMap[page.nextPageId] !== undefined) {
                                        page.nextPageId = idMap[page.nextPageId];
                                    } else {
                                        page.nextPageId = null; // Clear broken links
                                    }
                                });

                                book.pages.push(...pagesToAdd);

                                // Now, process the collections
                                let addedCollCount = 0;
                                let overwrittenCollCount = 0;
                                loadedData.collections.forEach(importedColl => {
                                    const finalPageIds = importedColl.pageIds.map(id => idMap[id]).filter(id => id !== undefined);
                                    const existingColl = book.collections.find(c => c.name.toLowerCase() === importedColl.name.toLowerCase());

                                    if (existingColl) {
                                        if (confirm(`Collection "${importedColl.name}" already exists. Overwrite its page list?`)) {
                                            existingColl.pageIds = finalPageIds;
                                            existingColl.isStarred = importedColl.isStarred || false;
                                            existingColl.isCollapsed = importedColl.isCollapsed || false;
                                            existingColl.tagIds = importedColl.tagIds || []; // Also overwrite tags
                                            overwrittenCollCount++;
                                        }
                                    } else {
                                        const newCollection = { id: `coll_${book.nextCollectionId++}`, name: importedColl.name, isStarred: importedColl.isStarred || false, isCollapsed: importedColl.isCollapsed || false, pageIds: finalPageIds, tagIds: importedColl.tagIds || [] };
                                        book.collections.push(newCollection);
                                        addedCollCount++;
                                    }
                                });

                                updateFuseIndex();
                                saveToLocalStorage();
                                renderPageList();
                                showTemporaryMessage(`Import complete: ${pagesToAdd.length} pages added, ${linkedPageCount} linked. ${addedCollCount} collections added, ${overwrittenCollCount} overwritten.`, 'success', 7000);
                            } catch (error) {
                                showTemporaryMessage(`Import failed: ${error.message}`, 'error');
                            } finally {
                                event.target.value = '';
                            }
                        };
                        reader.readAsText(file);
                    }

                    // --- Burn Book Function ---
                    function burnBook() { // This function is correct
                        if (!confirm("Are you sure you want to permanently delete all data for the current book? This cannot be undone.")) return;
                        // This function is now effectively the "Burn All" version. The modal will call burnBookFromModal.
                        stopListening(true); // Force stop speech recognition
                        stopAllSounds();     // Stop any playing audio
                        clearAllCooldowns(); // Clear sound cooldowns
                        activeSounds = {};   // Reset active sounds
                        youtubePlayers = {}; // Reset YouTube players
                        youtubePlayersContainer.innerHTML = ''; // Clear YT player divs

                        book = getDefaultBook(); // Reset book data to default empty state
                        localStorage.removeItem(LOCAL_STORAGE_KEY); // Remove from local storage
                        saveToLocalStorage(); // Save the fresh default book to local storage

                        // Reset global state variables from the new default book's settings
                        currentListeningMode = book.settings.listeningMode;
                        isCompoundPhrasingEnabled = book.settings.compoundPhrasing;
                        currentKeywordConfidenceThreshold = book.settings.accuracyThreshold;
                        stopAudioMode = book.settings.stopAudioMode;
                        currentMasterVolume = book.settings.masterVolume;
                        masterVolumeSlider.value = currentMasterVolume; // Update UI
                        masterVolumeValueSpan.textContent = `${currentMasterVolume}`;
                        stopPhrases = book.settings.stopPhrases;
                        customEnterPhrases = book.settings.customEnterPhrases;
                        customExitPhrases = book.settings.customExitPhrases;
                        daytimeTransitionPhrases = book.settings.daytimeTransitionPhrases;
                        nighttimeTransitionPhrases = book.settings.nighttimeTransitionPhrases;
                        autoplayOnClickSetting = book.settings.autoplayOnClick;
                        isCompoundPhrasingEnabled = book.settings.compoundPhrasing;
                        syrinscapeAuthToken = book.settings.syrinscapeAuthToken; // Should be null from default
                        syrinscapePlayerReady = false; // Reset Syrinscape player status
                        currentTimeOfDay = book.currentTimeOfDay; // Reset time of day
                        plotBoardView = { ...book.storyPlot.viewTransform }; // Reset plotter view

                        clearAddForm(); // Clear the add page form
                        searchInput.value = ''; // Clear search input
                        currentSearchTerm = '';

                        updateFuseIndex();
                        updateChapterKeywordList();
                        renderChapterTabs();
                        renderPageList();
                        if (storyPlotterModal.style.display === 'flex') { // If plotter is open, re-render it
                            renderPlotBoard();
                        }
                        updateUIState(); // Update overall UI
                        showTemporaryMessage("Book burned. All data cleared.", "success");
                    }

                    function burnBookFromModal() {
                        const toBurn = {
                            chapters: document.getElementById('burnSwitchChapters').checked,
                            collections: document.getElementById('burnSwitchCollections').checked,
                            pages: document.getElementById('burnSwitchPages').checked,
                            appendix: document.getElementById('burnSwitchAppendix').checked,
                            settings: document.getElementById('burnSwitchSettings').checked,
                            soundtracks: document.getElementById('burnSwitchSoundtracks').checked
                        };

                        if (Object.values(toBurn).every(v => !v)) {
                            showTemporaryMessage("Nothing selected to burn.", "info");
                            return;
                        }

                        stopListening(true);
                        stopAllSounds();
                        clearAllCooldowns();
                        activeSounds = {};

                        const defaultBook = getDefaultBook();
                        let partsBurned = [];

                        if (toBurn.pages) {
                            partsBurned.push("Pages");
                            book.pages = [];
                            book.nextPageId = 0;
                            // Clean up references in other parts of the book
                            (book.chapters || []).forEach(ch => {
                                ch.pageIds = [];
                                ch.autoPlayPageIds = [];
                                ch.leaveSoundPageIds = [];
                            });
                            (book.collections || []).forEach(c => { c.pageIds = []; });
                            (book.storyPlot.threads || []).forEach(t => { t.soundPageIds = []; });
                            (book.appendix || []).forEach(entry => {
                                entry.effects = (entry.effects || []).filter(effect => {
                                    const isPageEffect = ['start_pages', 'end_pages', 'increase_volume', 'decrease_volume', 'reset_volume'].includes(effect.type) && effect.target?.targetType === 'pages';
                                    return !isPageEffect;
                                });
                            });
                            // Remove appendix entries that now have no effects
                            book.appendix = (book.appendix || []).filter(entry => entry.effects.length > 0);
                        }

                        if (toBurn.chapters) {
                            partsBurned.push("Chapters & Plotter");
                            book.chapters = defaultBook.chapters;
                            book.activeChapterId = 'index';
                            book.nextChapterId = 1;
                            book.storyPlot = defaultBook.storyPlot;
                            plotBoardView = { ...book.storyPlot.viewTransform };
                        }

                        if (toBurn.collections) {
                            partsBurned.push("Collections");
                            book.collections = [];
                            book.nextCollectionId = 0;
                        }

                        if (toBurn.appendix) {
                            partsBurned.push("Appendix");
                            book.appendix = [];
                        }

                        if (toBurn.soundtracks) {
                            partsBurned.push("Soundtracks");
                            book.soundtracks = [];
                            stopSoundtrack();
                        }

                        if (toBurn.settings) {
                            partsBurned.push("Settings");
                            const appendixToKeep = toBurn.appendix ? [] : book.appendix; // Keep appendix if not burned
                            book.settings = defaultBook.settings;
                            book.settings.appendix = appendixToKeep;

                            // Reset global state variables
                            currentListeningMode = book.settings.listeningMode;
                            isCompoundPhrasingEnabled = book.settings.compoundPhrasing;
                            currentKeywordConfidenceThreshold = book.settings.accuracyThreshold;
                            stopAudioMode = book.settings.stopAudioMode;
                            currentMasterVolume = book.settings.masterVolume;
                            masterVolumeSlider.value = currentMasterVolume;
                            masterVolumeValueSpan.textContent = `${currentMasterVolume}`;
                            stopPhrases = book.settings.stopPhrases;
                            customEnterPhrases = book.settings.customEnterPhrases;
                            customExitPhrases = book.settings.customExitPhrases;
                            daytimeTransitionPhrases = book.settings.daytimeTransitionPhrases;
                            nighttimeTransitionPhrases = book.settings.nighttimeTransitionPhrases;
                            autoplayOnClickSetting = book.settings.autoplayOnClick;
                            syrinscapeAuthToken = book.settings.syrinscapeAuthToken;
                            syrinscapePlayerReady = false;
                        }

                        saveToLocalStorage();
                        updateFuseIndex();
                        updateChapterKeywordList();
                        renderChapterTabs();
                        renderPageList();
                        renderSoundtrackIcons();
                        updateUIState();
                        // Close the modal after burning
                        burnBookModal.style.display = 'none';
                        modalOverlay.style.display = 'none';
                        showTemporaryMessage(`Burned: ${partsBurned.join(', ')}.`, "success", 4000);
                    }

                    // --- Helper: Find Playable Source Variation ---
                    function findPlayableSourceVariation(page, isPlotterContextForVariationSelection = false, textToSearch = null) {
                        if (!page || !page.sources || page.sources.length === 0) return null;

                        // 1. Create Candidate Pool: Filter for variations that have at least one playable sub-source.
                        const allPlayableVariations = page.sources.filter(variation =>
                            variation.sources && variation.sources.length > 0 && variation.sources.some(subSource =>
                                (subSource.type === 'file' && !subSource.needsFile) ||
                                subSource.type === 'youtube' ||
                                (subSource.type === 'syrinscape' && subSource.syrinscapeElementId)
                            )
                        );

                        if (allPlayableVariations.length === 0) {
                            log(`No playable variations found for page "${page.title}" after checking sources.`);
                            return null;
                        }

                        let candidatePool = [];

                        // 2. Keyword-Based Selection (Highest Priority)
                        if (textToSearch) {
                            const keywordMatches = allPlayableVariations.filter(v => {
                                const keywords = v.variationKeywords || [];
                                if (keywords.length === 0) return false;
                                const hasKeywordMatch = keywords.some(kw => new RegExp(`\\b${kw.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&')}\\b`, 'i').test(textToSearch));
                                return hasKeywordMatch && checkVariationConditions(v.conditions);
                            });

                            if (keywordMatches.length > 0) {
                                log(`Found ${keywordMatches.length} variation(s) with matching keywords and conditions for "${page.title}".`);
                                candidatePool = keywordMatches;
                            }
                        }

                        // 3. Condition-Based Selection (If no keyword matches were found)
                        if (candidatePool.length === 0) {
                            const conditionalMatches = allPlayableVariations.filter(v => {
                                const hasKeywords = v.variationKeywords && v.variationKeywords.length > 0;
                                const hasConditions = v.conditions && v.conditions.length > 0;
                                // This variation must have conditions, but no keywords (since they didn't match)
                                return !hasKeywords && hasConditions && checkVariationConditions(v.conditions);
                            });

                            if (conditionalMatches.length > 0) {
                                log(`Found ${conditionalMatches.length} variation(s) with matching conditions (and no keywords) for "${page.title}".`);
                                candidatePool = conditionalMatches;
                            }
                        }

                        // 4. Default & General Fallback (If still no candidates)
                        if (candidatePool.length === 0) {
                            // First, look for a designated "Default" variation whose conditions are met.
                            const defaultVariation = allPlayableVariations.find(v => v.isDefault);
                            if (defaultVariation && checkVariationConditions(defaultVariation.conditions)) {
                                log(`Found valid Default variation for "${page.title}".`);
                                candidatePool = [defaultVariation];
                            } else {
                                // If no valid default, look for any variation with NO keywords and NO conditions.
                                const generalVariations = allPlayableVariations.filter(v =>
                                    (!v.variationKeywords || v.variationKeywords.length === 0) &&
                                    (!v.conditions || v.conditions.length === 0)
                                );
                                if (generalVariations.length > 0) {
                                    log(`Found ${generalVariations.length} general-purpose variation(s) for "${page.title}".`);
                                    candidatePool = generalVariations;
                                }
                            }
                        }

                        // 5. Final Selection
                        if (candidatePool.length === 0) {
                            log(`No suitable variation found for page "${page.title}" after all checks.`);
                            return null; // No suitable variation found at all
                        }

                        // Randomly select one variation from the final candidate pool.
                        const randomIndex = Math.floor(Math.random() * candidatePool.length);
                        const chosenVariation = candidatePool[randomIndex];

                        log(`Variation Chosen: "${chosenVariation.name || `Variation ${page.sources.indexOf(chosenVariation)}`}" for page "${page.title}". Now selecting a source.`);

                        // From the chosen variation, randomly select one playable sound source.
                        const playableSubSources = chosenVariation.sources.filter(sub =>
                            (sub.type === 'file' && !sub.needsFile) ||
                            sub.type === 'youtube' ||
                            (sub.type === 'syrinscape' && sub.syrinscapeElementId)
                        );

                        if (playableSubSources.length > 0) {
                            const subSourceIndex = Math.floor(Math.random() * playableSubSources.length);
                            const chosenSubSource = playableSubSources[subSourceIndex];
                            log(` -> Final Source Selected: ${chosenSubSource.fileName || chosenSubSource.type}`);
                            return chosenSubSource; // Return the specific, playable source object
                        }

                        console.error(`Logic Error: Chosen variation "${chosenVariation.name}" for page "${page.title}" has no playable sub-sources, but should have been filtered out.`);
                        return null;
                    }

                    function reEvaluateActiveSounds(triggeringPageId = null) {
                        log(`Re-evaluating active sounds due to context change. Trigger: ${triggeringPageId || 'N/A'}`);
                        const activeSoundEntries = Object.entries(activeSounds);

                        activeSoundEntries.forEach(([pageIdStr, soundData]) => {
                            const pageId = parseInt(pageIdStr, 10);
                            // NEW: Don't re-evaluate sounds that were just explicitly triggered by an Appendix effect.
                            // Their variation is intentional and should not be overridden by this general re-evaluation.
                            if (soundData.triggeredByAppendix) {
                                log(`Re-evaluation: Skipping page ${pageId} ("${soundData.page?.title}") because it was triggered by an Appendix effect.`);
                                return;
                            }

                            const page = book.pages.find(p => p.id === pageId);
                            if (!page) return;

                            const currentVariation = activeSounds[pageId]?.sourceDetail; // Get the most current variation
                            const newBestVariation = findPlayableSourceVariation(page, soundData.isPlotThreadSound);

                            if (newBestVariation && currentVariation && newBestVariation !== currentVariation) {
                                log(`State Change: Switching variation for active sound "${page.title}" (ID: ${pageId})`);
                                stopSingleSound(pageId, 're-evaluation');
                                playSound(page, newBestVariation, soundData.startedByAutoplay, soundData.onEndedCallback, soundData.isCompoundSequence, soundData.isPlotThreadSound);
                            }
                        });
                    }

                    function checkVariationConditions(conditions) {
                        if (!conditions || conditions.length === 0) return true;

                        // Separate chapter conditions from others.
                        const chapterConditions = conditions.filter(c => c.type === 'chapter_is');
                        const otherConditions = conditions.filter(c => c.type !== 'chapter_is');

                        // Check tag conditions with AND logic
                        const tagIsConditions = conditions.filter(c => c.type === 'tag_is');
                        const tagNotConditions = conditions.filter(c => c.type === 'tag_not');
                        const activeChapterTags = new Set(book.chapters.find(ch => ch.id == book.activeChapterId)?.tagIds || []);

                        // --- DEBUG LOG ---
                        log(`%c[DEBUG] checkVariationConditions: Checking tags. Active tags: [${[...activeChapterTags].join(', ')}]. Required: [${tagIsConditions.map(c => c.params.tagId).join(', ')}]. Forbidden: [${tagNotConditions.map(c => c.params.tagId).join(', ')}]`, 'color: magenta');
                        // --- END DEBUG LOG ---
                        if (tagIsConditions.length > 0 && !tagIsConditions.every(cond => activeChapterTags.has(cond.params.tagId))) {
                            return false; // Must have ALL specified tags
                        }
                        if (tagNotConditions.length > 0 && tagNotConditions.some(cond => activeChapterTags.has(cond.params.tagId))) {
                            return false; // Must NOT have ANY specified tags
                        }

                        // Check chapter conditions with OR logic.
                        const tagConditions = conditions.filter(c => c.type === 'chapter_has_tag');
                        if (tagConditions.length > 0) {
                            const activeChapter = book.chapters.find(ch => ch.id == book.activeChapterId);
                            const tagMet = activeChapter && tagConditions.some(cond => (activeChapter.tagIds || []).includes(cond.params.tagId));
                            if (!tagMet) return false;
                        }
                        if (chapterConditions.length > 0) {
                            const chapterMet = chapterConditions.some(cond => book.activeChapterId == cond.params.chapterId);
                            if (!chapterMet) return false;
                        }

                        // Check all other (non-chapter) conditions with AND logic.
                        return otherConditions.every(cond => {
                            if (cond.type === 'page_active') return activeSounds.hasOwnProperty(cond.params.pageId);
                            if (cond.type === 'page_inactive') return !activeSounds.hasOwnProperty(cond.params.pageId);
                            if (cond.type === 'time_is') return currentTimeOfDay === cond.params.time;
                            return true; // Unknown condition type is met
                        });
                    }

                    function checkAppendixConditions(conditions) {
                        if (!conditions || conditions.length === 0) return true;

                        const activeChapterTags = new Set(book.chapters.find(ch => ch.id == book.activeChapterId)?.tagIds || []);

                        return conditions.every(cond => {
                            switch (cond.type) {
                                case 'page_active':
                                    return activeSounds.hasOwnProperty(cond.params.pageId);
                                case 'page_inactive':
                                    return !activeSounds.hasOwnProperty(cond.params.pageId);
                                case 'time_is':
                                    return currentTimeOfDay === cond.params.time;
                                case 'chapter_is':
                                    return String(book.activeChapterId) === String(cond.params.chapterId);
                                case 'tag_is':
                                    return activeChapterTags.has(cond.params.tagId);
                                case 'tag_not':
                                    return !activeChapterTags.has(parseInt(cond.params.tagId, 10));
                                default:
                                    return true; // Unknown/unhandled condition type is considered met
                            }
                        });
                    }

                    function toggleTimeOfDay(forceTime = null) {
                        const oldTime = currentTimeOfDay;
                        const newTime = forceTime === 'toggle' ? (currentTimeOfDay === 'day' ? 'night' : 'day') : (forceTime || (currentTimeOfDay === 'day' ? 'night' : 'day'));

                        if (newTime === oldTime && !forceTime) {
                            log("Time toggle requested, but time is already:", oldTime);
                            return;
                        }
                        currentTimeOfDay = newTime;
                        book.currentTimeOfDay = currentTimeOfDay;
                        log(`Time of day changed from ${oldTime} to ${currentTimeOfDay}.`);
                        showTemporaryMessage(`Time changed to ${currentTimeOfDay}.`, 'info');
                        if (typeof evaluateSoundtrackTriggers === 'function') evaluateSoundtrackTriggers(currentTimeOfDay, 'time');

                        // Re-evaluate all active sounds based on the new time of day context
                        reEvaluateActiveSounds();

                        // After handling existing sounds, check for autoplay pages in the current chapter
                        const activeChapter = book.chapters.find(ch => ch.id == book.activeChapterId);
                        if (activeChapter) {
                            // Only trigger autoplay on a time change if the user setting allows it ("Only While Listening")
                            // and speech recognition is currently active.  Otherwise, skip autoplay entirely.  For other
                            // settings ('on' or 'off') we always run autoplay here regardless of listening state.
                            const autoplayOnClickSetting = book.settings.autoplayOnClick || 'listening';
                            const shouldAutoplayNow = (autoplayOnClickSetting === 'on') || (autoplayOnClickSetting === 'listening' && isListening);
                            log(`Re-evaluating autoplay for chapter "${activeChapter.name}" after time change to ${currentTimeOfDay}. Listening: ${isListening}, Setting: ${autoplayOnClickSetting}, Will autoplay: ${shouldAutoplayNow}`);
                            if (shouldAutoplayNow) {
                                isTimeChangeAutoplay = true;
                                playAutoplayPages(activeChapter.id);
                                isTimeChangeAutoplay = false;
                            } else {
                                log('Skipping autoplay on time change due to listening setting/state.');
                            }
                        }

                        saveToLocalStorage();
                        evaluateAppendixStateTriggers(); // Re-evaluate conditions after time change
                        updateUIState(); // This will re-render page list with new time restrictions
                    }

                    function transitionVariation(pageId, fromVariationId, toVariationId) {

                        log(`%c[TRANSITION]`, 'color: #FFD700; font-weight: bold;', `Attempting variation transition for Page ID: ${pageId}`);
                        log(`%c[TRANSITION]`, 'color: #FFD700; font-weight: bold;', `Params: from='${fromVariationId}', to='${toVariationId}'`);


                        const activeSound = activeSounds[pageId];
                        if (!activeSound) {

                            log(`%c[TRANSITION]`, 'color: #FFD700; font-weight: bold;', `FAIL: Page ${pageId} is not currently active.`);

                            return;
                        }

                        const page = book.pages.find(p => p.id === parseInt(pageId, 10)); // Ensure pageId is a number
                        if (!page) {

                            log(`%c[TRANSITION]`, 'color: #FFD700; font-weight: bold;', `FAIL: Page object for ID ${pageId} not found.`);

                            return;
                        }

                        const currentVariationId = activeSound.parentVariation?.id;
                        const toVariation = page.sources.find(s => s.id === toVariationId);


                        log(`%c[TRANSITION]`, 'color: #FFD700; font-weight: bold;', `Detected current playing variation ID: '${currentVariationId}'`);
                        log(`%c[TRANSITION]`, 'color: #FFD700; font-weight: bold;', `Target variation object found:`, toVariation ? JSON.parse(JSON.stringify(toVariation)) : 'Not Found');


                        if (!toVariation) {
                            console.warn(`Transition Variation: Target variation ID ${toVariationId} not found on page ${pageId}.`);
                            return;
                        }

                        // Prevent transitioning to the same variation
                        if (currentVariationId === toVariationId) {
                            log(`%c[TRANSITION]`, 'color: #FFD700; font-weight: bold;', `SKIP: Already playing target variation '${toVariationId}'.`);
                            return;
                        }
                        if (fromVariationId === 'any' || fromVariationId === currentVariationId) { // This check is now correct

                            log(`%c[TRANSITION]`, 'color: #FFD700; font-weight: bold;', `SUCCESS: Condition met. Transitioning page ${pageId} from '${currentVariationId}' to '${toVariationId}'.`);

                            stopSingleSound(pageId, 'variation_transition');
                            setTimeout(() => playSound(page, toVariation, false, null, false, false, false, true), 100);
                        } else {

                            log(`%c[TRANSITION]`, 'color: #FFD700; font-weight: bold;', `FAIL: Condition not met. 'from' condition ('${fromVariationId}') does not match current variation ('${currentVariationId}').`);

                        }
                    }


                    // --- Story Plotter Helper Functions ---
                    function generateUUID() { return ([1e7] + -1e3 + -4e3 + -8e3 + -1e11).replace(/[018]/g, c => (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16)); }
                    function getPlotNodeById(nodeId) { return book.storyPlot.nodes.find(n => n.id === nodeId); }
                    function getPlotThreadById(threadId) { return book.storyPlot.threads.find(t => t.id === threadId); }


                    // --- Story Plotter Modal Functions ---
                    function openStoryPlotterModal() {
                        log("Opening Story Plotter modal.");
                        ensureAllChaptersArePlotNodes();
                        plotBoardView = { ...(book.storyPlot.viewTransform || { x: 0, y: 0, scale: 1.0 }) };
                        renderPlotBoard();
                        modalOverlay.style.display = 'block';
                        storyPlotterModal.style.display = 'flex';
                    }
                    function closeStoryPlotterModal() {
                        book.storyPlot.viewTransform = { ...plotBoardView };
                        saveToLocalStorage();

                        modalOverlay.style.display = 'none';
                        storyPlotterModal.style.display = 'none';
                        if (plotThreadMenu.style.display === 'block') closePlotThreadMenu();
                        isDrawingPlotThread = false;
                        if (plotThreadPreviewLine) plotThreadPreviewLine.remove();
                        plotThreadPreviewLine = null;
                        plotThreadStartConnector = null;
                    }

                    // --- Story Plotter Board Rendering ---
                    function renderPlotBoard() {
                        if (!plotBoardContainer || !plotBoardSVG) return;

                        Array.from(plotBoardContainer.querySelectorAll('.plot-node')).forEach(nodeEl => nodeEl.remove());
                        Array.from(plotBoardSVG.querySelectorAll('.plot-thread, .plot-thread-title-text, defs')).forEach(el => el.remove());

                        const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
                        const marker = document.createElementNS('http://www.w3.org/2000/svg', 'marker');
                        marker.id = 'arrowhead';
                        marker.setAttribute('markerWidth', '10'); marker.setAttribute('markerHeight', '7');
                        marker.setAttribute('refX', '9'); marker.setAttribute('refY', '3.5');
                        marker.setAttribute('orient', 'auto');
                        const polygon = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
                        polygon.setAttribute('points', '0 0, 10 3.5, 0 7');
                        marker.appendChild(polygon);
                        defs.appendChild(marker);
                        plotBoardSVG.appendChild(defs);

                        renderPlotNodes();
                        renderPlotThreads();
                        applyPlotBoardTransform();
                    }


                    function renderPlotNodes() {
                        activePlotNodes = [];
                        (book.storyPlot.nodes || []).forEach(nodeData => {
                            const chapter = book.chapters.find(ch => ch.id == nodeData.chapterId);
                            if (!chapter) { console.warn(`Chapter ID ${nodeData.chapterId} for plot node ${nodeData.id} not found.`); return; }

                            const nodeEl = document.createElement('div');
                            nodeEl.className = 'plot-node';
                            nodeEl.id = nodeData.id;
                            nodeEl.dataset.chapterId = nodeData.chapterId;

                            const header = document.createElement('div');
                            header.className = 'plot-node-header';
                            header.textContent = chapter.name;
                            nodeEl.appendChild(header);

                            const inputConnector = document.createElement('div');
                            inputConnector.className = 'plot-node-connector input';
                            inputConnector.title = "Connect thread to this chapter";
                            inputConnector.dataset.nodeId = nodeData.id;
                            inputConnector.dataset.connectorType = 'input';
                            nodeEl.appendChild(inputConnector);

                            const outputConnector = document.createElement('div');
                            outputConnector.className = 'plot-node-connector output';
                            outputConnector.title = "Start new thread from this chapter";
                            outputConnector.dataset.nodeId = nodeData.id;
                            outputConnector.dataset.connectorType = 'output';
                            nodeEl.appendChild(outputConnector);

                            plotBoardContainer.appendChild(nodeEl);
                            activePlotNodes.push(nodeEl);

                            header.addEventListener('mousedown', handlePlotNodeDragStart);
                            inputConnector.addEventListener('mousedown', (e) => { e.stopPropagation(); handleConnectorClick(e); });
                            outputConnector.addEventListener('mousedown', (e) => { e.stopPropagation(); handleConnectorClick(e); });
                        });
                    }

                    function renderPlotThreads() {
                        Array.from(plotBoardSVG.querySelectorAll('line.plot-thread, title.plot-thread-title-text')).forEach(el => el.remove());

                        const threadGroups = {};
                        (book.storyPlot.threads || []).forEach(threadData => {
                            const key = `${threadData.fromNodeId}-${threadData.toNodeId}`;
                            if (!threadGroups[key]) threadGroups[key] = [];
                            threadGroups[key].push(threadData);
                        });

                        Object.values(threadGroups).forEach(group => {
                            const numThreadsInGroup = group.length;
                            const isMultiGroup = numThreadsInGroup > 1;

                            group.forEach((threadData, indexInGroup) => {
                                const fromNodeData = getPlotNodeById(threadData.fromNodeId);
                                const toNodeData = getPlotNodeById(threadData.toNodeId);
                                if (!fromNodeData || !toNodeData) { console.warn(`Cannot render thread ${threadData.id}: missing node(s).`); return; }

                                const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
                                let x1 = fromNodeData.x + PLOT_NODE_WIDTH;
                                let y1 = fromNodeData.y + PLOT_NODE_HEIGHT / 2;
                                let x2 = toNodeData.x;
                                let y2 = toNodeData.y + PLOT_NODE_HEIGHT / 2;

                                if (isMultiGroup) {
                                    const angle = Math.atan2(y2 - y1, x2 - x1);
                                    const offsetIndex = indexInGroup - (numThreadsInGroup - 1) / 2;
                                    const offsetX = PLOT_THREAD_OFFSET_AMOUNT * offsetIndex * Math.sin(angle);
                                    const offsetY = -PLOT_THREAD_OFFSET_AMOUNT * offsetIndex * Math.cos(angle);
                                    x1 += offsetX; y1 += offsetY;
                                    x2 += offsetX; y2 += offsetY;
                                }

                                line.setAttribute('x1', x1); line.setAttribute('y1', y1);
                                line.setAttribute('x2', x2); line.setAttribute('y2', y2);

                                const colorClassIndex = (threadData.id.charCodeAt(threadData.id.length - 1) % PLOT_THREAD_COLORS) + 1;
                                line.setAttribute('class', `plot-thread plot-thread-color-${colorClassIndex}`);
                                line.setAttribute('marker-end', 'url(#arrowhead)');
                                line.dataset.threadId = threadData.id;

                                if (threadData.title && threadData.title.trim() !== '') {
                                    const titleEl = document.createElementNS('http://www.w3.org/2000/svg', 'title');
                                    titleEl.classList.add('plot-thread-title-text');
                                    titleEl.textContent = threadData.title;
                                    line.appendChild(titleEl);
                                }
                                line.addEventListener('click', (e) => { e.stopPropagation(); openPlotThreadMenu(threadData.id, e.clientX, e.clientY); });
                                plotBoardSVG.appendChild(line);
                            });
                        });
                    }


                    function applyPlotBoardTransform() {
                        if (!plotBoardContainer || !plotBoardSVG) return;

                        activePlotNodes.forEach(nodeEl => {
                            const nodeData = getPlotNodeById(nodeEl.id);
                            if (nodeData) {
                                nodeEl.style.left = `${(nodeData.x * plotBoardView.scale) + plotBoardView.x}px`;
                                nodeEl.style.top = `${(nodeData.y * plotBoardView.scale) + plotBoardView.y}px`;
                                nodeEl.style.transform = `scale(${plotBoardView.scale})`;
                            }
                        });
                        plotBoardSVG.style.transform = `translate(${plotBoardView.x}px, ${plotBoardView.y}px) scale(${plotBoardView.scale})`;

                        let minX = Infinity, minY = Infinity, maxX = 0, maxY = 0;
                        let hasNodes = false;
                        (book.storyPlot.nodes || []).forEach(n => {
                            hasNodes = true;
                            minX = Math.min(minX, n.x); minY = Math.min(minY, n.y);
                            maxX = Math.max(maxX, n.x + PLOT_NODE_WIDTH); maxY = Math.max(maxY, n.y + PLOT_NODE_HEIGHT);
                        });

                        if (hasNodes) {
                            const svgWidth = (maxX) + 50;
                            const svgHeight = (maxY) + 50;
                            plotBoardSVG.setAttribute('width', svgWidth);
                            plotBoardSVG.setAttribute('height', svgHeight);
                        } else {
                            plotBoardSVG.setAttribute('width', '100%');
                            plotBoardSVG.setAttribute('height', '100%');
                        }
                    }


                    // --- Story Plotter Node Management ---
                    function ensureAllChaptersArePlotNodes() {
                        let changed = false;
                        const existingNodeChapterIds = new Set(book.storyPlot.nodes.map(n => n.chapterId));

                        book.chapters.forEach((chapter, index) => {
                            if (!existingNodeChapterIds.has(chapter.id)) {
                                const newNodeId = `plotNode_${book.storyPlot.nextPlotNodeId++}`;
                                const initialX = 50 + (index % 5) * (PLOT_NODE_WIDTH + 30);
                                const initialY = 50 + Math.floor(index / 5) * (PLOT_NODE_HEIGHT + 50);

                                const newNodeData = {
                                    id: newNodeId,
                                    chapterId: chapter.id,
                                    x: Math.max(0, initialX),
                                    y: Math.max(0, initialY),
                                };
                                book.storyPlot.nodes.push(newNodeData);
                                existingNodeChapterIds.add(chapter.id);
                                changed = true;
                                log(`Auto-added plot node for chapter "${chapter.name}" (ID: ${chapter.id}) at ${initialX},${initialY}`);
                            }
                        });

                        if (changed) {
                            saveToLocalStorage();
                        }
                        return changed;
                    }


                    function handlePlotNodeDragStart(e) {
                        if (e.target.classList.contains('plot-node-header') && e.button === 0) {
                            e.preventDefault(); e.stopPropagation();
                            isDraggingPlotNode = true;
                            draggedPlotNode = e.target.closest('.plot-node');
                            if (!draggedPlotNode) return;
                            draggedPlotNode.classList.add('dragging-node');
                            const nodeData = getPlotNodeById(draggedPlotNode.id);
                            if (!nodeData) {
                                isDraggingPlotNode = false; draggedPlotNode.classList.remove('dragging-node'); draggedPlotNode = null; return;
                            }
                            const boardRect = plotBoardContainer.getBoundingClientRect();
                            const mouseXInBoard = e.clientX - boardRect.left;
                            const mouseYInBoard = e.clientY - boardRect.top;
                            dragPlotNodeOffset.x = (mouseXInBoard - plotBoardView.x) / plotBoardView.scale - nodeData.x;
                            dragPlotNodeOffset.y = (mouseYInBoard - plotBoardView.y) / plotBoardView.scale - nodeData.y;

                            document.addEventListener('mousemove', handlePlotNodeDrag);
                            document.addEventListener('mouseup', handlePlotNodeDragEnd);
                        }
                    }

                    function handlePlotNodeDrag(e) {
                        if (!isDraggingPlotNode || !draggedPlotNode) return;
                        e.preventDefault();
                        const nodeData = getPlotNodeById(draggedPlotNode.id);
                        if (!nodeData) return;
                        const boardRect = plotBoardContainer.getBoundingClientRect();
                        const mouseXInBoard = e.clientX - boardRect.left;
                        const mouseYInBoard = e.clientY - boardRect.top;
                        const newUnscaledX = (mouseXInBoard - plotBoardView.x) / plotBoardView.scale - dragPlotNodeOffset.x;
                        const newUnscaledY = (mouseYInBoard - plotBoardView.y) / plotBoardView.scale - dragPlotNodeOffset.y;
                        nodeData.x = Math.max(0, newUnscaledX);
                        nodeData.y = Math.max(0, newUnscaledY);
                        applyPlotBoardTransform();
                        renderPlotThreads();
                    }


                    function handlePlotNodeDragEnd(e) {
                        if (!isDraggingPlotNode) return;
                        isDraggingPlotNode = false;
                        if (draggedPlotNode) {
                            draggedPlotNode.classList.remove('dragging-node');
                            saveToLocalStorage();
                        }
                        draggedPlotNode = null;
                        document.removeEventListener('mousemove', handlePlotNodeDrag);
                        document.removeEventListener('mouseup', handlePlotNodeDragEnd);
                    }


                    // --- Story Plotter Thread Management ---
                    function handleConnectorClick(e) {
                        e.stopPropagation();
                        const connector = e.target;
                        const nodeId = connector.dataset.nodeId;
                        const connectorType = connector.dataset.connectorType;

                        if (!isDrawingPlotThread && connectorType === 'output') {
                            startPlotThreadDraw(nodeId, connector);
                        } else if (isDrawingPlotThread && connectorType === 'input' && plotThreadStartConnector && plotThreadStartConnector.nodeId !== nodeId) {
                            finishPlotThreadDraw(nodeId);
                        } else if (isDrawingPlotThread) {
                            isDrawingPlotThread = false;
                            if (plotThreadPreviewLine) plotThreadPreviewLine.remove();
                            plotThreadPreviewLine = null;
                            plotThreadStartConnector = null;
                            plotBoardContainer.style.cursor = 'grab';
                            plotBoardContainer.removeEventListener('mousemove', previewPlotThreadDraw);
                            log("Thread drawing cancelled (invalid click or same node).");
                        }
                    }

                    function startPlotThreadDraw(nodeId, connectorElement) {
                        isDrawingPlotThread = true;
                        plotThreadStartConnector = { nodeId: nodeId, type: 'output', element: connectorElement };
                        plotBoardContainer.style.cursor = 'crosshair';

                        plotThreadPreviewLine = document.createElementNS('http://www.w3.org/2000/svg', 'line');
                        plotThreadPreviewLine.setAttribute('class', 'plot-thread plot-thread-color-1');
                        plotThreadPreviewLine.style.pointerEvents = 'none';
                        plotBoardSVG.appendChild(plotThreadPreviewLine);

                        log(`Starting thread draw from node ${nodeId}`);
                        plotBoardContainer.addEventListener('mousemove', previewPlotThreadDraw);
                        plotBoardContainer.addEventListener('mouseup', cancelThreadDrawOnBoardMouseUp, { capture: true, once: true });
                    }

                    function cancelThreadDrawOnBoardMouseUp(e) {
                        if (isDrawingPlotThread && !e.target.classList.contains('plot-node-connector')) {
                            isDrawingPlotThread = false;
                            if (plotThreadPreviewLine) plotThreadPreviewLine.remove();
                            plotThreadPreviewLine = null;
                            plotThreadStartConnector = null;
                            plotBoardContainer.style.cursor = 'grab';
                            plotBoardContainer.removeEventListener('mousemove', previewPlotThreadDraw);
                            log("Thread drawing cancelled by board mouseup.");
                        }
                    }


                    function previewPlotThreadDraw(e) {
                        if (!isDrawingPlotThread || !plotThreadStartConnector || !plotThreadPreviewLine) return;

                        const startNodeData = getPlotNodeById(plotThreadStartConnector.nodeId);
                        if (!startNodeData) return;

                        const x1 = startNodeData.x + PLOT_NODE_WIDTH;
                        const y1 = startNodeData.y + PLOT_NODE_HEIGHT / 2;

                        const boardRect = plotBoardContainer.getBoundingClientRect();
                        const mouseXInContainer = e.clientX - boardRect.left;
                        const mouseYInContainer = e.clientY - boardRect.top;

                        const svgMouseX = (mouseXInContainer - plotBoardView.x) / plotBoardView.scale;
                        const svgMouseY = (mouseYInContainer - plotBoardView.y) / plotBoardView.scale;

                        plotThreadPreviewLine.setAttribute('x1', x1);
                        plotThreadPreviewLine.setAttribute('y1', y1);
                        plotThreadPreviewLine.setAttribute('x2', svgMouseX);
                        plotThreadPreviewLine.setAttribute('y2', svgMouseY);
                    }


                    function finishPlotThreadDraw(toNodeId) {
                        if (!isDrawingPlotThread || !plotThreadStartConnector) return;
                        const fromNodeId = plotThreadStartConnector.nodeId;

                        if (fromNodeId === toNodeId) {
                            showTemporaryMessage("Cannot connect a chapter to itself.", "info");
                        } else {
                            createPlotThread(fromNodeId, toNodeId);
                        }

                        isDrawingPlotThread = false;
                        if (plotThreadPreviewLine) plotThreadPreviewLine.remove();
                        plotThreadPreviewLine = null;
                        plotThreadStartConnector = null;
                        plotBoardContainer.style.cursor = 'grab';
                        plotBoardContainer.removeEventListener('mousemove', previewPlotThreadDraw);
                    }

                    function createPlotThread(fromNodeId, toNodeId) {
                        const newThreadId = `plotThread_${book.storyPlot.nextPlotThreadId++}`;
                        const newThreadData = {
                            id: newThreadId,
                            title: null,
                            fromNodeId: fromNodeId,
                            toNodeId: toNodeId,
                            transitionPhrases: [],
                            keywords: [],
                            soundPageIds: [],
                            timeCondition: 'always',
                            timeChange: 'none',
                            enableReturn: false,
                            returnKeywordType: 'thread'
                        };
                        book.storyPlot.threads.push(newThreadData);
                        saveToLocalStorage();
                        renderPlotBoard();
                        showTemporaryMessage("Plot thread created. Click to configure.", "success");
                        log(`Created plot thread ${newThreadId} from ${fromNodeId} to ${toNodeId}`);
                    }

                    // --- Story Plotter Thread Configuration Menu ---
                    function openPlotThreadMenu(threadId, clickX, clickY) {
                        const thread = getPlotThreadById(threadId);
                        if (!thread) { console.error(`Thread ${threadId} not found.`); return; }

                        currentlySelectedPlotThreadId = threadId;

                        const fromNode = getPlotNodeById(thread.fromNodeId);
                        const toNode = getPlotNodeById(thread.toNodeId);
                        const fromChapter = fromNode ? book.chapters.find(ch => ch.id == fromNode.chapterId) : null;
                        const toChapter = toNode ? book.chapters.find(ch => ch.id == toNode.chapterId) : null;
                        plotThreadMenuTitle.textContent = `Thread: ${fromChapter?.name || 'Unknown'} → ${toChapter?.name || 'Unknown'}`;

                        plotThreadTitleInput.value = thread.title || '';
                        plotThreadKeywordsInput.value = (thread.keywords || []).join(', ');
                        plotThreadTransitionPhrasesInput.value = (thread.transitionPhrases || []).join('\n');
                        plotThreadDisableAutoplayCheckbox.checked = thread.disableAutoplay || false;
                        plotThreadEnableReturnCheckbox.checked = thread.enableReturn || false;

                        // New Time Condition Button Logic
                        plotThreadReturnKeywordTypeButton.classList.toggle('hidden', !thread.enableReturn);
                        updatePlotThreadReturnKeywordButton(thread.returnKeywordType || 'both');
                        plotThreadEnableReturnCheckbox.onchange = (e) => {
                            plotThreadReturnKeywordTypeButton.classList.toggle('hidden', !e.target.checked);
                        };

                        const updateButton = (state) => {
                            plotThreadTimeConditionButton.dataset.state = state;
                            if (state === 'day') {
                                plotThreadTimeConditionButton.innerHTML = `<i class="fas fa-sun day fa-fw"></i>`;
                                plotThreadTimeConditionButton.title = "Activation Condition: Day Only";
                            } else if (state === 'night') {
                                plotThreadTimeConditionButton.innerHTML = `<i class="fas fa-moon night fa-fw"></i>`;
                                plotThreadTimeConditionButton.title = "Activation Condition: Night Only";
                            } else {
                                plotThreadTimeConditionButton.innerHTML = `<i class="fas fa-ban fa-fw text-red-400"></i>`;
                                plotThreadTimeConditionButton.title = "Activation Condition: No Time Restriction";
                            }
                        };

                        const timeCondition = (thread.conditions || []).find(c => c.type === 'time_is');
                        const initialState = timeCondition ? timeCondition.params.time : 'always';
                        updateButton(initialState);

                        updatePlotThreadTimeChangeButton(thread.timeChange || 'none');

                        plotThreadTimeConditionButton.onclick = () => {
                            const currentState = plotThreadTimeConditionButton.dataset.state;
                            const nextState = currentState === 'always' ? 'day' : (currentState === 'day' ? 'night' : 'always');
                            updateButton(nextState);
                        };

                        populatePlotThreadSounds(thread);
                        // Filter out time conditions before passing to the builder, as it's now handled separately
                        const nonTimeConditions = (thread.conditions || []).filter(c => c.type !== 'time_is' && !c.type.startsWith('tag_'));
                        initializeConditionBuilder('plotThreadPageConditionsList', null, null, nonTimeConditions, 'plotThreadPageConditionSearchInput', null);

                        plotThreadMenu.style.display = 'flex'; // Use flex to match other modals
                    }

                    function closePlotThreadMenu() {
                        plotThreadMenu.style.display = 'none';
                        currentlySelectedPlotThreadId = null;
                    } // This function is correct

                    function filterPlotThreadMenuSounds() {
                        const searchTerm = plotThreadSoundSearchInput.value.toLowerCase().trim();
                        const items = plotThreadSoundsListDiv.querySelectorAll('.plot-thread-page-item');
                        items.forEach(item => {
                            const pageTitle = item.querySelector('.page-title').textContent.toLowerCase();
                            item.style.display = pageTitle.includes(searchTerm) ? '' : 'none';
                        });
                    }

                    function populatePlotThreadSounds(thread) {
                        plotThreadSoundsListDiv.innerHTML = '';
                        if (book.pages.length === 0) {
                            plotThreadSoundsListDiv.innerHTML = '<span class="text-xs text-gray-400 italic p-2">No pages available.</span>';
                            return;
                        }

                        const soundPageIds = new Set(thread.soundPageIds || []);
                        book.pages.sort((a, b) => a.title.localeCompare(b.title)).forEach(page => {
                            const itemDiv = document.createElement('div');
                            itemDiv.className = 'plot-thread-page-item';
                            itemDiv.dataset.pageId = page.id;
                            const isChecked = soundPageIds.has(page.id);
                            itemDiv.innerHTML = `
                        <span class="page-title">${escapeHtml(page.title)}</span>
                        <input type="checkbox" class="plot-thread-sound-checkbox" ${isChecked ? 'checked' : ''}>
                    `;
                            itemDiv.addEventListener('click', (e) => {
                                const checkbox = itemDiv.querySelector('.plot-thread-sound-checkbox');
                                if (e.target !== checkbox) {
                                    checkbox.checked = !checkbox.checked;
                                }
                            });
                            plotThreadSoundsListDiv.appendChild(itemDiv);
                        });
                        filterPlotThreadMenuSounds();
                    }

                    function savePlotThreadMenuChanges() {
                        if (!currentlySelectedPlotThreadId) return;
                        const thread = getPlotThreadById(currentlySelectedPlotThreadId);
                        if (!thread) { console.error("Failed to save thread: ID not found."); return; }

                        thread.title = plotThreadTitleInput.value.trim() || null;

                        thread.enableReturn = plotThreadEnableReturnCheckbox.checked;
                        thread.returnKeywordType = document.getElementById('plotThreadReturnKeywordTypeButton').dataset.state || 'both';
                        // Save from the two separate text boxes
                        thread.transitionPhrases = plotThreadTransitionPhrasesInput.value.trim().toLowerCase().split('\n').map(s => s.trim()).filter(Boolean); thread.keywords = plotThreadKeywordsInput.value.trim().toLowerCase().split(',').map(s => s.trim()).filter(Boolean);

                        thread.soundPageIds = Array.from(plotThreadSoundsListDiv.querySelectorAll('.plot-thread-page-item'))
                            .filter(item => item.querySelector('.plot-thread-sound-checkbox')?.checked)
                            .map(item => parseInt(item.dataset.pageId, 10));

                        // Get page/tag conditions from the builder
                        let conditions = getConditionsFromBuilder('plotThreadPageConditionsList', null, null);

                        // Get time condition from the new button
                        const timeState = plotThreadTimeConditionButton.dataset.state;
                        if (timeState === 'day' || timeState === 'night') {
                            conditions.push({ type: 'time_is', params: { time: timeState } });
                        }
                        thread.conditions = conditions.length > 0 ? conditions : null;

                        // Save from the new button
                        thread.timeChange = plotThreadTimeChangeButton.dataset.state || 'none';
                        thread.disableAutoplay = plotThreadDisableAutoplayCheckbox ? plotThreadDisableAutoplayCheckbox.checked : false;

                        saveToLocalStorage();
                        showTemporaryMessage("Plot thread changes saved.", "success");
                        log("Plot thread updated:", thread);
                        closePlotThreadMenu();
                        renderPlotBoard();
                    }

                    function updatePlotThreadReturnKeywordButton(state) {
                        const button = document.getElementById('plotThreadReturnKeywordTypeButton');
                        button.dataset.state = state;
                        let iconClass = 'fa-layer-group'; // Default for 'both'
                        let title = 'Return uses Both Chapter & Thread Keywords';
                        switch (state) {
                            case 'chapter':
                                iconClass = 'fa-scroll'; // Icon for chapter
                                title = 'Return uses Chapter Keywords Only';
                                break;
                            case 'thread':
                                iconClass = 'fa-project-diagram'; // Icon for thread
                                title = 'Return uses Thread Keywords Only';
                                break;
                            case 'both':
                            default:
                                // Uses default iconClass and title
                                break;
                        }
                        button.innerHTML = `<i class="fas ${iconClass} fa-fw"></i>`;
                        button.title = title;
                    }

                    document.getElementById('plotThreadReturnKeywordTypeButton').addEventListener('click', () => {
                        const button = document.getElementById('plotThreadReturnKeywordTypeButton');
                        const currentState = button.dataset.state;
                        const nextState = currentState === 'both' ? 'chapter' : (currentState === 'chapter' ? 'thread' : 'both');
                        updatePlotThreadReturnKeywordButton(nextState);
                    });
                    function updatePlotThreadTimeChangeButton(state) {
                        plotThreadTimeChangeButton.dataset.state = state;
                        switch (state) {
                            case 'day':
                                plotThreadTimeChangeButton.innerHTML = `<i class="fas fa-sun day fa-fw"></i>`;
                                plotThreadTimeChangeButton.title = "On Activation: Set to Day";
                                break;
                            case 'night':
                                plotThreadTimeChangeButton.innerHTML = `<i class="fas fa-moon night fa-fw"></i>`;
                                plotThreadTimeChangeButton.title = "On Activation: Set to Night";
                                break;
                            case 'toggle':
                                plotThreadTimeChangeButton.innerHTML = `<i class="fas fa-sync-alt fa-fw"></i>`;
                                plotThreadTimeChangeButton.title = "On Activation: Toggle Day/Night";
                                break;
                            case 'none':
                            default:
                                plotThreadTimeChangeButton.innerHTML = `<i class="fas fa-ban fa-fw text-red-400"></i>`;
                                plotThreadTimeChangeButton.title = "On Activation: No Time Change";
                                break;
                        }
                    }

                    plotThreadTimeChangeButton.addEventListener('click', () => {
                        const currentState = plotThreadTimeChangeButton.dataset.state;
                        const nextState = currentState === 'none' ? 'day' : (currentState === 'day' ? 'night' : (currentState === 'night' ? 'toggle' : 'none'));
                        updatePlotThreadTimeChangeButton(nextState);
                    });

                    function deletePlotThreadFromMenu() {
                        if (!currentlySelectedPlotThreadId) return;
                        if (!confirm("Are you sure you want to delete this plot thread?")) return;

                        const threadIndex = book.storyPlot.threads.findIndex(t => t.id === currentlySelectedPlotThreadId);
                        if (threadIndex > -1) {
                            book.storyPlot.threads.splice(threadIndex, 1);
                            saveToLocalStorage();
                            renderPlotBoard();
                            showTemporaryMessage("Plot thread deleted.", "info");
                            log(`Plot thread ${currentlySelectedPlotThreadId} deleted.`);
                        } else {
                            console.error("Failed to delete thread: ID not found after confirmation.");
                        }
                        closePlotThreadMenu();
                    }
                    function cyclePlotThreadConditionState(itemDiv) {
                        // This function is now generic and handled by the condition builder logic
                        // We can keep it here for now, but it's part of a larger refactor.
                        const currentState = itemDiv.dataset.state; let nextState = 'none'; let nextIconClass = ''; let nextBoxClass = 'state-none'; if (currentState === 'none') { nextState = 'active'; nextIconClass = 'fas fa-play'; nextBoxClass = 'state-active'; } else if (currentState === 'active') { nextState = 'inactive'; nextIconClass = 'fas fa-stop'; nextBoxClass = 'state-inactive'; } itemDiv.dataset.state = nextState; const box = itemDiv.querySelector('.condition-box'); box.className = `condition-box ${nextBoxClass}`; box.querySelector('i').className = nextIconClass;
                    }


                    // --- Story Plotter Pan & Zoom ---
                    function handlePlotBoardZoom(event) {
                        event.preventDefault();
                        const boardRect = plotBoardContainer.getBoundingClientRect();
                        const mouseX = event.clientX - boardRect.left;
                        const mouseY = event.clientY - boardRect.top;

                        const oldScale = plotBoardView.scale;
                        const delta = event.deltaY > 0 ? -PLOT_BOARD_ZOOM_SPEED : PLOT_BOARD_ZOOM_SPEED;
                        const newScale = Math.max(PLOT_BOARD_MIN_ZOOM, Math.min(PLOT_BOARD_MAX_ZOOM, oldScale * (1 + delta)));

                        plotBoardView.x = mouseX - (mouseX - plotBoardView.x) * (newScale / oldScale);
                        plotBoardView.y = mouseY - (mouseY - plotBoardView.y) * (newScale / oldScale);
                        plotBoardView.scale = newScale;

                        applyPlotBoardTransform();
                    }


                    function handlePlotBoardPanStart(event) {
                        if (event.target !== plotBoardContainer && event.target !== plotBoardSVG) return;
                        if (event.button !== 0 && event.button !== 1) return; // Allow middle mouse button for panning too
                        event.preventDefault();
                        isPlotBoardPanning = true;
                        lastPanPosition = { x: event.clientX, y: event.clientY };
                        plotBoardContainer.style.cursor = 'grabbing';
                        document.addEventListener('mousemove', handlePlotBoardPan);
                        document.addEventListener('mouseup', handlePlotBoardPanEnd);
                    }
                    function handlePlotBoardPan(event) {
                        if (!isPlotBoardPanning) return;
                        event.preventDefault();
                        const dx = event.clientX - lastPanPosition.x;
                        const dy = event.clientY - lastPanPosition.y;
                        lastPanPosition = { x: event.clientX, y: event.clientY };
                        plotBoardView.x += dx;
                        plotBoardView.y += dy;
                        applyPlotBoardTransform();
                    }
                    function handlePlotBoardPanEnd(event) {
                        if (!isPlotBoardPanning) return;
                        isPlotBoardPanning = false;
                        plotBoardContainer.style.cursor = 'grab';
                        document.removeEventListener('mousemove', handlePlotBoardPan);
                        document.removeEventListener('mouseup', handlePlotBoardPanEnd);
                    }
                    function resetPlotBoardView() {
                        plotBoardView.x = 0;
                        plotBoardView.y = 0;
                        plotBoardView.scale = 1.0;
                        applyPlotBoardTransform();
                    }
                    // --- Local Storage Functions ---
                    function saveToLocalStorage() {
                        try {
                            const savableBook = {
                                schemaVersion: SCHEMA_VERSION,
                                nextPageId: book.nextPageId ?? 0,
                                nextChapterId: book.nextChapterId ?? 1,
                                nextTagId: book.nextTagId ?? 0,
                                activeChapterId: book.activeChapterId ?? 'index',
                                currentTimeOfDay: book.currentTimeOfDay ?? 'day',
                                nextCollectionId: book.nextCollectionId ?? 0,
                                settings: book.settings ? { ...getDefaultBook().settings, ...book.settings } : getDefaultBook().settings,
                                collections: Array.isArray(book.collections) ? book.collections.map(c => ({ id: c.id, name: c.name, isStarred: c.isStarred, isCollapsed: c.isCollapsed, pageIds: c.pageIds, tagIds: c.tagIds || [], tagMatchRule: c.tagMatchRule || 'any' })) : [],
                                pages: Array.isArray(book.pages) ? book.pages.map(page => ({
                                    id: page.id,
                                    title: page.title || "",
                                    primaryKey: page.primaryKey || null,
                                    keywords: page.keywords || [],
                                    phrases: page.phrases || [],
                                    isStarred: page.isStarred || false,
                                    volume: page.volume ?? 80,
                                    loop: page.loop || false,
                                    loopCount: page.loopCount ?? 0,
                                    fadeInOut: page.fadeInOut || false,
                                    endPlayKeywords: page.endPlayKeywords || [],
                                    nextPageId: page.nextPageId ?? null,
                                    timeOfDaySetting: page.timeOfDaySetting || 'always',
                                    sources: (page.sources || []).map(variation => ({
                                        // Properties of the variation container
                                        id: variation.id,
                                        name: variation.name || null,
                                        volumeOverride: variation.volumeOverride,
                                        isDefault: variation.isDefault,
                                        conditions: variation.conditions,
                                        variationKeywords: variation.variationKeywords || [],
                                        // The nested array of actual sound sources
                                        sources: (variation.sources || []).map(subSource => ({
                                            type: subSource.type,
                                            fileName: subSource.fileName,
                                            source: subSource.type === 'youtube' ? subSource.source : null, // Only save YT source, not AudioBuffer
                                            audioHash: subSource.audioHash || null, // B3: key to bytes cached in IndexedDB
                                            startTime: subSource.startTime,
                                            endTime: subSource.endTime,
                                            syrinscapeElementId: subSource.syrinscapeElementId,
                                            syrinscapeKind: subSource.syrinscapeKind,
                                            syrinscapePlayDuration: subSource.syrinscapePlayDuration,
                                            videoTitle: subSource.videoTitle,
                                            // A file with cached bytes does not need a manual relink (B3)
                                            needsFile: subSource.type === 'file' && !subSource.audioHash
                                        }))
                                    }))
                                })) : [],
                                chapters: Array.isArray(book.chapters) ? book.chapters.map(chapter => ({
                                    id: chapter.id,
                                    name: chapter.name,
                                    isIndex: chapter.isIndex || false,
                                    isStarred: chapter.isStarred || false,
                                    pageIds: chapter.pageIds || [],
                                    chapterKeywords: chapter.chapterKeywords || [],
                                    // --- DEBUG LOG ---
                                    tagIds: (() => {
                                        log(`[saveToLocalStorage] Saving chapter "${chapter.name}" with tagIds:`, chapter.tagIds);
                                        return chapter.tagIds || [];
                                    })(),
                                    autoPlayPageIds: chapter.autoPlayPageIds || [],
                                    leaveSoundPageIds: chapter.leaveSoundPageIds || [],
                                    leaveTransitionTargetId: chapter.leaveTransitionTargetId || 'index'
                                })) : [getDefaultBook().chapters[0]],
                                storyPlot: book.storyPlot ? {
                                    nodes: Array.isArray(book.storyPlot.nodes) ? book.storyPlot.nodes : [],
                                    threads: Array.isArray(book.storyPlot.threads) ? book.storyPlot.threads : [],
                                    nextPlotNodeId: book.storyPlot.nextPlotNodeId ?? 0,
                                    nextPlotThreadId: book.storyPlot.nextPlotThreadId ?? 0,
                                    viewTransform: book.storyPlot.viewTransform ? { ...book.storyPlot.viewTransform } : { x: 0, y: 0, scale: 1.0 }
                                } : getDefaultBook().storyPlot,
                                soundtracks: Array.isArray(book.soundtracks) ? book.soundtracks.map(st => ({
                                    id: st.id,
                                    name: st.name,
                                    icon: st.icon || 'fas fa-music',
                                    keywords: st.keywords || [],
                                    timeOfDay: st.timeOfDay || 'none',
                                    chapters: st.chapters || [],
                                    shuffle: st.shuffle || false,
                                    volume: st.volume ?? 100,
                                    songs: (st.songs || []).map(song => ({
                                        name: song.name,
                                        type: song.type,
                                        url: song.url || null,
                                        videoId: song.videoId || null,
                                        volume: song.volume ?? 100,
                                        startTime: song.startTime ?? 0,
                                        endTime: song.endTime ?? null,
                                        needsFile: song.type === 'file'
                                    }))
                                })) : [],
                                // Ensure name is saved for appendix entries
                                appendix: Array.isArray(book.appendix) ? book.appendix.map(entry => ({ ...entry, name: entry.name || null })) : []
                            };
                            const jsonString = JSON.stringify(savableBook);
                            // (Removed keep-alive checkbox read: no such control exists in the UI, B4)
                            localStorage.setItem(LOCAL_STORAGE_KEY, jsonString);
                        } catch (error) {
                            console.error("Error autosaving to local storage:", error);
                            showTemporaryMessage("Autosave failed. Check console.", "error");
                        }
                    }

                    // Returns the best available saved book JSON string, migrating from any
                    // older version-suffixed key (storytellerBookData_vXX.Y) if the fixed key
                    // is empty. The legacy key is preserved as a backup (B2).
                    function readSavedBookRaw() {
                        const current = localStorage.getItem(LOCAL_STORAGE_KEY);
                        if (current) return current;

                        let bestKey = null, bestVersion = -Infinity;
                        for (let i = 0; i < localStorage.length; i++) {
                            const key = localStorage.key(i);
                            if (key && key.startsWith(LEGACY_KEY_PREFIX)) {
                                const v = parseFloat(key.slice(LEGACY_KEY_PREFIX.length));
                                if (!isNaN(v) && v >= bestVersion) { bestVersion = v; bestKey = key; }
                            }
                        }
                        if (!bestKey) return null;

                        const legacy = localStorage.getItem(bestKey);
                        if (legacy) {
                            log(`Migrating book from legacy key "${bestKey}" -> "${LOCAL_STORAGE_KEY}".`);
                            try {
                                localStorage.setItem(LOCAL_STORAGE_KEY, legacy); // adopt under the fixed key; keep legacy as backup
                            } catch (e) {
                                console.error("Could not write migrated book to fixed key:", e);
                            }
                        }
                        return legacy;
                    }

                    function loadFromLocalStorage() {
                        log("Attempting to load from local storage...");
                        const savedData = readSavedBookRaw();
                        if (!savedData) {
                            log("No data found in local storage.");
                            try {
                                const savedSearches = localStorage.getItem(YT_RECENT_SEARCHES_KEY);
                                if (savedSearches) recentYoutubeSearches = JSON.parse(savedSearches);
                            } catch (e) {
                                console.error("Error loading recent YouTube searches:", e);
                            }
                            return false;
                        }
                        try {
                            const loadedData = JSON.parse(savedData);
                            if (!loadedData || typeof loadedData !== 'object') {
                                throw new Error("Invalid book data format in local storage.");
                            }

                            const defaultBookData = getDefaultBook();
                            try {
                                const savedSearches = localStorage.getItem(YT_RECENT_SEARCHES_KEY);
                                if (savedSearches) recentYoutubeSearches = JSON.parse(savedSearches);
                            } catch (e) {
                                console.error("Error loading recent YouTube searches:", e);
                                recentYoutubeSearches = [];
                            }
                            book = { ...defaultBookData };

                            book.settings = { ...defaultBookData.settings, ...(loadedData.settings || {}) };
                            if (book.settings.compoundPhrasing === undefined) book.settings.compoundPhrasing = defaultBookData.settings.compoundPhrasing;
                            if (typeof book.settings.accuracyThreshold !== 'number' || isNaN(book.settings.accuracyThreshold)) book.settings.accuracyThreshold = defaultBookData.settings.accuracyThreshold;
                            book.settings.accuracyThreshold = Math.max(0.5, Math.min(1, book.settings.accuracyThreshold));
                            if (typeof book.settings.stopAudioOnChapterChange === 'boolean') {
                                book.settings.stopAudioMode = book.settings.stopAudioOnChapterChange ? 'all' : 'autoplay';
                                delete book.settings.stopAudioOnChapterChange;
                            }
                            const validStopModes = ['all', 'autoplay', 'smart', 'indexContinue'];
                            if (!validStopModes.includes(book.settings.stopAudioMode)) {
                                book.settings.stopAudioMode = defaultBookData.settings.stopAudioMode;
                            }
                            delete book.settings.compoundFunction; delete book.settings.customCompoundWords;
                            book.settings.stopPhrases = book.settings.stopPhrases || book.settings.masterStopKeywords || [];
                            book.settings.customEnterPhrases = book.settings.customEnterPhrases || book.settings.customTransitionCues || [];
                            book.settings.customExitPhrases = book.settings.customExitPhrases || book.settings.customEndPhrases || [];
                            book.settings.daytimeTransitionPhrases = book.settings.daytimeTransitionPhrases || book.settings.dayTransitionPhrases || [];
                            book.settings.nighttimeTransitionPhrases = book.settings.nighttimeTransitionPhrases || book.settings.nightTransitionPhrases || [];
                            book.settings.autoplayOnClick = book.settings.autoplayOnClick || 'listening';
                            book.settings.masterVolume = typeof book.settings.masterVolume === 'number' ? Math.max(0, Math.min(100, book.settings.masterVolume)) : defaultBookData.settings.masterVolume;
                            book.settings.syrinscapeAuthToken = loadedData.settings?.syrinscapeAuthToken || null;


                            delete book.settings.masterStopKeywords;
                            delete book.settings.customTransitionCues;
                            delete book.settings.customEndPhrases;
                            delete book.settings.dayTransitionPhrases;
                            delete book.settings.nightTransitionPhrases;


                            book.nextPageId = loadedData.nextPageId ?? defaultBookData.nextPageId;
                            book.nextChapterId = loadedData.nextChapterId ?? defaultBookData.nextChapterId;
                            book.nextTagId = loadedData.nextTagId ?? defaultBookData.nextTagId;
                            book.nextCollectionId = loadedData.nextCollectionId ?? defaultBookData.nextCollectionId;
                            book.activeChapterId = loadedData.activeChapterId ?? defaultBookData.activeChapterId;
                            book.collections = Array.isArray(loadedData.collections) ? loadedData.collections : [];
                            // Ensure new properties exist on loaded collections
                            book.collections.forEach(c => {
                                c.tagIds = c.tagIds || []; // Ensure tagIds array exists
                                c.tagMatchRule = c.tagMatchRule || 'any'; // Ensure tagMatchRule exists
                            });
                            const loadedPages = [];
                            if (Array.isArray(loadedData.pages)) {
                                loadedData.pages.forEach(item => {
                                    if (!item || typeof item.title !== 'string' || item.id === undefined || item.id === null) return;
                                    let loopCount = 0;
                                    if (typeof item.loopCount === 'number') {
                                        loopCount = item.loopCount;
                                    } else if (item.loop === true) {
                                        loopCount = -1;
                                    }

                                    let sourcesData = [];
                                    if (Array.isArray(item.sources)) {
                                        log(`[loadFromLocalStorage] Processing sources for page "${item.title}" (ID: ${item.id})`);
                                        sourcesData = item.sources.map((variationContainer, index) => {
                                            log(`[loadFromLocalStorage] -> Variation #${index}:`, JSON.parse(JSON.stringify(variationContainer)));
                                            if (variationContainer.type && variationContainer.sources === undefined) {
                                                log(`[loadFromLocalStorage] -> -> Detected old format source. Wrapping in variation container.`);
                                                const subSource = { ...variationContainer, needsFile: variationContainer.type === 'file' };
                                                return { id: `var_${generateUUID()}`, name: variationContainer.name || null, isDefault: variationContainer.isDefault || false, conditions: variationContainer.conditions || null, variationKeywords: variationContainer.variationKeywords || [], sources: [subSource] };
                                            }
                                            if (Array.isArray(variationContainer.sources)) {
                                                log(`[loadFromLocalStorage] -> -> Detected new format with ${variationContainer.sources.length} sub-sources. Processing them.`);
                                                const processedSubSources = variationContainer.sources.map(subSource => ({
                                                    ...subSource, // Keep all existing properties from the sub-source (incl. audioHash)
                                                    source: subSource.type === 'youtube' ? (subSource.source || extractYouTubeVideoId(subSource.fileName || '')) : null,
                                                    // Files with cached bytes (audioHash) are rehydrated from IndexedDB, no relink (B3)
                                                    needsFile: subSource.type === 'file' && !subSource.audioHash
                                                }));
                                                return { ...variationContainer, sources: processedSubSources };
                                            }
                                            console.warn(`[loadFromLocalStorage] -> -> Variation container for page "${item.title}" is in an unknown format or has no sources array.`, variationContainer);
                                            return { ...variationContainer, sources: [] };
                                        });
                                    }

                                    const newPage = {
                                        id: item.id, title: item.title, primaryKey: item.primaryKey || null,
                                        keywords: Array.isArray(item.keywords) ? item.keywords : [],
                                        phrases: Array.isArray(item.phrases) ? item.phrases : [],
                                        isStarred: item.isStarred || false,
                                        volume: typeof item.volume === 'number' ? item.volume : 80,
                                        loop: loopCount !== 0, loopCount: loopCount,
                                        fadeInOut: typeof item.fadeInOut === 'boolean' ? item.fadeInOut : false,
                                        endPlayKeywords: Array.isArray(item.endPlayKeywords) ? item.endPlayKeywords : [],
                                        nextPageId: item.nextPageId ?? null,
                                        timeOfDaySetting: ['day', 'night', 'always'].includes(item.timeOfDaySetting) ? item.timeOfDaySetting : 'always',
                                        currentLoop: 0, sources: sourcesData
                                    };
                                    loadedPages.push(newPage);
                                    if (typeof item.id === 'number' && item.id >= book.nextPageId) {
                                        book.nextPageId = item.id + 1;
                                    }
                                });
                            }
                            book.pages = loadedPages;

                            const loadedChapters = [];
                            let indexChapterFound = false;
                            if (Array.isArray(loadedData.chapters)) {
                                loadedData.chapters.forEach(item => {
                                    if (!item || typeof item.name !== 'string' || item.id === undefined || item.id === null) return;
                                    const newChapter = {
                                        id: item.id, name: item.name, isIndex: item.isIndex || false,
                                        isStarred: item.isStarred || false,
                                        pageIds: Array.isArray(item.pageIds) ? item.pageIds.filter(id => book.pages.some(p => p.id === id)) : [],
                                        chapterKeywords: Array.isArray(item.chapterKeywords || item.transitionWords) ? (item.chapterKeywords || item.transitionWords) : [],
                                        tagIds: Array.isArray(item.tagIds) ? item.tagIds : [],
                                        autoPlayPageIds: Array.isArray(item.autoPlayPageIds) ? item.autoPlayPageIds.filter(id => book.pages.some(p => p.id === id)) : [],
                                        leaveSoundPageIds: Array.isArray(item.leaveSoundPageIds) ? item.leaveSoundPageIds.filter(id => book.pages.some(p => p.id === id)) : [],
                                        leaveTransitionTargetId: item.leaveTransitionTargetId || 'index'
                                    };
                                    loadedChapters.push(newChapter);
                                    if (newChapter.isIndex) indexChapterFound = true;
                                    if (typeof item.id === 'number' && item.id >= book.nextChapterId) {
                                        book.nextChapterId = item.id + 1;
                                    } else if (typeof item.id === 'string' && item.id !== 'index') {
                                        const numericPart = parseInt(item.id.replace(/[^0-9]/g, ''), 10);
                                        if (!isNaN(numericPart) && numericPart >= book.nextChapterId) {
                                            book.nextChapterId = numericPart + 1;
                                        }
                                    }
                                });
                            }
                            if (!indexChapterFound && loadedChapters.every(ch => ch.id !== 'index')) {
                                loadedChapters.unshift({ ...defaultBookData.chapters[0] });
                            }
                            book.chapters = loadedChapters.length > 0 ? loadedChapters : [{ ...defaultBookData.chapters[0] }];


                            book.pages.forEach(page => {
                                page.sources.forEach(source => {
                                    if (Array.isArray(source.chapterIds)) {
                                        source.chapterIds = source.chapterIds.filter(chId => book.chapters.some(ch => ch.id == chId));
                                        if (source.chapterIds.length === 0) source.chapterIds = null;
                                    }
                                });
                            });


                            const validActiveId = book.chapters.some(ch => ch.id == loadedData.activeChapterId);
                            book.activeChapterId = validActiveId ? loadedData.activeChapterId : 'index';
                            currentTimeOfDay = book.currentTimeOfDay;

                            book.nextPageId = loadedData.nextPageId ?? book.nextPageId;
                            book.nextChapterId = loadedData.nextChapterId ?? book.nextChapterId;

                            if (loadedData.storyPlot && typeof loadedData.storyPlot === 'object') {
                                book.storyPlot.nodes = Array.isArray(loadedData.storyPlot.nodes) ? loadedData.storyPlot.nodes.filter(n => n && n.id && n.chapterId !== undefined) : [];
                                book.storyPlot.threads = Array.isArray(loadedData.storyPlot.threads) ? loadedData.storyPlot.threads.filter(t => t && t.id && t.fromNodeId && t.toNodeId) : [];
                                book.storyPlot.nextPlotNodeId = typeof loadedData.storyPlot.nextPlotNodeId === 'number' ? loadedData.storyPlot.nextPlotNodeId : 0;
                                book.storyPlot.nextPlotThreadId = typeof loadedData.storyPlot.nextPlotThreadId === 'number' ? loadedData.storyPlot.nextPlotThreadId : 0;
                                book.storyPlot.nextPlotNodeId = typeof loadedData.storyPlot.nextPlotNodeId === 'number' ? loadedData.storyPlot.nextPlotNodeId : 0;
                                book.storyPlot.nextPlotThreadId = typeof loadedData.storyPlot.nextPlotThreadId === 'number' ? loadedData.storyPlot.nextPlotThreadId : 0;
                                book.storyPlot.viewTransform = (loadedData.storyPlot.viewTransform && typeof loadedData.storyPlot.viewTransform.scale === 'number') ?
                                    { ...loadedData.storyPlot.viewTransform } :
                                    { x: 0, y: 0, scale: 1.0 };
                            } else {
                                book.storyPlot = getDefaultBook().storyPlot;
                            }
                            plotBoardView = { ...book.storyPlot.viewTransform };

                            // Load Appendix
                            if (Array.isArray(loadedData.appendix)) {
                                book.appendix = loadedData.appendix.map(entry => ({ ...entry, name: entry.name || null }));
                                book.appendix.forEach(entry => {
                                    if (entry.trigger?.type === 'chapter_has_tag' && entry.trigger.tagId) {
                                        entry.trigger.conditions = [{ type: 'tag_is', params: { tagId: entry.trigger.tagId } }];
                                    }
                                });
                            } else {
                                book.appendix = [];
                            }

                            // Load Soundtracks
                            if (Array.isArray(loadedData.soundtracks)) {
                                book.soundtracks = loadedData.soundtracks.map(st => ({
                                    ...st,
                                    chapters: st.chapters || (st.chapter && st.chapter !== 'none' ? [st.chapter] : []),
                                    songs: (st.songs || []).map(song => ({
                                        ...song,
                                        needsFile: song.type === 'file'
                                    }))
                                }));
                            } else {
                                book.soundtracks = [];
                            }

                            log("Book data successfully parsed and applied from local storage.");
                            return true;

                        } catch (error) {
                            console.error("Error loading book from local storage:", error);
                            showTemporaryMessage(`Load from autosave failed: ${error.message}. Starting fresh.`, "error", 5000);
                            localStorage.removeItem(LOCAL_STORAGE_KEY);
                            book = getDefaultBook();
                            currentListeningMode = book.settings.listeningMode;
                            isSmartFilteringEnabled = book.settings.smartFiltering;
                            isCompoundPhrasingEnabled = book.settings.compoundPhrasing;
                            currentKeywordConfidenceThreshold = book.settings.accuracyThreshold;
                            stopAudioMode = book.settings.stopAudioMode;
                            currentMasterVolume = book.settings.masterVolume;
                            masterVolumeSlider.value = currentMasterVolume;
                            masterVolumeValueSpan.textContent = `${currentMasterVolume}`;
                            stopPhrases = book.settings.stopPhrases;
                            customEnterPhrases = book.settings.customEnterPhrases;
                            customExitPhrases = book.settings.customExitPhrases;
                            daytimeTransitionPhrases = book.settings.daytimeTransitionPhrases;
                            nighttimeTransitionPhrases = book.settings.nighttimeTransitionPhrases;
                            autoplayOnClickSetting = book.settings.autoplayOnClick;
                            youtubeApiKeys = book.settings.youtubeApiKeys || [];
                            syrinscapeAuthToken = book.settings.syrinscapeAuthToken;
                            syrinscapePlayerReady = false;
                            currentTimeOfDay = book.currentTimeOfDay;
                            plotBoardView = { ...book.storyPlot.viewTransform };
                            return false;
                        }
                    }

                    // --- YouTube Preview Player Callbacks ---
                    function onYtPreviewPlayerReady(event) {
                        log(`%c[PREVIEW]`, 'color: #9966CC; font-weight: bold;', `onYtPreviewPlayerReady fired. Player is ready.`);
                        if (activePreviewContext && activePreviewContext.type === 'youtube') {
                            log(`%c[PREVIEW]`, 'color: #9966CC; font-weight: bold;', `Context found. Attempting to initialize sliders.`);
                            log(`%c[PREVIEW]`, 'color: #9966CC; font-weight: bold;', `Context details:`, JSON.parse(JSON.stringify(activePreviewContext)));

                            // Give the player a moment to load metadata and duration
                            let attempts = 0;
                            const maxAttempts = 10; // Try for up to 1 second (10 * 100ms)
                            const checkDurationAndInit = () => {
                                const duration = event.target.getDuration ? event.target.getDuration() : 0;
                                if (duration > 0 || attempts >= maxAttempts) {
                                    log(`%c[PREVIEW]`, 'color: #9966CC; font-weight: bold;', `Duration is ${duration}. Initializing sliders.`);
                                    initializePreviewSliders(activePreviewContext.container, event.target);
                                } else {
                                    attempts++;
                                    setTimeout(checkDurationAndInit, 100);
                                }
                            };
                            checkDurationAndInit();
                        }
                    }

                    function onYtPreviewPlayerStateChange(event) { // This function is correct
                        log(`%c[PREVIEW]`, 'color: #9966CC; font-weight: bold;', `onYtPreviewPlayerStateChange fired. New state: ${event.data}`);
                        const playerState = event.data;

                        // When a new video is cued, its metadata (like duration) is available.
                        // This is the key to fixing the issue for subsequent videos.
                        if (playerState === YT.PlayerState.CUED) {
                            log(`%c[PREVIEW]`, 'color: #9966CC; font-weight: bold;', `Video cued. Re-initializing sliders for new video.`);
                            if (activePreviewContext && activePreviewContext.type === 'youtube') {
                                const startTime = activePreviewContext.startTime;
                                // Seek to the start time when the video is cued and ready.
                                if (startTime !== null && startTime > 0) {
                                    log(`%c[PREVIEW]`, 'color: #9966CC; font-weight: bold;', `Seeking to initial start time: ${startTime} seconds.`);
                                    event.target.seekTo(startTime, true); // Seek...
                                    event.target.pauseVideo(); // ...and then immediately pause to prevent autoplay on seek.
                                } else {
                                    event.target.seekTo(0, true); // Ensure it's at the beginning if no start time is set
                                    event.target.pauseVideo();
                                }
                                initializePreviewSliders(activePreviewContext.container, event.target);
                            }
                        }

                        if (playerState === YT.PlayerState.PLAYING) {
                            if (currentlyPlayingYtTile && activePreviewContext?.container === currentlyPlayingYtTile.querySelector('.media-preview-container')) {
                                const playIcon = currentlyPlayingYtTile.querySelector('.media-preview-play-pause-btn i');
                                // const pauseIcon = currentlyPlayingYtTile.querySelector('.yt-pause-icon');
                                if (playIcon) playIcon.className = 'fas fa-pause fa-fw';
                                startYtPreviewInterval();
                                updateYtPreviewTime();
                            }
                        } else {
                            if (currentlyPlayingYtTile) {
                                const playIcon = currentlyPlayingYtTile.querySelector('.media-preview-play-pause-btn i');
                                // const pauseIcon = currentlyPlayingYtTile.querySelector('.yt-pause-icon');
                                if (playIcon) playIcon.className = 'fas fa-play fa-fw';
                            }
                            stopYtPreviewInterval();
                        }
                    }

                    function onYtPreviewPlayerError(event) {
                        console.error(`%c[PREVIEW]`, 'color: #FF6347; font-weight: bold;', `YouTube Preview Player Error: ${event.data} for video ID: ${currentYtPreviewVideoId}`);
                        showTemporaryMessage(`Could not play preview for this video (Error: ${event.data})`, 'error');
                        if (currentlyPlayingYtTile) {
                            currentlyPlayingYtTile.classList.remove('is-playing');
                            currentlyPlayingYtTile = null;
                        }
                        stopYtPreviewInterval();
                    }

                    // --- YouTube Preview Player Controls ---
                    function updateYtPreviewTime() {
                        if (ytPreviewPlayer && typeof ytPreviewPlayer.getCurrentTime === 'function' && ytPreviewPlayer.getDuration && currentlyPlayingYtTile) {
                            // This is now handled by the generic updateModalPreviewUI function
                            updateModalPreviewUI();
                        }
                    }
                    function startYtPreviewInterval() { stopYtPreviewInterval(); ytPreviewUpdateInterval = setInterval(updateYtPreviewTime, 250); }
                    function stopYtPreviewInterval() { clearInterval(ytPreviewUpdateInterval); }

                    function formatTime(seconds) {
                        if (isNaN(seconds) || seconds < 0) return '0:00';
                        const min = Math.floor(seconds / 60);
                        const sec = Math.floor(seconds % 60);
                        return `${min}:${sec < 10 ? '0' : ''}${sec}`;
                    }

                    function selectYoutubeVideo(videoUrl) {
                        if (currentYoutubeSearchContext === 'add') {
                            addYoutubeUrlInput.value = videoUrl;
                            checkYouTubeEmbeddability(addYoutubeUrlInput, addYoutubeUrlStatus);
                        } else if (currentYoutubeSearchContext === 'source') {
                            sourceYoutubeUrlInput.value = videoUrl;
                            checkYouTubeEmbeddability(sourceYoutubeUrlInput, sourceYoutubeUrlStatus);
                        }
                        closeYoutubeSearchModal();
                    }



                    // --- Keyboard Shortcuts ---
                    document.addEventListener('keydown', (event) => {
                        const inInput = event.target.tagName === 'INPUT' || event.target.tagName === 'TEXTAREA' || event.target.isContentEditable;
                        const addModalVisible = addEditSourceModal.style.display === 'flex' && currentSyrinscapeSearchContext === 'add'; // More specific check for when it's acting as the "Add Page" source modal
                        const editPageModalVisible = editPageModal.style.display === 'flex';
                        const editChapterModalVisible = editChapterModal.style.display === 'flex';
                        const settingsModalVisible = settingsModal.style.display === 'flex';
                        const guidebookModalVisible = guidebookModal.style.display === 'flex';
                        const variationModalVisible = variationSettingsModal.style.display === 'flex';
                        const plotterModalVisible = storyPlotterModal.style.display === 'flex';
                        const threadMenuVisible = plotThreadMenu.style.display === 'block';
                        const syrinscapeSearchModalVisible = syrinscapeSearchModal.style.display === 'flex';

                        const anySubModalOpen = addModalVisible || editPageModalVisible || editChapterModalVisible || settingsModalVisible || guidebookModalVisible || variationModalVisible || threadMenuVisible || syrinscapeSearchModalVisible;
                        const anyModalOpenForGlobalShortcuts = anySubModalOpen || plotterModalVisible;

                        const inCollectionRename = event.target.tagName === 'INPUT' && event.target.closest('.collection-header');

                        if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
                            if (addModalVisible) { addButton.click(); event.preventDefault(); }
                            else if (editPageModalVisible) { saveEditButton.click(); event.preventDefault(); }
                            else if (editChapterModalVisible) { saveChapterEditButton.click(); event.preventDefault(); }
                            else if (settingsModalVisible) { saveSettingsButton.click(); event.preventDefault(); }
                            else if (variationModalVisible) { saveSourceVariationButton.click(); event.preventDefault(); }
                            else if (threadMenuVisible) { savePlotThreadChangesButton.click(); event.preventDefault(); } // Add appendix save here later
                            else if (syrinscapeSearchModalVisible && syrinscapeSearchQueryInput === document.activeElement) { executeSyrinscapeSearchButton.click(); event.preventDefault(); }
                            else if (saveFileModal.style.display === 'flex') { saveFileButton.click(); event.preventDefault(); }
                        } else if (event.key === 'Escape') {
                            if (syrinscapeSearchModalVisible) { cancelSyrinscapeSearchButton.click(); event.preventDefault(); }
                            else if (threadMenuVisible) { cancelPlotThreadMenuButton.click(); event.preventDefault(); }
                            else if (appendixEffectModal.style.display === 'flex') { cancelAppendixEffectButton.click(); event.preventDefault(); }
                            else if (plotterModalVisible && !anySubModalOpen) { closeStoryPlotterButton.click(); event.preventDefault(); }
                            else if (variationModalVisible) { cancelSourceVariationButton.click(); event.preventDefault(); }
                            else if (addModalVisible) { cancelAddButton.click(); event.preventDefault(); }
                            else if (editPageModalVisible) { cancelEditButton.click(); event.preventDefault(); }
                            else if (editChapterModalVisible) { cancelChapterEditButton.click(); event.preventDefault(); }
                            else if (settingsModalVisible) { cancelSettingsButton.click(); event.preventDefault(); }
                            else if (guidebookModalVisible) { closeGuidebookButton.click(); event.preventDefault(); }
                            else if (addEditAppendixEntryModal.style.display === 'flex') { cancelAppendixEntryButton.click(); event.preventDefault(); }
                            else if (appendixModal.style.display === 'flex') { closeAppendixModalButton.click(); event.preventDefault(); }
                            else if (saveFileModal.style.display === 'flex') { cancelSaveFileButton.click(); event.preventDefault(); }

                        } else if (!inInput && !anyModalOpenForGlobalShortcuts && !inCollectionRename) {
                            if ((event.ctrlKey || event.metaKey) && event.key === 's') {
                                event.preventDefault(); openSaveFileModalButton.click();
                            } else if ((event.ctrlKey || event.metaKey) && event.key === 'o') {
                                event.preventDefault(); const loadLabel = document.querySelector('label[title*="Load a book file"]'); if (loadLabel) loadLabel.click(); showTemporaryMessage("Load Book from File (Shortcut)", "info", 1500);
                            } else if ((event.ctrlKey || event.metaKey) && event.key === 'q') {
                                event.preventDefault(); stopAllSoundsButton.click(); showTemporaryMessage("All Sounds Stopped (Shortcut)", "info", 1500);
                            }
                        }
                    });
                    document.addEventListener('keydown', (event) => {
                        const anyModalOpen = modalOverlay.style.display === 'block' || storyPlotterModal.style.display === 'flex' || plotThreadMenu.style.display === 'block' || syrinscapeSearchModal.style.display === 'flex' || appendixModal.style.display === 'flex' || addEditAppendixEntryModal.style.display === 'flex' || appendixEffectModal.style.display === 'flex';
                        if (event.target.tagName === 'INPUT' || event.target.tagName === 'TEXTAREA' || event.target.isContentEditable || anyModalOpen) return;

                        if (event.key === ' ' && !event.repeat) {
                            if (currentListeningMode === 'push') {
                                if (!isListening) {
                                    pttActive = true;
                                    resetSpeechRetryState();
                                    startListening();
                                }
                            } else if (currentListeningMode === 'toggle') {
                                if (isListening) stopListening(true); else { resetSpeechRetryState(); startListening(); }
                            }
                            event.preventDefault();
                        }
                    });
                    document.addEventListener('keyup', (event) => {
                        const anyModalOpen = modalOverlay.style.display === 'block' || storyPlotterModal.style.display === 'flex' || plotThreadMenu.style.display === 'block' || syrinscapeSearchModal.style.display === 'flex' || appendixModal.style.display === 'flex' || addEditAppendixEntryModal.style.display === 'flex' || appendixEffectModal.style.display === 'flex';
                        if (event.target.tagName === 'INPUT' || event.target.tagName === 'TEXTAREA' || event.target.isContentEditable || anyModalOpen) return;

                        if (event.key === ' ') {
                            if (currentListeningMode === 'push') {
                                if (isListening && pttActive) {
                                    pttActive = false;
                                    stopListening(true);
                                }
                            }
                            event.preventDefault();
                        }
                    });

                    // --- Guidebook Filtering ---
                    function filterGuidebook() {
                        const searchTerm = guidebookSearchInput.value.toLowerCase().trim();
                        const sections = guidebookEntriesDiv.querySelectorAll('.guidebook-section');
                        sections.forEach(section => {
                            const textContent = section.textContent.toLowerCase();
                            if (textContent.includes(searchTerm)) {
                                section.classList.remove('hidden-by-search');
                            } else {
                                section.classList.add('hidden-by-search');
                            }
                        });
                    }

                    // --- Syrinscape Integration Functions ---

                    async function initializeSyrinscapePlayer() {
                        if (!syrinscapeAuthToken) {
                            showTemporaryMessage('Syrinscape Auth Token not set in Settings.', 'error', 4000);
                            syrinscapePlayerReady = false;
                            return;
                        }
                        if (typeof syrinscape === 'undefined' || !syrinscape.player) {
                            showTemporaryMessage('Syrinscape libraries not loaded. Please wait or refresh.', 'error', 4000);
                            syrinscapePlayerReady = false;
                            return;
                        }

                        log("Initializing Syrinscape player with token:", syrinscapeAuthToken);
                        showTemporaryMessage('Initializing Syrinscape Player...', 'info', 3000);

                        try {
                            syrinscape.player.init({
                                configure: async () => {
                                    log("Syrinscape player.init configure callback - setting token.");
                                    syrinscape.config.token = syrinscapeAuthToken;
                                    await syrinscape.config.sync();
                                    log("Syrinscape token configured and synced.");
                                },
                                onActive: () => {
                                    log('Syrinscape Player activated (audio context ready).');
                                    syrinscapePlayerReady = true;
                                    showTemporaryMessage('Syrinscape Player Initialized & Active!', 'success', 3000);
                                },
                                onInactive: () => {
                                    console.warn('Syrinscape Player became inactive.');
                                    syrinscapePlayerReady = false;
                                }
                            });
                            if (syrinscape.player.audioContext && syrinscape.player.audioContext.state !== 'running') {
                                showTemporaryMessage('Syrinscape may need a click on the page to activate audio.', 'info', 5000);
                            } else if (syrinscape.player.audioContext && syrinscape.player.audioContext.state === 'running' && !syrinscapePlayerReady) {
                                log('Syrinscape audio context is running, but onActive callback has not fired yet.');
                            }

                        } catch (error) {
                            console.error("Error during syrinscape.player.init:", error);
                            showTemporaryMessage(`Syrinscape Init Error: ${error.message}`, 'error', 5000);
                            syrinscapePlayerReady = false;
                        }
                    }


                    function openSyrinscapeSearchModal(context) {
                        if (!syrinscapeAuthToken) {
                            showTemporaryMessage('Set Syrinscape Auth Token in Settings to search.', 'error', 4000);
                            return;
                        }
                        log(`Opening Syrinscape search modal for context: ${context}`);
                        currentSyrinscapeSearchContext = context;
                        syrinscapeSearchQueryInput.value = '';
                        syrinscapeSearchResultsUl.innerHTML = '';
                        syrinscapeSearchStatusP.textContent = 'Enter a search term and click search.';
                        modalOverlay.style.display = 'block';
                        syrinscapeSearchModal.style.display = 'flex';
                        syrinscapeSearchQueryInput.focus();
                    }

                    function closeSyrinscapeSearchModal() {
                        if (activeSyrinscapePreview && syrinscapePlayerReady && syrinscape.player && syrinscape.player.controlSystem) {
                            log(`Stopping preview from modal close: ID=${activeSyrinscapePreview.elementId}, Kind=${activeSyrinscapePreview.kind}`);
                            const elementId = parseInt(activeSyrinscapePreview.elementId, 10);
                            const kind = activeSyrinscapePreview.kind?.toLowerCase();
                            if (kind === 'mood' || kind === 'moods') {
                                syrinscape.player.controlSystem.stopMood(elementId);
                            } else if (kind === 'music') {
                                // Music might need to be stopped via stopElements
                                log(`Stopping Syrinscape music preview via stopElements: ID=${elementId}`);
                                syrinscape.player.controlSystem.stopElements([elementId.toString()]);
                            } else {
                                syrinscape.player.controlSystem.stopElements([elementId.toString()]);
                            }
                            if (activeSyrinscapePreview.buttonElement) {
                                activeSyrinscapePreview.buttonElement.classList.remove('playing-preview');
                                activeSyrinscapePreview.buttonElement.innerHTML = '<i class="fas fa-play fa-fw"></i>';
                                activeSyrinscapePreview.buttonElement.title = 'Preview Sound';
                            }
                        }
                        activeSyrinscapePreview = null;

                        modalOverlay.style.display = 'none';
                        syrinscapeSearchModal.style.display = 'none';
                        currentSyrinscapeSearchContext = null;
                    }

                    async function executeSyrinscapeAPISearch() {
                        const query = syrinscapeSearchQueryInput.value.trim();
                        if (!query) {
                            syrinscapeSearchStatusP.textContent = 'Please enter a search term.';
                            return;
                        }
                        if (!syrinscapeAuthToken) {
                            syrinscapeSearchStatusP.textContent = 'Syrinscape Auth Token not set in Settings.';
                            showTemporaryMessage('Syrinscape Auth Token not set in Settings.', 'error', 4000);
                            return;
                        }

                        syrinscapeSearchStatusP.textContent = 'Searching...';
                        syrinscapeSearchResultsUl.innerHTML = '';

                        const headers = new Headers();
                        headers.append('Authorization', `Token ${syrinscapeAuthToken}`);
                        headers.append('Accept', 'application/json');

                        const params = new URLSearchParams({ q: query, library: 'Available to Play', pp: 50 });
                        const requestUrl = `${SYRINSCAPE_API_SEARCH_URL}?${params.toString()}`;
                        log(`Requesting Syrinscape search: ${requestUrl}`);

                        try {
                            const response = await fetch(requestUrl, { method: 'GET', headers: headers });
                            if (!response.ok) {
                                const errorText = await response.text();
                                console.error("Syrinscape API Error Response Text:", errorText);
                                let errorDetail = `HTTP error ${response.status}`;
                                try {
                                    const errorJson = JSON.parse(errorText);
                                    errorDetail = errorJson.detail || errorJson.message || errorDetail;
                                } catch (e) { /* Ignore if not JSON */ }
                                throw new Error(errorDetail);
                            }
                            const data = await response.json();
                            log("Syrinscape Search API Response:", data);
                            renderSyrinscapeSearchResults(data.results || []);
                        } catch (error) {
                            console.error("Error searching Syrinscape:", error);
                            syrinscapeSearchStatusP.textContent = `Error: ${error.message}`;
                            showTemporaryMessage(`Syrinscape Search Error: ${error.message}`, 'error', 5000);
                        }
                    }

                    function renderSyrinscapeSearchResults(results) {
                        syrinscapeSearchResultsUl.innerHTML = '';
                        let displayedCount = 0;

                        if (!results || results.length === 0) {
                            syrinscapeSearchStatusP.textContent = 'No results found.';
                            return;
                        }

                        results.forEach(item => {
                            const elementId = item.pk || item.uuid;
                            const elementName = item.title;
                            const elementKind = item.model_human_name || item.model_name;
                            const soundsetName = item.soundset_name;

                            if (elementKind && elementKind.toLowerCase().includes('sample')) {
                                log(`Hiding Sample: ${elementName} (ID: ${elementId}, Kind: ${elementKind})`);
                                return;
                            }

                            if (elementId && elementName && elementKind) {
                                const li = document.createElement('li');
                                li.className = 'syrinscape-search-item';
                                li.dataset.elementId = elementId;
                                li.dataset.elementName = elementName;
                                li.dataset.elementKind = elementKind;

                                const detailsDiv = document.createElement('div');
                                detailsDiv.className = 'item-details';
                                detailsDiv.innerHTML = `
                            <span class="item-name">${elementName}</span>
                            <span class="item-type">(${elementKind})</span>
                            ${soundsetName ? `<span class="item-soundset">Soundset: ${soundsetName}</span>` : ''}
                        `;
                                detailsDiv.title = `Select to use ${elementName} (${elementKind})`;
                                detailsDiv.addEventListener('click', () => selectSyrinscapeSound(elementId, elementName, elementKind));

                                const actionsDiv = document.createElement('div');
                                actionsDiv.className = 'syrinscape-item-actions';

                                const togglePreviewButton = document.createElement('button');
                                togglePreviewButton.className = 'btn-rpg-sm btn-rpg-sm-icon syrinscape-preview-toggle-button';
                                togglePreviewButton.innerHTML = '<i class="fas fa-play fa-fw"></i>';
                                togglePreviewButton.title = 'Preview Sound';
                                togglePreviewButton.addEventListener('click', (e) => {
                                    e.stopPropagation();
                                    handleSyrinscapePreviewToggle(elementId, elementName, elementKind, togglePreviewButton);
                                });

                                actionsDiv.appendChild(togglePreviewButton);
                                li.appendChild(detailsDiv);
                                li.appendChild(actionsDiv);
                                syrinscapeSearchResultsUl.appendChild(li);
                                displayedCount++;
                            } else {
                                console.warn("Skipping Syrinscape search result item due to missing id, title, or derived kind:", item);
                            }
                        });

                        if (displayedCount === 0 && results.length > 0) {
                            syrinscapeSearchStatusP.textContent = `Found ${results.length} results, but none were displayable after filtering Samples. Check console.`;
                        } else if (displayedCount > 0) {
                            syrinscapeSearchStatusP.textContent = `Found ${displayedCount} results (Samples hidden). Click item name to select, or use preview buttons.`;
                        } else {
                            syrinscapeSearchStatusP.textContent = 'No results found.';
                        }
                    }


                    function handleSyrinscapePreviewToggle(elementId, elementName, elementKind, buttonElement) {
                        if (!syrinscapePlayerReady || !syrinscape.player || !syrinscape.player.controlSystem) {
                            showTemporaryMessage('Syrinscape player not ready for preview.', 'error');
                            return;
                        }

                        const isCurrentlyPlayingThisPreview = activeSyrinscapePreview && activeSyrinscapePreview.elementId === elementId;

                        // Stop any previously active preview if it's different from the current one
                        if (activeSyrinscapePreview && activeSyrinscapePreview.elementId !== elementId) {
                            log(`Stopping previous preview: ID=${activeSyrinscapePreview.elementId}, Kind=${activeSyrinscapePreview.kind}`);
                            const prevElementId = parseInt(activeSyrinscapePreview.elementId, 10);
                            const prevKind = activeSyrinscapePreview.kind?.toLowerCase();
                            if (prevKind === 'mood' || prevKind === 'moods') {
                                syrinscape.player.controlSystem.stopMood(prevElementId);
                            } else {
                                syrinscape.player.controlSystem.stopElements([prevElementId.toString()]);
                            }
                            if (activeSyrinscapePreview.buttonElement) {
                                activeSyrinscapePreview.buttonElement.classList.remove('playing-preview');
                                activeSyrinscapePreview.buttonElement.innerHTML = '<i class="fas fa-play fa-fw"></i>';
                                activeSyrinscapePreview.buttonElement.title = 'Preview Sound';
                            }
                        }

                        if (isCurrentlyPlayingThisPreview) { // If this preview is playing, stop it
                            log(`Stopping Syrinscape preview: ID=${elementId}, Kind=${elementKind}`);
                            const idToStop = parseInt(elementId, 10);
                            const kindToStop = elementKind?.toLowerCase();
                            if (kindToStop === 'mood' || kindToStop === 'moods') {
                                syrinscape.player.controlSystem.stopMood(idToStop);
                            } else {
                                syrinscape.player.controlSystem.stopElements([idToStop.toString()]);
                            }
                            buttonElement.classList.remove('playing-preview');
                            buttonElement.innerHTML = '<i class="fas fa-play fa-fw"></i>';
                            buttonElement.title = 'Preview Sound';
                            activeSyrinscapePreview = null;
                        } else { // Start this preview
                            log(`Playing Syrinscape preview: ID=${elementId}, Kind=${elementKind}, Name="${elementName}"`);
                            const idToPlay = parseInt(elementId, 10);
                            const kindToPlay = elementKind?.toLowerCase();

                            if (kindToPlay === 'mood' || kindToPlay === 'moods') {
                                syrinscape.player.controlSystem.startMood(idToPlay);
                            } else {
                                syrinscape.player.controlSystem.startElements([idToPlay.toString()]);
                            }
                            activeSyrinscapePreview = { elementId, elementName, elementKind, buttonElement };
                            buttonElement.classList.add('playing-preview');
                            buttonElement.innerHTML = '<i class="fas fa-stop fa-fw"></i>';
                            buttonElement.title = 'Stop Preview';
                        }
                    }


                    function selectSyrinscapeSound(elementId, elementName, elementKind) {
                        log(`Syrinscape sound selected: ID=${elementId}, Name=${elementName}, Kind=${elementKind}, Context: ${currentSyrinscapeSearchContext}`);
                        let targetLoopCb, targetIndefCb, targetCountIn, targetLoopOptionsDiv, targetEndKeywordsDiv, targetDurationInput;

                        if (currentSyrinscapeSearchContext === 'add') {
                            addSyrinscapeElementIdInput.value = elementId;
                            addSyrinscapeKindInput.value = elementKind;
                            addSyrinscapeSelectedSoundSpan.textContent = `${elementName} (${elementKind})`;
                            addSyrinscapeSelectedSoundSpan.dataset.syrinscapeName = elementName;
                            addSyrinscapeSelectedSoundSpan.dataset.syrinscapeKind = elementKind;
                            targetLoopCb = addLoopSoundCheckbox;
                            targetIndefCb = addLoopIndefinitelyCheckbox;
                            targetCountIn = addLoopCountInput;
                            targetLoopOptionsDiv = addLoopOptionsContainer;
                            targetEndKeywordsDiv = addEndPlayKeywordsContainer;
                            targetDurationInput = addSyrinscapePlayDurationInput;
                        }
                        // (Removed dead 'sub-variation' branch: the variation modal's
                        //  Syrinscape source inputs were deleted from the markup, B4)

                        if (targetLoopCb) { // Ensure controls exist before trying to evaluate
                            evaluateSyrinscapeLoopControls(
                                'syrinscape',
                                elementKind,
                                targetDurationInput.value, // Use current duration from the input
                                targetLoopCb,
                                targetIndefCb,
                                targetCountIn,
                                targetLoopOptionsDiv,
                                targetEndKeywordsDiv
                            );
                        }
                        closeSyrinscapeSearchModal();
                    }

                    // --- Picture-in-Picture (PiP) Functions ---
                    function drawPipCanvas() {
                        if (!pipCanvasCtx) return;
                        const ctx = pipCanvasCtx;
                        const size = PIP_CANVAS_SIZE;
                        pipCanvas.width = size; // Set canvas drawing surface
                        pipCanvas.height = size;
                        ctx.clearRect(0, 0, size, size);

                        // Background
                        ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--pip-canvas-bg').trim();
                        ctx.fillRect(0, 0, size, size);

                        // Icon (Microphone or Stop)
                        const iconSize = size * 0.6;
                        ctx.font = `900 ${iconSize}px "Font Awesome 6 Free"`;
                        ctx.textAlign = 'center';
                        ctx.textBaseline = 'middle';

                        if (isListening) {
                            ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--pip-icon-active').trim();
                            ctx.fillText('\uf130', size / 2, size / 2 + (size * 0.05)); // fa-microphone
                        } else {
                            ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--pip-icon-inactive').trim();
                            ctx.fillText('\uf28d', size / 2, size / 2 + (size * 0.05)); // fa-stop-circle
                        }
                    }

                    async function togglePictureInPicture() { // This function is correct
                        if (!pipCanvas || !pipVideo) {
                            showTemporaryMessage("PiP elements not found.", "error");
                            return;
                        }
                        if (!('requestPictureInPicture' in HTMLVideoElement.prototype)) {
                            showTemporaryMessage("Picture-in-Picture for Video is not supported by your browser.", "error");
                            return;
                        }
                        if (!('captureStream' in HTMLCanvasElement.prototype)) {
                            showTemporaryMessage("Canvas captureStream API not supported. Cannot use PiP.", "error");
                            return;
                        }


                        try {
                            if (document.pictureInPictureElement === pipVideo) {
                                await document.exitPictureInPicture();
                                log("Exited PiP mode.");
                                if (pipStream) {
                                    pipStream.getTracks().forEach(track => track.stop());
                                    pipStream = null;
                                }
                                pipVideo.srcObject = null;
                            } else {
                                drawPipCanvas();

                                if (pipStream) {
                                    pipStream.getTracks().forEach(track => track.stop());
                                }

                                pipStream = pipCanvas.captureStream(25);
                                pipVideo.srcObject = pipStream;
                                // Attempt to set a small size for the video element itself, though browser might override for PiP
                                pipVideo.width = PIP_CANVAS_SIZE;
                                pipVideo.height = PIP_CANVAS_SIZE;


                                await pipVideo.play().catch(e => console.warn("PiP video play() was interrupted or failed:", e));

                                pipWindow = await pipVideo.requestPictureInPicture({ width: PIP_CANVAS_SIZE, height: PIP_CANVAS_SIZE }); // Attempt to suggest size
                                log("Entered PiP mode with video element.");

                                pipWindow.addEventListener('leavepictureinpicture', () => {
                                    log("PiP window closed by user or API.");
                                    if (pipStream) {
                                        pipStream.getTracks().forEach(track => track.stop());
                                        pipStream = null;
                                    }
                                    pipVideo.srcObject = null;
                                    pipWindow = null;
                                }, { once: true });
                            }
                        } catch (error) {
                            console.error("Error toggling Picture-in-Picture:", error);
                            showTemporaryMessage(`PiP Error: ${error.message}`, "error");
                            if (pipStream) {
                                pipStream.getTracks().forEach(track => track.stop());
                                pipStream = null;
                            }
                            pipVideo.srcObject = null;
                            pipWindow = null;
                        }
                    }

                    // --- YouTube Player API Callbacks for Verification ---
                    function onYtVerificationPlayerReady(event) {
                        log("YouTube verification player is ready.");
                        // Mute the player immediately to ensure no sound is heard during verification.
                        event.target.mute();
                    }

                    function onYtVerificationPlayerStateChange(event) {
                        // During verification, if the video starts playing (even for a moment), it's embeddable.
                        if (isYtVerifying && event.data === YT.PlayerState.PLAYING) {
                            window.ytVerificationPromise?.resolve?.();
                        }
                    }

                    function onYtVerificationPlayerError(event) {
                        // If an error occurs while trying to cue, it's likely not embeddable.                
                        if (isYtVerifying) {
                            console.warn(`YouTube verification failed for video ID ${currentYtVerificationVideoId} with error code: ${event.data}`);
                            ytVerificationPromise.reject?.(new Error(`Verification failed with code ${event.data}`));
                        }
                    }





                    // --- YouTube Search Modal Functions ---
                    function openYoutubeSearchModal(context) {
                        currentYoutubeSearchContext = context;
                        renderRecentYoutubeSearches();
                        youtubeSearchQueryInput.value = '';
                        youtubeSearchResultsUl.innerHTML = '';
                        if (youtubeSearchError) youtubeSearchError.classList.add('hidden');
                        // Pagination was removed, so this element no longer exists.
                        // youtubePaginationTop.classList.add('hidden');
                        // youtubePaginationBottom is not used, so no need to hide
                        addSelectedYoutubeVideosButton.classList.add('hidden');
                        modalOverlay.style.display = 'block';
                        youtubeSearchModal.style.display = 'flex';
                        youtubeSearchQueryInput.focus();

                        // Initialize the verification player if it doesn't exist
                        if (!ytVerificationPlayer && youtubeApiReady) {
                            ytVerificationPlayer = new YT.Player('youtube-verification-player', {
                                height: '0', width: '0',
                                events: {
                                    'onReady': onYtVerificationPlayerReady,
                                    'onStateChange': onYtVerificationPlayerStateChange,
                                    'onError': onYtVerificationPlayerError
                                }
                            });
                        }
                    }

                    function closeYoutubeSearchModal() {
                        youtubeSearchModal.style.display = 'none';
                        modalOverlay.style.display = 'none';
                        currentYoutubeSearchContext = null;
                        // Stop any preview playing in the search modal
                        if (ytPreviewPlayer && typeof ytPreviewPlayer.stopVideo === 'function') {
                            ytPreviewPlayer.stopVideo();
                        }
                    }

                    function handleYoutubeSearch(isPaginating = false) {
                        const query = youtubeSearchQueryInput.value.trim();
                        if (!query) return;

                        if (!isPaginating) {
                            ytCurrentQuery = query;
                            addRecentYoutubeSearch(query);
                            ytPageHistory = [null]; // Reset history for new search
                            searchYouTubeVideos(query, null);
                        } else {
                            // Pagination logic is handled by the button event listeners
                        }
                    }

                    async function searchYouTubeVideos(query, pageToken = '', isPaginating = false) {
                        youtubeSearchLoading.classList.remove('hidden');
                        if (!isPaginating) {
                            youtubeSearchResultsUl.innerHTML = ''; // Clear only for new searches
                        }
                        youtubeSearchError.classList.add('hidden');

                        const cacheKey = `yt-search-cache-${query}`;
                        const pageCacheKey = `${cacheKey}-${pageToken || 'start'}`;

                        // --- Caching Logic ---
                        const cached = localStorage.getItem(pageCacheKey);
                        if (cached) {
                            const { timestamp, data } = JSON.parse(cached);
                            if (Date.now() - timestamp < 2 * 60 * 60 * 1000) { // 2 hour cache
                                log(`Loading YouTube search results for "${query}" (Page: ${pageToken || 'start'}) from cache.`);
                                await verifyAndDisplayYoutubeVideos(data.items, data.nextPageToken, data.prevPageToken);
                                return;
                            }
                        }

                        const apiKeys = book.settings.youtubeApiKeys || [];
                        if (currentYoutubeApiKeyIndex >= apiKeys.length) {
                            youtubeSearchError.textContent = "All available YouTube API keys have exceeded their quota.";
                            youtubeSearchError.classList.remove('hidden');
                            youtubeSearchLoading.classList.add('hidden');
                            return;
                        }

                        const apiKey = apiKeys[currentYoutubeApiKeyIndex];
                        let url = `https://www.googleapis.com/youtube/v3/search?part=snippet&q=${encodeURIComponent(query)}&key=${apiKey}&type=video&videoEmbeddable=true&maxResults=50`;
                        if (pageToken) {
                            url += `&pageToken=${pageToken}`;
                        }

                        try {
                            const response = await fetch(url);
                            if (!response.ok) {
                                const errorData = await response.json();
                                if (response.status === 403 && errorData.error?.errors?.[0]?.reason === 'quotaExceeded') {
                                    console.warn(`YouTube API Key at index ${currentYoutubeApiKeyIndex} has exceeded its quota.`);
                                    currentYoutubeApiKeyIndex++;
                                    searchYouTubeVideos(query, pageToken, isPaginating); // Retry with the next key
                                    return;
                                }
                                throw new Error(errorData.error.message || `API Error: ${response.status}`);
                            }
                            const data = await response.json();

                            localStorage.setItem(pageCacheKey, JSON.stringify({
                                timestamp: Date.now(),
                                data: { ...data } // Cache the raw, unverified items
                            }));
                            // Instead of waiting for all, verify and display progressively
                            await verifyAndDisplayYoutubeVideos(data.items || [], data.nextPageToken, data.prevPageToken);

                        } catch (err) {
                            console.error("Error fetching data from YouTube API:", err);
                            youtubeSearchError.textContent = `Failed to load videos. ${err.message}. Try another search or check API keys.`;
                            youtubeSearchError.classList.remove('hidden');
                        } finally {
                            youtubeSearchLoading.classList.add('hidden');
                        }
                    }

                    async function verifyAndDisplayYoutubeVideos(items, nextPageToken, prevPageToken) {
                        if (!ytVerificationPlayer) {
                            console.error("Verification player is not ready.");
                            showTemporaryMessage("YouTube verification player not ready. Cannot check videos.", "error");
                            return;
                        }
                        isYtVerifying = true;
                        const originalStatus = youtubeSearchLoading.querySelector('p').textContent;
                        youtubeSearchLoading.querySelector('p').textContent = 'Verifying videos...';

                        let hasDisplayedItems = youtubeSearchResultsUl.children.length > 0 && youtubeSearchResultsUl.children[0].tagName === 'LI';

                        for (const item of items) {
                            try {
                                await checkYoutubeEmbeddability(item.id.videoId);
                                if (!hasDisplayedItems) {
                                    youtubeSearchResultsUl.innerHTML = ''; // Clear "no results" message
                                    hasDisplayedItems = true;
                                }
                                appendYoutubeResult(item);
                            } catch (e) {
                                log(`Video "${item.snippet.title}" (${item.id.videoId}) is not embeddable. Skipping.`);
                            }
                        }
                        isYtVerifying = false;
                        youtubeSearchLoading.classList.add('hidden');
                        updateYoutubePaginationUI(nextPageToken, prevPageToken);
                    }

                    function checkYoutubeEmbeddability(videoId) {
                        return new Promise((resolve, reject) => {
                            currentYtVerificationVideoId = videoId;
                            ytVerificationPromise = { resolve, reject };
                            ytVerificationPlayer.loadVideoById(videoId); // Use loadVideoById to trigger play attempt
                        });
                    }

                    function appendYoutubeResult(item) {
                        const videoId = item.id.videoId;
                        const title = item.snippet.title;
                        const channel = item.snippet.channelTitle;
                        const thumb = item.snippet.thumbnails.default.url;

                        const li = document.createElement('li');
                        li.className = 'bg-stone-800/50 rounded-lg transition yt-video-item p-3 cursor-pointer hover:bg-stone-700/50';
                        li.dataset.videoId = videoId;

                        li.innerHTML = `
                    <div class="flex items-center gap-4">
                        <img src="${thumb}" alt="thumbnail" class="w-24 h-24 sm:w-32 sm:h-20 object-cover rounded-md flex-shrink-0">
                        <div class="flex-grow min-w-0">
                            <h4 class="font-semibold text-white truncate text-sm">${title}</h4>
                            <p class="text-xs text-gray-400">${channel}</p>
                            <div class="flex items-center gap-2 mt-2 text-xs">
                                <label>Start: <input type="text" class="yt-search-start-time bg-stone-900 border border-stone-700 rounded px-2 py-1 w-20" placeholder="0:00"></label>
                                <label>End: <input type="text" class="yt-search-end-time bg-stone-900 border border-stone-700 rounded px-2 py-1 w-20" placeholder="e.g., 1:30"></label>
                            </div>
                        </div>
                        <input type="checkbox" class="yt-select-checkbox ml-auto w-5 h-5 cursor-pointer flex-shrink-0">
                    </div>
                    <div class="media-preview-container hidden mt-3 p-3 rounded-lg bg-stone-900/50 border border-stone-700" style="display: none;">
                        <div class="flex items-center gap-3">
                            <button type="button" class="media-preview-play-pause-btn w-10 h-10 flex items-center justify-center bg-[var(--accent-blue)] rounded-full text-[var(--bg-secondary)] hover:bg-[var(--accent-gold-light)] transition flex-shrink-0" title="Play/Pause">
                                <i class="fas fa-play fa-fw"></i>
                            </button>
                            <button type="button" class="media-preview-goto-start-btn w-10 h-10 flex items-center justify-center bg-stone-600 rounded-full text-stone-200 hover:bg-stone-500 transition flex-shrink-0" title="Seek to Start Time">
                                <i class="fas fa-step-backward fa-fw"></i>
                            </button>
                            <div class="flex-grow min-w-0">
                                <div class="flex justify-between items-center text-xs text-gray-400">
                                    <span class="media-preview-current-time">0:00</span>
                                    <span class="media-preview-duration">0:00</span>
                                </div>
                                <div class="relative h-4 mt-1">
                                    <div class="media-range-track"></div>
                                    <div class="media-range-selection"></div>
                                    <input type="range" class="media-preview-scrub-bar" value="0" min="0" max="100" step="0.1">
                                    <input type="range" class="media-preview-start-bar" value="0" min="0" max="100" step="0.1">
                                    <input type="range" class="media-preview-end-bar" value="100" min="0" max="100" step="0.1">
                                </div>
                            </div>
                        </div>
                    </div>
                `;

                        youtubeSearchResultsUl.appendChild(li);
                        attachYoutubePreviewListeners(li);
                    }

                    function updateYoutubePaginationUI(nextPageToken, prevPageToken) {
                        // Pagination has been removed per user request.
                        // ytSearchNextPageToken = nextPageToken;
                        // ytSearchPrevPageToken = prevPageToken;

                        if (!(youtubeSearchResultsUl.children.length > 0 && youtubeSearchResultsUl.children[0].tagName === 'LI')) {
                            youtubeSearchResultsUl.innerHTML = '<li class="text-center text-gray-400 italic">No embeddable videos found for this query.</li>';
                        }

                        addSelectedYoutubeVideosButton.classList.remove('hidden');
                        // youtubeNextButtons.forEach(btn => btn.disabled = !ytSearchNextPageToken);
                        // youtubePrevButtons.forEach(btn => btn.disabled = ytPageHistory.length <= 1);
                    }

                    function attachYoutubePreviewListeners(item) {
                        const playPauseBtn = item.querySelector('.media-preview-play-pause-btn'); // The one inside the player
                        const previewContainer = item.querySelector('.media-preview-container');

                        const openAndPlayHandler = (e) => {
                            // Prevent opening the player if clicking on an interactive element.
                            if (e.target.closest('input, a, .media-preview-container')) {
                                // But if the click was specifically on the play/pause button inside the player, let it proceed.
                                if (!e.target.closest('.media-preview-play-pause-btn')) {
                                    return;
                                }
                            }

                            if (currentlyPlayingYtTile && currentlyPlayingYtTile !== item) {
                                // Stop the old player and reset its UI
                                const oldPreviewContainer = currentlyPlayingYtTile.querySelector('.media-preview-container');
                                if (oldPreviewContainer) {
                                    // Use style.display for more direct control that isn't overridden by Tailwind classes
                                    oldPreviewContainer.style.display = 'none';
                                }

                                if (ytPreviewPlayer && typeof ytPreviewPlayer.stopVideo === 'function') {
                                    ytPreviewPlayer.stopVideo();
                                }
                                stopYtPreviewInterval();
                                const oldPlayIcon = currentlyPlayingYtTile.querySelector('.media-preview-play-pause-btn i');
                                if (oldPlayIcon) oldPlayIcon.className = 'fas fa-play fa-fw';
                            }

                            currentlyPlayingYtTile = item;
                            const videoId = item.dataset.videoId;

                            // Explicitly show the container for the item we are about to play.
                            // Use style.display to ensure it shows up.
                            previewContainer.style.display = 'block';

                            // If this tile is not the one with the active player, set it up.
                            if (activePreviewContext?.container !== previewContainer || !ytPreviewPlayer) {
                                setupYouTubePreview(videoId, previewContainer, false); // Pass false to prevent autoplay on click
                            } else {
                                // If the player is already set up for this tile, just toggle play/pause.
                                const playerState = ytPreviewPlayer.getPlayerState();
                                if (playerState === YT.PlayerState.PLAYING || playerState === YT.PlayerState.BUFFERING) {
                                    ytPreviewPlayer.pauseVideo();
                                } else {
                                    ytPreviewPlayer.playVideo();
                                }
                            }
                        };

                        item.addEventListener('click', openAndPlayHandler);
                    }

                    async function addSelectedYoutubeVideos() {
                        const selectedItems = Array.from(youtubeSearchResultsUl.querySelectorAll('.yt-video-item'))
                            .filter(item => item.querySelector('.yt-select-checkbox').checked);

                        if (selectedItems.length === 0) {
                            showTemporaryMessage("No videos selected.", "info");
                            return;
                        }

                        showTemporaryMessage(`Adding ${selectedItems.length} video(s)...`, 'info', 3000);

                        if (currentYoutubeSearchContext === 'add') {
                            // This context is for the very first source of a new page.
                            // We'll add the first selected video to the main fields and then open the edit modal to show all added sources.
                            if (!tempPageForAddModal) {
                                showTemporaryMessage("Error: No temporary page object found for 'Add Page' modal.", "error");
                                return;
                            }

                            for (const item of selectedItems) {
                                const videoId = item.dataset.videoId;
                                const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
                                const videoTitle = await getYouTubeVideoTitle(videoId);
                                const startTime = item.querySelector('.yt-search-start-time').value;
                                const endTime = item.querySelector('.yt-search-end-time').value;

                                const newVariation = { id: `var_${generateUUID()}`, name: videoTitle, isDefault: tempPageForAddModal.sources.length === 0, sources: [{ type: 'youtube', source: videoId, fileName: videoUrl, videoTitle: videoTitle, needsFile: false, startTime: parseTimeHms(startTime), endTime: parseTimeHms(endTime) }] };
                                tempPageForAddModal.sources.push(newVariation);
                            }
                            renderVariationList(tempPageForAddModal, true);
                            closeYoutubeSearchModal();

                        } else if (currentYoutubeSearchContext === 'source') {
                            // This context means we are adding to an existing variation.
                            const page = book.pages.find(p => p.id === currentlyEditingPageId);
                            const variationIndex = parseInt(managingSourcesVariationIndexInput.value, 10);
                            const variation = page?.sources[variationIndex];
                            if (!variation) { showTemporaryMessage("Could not find variation to add sources to.", "error"); closeYoutubeSearchModal(); return; }

                            for (const item of selectedItems) {
                                const videoId = item.dataset.videoId;
                                const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
                                const videoTitle = await getYouTubeVideoTitle(videoId);
                                const startTime = item.querySelector('.yt-search-start-time')?.value;
                                const endTime = item.querySelector('.yt-search-end-time')?.value;

                                variation.sources.push({ type: 'youtube', source: videoId, fileName: videoUrl, videoTitle: videoTitle, needsFile: false, startTime: parseTimeHms(startTime), endTime: parseTimeHms(endTime) });
                            }
                            renderSubVariationList(variation);
                            closeYoutubeSearchModal();
                            closeAddEditSourceModal();
                            showTemporaryMessage(`${selectedItems.length} video(s) added.`, 'success');
                        } else if (currentYoutubeSearchContext === 'sub-variation') {
                            // This is the same as 'source' context, just a different name from a previous refactor.
                            const page = book.pages.find(p => p.id === currentlyEditingPageId);
                            const variationIndex = parseInt(managingSourcesVariationIndexInput.value, 10);
                            const variation = page?.sources[variationIndex];
                            if (!variation) { showTemporaryMessage("Could not find variation to add sources to.", "error"); closeYoutubeSearchModal(); return; }

                            for (const item of selectedItems) {
                                const videoId = item.dataset.videoId;
                                const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
                                const videoTitle = await getYouTubeVideoTitle(videoId);
                                const startTime = item.querySelector('.yt-search-start-time')?.value;
                                const endTime = item.querySelector('.yt-search-end-time')?.value;

                                variation.sources.push({ type: 'youtube', source: videoId, fileName: videoUrl, videoTitle: videoTitle, needsFile: false, startTime: parseTimeHms(startTime), endTime: parseTimeHms(endTime) });
                            }
                            renderSubVariationList(variation);
                            closeYoutubeSearchModal();
                            closeAddEditSourceModal();
                            showTemporaryMessage(`${selectedItems.length} video(s) added.`, 'success');
                        }
                    }

                    function addRecentYoutubeSearch(query) {
                        const cleanedQuery = query.trim().toLowerCase();
                        if (!cleanedQuery) return;

                        // Remove if it already exists to move it to the top
                        const existingIndex = recentYoutubeSearches.indexOf(cleanedQuery);
                        if (existingIndex > -1) {
                            recentYoutubeSearches.splice(existingIndex, 1);
                        }

                        // Add to the beginning
                        recentYoutubeSearches.unshift(cleanedQuery);

                        // Limit to 10 recent searches
                        if (recentYoutubeSearches.length > 10) {
                            recentYoutubeSearches.length = 10;
                        }

                        localStorage.setItem(YT_RECENT_SEARCHES_KEY, JSON.stringify(recentYoutubeSearches));
                        renderRecentYoutubeSearches(); // Re-render the list
                    }

                    function removeRecentYoutubeSearch(query) {
                        const cleanedQuery = query.trim().toLowerCase();
                        recentYoutubeSearches = recentYoutubeSearches.filter(q => q !== cleanedQuery);
                        localStorage.setItem(YT_RECENT_SEARCHES_KEY, JSON.stringify(recentYoutubeSearches));
                        renderRecentYoutubeSearches();
                    }

                    function renderRecentYoutubeSearches() {
                        const container = document.getElementById('youtubeRecentSearchesContainer');
                        container.innerHTML = '';
                        if (recentYoutubeSearches.length === 0) {
                            container.classList.add('hidden');
                            return;
                        }

                        recentYoutubeSearches.forEach(query => {
                            const item = document.createElement('div');
                            item.className = 'recent-search-item';
                            item.innerHTML = `
                        <span class="flex-grow">${query}</span>
                        <button class="remove-recent-search-btn" title="Remove search">&times;</button>
                    `;
                            item.querySelector('span').addEventListener('click', () => {
                                youtubeSearchQueryInput.value = query;
                                handleYoutubeSearch(false);
                                container.classList.add('hidden');
                            });
                            item.querySelector('.remove-recent-search-btn').addEventListener('click', (e) => {
                                e.stopPropagation(); // Prevent triggering the search
                                removeRecentYoutubeSearch(query);
                            });
                            container.appendChild(item);
                        });
                    }



                    function createOrLoadYtPreviewPlayer(videoId, autoplay = false) {
                        currentYtPreviewVideoId = videoId;
                        log(`%c[PREVIEW]`, 'color: #9966CC; font-weight: bold;', `createOrLoadYtPreviewPlayer called for videoId: ${videoId}. Player exists: ${!!ytPreviewPlayer}`);
                        if (!ytPreviewPlayer || ytPreviewPlayer.isDestroyed?.()) {
                            log(`%c[PREVIEW]`, 'color: #9966CC; font-weight: bold;', `Creating NEW YT.Player instance.`);
                            ytPreviewPlayer = new YT.Player('youtube-preview-player', {
                                height: '0', width: '0', videoId: videoId,
                                playerVars: { 'playsinline': 1, 'controls': 0, 'autoplay': 0, 'loop': 0 }, // Always set autoplay to 0 here, control it via API calls
                                events: {
                                    'onReady': onYtPreviewPlayerReady,
                                    'onStateChange': onYtPreviewPlayerStateChange,
                                    'onError': onYtPreviewPlayerError
                                }
                            });
                        } else {
                            log(`%c[PREVIEW]`, 'color: #9966CC; font-weight: bold;', `Re-using existing player. Cueing video: ${videoId}`);
                            // We always cue here. The onStateChange handler will catch the CUED event
                            // and allow us to initialize sliders correctly.
                            // The play/pause button in the UI will handle starting playback.
                            ytPreviewPlayer.cueVideoById({ videoId: videoId });
                        }
                    }



                    function limitAppendixEffectsForTrigger(triggerType, effectSelectElement) { // This function is correct
                        const allOptions = [
                            { value: 'play_soundtrack', text: 'Play Soundtrack' },
                            { value: 'stop_soundtrack', text: 'Stop Soundtrack' },
                            { value: 'start_pages', text: 'Start Pages' },
                            { value: 'end_pages', text: 'End Pages' },
                            { value: 'increase_volume', text: 'Increase Volume' },
                            { value: 'decrease_volume', text: 'Decrease Volume' },
                            { value: 'reset_volume', text: 'Reset Volume' },
                            { value: 'change_chapter', text: 'Change Chapter' },
                            { value: 'set_time', text: 'Set Time of Day' },
                            { value: 'toggle_time', text: 'Toggle Time of Day' },
                            { value: 'transition_variation', text: 'Transition Variation' },
                            { value: 'set_page_title', text: 'Set Page Title' }
                        ];

                        const allowedOptions = triggerType === 'condition'
                            ? allOptions.filter(opt => ['start_pages', 'end_pages', 'increase_volume', 'decrease_volume', 'reset_volume'].includes(opt.value))
                            : allOptions;

                        const currentValue = effectSelectElement.value;
                        effectSelectElement.innerHTML = '';
                        allowedOptions.forEach(opt => {
                            const option = document.createElement('option');
                            option.value = opt.value;
                            option.textContent = opt.text;
                            effectSelectElement.appendChild(option);
                        });

                        // Try to restore the previous selection if it's still valid
                        if (allowedOptions.some(opt => opt.value === currentValue)) {
                            effectSelectElement.value = currentValue;
                        } else {
                            // If not valid, select the first available option
                            if (allowedOptions.length > 0) {
                                effectSelectElement.value = allowedOptions[0].value;
                            }
                        }
                        // Manually trigger change event to re-render controls
                        effectSelectElement.dispatchEvent(new Event('change'));
                    }


                    // --- Appendix Condition Builder Functions ---
                    function initializeConditionBuilder(pageListContainerId, otherConditionsContainerId, tagListContainerId, conditions = [], pageSearchInputId, tagSearchInputId) {
                        const pageListContainer = document.getElementById(pageListContainerId);
                        const otherConditionsContainer = otherConditionsContainerId ? document.getElementById(otherConditionsContainerId) : null;
                        const tagListContainer = document.getElementById(tagListContainerId);
                        const searchInput = document.getElementById(pageSearchInputId);
                        const tagSearchInput = document.getElementById(tagSearchInputId);

                        if (!pageListContainer) { // otherConditionsContainer and tagListContainer are optional
                            // console.error("LOG: Condition builder containers not found!", { pageListContainerId, otherConditionsContainerId, tagListContainerId });
                            // console.error("Condition builder containers not found:", { pageListContainerId, otherConditionsContainerId, tagListContainerId });
                            return;
                        }

                        // Separate conditions into page-based and other
                        const pageConditions = conditions.filter(c => c.type.startsWith('page_'));
                        const tagConditions = conditions.filter(c => c.type.startsWith('tag_'));
                        const otherConditions = conditions.filter(c => !c.type.startsWith('page_') && !c.type.startsWith('tag_'));

                        // *** LOG: Log the conditions being passed to the builder.
                        // --- DEBUG LOG ---
                        log(`%c[DEBUG] initializeConditionBuilder: Initializing for "${pageListContainerId}" with conditions:`, 'color: orange', JSON.parse(JSON.stringify(conditions)));
                        // --- END DEBUG LOG ---
                        log(`LOG: Initializing condition builder "${pageListContainerId}" with ${conditions.length} conditions.`);

                        // --- 1. Setup Page Conditions ---
                        pageListContainer.innerHTML = ''; // Clear previous
                        const pageConditionsMap = new Map(pageConditions.map(c => {
                            const state = c.type.replace('page_', ''); // 'page_active' -> 'active'
                            return [c.params.pageId, state];
                        }));

                        book.pages.sort((a, b) => a.title.localeCompare(b.title)).forEach(page => {
                            const itemDiv = document.createElement('div');
                            itemDiv.className = 'plot-thread-page-item';
                            itemDiv.dataset.pageId = page.id;
                            const state = pageConditionsMap.get(page.id) || 'none';
                            let iconClass = '';
                            if (state === 'active') iconClass = 'fas fa-play';
                            else if (state === 'inactive') iconClass = 'fas fa-stop';
                            itemDiv.dataset.state = state;
                            itemDiv.innerHTML = `<span class="page-title">${escapeHtml(page.title)}</span><div class="condition-box state-${state}"><i class="${iconClass}"></i></div>`;
                            itemDiv.addEventListener('click', () => cyclePlotThreadConditionState(itemDiv));
                            pageListContainer.appendChild(itemDiv);
                        });

                        if (searchInput) {
                            searchInput.oninput = () => {
                                const term = searchInput.value.toLowerCase();
                                pageListContainer.querySelectorAll('.plot-thread-page-item').forEach(item => {
                                    item.style.display = item.querySelector('.page-title').textContent.toLowerCase().includes(term) ? '' : 'none';
                                });
                            };
                        }

                        // --- 2. Setup Tag Conditions ---
                        if (tagListContainer) {
                            tagListContainer.innerHTML = ''; // Clear previous
                            const tagConditionsMap = new Map(tagConditions.map(c => {
                                const numericTagId = parseInt(String(c.params.tagId).replace('tag_', ''), 10);
                                return [numericTagId, c.type === 'tag_is' ? 'is' : 'not'];
                            }));
                            // --- DEBUG LOG ---
                            log(`%c[DEBUG] initializeConditionBuilder: Processed tag conditions map:`, 'color: orange', tagConditionsMap);
                            // --- END DEBUG LOG ---
                            const allTags = book.settings.chapterTags || [];
                            if (allTags.length > 0) {
                                allTags.sort((a, b) => a.name.localeCompare(b.name)).forEach(tag => {
                                    const itemDiv = document.createElement('div');
                                    itemDiv.className = 'plot-thread-page-item';
                                    itemDiv.dataset.tagId = tag.id;
                                    const numericTagId = parseInt(String(tag.id).replace('tag_', ''), 10);
                                    const state = tagConditionsMap.get(numericTagId) || 'none';
                                    let iconClass = '';
                                    if (state === 'is') iconClass = 'fas fa-check';
                                    else if (state === 'not') iconClass = 'fas fa-times';
                                    itemDiv.dataset.state = state;
                                    itemDiv.innerHTML = `<span class="page-title">${escapeHtml(tag.name)}</span><div class="condition-box state-${state === 'is' ? 'active' : (state === 'not' ? 'inactive' : 'none')}"><i class="${iconClass}"></i></div>`;
                                    // --- DEBUG LOG ---
                                    log(`%c[DEBUG] initializeConditionBuilder: Rendering tag "${tag.name}" (ID: ${tag.id}) with initial state: ${state}`, 'color: orange');
                                    // --- END DEBUG LOG ---
                                    itemDiv.addEventListener('click', () => {
                                        const currentState = itemDiv.dataset.state;
                                        const box = itemDiv.querySelector('.condition-box');
                                        const icon = box.querySelector('i');
                                        let nextState = 'none', nextIconClass = '', nextBoxClass = 'state-none';
                                        if (currentState === 'none') { nextState = 'is'; nextIconClass = 'fas fa-check'; nextBoxClass = 'state-active'; }
                                        else if (currentState === 'is') { nextState = 'not'; nextIconClass = 'fas fa-times'; nextBoxClass = 'state-inactive'; }
                                        else { nextState = 'none'; } // 'not' goes to 'none'
                                        itemDiv.dataset.state = nextState;
                                        box.className = `condition-box ${nextBoxClass}`;
                                        icon.className = nextIconClass;
                                    });
                                    tagListContainer.appendChild(itemDiv);
                                });
                            } else {
                                tagListContainer.innerHTML = '<span class="text-xs text-gray-400 italic p-2">No tags defined in book settings.</span>';
                            }
                        }

                        if (tagSearchInput) {
                            tagSearchInput.oninput = () => {
                                const term = tagSearchInput.value.toLowerCase();
                                tagListContainer.querySelectorAll('.plot-thread-page-item').forEach(item => {
                                    item.style.display = item.querySelector('.page-title').textContent.toLowerCase().includes(term) ? '' : 'none';
                                });
                            };
                        }


                        // --- 2. Setup Other Conditions (the old builder for chapter/time/tags) ---
                        if (otherConditionsContainer) {
                            otherConditionsContainer.innerHTML = '';
                            const conditionGroup = document.createElement('div');
                            conditionGroup.className = 'condition-builder-group';
                            // otherConditionsContainer.appendChild(conditionGroup); // Don't add the group div if we aren't adding the button

                            // const addButton = document.createElement('button');
                            // addButton.type = 'button';
                            // addButton.className = 'btn-rpg-sm mt-2';
                            // addButton.innerHTML = '<i class="fas fa-plus mr-1"></i> Add Other Condition';
                            // addButton.addEventListener('click', () => addConditionItem(conditionGroup));
                            // otherConditionsContainer.appendChild(addButton);

                            // Only add condition items if they exist. Don't add a blank one by default.
                            if (otherConditions.length > 0) {
                                otherConditions.forEach(cond => addConditionItem(conditionGroup, cond));
                            }
                        }
                    }

                    function addConditionItem(group, conditionData = {}) {
                        // If no condition data is provided, it means the user clicked "Add", so we create a default.
                        // We only proceed if it's a true "add new" click (conditionData is undefined) or if we are populating from existing data (conditionData has a type).
                        if (conditionData.type === undefined && arguments.length > 1) {
                            // This is a population call with an empty object, so we should not add a blank item.
                            return;
                        }
                        const template = document.getElementById('appendixConditionTemplate');
                        const clone = template.content.cloneNode(true);
                        const conditionItem = clone.querySelector('.condition-item');
                        const typeSelect = clone.querySelector('.condition-type-select');
                        const paramsDiv = clone.querySelector('.condition-params');

                        // Populate type select with ONLY non-page conditions
                        // --- DEBUG LOG ---
                        log(`%c[DEBUG] addConditionItem: Adding item with data:`, 'color: orange', JSON.parse(JSON.stringify(conditionData)));
                        // --- END DEBUG LOG ---
                        const conditionTypes = [
                            { value: 'chapter_is', text: 'Chapter is' },
                            { value: 'time_is', text: 'Time of Day is' }
                        ].filter(t => t.value !== 'chapter_is'); // Remove 'chapter_is'
                        conditionTypes.forEach(opt => {
                            typeSelect.add(new Option(opt.text, opt.value));
                        });

                        typeSelect.addEventListener('change', () => renderConditionParams(typeSelect.value, paramsDiv));

                        // Set initial value and render params
                        if (conditionData.type && conditionTypes.some(t => t.value === conditionData.type)) {
                            typeSelect.value = conditionData.type;
                        }
                        renderConditionParams(typeSelect.value, paramsDiv, conditionData.params);

                        conditionItem.querySelector('.remove-condition-btn').addEventListener('click', () => conditionItem.remove());
                        group.appendChild(clone);
                    }





                    function renderConditionParams(type, paramsDiv, paramsData = {}) {
                        paramsDiv.innerHTML = '';
                        switch (type) {
                            case 'chapter_is':
                                const chapterSelect = document.createElement('select');
                                book.chapters.sort((a, b) => a.name.localeCompare(b.name)).forEach(c => chapterSelect.add(new Option(c.name, c.id)));
                                if (paramsData.chapterId) chapterSelect.value = paramsData.chapterId;
                                paramsDiv.appendChild(chapterSelect);
                                break;
                            case 'time_is':
                                const timeSelect = document.createElement('select');
                                timeSelect.add(new Option('Day', 'day'));
                                timeSelect.add(new Option('Night', 'night'));
                                if (paramsData.time) timeSelect.value = paramsData.time;
                                paramsDiv.appendChild(timeSelect);
                                break;
                        }
                    }

                    function cleanupUnusedTags() {
                        if (!book.settings.chapterTags || book.settings.chapterTags.length === 0) return;

                        const usedTagIds = new Set();

                        // Tags used by chapters
                        (book.chapters || []).forEach(ch => (ch.tagIds || []).forEach(id => usedTagIds.add(id)));

                        // Tags used by collections
                        (book.collections || []).forEach(co => (co.tagIds || []).forEach(id => usedTagIds.add(id)));

                        // Tags used by conditions (appendix and source variations)
                        const findTagsInConditions = (conditions) => {
                            (conditions || []).forEach(cond => { if ((cond.type === 'tag_is' || cond.type === 'tag_not') && cond.params?.tagId) usedTagIds.add(cond.params.tagId); });
                        };
                        (book.appendix || []).forEach(entry => { findTagsInConditions(entry.trigger?.conditions); findTagsInConditions(entry.conditions); });
                        (book.pages || []).forEach(page => page.sources.forEach(source => findTagsInConditions(source.conditions)));

                        const originalCount = book.settings.chapterTags.length;
                        book.settings.chapterTags = book.settings.chapterTags.filter(tag => usedTagIds.has(tag.id));
                        if (originalCount !== book.settings.chapterTags.length) log(`Cleaned up ${originalCount - book.settings.chapterTags.length} unused tags.`);
                    }

                    // --- Spotify Auth Functions (from reference) ---
                    function getSpotifyClientId() {
                        return book.settings.spotifyClientId || SPOTIFY_DEFAULT_CLIENT_ID;
                    }

                    async function redirectToSpotifyLogin() {
                        // Spotify OAuth needs a real http(s) origin for the redirect URI. Opened
                        // as a local file, window.location.origin is "null" and the callback can
                        // never work, so fail clearly instead of bouncing to a broken redirect (B8).
                        if (window.location.protocol === 'file:') {
                            showTemporaryMessage("Spotify requires the hosted version of Storyteller — it can't authenticate when the page is opened as a local file.", "error", 6000);
                            return;
                        }
                        const verifier = generateCodeVerifier(128);
                        const challenge = await generateCodeChallenge(verifier);

                        localStorage.setItem("spotify_code_verifier", verifier);

                        const params = new URLSearchParams();
                        params.append("client_id", getSpotifyClientId());
                        params.append("response_type", "code");
                        params.append("redirect_uri", SPOTIFY_REDIRECT_URI);
                        params.append("scope", SPOTIFY_SCOPES);
                        params.append("code_challenge_method", "S256");
                        params.append("code_challenge", challenge);

                        document.location = `https://accounts.spotify.com/authorize?${params.toString()}`;
                    }

                    async function handleSpotifyRedirect(code) {
                        const verifier = localStorage.getItem("spotify_code_verifier");
                        if (!verifier) {
                            showTemporaryMessage("Spotify login error: Code verifier not found. Please try again.", "error");
                            return;
                        }

                        try {
                            const tokenData = await getSpotifyAccessToken(code, verifier);
                            storeSpotifyTokens(tokenData);
                            // Clean URL
                            window.history.pushState({}, document.title, window.location.pathname);
                            showTemporaryMessage("Successfully logged in to Spotify!", "success");
                            updateSpotifyLoginUI();
                        } catch (error) {
                            showTemporaryMessage(`Error fetching Spotify token: ${error.message}`, "error");
                            logoutSpotify();
                        }
                    }

                    async function getSpotifyAccessToken(code, verifier) {
                        const params = new URLSearchParams();
                        params.append("client_id", getSpotifyClientId());
                        params.append("grant_type", "authorization_code");
                        params.append("code", code);
                        params.append("redirect_uri", SPOTIFY_REDIRECT_URI);
                        params.append("code_verifier", verifier);

                        const response = await fetch("https://accounts.spotify.com/api/token", {
                            method: "POST",
                            headers: { "Content-Type": "application/x-www-form-urlencoded" },
                            body: params
                        });

                        if (!response.ok) {
                            const errorData = await response.json();
                            throw new Error(errorData.error_description || "Failed to get Spotify access token.");
                        }
                        return response.json();
                    }

                    function storeSpotifyTokens(tokenData) {
                        const expiryTime = new Date().getTime() + tokenData.expires_in * 1000;
                        localStorage.setItem('spotify_access_token', tokenData.access_token);
                        localStorage.setItem('spotify_token_expiry', expiryTime);
                        if (tokenData.refresh_token) {
                            localStorage.setItem('spotify_refresh_token', tokenData.refresh_token);
                        }
                    }

                    function logoutSpotify() {
                        localStorage.removeItem('spotify_access_token');
                        localStorage.removeItem('spotify_refresh_token');
                        localStorage.removeItem('spotify_token_expiry');
                        localStorage.removeItem('spotify_code_verifier');
                        showTemporaryMessage("Logged out from Spotify.", "info");
                        updateSpotifyLoginUI();
                    }

                    async function updateSpotifyLoginUI() {
                        const accessToken = localStorage.getItem('spotify_access_token');
                        const expiryTime = localStorage.getItem('spotify_token_expiry');

                        if (accessToken && new Date().getTime() < expiryTime) {
                            spotifyLoginContainer.classList.add('hidden');
                            spotifyLogoutContainer.classList.remove('hidden');
                            // Fetch user profile to display name
                            try {
                                const response = await fetch("https://api.spotify.com/v1/me", {
                                    headers: { 'Authorization': `Bearer ${accessToken}` }
                                });
                                if (!response.ok) throw new Error('Could not fetch profile.');
                                const data = await response.json();
                                spotifyUserStatus.textContent = `Logged in as: ${data.display_name}`;
                            } catch (e) {
                                spotifyUserStatus.textContent = 'Logged in to Spotify.';
                            }
                        } else {
                            spotifyLoginContainer.classList.remove('hidden');
                            spotifyLogoutContainer.classList.add('hidden');
                            if (window.location.protocol === 'file:' && spotifyLoginButton) {
                                spotifyLoginButton.classList.add('opacity-50');
                                spotifyLoginButton.title = "Unavailable on file:// — use the hosted version of Storyteller to connect Spotify.";
                            }
                        }
                    }

                    // --- PKCE Helper Functions ---
                    function generateCodeVerifier(length) {
                        let text = '';
                        let possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
                        for (let i = 0; i < length; i++) {
                            text += possible.charAt(Math.floor(Math.random() * possible.length));
                        }
                        return text;
                    }

                    async function generateCodeChallenge(codeVerifier) {
                        const data = new TextEncoder().encode(codeVerifier);
                        const digest = await window.crypto.subtle.digest('SHA-256', data);
                        return btoa(String.fromCharCode.apply(null, [...new Uint8Array(digest)]))
                            .replace(/\+/g, '-')
                            .replace(/\//g, '_')
                            .replace(/=+$/, '');
                    }

                    function checkForSpotifyRedirect() {
                        const urlParams = new URLSearchParams(window.location.search);
                        const code = urlParams.get('code');
                        const state = urlParams.get('state'); // Spotify doesn't use state with PKCE but good to check
                        if (code) {
                            handleSpotifyRedirect(code);
                        }
                    }

                    // ===== SOUNDTRACK SYSTEM LOGIC ===== //
                    let activeSoundtrackId = null;
                    let activeStSongIndex = 0;
                    let stPlayerNode = null;
                    let isStPlaying = false;
                    let globalSoundtrackVolume = 100;
                    let editStCurrentId = null;

                    function renderSoundtrackIcons() {
                        const container = document.getElementById('soundtrackIconsContainer');
                        if (!container) return;
                        container.innerHTML = '';
                        (book.soundtracks || []).forEach(st => {
                            const iconDiv = document.createElement('div');
                            iconDiv.className = 'soundtrack-icon' + (activeSoundtrackId === st.id ? ' active' : '');
                            iconDiv.innerHTML = '<i class="' + escapeHtml(st.icon || 'fas fa-music') + '"></i><span class="st-name-label hidden min-[1100px]:block ml-2 text-sm font-semibold truncate">' + escapeHtml(st.name) + '</span><div class="tooltip min-[1100px]:hidden">' + escapeHtml(st.name) + '</div>';
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

                            const shuffleBtn = document.getElementById('stShuffleBtn');
                            if (shuffleBtn) {
                                shuffleBtn.classList.toggle('active', st.shuffle === true);
                                shuffleBtn.style.color = st.shuffle ? 'var(--accent-gold-light)' : 'var(--text-secondary)';
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


                    function getSoundtrackFinalVol(st, song) {
                        const baseVol = globalSoundtrackVolume / 100;
                        const playlistVol = (st.volume !== undefined ? st.volume : 100) / 100;
                        const songVol = (song.volume !== undefined ? song.volume : 100) / 100;
                        let finalVol = Math.max(baseVol * playlistVol * songVol, 0.001);
                        if (typeof book !== 'undefined' && book.settings && book.settings.masterVolumeAffectsSoundtracks !== false) {
                            const mv = typeof currentMasterVolume !== 'undefined' ? currentMasterVolume : 100;
                            finalVol = Math.max(finalVol * (mv / 100), 0.001);
                        }
                        return finalVol;
                    }

                    function evaluateSoundtrackTriggers(input, triggerType) {
                        if (typeof book === 'undefined' || !book || !book.soundtracks) return;

                        book.soundtracks.forEach(st => {
                            let shouldTrigger = false;

                            if (triggerType === 'keyword' && st.keywords && st.keywords.length > 0) {
                                const foundKeyword = st.keywords.find(kw => new RegExp(`\\b${kw.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&')}\\b`, 'i').test(input));
                                if (foundKeyword) {
                                    log(`Soundtrack Keyword Triggered: "${foundKeyword}" for playlist "${st.name}"`);
                                    shouldTrigger = true;
                                }
                            }

                            if (triggerType === 'chapter') {
                                const selectedChapters = st.chapters || (st.chapter && st.chapter !== 'none' ? [st.chapter] : []);
                                if (selectedChapters.includes(String(input))) {
                                    log(`Soundtrack Chapter Triggered: Chapter ID "${input}" for playlist "${st.name}"`);
                                    shouldTrigger = true;
                                }
                            }

                            if (triggerType === 'time' && st.timeOfDay && st.timeOfDay !== 'none') {
                                if (st.timeOfDay === input) {
                                    log(`Soundtrack Time Triggered: "${input}" for playlist "${st.name}"`);
                                    shouldTrigger = true;
                                }
                            }

                            if (shouldTrigger && activeSoundtrackId !== st.id) {
                                toggleSoundtrack(st.id);
                            }
                        });
                    }
                    let stPlayRequestCount = 0; // Global counter to prevent race conditions during skips

                    function playStSong(st, songIndex, overrideSong = null) {
                        if (typeof audioContext !== 'undefined' && audioContext && audioContext.state === 'suspended') audioContext.resume();
                        if (!st || !st.songs || st.songs.length === 0) return;

                        const song = overrideSong || st.songs[songIndex];
                        if (!song) return;

                        const currentRequestId = ++stPlayRequestCount;

                        // Stop current immediately
                        if (stPlayerNode) {
                            if (stPlayerNode.endTimeout) clearTimeout(stPlayerNode.endTimeout);
                            if (stPlayerNode.endTimeTimeout) clearTimeout(stPlayerNode.endTimeTimeout);

                            try {
                                if (stPlayerNode.stop) stPlayerNode.stop();
                                if (stPlayerNode.pauseVideo) stPlayerNode.pauseVideo();
                                if (stPlayerNode.destroy) stPlayerNode.destroy();
                            } catch(e) {}
                            stPlayerNode = null;
                        }

                        activeStSongIndex = songIndex;
                        document.getElementById('stTrackTitle').innerText = song.name;
                        const finalVol = getSoundtrackFinalVol(st, song);

                        if (song.type === 'file' && song.fileData) {
                            initAudioContext();
                            const reader = new FileReader();
                            reader.onload = function (e) {
                                if (currentRequestId !== stPlayRequestCount) return; // Stale request

                                audioContext.decodeAudioData(e.target.result, function (buffer) {
                                    if (currentRequestId !== stPlayRequestCount) return; // Stale request

                                    const source = audioContext.createBufferSource();
                                    source.buffer = buffer;
                                    const gainNode = audioContext.createGain();
                                    gainNode.gain.value = finalVol; 
                                    source.connect(gainNode);
                                    gainNode.connect(audioContext.destination); // was undefined masterGainNode (B4)

                                    const sTime = song.startTime || 0;
                                    const eTime = (song.endTime && song.endTime > sTime) ? song.endTime : buffer.duration;

                                    source.onended = () => {
                                        if (stPlayerNode === source && isStPlaying) {
                                            nextStSong();
                                        }
                                    };
                                    source.start(0, sTime);

                                    stPlayerNode = source;
                                    stPlayerNode.gainNode = gainNode;
                                    stPlayerNode.startTimeReal = audioContext.currentTime;
                                    stPlayerNode.songStartTime = sTime;
                                    stPlayerNode.songEndTime = eTime;
                                    stPlayerNode.bufferDuration = buffer.duration;

                                    isStPlaying = true;
                                    startStScrubberUpdate();
                                    updateSoundtrackBarUI();

                                    // Handle end time for file tracks
                                    const duration = eTime - sTime;
                                    stPlayerNode.endTimeTimeout = setTimeout(() => {
                                        if (stPlayerNode === source && isStPlaying) nextStSong();
                                    }, duration * 1000);
                                });
                            };
                            reader.readAsArrayBuffer(song.fileData);
                        } else if (song.type === 'youtube' && song.videoId) {
                            if (currentRequestId !== stPlayRequestCount) return; // Stale request

                            const dummyDiv = document.createElement('div');
                            dummyDiv.style.display = 'none';
                            document.body.appendChild(dummyDiv);

                            if (typeof YT === 'undefined' || !YT.Player) {
                                setTimeout(() => playStSong(st, songIndex), 500);
                                return;
                            }

                            const ytPlayer = new YT.Player(dummyDiv, {
                                height: '0',
                                width: '0',
                                videoId: song.videoId,
                                playerVars: {
                                    'autoplay': 1,
                                    'controls': 0,
                                    'start': Math.floor(song.startTime || 0),
                                    'end': (song.endTime && song.endTime > (song.startTime || 0)) ? Math.floor(song.endTime) : undefined
                                },
                                events: {
                                    'onReady': (event) => {
                                        if (currentRequestId !== stPlayRequestCount) {
                                            try { event.target.destroy(); } catch(e) {}
                                            return;
                                        }

                                        const targetVol = finalVol * 100;
                                        event.target.setVolume(targetVol);
                                        event.target.playVideo();

                                        isStPlaying = true;
                                        startStScrubberUpdate();
                                        updateSoundtrackBarUI();
                                    },
                                    'onStateChange': (event) => {
                                        if (event.data == YT.PlayerState.ENDED) {
                                            if (stPlayerNode === ytPlayer) nextStSong();
                                        }
                                    },
                                    'onError': (event) => {
                                        console.error("YouTube Player Error in Soundtrack:", event.data);
                                        if (stPlayerNode === ytPlayer) nextStSong(); // Try to skip on error
                                    }
                                }
                            });
                            stPlayerNode = ytPlayer;
                            
                            // 3. Robust "end time" handler for YouTube
                            if (song.endTime && song.endTime > (song.startTime || 0)) {
                                const duration = song.endTime - (song.startTime || 0);
                                stPlayerNode.endTimeout = setTimeout(() => {
                                    if (stPlayerNode === ytPlayer && isStPlaying) {
                                        log("YouTube track end time reached (timer). Moving to next.");
                                        nextStSong();
                                    }
                                }, (duration * 1000) + 100); // Small sync buffer
                            }
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
                            if (st && st.shuffle && st.songs && st.songs.length > 0) {
                                activeStSongIndex = Math.floor(Math.random() * st.songs.length);
                            } else {
                                activeStSongIndex = 0;
                            }
                            playStSong(st, activeStSongIndex);
                            renderSoundtrackIcons();
                        }
                    }

                    function pauseSoundtrack() {
                        isStPlaying = false;
                        if (stScrubberInterval) clearInterval(stScrubberInterval);
                        if (stPlayerNode) {
                            if (stPlayerNode.gainNode && audioContext) {
                                stPlayerNode.gainNode.gain.value = 0.001;
                                // NOT suspending audioContext to avoid breaking global audio
                            } else if (stPlayerNode.pauseVideo) {
                                stPlayerNode.pauseVideo();
                            }
                        }
                        updateSoundtrackBarUI();
                        renderSoundtrackIcons();
                    }

                    function resumeSoundtrack() {
                        isStPlaying = true;
                        startStScrubberUpdate();
                        if (stPlayerNode) {
                            if (stPlayerNode.gainNode && audioContext) {
                                if (audioContext.state === 'suspended') audioContext.resume();
                                const st = book.soundtracks.find(s => s.id === activeSoundtrackId);
                                const song = st.songs[activeStSongIndex];
                                const finalVol = getSoundtrackFinalVol(st, song);
                                stPlayerNode.gainNode.gain.value = finalVol;
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

                    let stScrubberInterval = null;
                    function formatTime(seconds) {
                        if (isNaN(seconds)) return '0:00';
                        const mins = Math.floor(seconds / 60);
                        const secs = Math.floor(seconds % 60);
                        return `${mins}:${secs.toString().padStart(2, '0')}`;
                    }

                    function startStScrubberUpdate() {
                        if (stScrubberInterval) clearInterval(stScrubberInterval);
                        const scrubber = document.getElementById('stScrubber');
                        const currentLabel = document.getElementById('stCurrentTime');
                        const totalLabel = document.getElementById('stTotalTime');

                        stScrubberInterval = setInterval(() => {
                            if (!isStPlaying || !stPlayerNode) {
                                clearInterval(stScrubberInterval);
                                return;
                            }

                            let currentPos = 0;
                            let totalDur = 0;

                            if (stPlayerNode.getDuration) { // YouTube
                                currentPos = stPlayerNode.getCurrentTime();
                                totalDur = stPlayerNode.getDuration();
                            } else if (stPlayerNode.bufferDuration) { // File
                                currentPos = stPlayerNode.songStartTime + (audioContext.currentTime - stPlayerNode.startTimeReal);
                                totalDur = stPlayerNode.bufferDuration;
                            }

                            if (totalDur > 0) {
                                scrubber.max = totalDur;
                                scrubber.value = currentPos;
                                currentLabel.innerText = formatTime(currentPos);
                                totalLabel.innerText = formatTime(totalDur);
                            }
                        }, 500);
                    }

                    // Scrubber Input Handling
                    const __stScrubber = document.getElementById('stScrubber');
                    if (__stScrubber) {
                        __stScrubber.oninput = () => {
                            if (stScrubberInterval) clearInterval(stScrubberInterval);
                            const currentLabel = document.getElementById('stCurrentTime');
                            currentLabel.innerText = formatTime(__stScrubber.value);
                        };
                        __stScrubber.onchange = () => {
                            if (stPlayerNode) {
                                if (stPlayerNode.seekTo) { // YouTube
                                    stPlayerNode.seekTo(__stScrubber.value, true);
                                } else if (stPlayerNode.bufferDuration) { // File
                                    const st = book.soundtracks.find(s => s.id === activeSoundtrackId);
                                    const song = st.songs[activeStSongIndex];
                                    const newSong = { ...song, startTime: parseFloat(__stScrubber.value) };
                                    playStSong(st, activeStSongIndex, newSong); // Re-play from new offset
                                }
                            }
                            startStScrubberUpdate();
                        };
                    }

                    function nextStSong() {
                        if (!activeSoundtrackId) return;
                        const st = book.soundtracks.find(s => s.id === activeSoundtrackId);
                        if (!st || !st.songs || st.songs.length === 0) return;

                        if (st.shuffle) {
                            let newIndex = activeStSongIndex;
                            if (st.songs.length > 1) {
                                while (newIndex === activeStSongIndex) {
                                    newIndex = Math.floor(Math.random() * st.songs.length);
                                }
                            } else {
                                newIndex = 0;
                            }
                            activeStSongIndex = newIndex;
                        } else {
                            activeStSongIndex = (activeStSongIndex + 1) % st.songs.length;
                        }
                        log(`Playlist Looping: playing song index ${activeStSongIndex + 1}/${st.songs.length}`);
                        playStSong(st, activeStSongIndex);
                    }

                    function prevStSong() {
                        if (!activeSoundtrackId) return;
                        const st = book.soundtracks.find(s => s.id === activeSoundtrackId);
                        if (!st || !st.songs || st.songs.length === 0) return;
                        activeStSongIndex = (activeStSongIndex - 1 + st.songs.length) % st.songs.length;
                        playStSong(st, activeStSongIndex);
                    }

                    // Redundant initialization removed to fix duplication. Correct initialization is handled in the Extender section below.


                    function renderManifestList() {
                        const list = document.getElementById('soundtracksList');
                        if (!list) return;
                        list.innerHTML = '';
                        (book.soundtracks || []).forEach(st => {
                            const li = document.createElement('li');
                            li.className = 'flex justify-between items-center p-2 border-b border-stone-700 hover:bg-black/20';
                            li.innerHTML = `<span class="text-sm font-semibold text-accent-gold-light"><i class="${escapeHtml(st.icon)} mr-2"></i>${escapeHtml(st.name)} (${st.songs ? st.songs.length : 0} songs)</span>
            <div class="flex gap-2">
                <button class="text-accent-blue hover:text-white btn-edit-st" data-id="${st.id}"><i class="fas fa-edit"></i></button>
                <button class="text-red-400 hover:text-red-500 btn-del-st" data-id="${st.id}"><i class="fas fa-trash"></i></button>
            </div>`;
                            list.appendChild(li);

                            li.querySelector('.btn-edit-st').onclick = () => openEditSoundtrack(st);
                            li.querySelector('.btn-del-st').onclick = () => {
                                if (confirm('Delete playlist?')) {
                                    book.soundtracks = book.soundtracks.filter(s => s.id !== st.id);
                                    if (activeSoundtrackId === st.id) stopSoundtrack();
                                    renderManifestList();
                                    document.getElementById('editSoundtrackContainer').classList.add('hidden');
                                    saveToLocalStorage();
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
                        const addedChIds = new Set();
                        book.chapters.forEach(ch => {
                            if (!addedChIds.has(ch.id)) {
                                chSelect.innerHTML += `<option value="${ch.id}">${escapeHtml(ch.name)}</option>`;
                                addedChIds.add(ch.id);
                            }
                        });

                        // Set multi-select values
                        const selectedChapters = st.chapters || (st.chapter && st.chapter !== 'none' ? [st.chapter] : []);
                        Array.from(chSelect.options).forEach(opt => {
                            opt.selected = selectedChapters.includes(opt.value);
                        });

                        document.getElementById('editStVolume').value = st.volume !== undefined ? st.volume : 100;
                        document.getElementById('editStShuffle').checked = st.shuffle === true;

                        renderStSongs(st);
                    }

                    function renderStSongs(st) {
                        const list = document.getElementById('stSongsList');
                        list.innerHTML = '';
                        (st.songs || []).forEach((song, i) => {
                            const li = document.createElement('li');
                            li.className = 'flex justify-between items-center p-2 text-sm border-b border-stone-800';
                            const songTypeBadge = song.type === 'youtube' ? '<i class="fab fa-youtube text-red-500 ml-2"></i>' : '<i class="fas fa-file-audio text-blue-400 ml-2"></i>';
                            li.innerHTML = `<span><span class="text-gray-500 mr-2">${i + 1}.</span>${escapeHtml(song.name)} ${songTypeBadge}</span>
            <div class="flex gap-2">
                <button class="text-accent-blue" onclick="window.editStSong(${i})"><i class="fas fa-edit"></i></button>
                <button class="text-red-400" onclick="window.deleteStSong(${i})"><i class="fas fa-trash"></i></button>
            </div>`;
                            list.appendChild(li);
                        });
                    }

                    window.deleteStSong = function (index) {
                        const st = book.soundtracks.find(s => s.id === editStCurrentId);
                        st.songs.splice(index, 1);
                        renderStSongs(st);
                    }
                    window.editStSong = function (index) {
                        const st = book.soundtracks.find(s => s.id === editStCurrentId);
                        const song = st.songs[index];
                        document.getElementById('stSongEditIndex').value = index;
                        document.getElementById('stSongName').value = song.name;
                        document.getElementById('stSongVolume').value = song.volume || 100;

                        const radioBtn = document.querySelector(`input[name="stSongType"][value="${song.type}"]`);
                        if (radioBtn) radioBtn.checked = true;
                        document.getElementById('stSongStartTime').value = formatTimeHms(song.startTime || 0);
                        document.getElementById('stSongEndTime').value = song.endTime !== null && song.endTime !== undefined ? formatTimeHms(song.endTime) : '';

                        document.getElementById('stSongYoutubeUrl').value = song.type === 'youtube' ? song.url : '';

                        document.getElementById('stSongYoutubeContainer').classList.toggle('hidden', song.type !== 'youtube');
                        document.getElementById('stSongFileContainer').classList.toggle('hidden', song.type !== 'file');

                        document.getElementById('stAddSongModal').style.display = 'flex';
                    }







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
                            keepAliveAudio.play().catch(e => log("Keep-alive auto-play prevented until user interaction."));
                        } else {
                            if (keepAliveAudio) {
                                keepAliveAudio.pause();
                            }
                        }
                    }

                    // --- Initial Setup ---
                    function initializeApp() {
                        log("Initializing app...");

                        if (pipCanvas) {
                            pipCanvas.width = PIP_CANVAS_SIZE;
                            pipCanvas.height = PIP_CANVAS_SIZE;
                            pipCanvasCtx = pipCanvas.getContext('2d');
                        } else {
                            console.error("PiP Canvas element not found during initialization!");
                        }
                        if (!pipVideo) {
                            console.error("PiP Video element not found!");
                        }

                        // Check for Spotify redirect on page load
                        checkForSpotifyRedirect();

                        const loadedFromStorage = loadFromLocalStorage();
                        if (!loadedFromStorage) {
                            book = getDefaultBook();
                            currentListeningMode = book.settings.listeningMode;
                            isCompoundPhrasingEnabled = book.settings.compoundPhrasing;
                            currentKeywordConfidenceThreshold = book.settings.accuracyThreshold;
                            stopAudioMode = book.settings.stopAudioMode;
                            currentMasterVolume = book.settings.masterVolume;
                            masterVolumeSlider.value = currentMasterVolume;
                            masterVolumeValueSpan.textContent = `${currentMasterVolume}`;
                            stopPhrases = book.settings.stopPhrases;
                            customEnterPhrases = book.settings.customEnterPhrases;
                            customExitPhrases = book.settings.customExitPhrases;
                            daytimeTransitionPhrases = book.settings.daytimeTransitionPhrases;
                            nighttimeTransitionPhrases = book.settings.nighttimeTransitionPhrases;
                            autoplayOnClickSetting = book.settings.autoplayOnClick;
                            youtubeApiKeys = book.settings.youtubeApiKeys || [];
                            syrinscapeAuthToken = book.settings.syrinscapeAuthToken;
                            syrinscapePlayerReady = false;
                            currentTimeOfDay = book.currentTimeOfDay;
                            plotBoardView = { ...book.storyPlot.viewTransform };
                            log("Initialized with default empty book.");
                        } else {
                            log("Book loaded successfully from local storage.");
                            currentListeningMode = book.settings.listeningMode;
                            isCompoundPhrasingEnabled = book.settings.compoundPhrasing;
                            currentKeywordConfidenceThreshold = book.settings.accuracyThreshold;
                            stopAudioMode = book.settings.stopAudioMode;
                            currentMasterVolume = book.settings.masterVolume;
                            masterVolumeSlider.value = currentMasterVolume;
                            masterVolumeValueSpan.textContent = `${currentMasterVolume}`;
                            stopPhrases = book.settings.stopPhrases;
                            customEnterPhrases = book.settings.customEnterPhrases;
                            customExitPhrases = book.settings.customExitPhrases;
                            daytimeTransitionPhrases = book.settings.daytimeTransitionPhrases;
                            nighttimeTransitionPhrases = book.settings.nighttimeTransitionPhrases;
                            autoplayOnClickSetting = book.settings.autoplayOnClick;
                            syrinscapeAuthToken = book.settings.syrinscapeAuthToken;
                            syrinscapePlayerReady = false;
                            currentTimeOfDay = book.currentTimeOfDay;
                            plotBoardView = { ...(book.storyPlot.viewTransform || { x: 0, y: 0, scale: 1.0 }) };
                        }

                        if (openStoryPlotterButton) {
                            openStoryPlotterButton.addEventListener('click', openStoryPlotterModal);
                        } else {
                            console.warn("Export Chapter button not found in HTML.");
                        }


                        updateFuseIndex();
                        updateChapterKeywordList();
                        renderChapterTabs();
                        renderPageList();
                        renderSoundtrackIcons();
                        updateUIState();

                        // Restore cached local audio from IndexedDB so files play without a
                        // manual relink (B3). Runs in the background; re-renders when done.
                        rehydrateAudioFromStore().catch(e => console.warn('Audio rehydrate failed:', e));

                        if (initializeSyrinscapeButton) {
                            initializeSyrinscapeButton.addEventListener('click', initializeSyrinscapePlayer);
                        }
                        if (addSyrinscapeSearchButton) {
                            addSyrinscapeSearchButton.addEventListener('click', () => openSyrinscapeSearchModal('add'));
                        }
                        // (Removed: listener for the deleted sourceVariationSyrinscapeSearch button, B4)
                        if (executeSyrinscapeSearchButton) {
                            executeSyrinscapeSearchButton.addEventListener('click', executeSyrinscapeAPISearch);
                        }
                        if (executeYoutubeSearchButton) {
                            executeYoutubeSearchButton.addEventListener('click', () => handleYoutubeSearch(false));
                        }

                        if (cancelSyrinscapeSearchButton) {
                            cancelSyrinscapeSearchButton.addEventListener('click', closeSyrinscapeSearchModal);
                        }
                        // YouTube Search Listeners
                        if (addYoutubeSearchButton) addYoutubeSearchButton.addEventListener('click', () => openYoutubeSearchModal('add'));
                        if (sourceYoutubeSearchButton) sourceYoutubeSearchButton.addEventListener('click', () => openYoutubeSearchModal('source'));
                        if (youtubeSearchQueryInput) {
                            youtubeSearchQueryInput.addEventListener('focus', () => {
                                if (recentYoutubeSearches.length > 0) {
                                    document.getElementById('youtubeRecentSearchesContainer').classList.remove('hidden');
                                }
                            });
                            youtubeSearchQueryInput.addEventListener('keydown', (event) => {
                                if (event.key === 'Enter') {
                                    handleYoutubeSearch(false);
                                }
                            });
                            youtubeSearchQueryInput.addEventListener('blur', () => {
                                // Use a timeout to allow click on a recent search item before hiding
                                setTimeout(() => document.getElementById('youtubeRecentSearchesContainer').classList.add('hidden'), 150);
                            });
                        }

                        if (executeYoutubeSearchButton) executeYoutubeSearchButton.addEventListener('click', () => handleYoutubeSearch(false));
                        if (cancelYoutubeSearchButton) cancelYoutubeSearchButton.addEventListener('click', closeYoutubeSearchModal);
                        if (syrinscapeAuthToken) {
                            addSelectedYoutubeVideosButton.addEventListener('click', addSelectedYoutubeVideos);
                            initializeSyrinscapePlayer();
                        }
                        evaluateAppendixStateTriggers(); // Initial evaluation on load


                        closeStoryPlotterButton.addEventListener('click', closeStoryPlotterModal);
                        plotBoardContainer.addEventListener('wheel', handlePlotBoardZoom, { passive: false });
                        plotBoardContainer.addEventListener('mousedown', handlePlotBoardPanStart);
                        plotterZoomInButton.addEventListener('click', () => { plotBoardView.scale = Math.min(PLOT_BOARD_MAX_ZOOM, plotBoardView.scale * 1.1); applyPlotBoardTransform(); });
                        plotterZoomOutButton.addEventListener('click', () => { plotBoardView.scale = Math.max(PLOT_BOARD_MIN_ZOOM, plotBoardView.scale / 1.1); applyPlotBoardTransform(); });
                        plotterResetViewButton.addEventListener('click', resetPlotBoardView);


                        if (cancelPlotThreadMenuButton) cancelPlotThreadMenuButton.addEventListener('click', closePlotThreadMenu);
                        if (savePlotThreadChangesButton) savePlotThreadChangesButton.addEventListener('click', savePlotThreadMenuChanges);
                        if (deletePlotThreadButton) deletePlotThreadButton.addEventListener('click', deletePlotThreadFromMenu);
                        if (plotThreadTransitionPhrasesInput) plotThreadTransitionPhrasesInput.addEventListener('input', filterPlotThreadMenuSounds);
                        if (plotThreadSoundSearchInput) plotThreadSoundSearchInput.addEventListener('input', filterPlotThreadMenuSounds);

                        // PiP Button Listener
                        if (togglePipButton) {
                            togglePipButton.addEventListener('click', togglePictureInPicture);
                        }


                        log("Storyteller Initialized.");
                    }


                    // ===== NATIVE APPLICATION EXTENDER ===== //
                    // We are safely inside DOMContentLoaded with full access to the local scope!

                    // 1. ACTIVE SOUNDS TRACKER
                    const __activeSoundsContainer = document.getElementById('activeSoundsListContainer');
                    if (__activeSoundsContainer) {
                        function updateActiveSoundsUINative() {
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
                                        let title = 'Unknown Sound';
                                        if (typeof book !== 'undefined' && book && book.pages) {
                                            const p = book.pages.find(page => page.id == pageId);
                                            if (p) title = p.title;
                                        }
                                        longSounds.push({ id: parseInt(pageId, 10), title: title, isSt: false });
                                    }
                                });
                            }

                            if (typeof activeSoundtrackId !== 'undefined' && activeSoundtrackId && typeof isStPlaying !== 'undefined' && isStPlaying) {
                                const st = (typeof book !== 'undefined' && book && book.soundtracks) ? book.soundtracks.find(s => s.id == activeSoundtrackId) : null;
                                if (st) {
                                    longSounds.push({ id: activeSoundtrackId, title: st.name + ' (Playlist)', isSt: true });
                                }
                            }

                            __activeSoundsContainer.style.display = 'block';
                            __activeSoundsContainer.innerHTML = '';

                            const header = document.createElement('div');
                            header.className = 'text-[0.65rem] font-bold text-[var(--accent-gold-light)] mb-1 uppercase tracking-widest text-center border-b border-stone-700/50 pb-1 w-full';
                            header.innerHTML = '<i class="fas fa-music mr-2"></i>Active Audio';
                            __activeSoundsContainer.appendChild(header);

                            if (longSounds.length === 0) {
                                const emptyMsg = document.createElement('div');
                                emptyMsg.className = 'text-xs text-stone-500 italic text-center w-full mt-2';
                                emptyMsg.textContent = 'No active audio.';
                                __activeSoundsContainer.appendChild(emptyMsg);
                                return;
                            }

                            const ul = document.createElement('ul');
                            ul.className = 'grid grid-cols-1 min-[900px]:grid-cols-2 lg:grid-cols-2 gap-2 flex-grow overflow-y-auto max-h-[20vh] w-full mt-1 scrollbar-thin scrollbar-thumb-stone-600 scrollbar-track-transparent';

                            longSounds.forEach(sound => {
                                const li = document.createElement('li');
                                li.className = 'flex justify-between items-center bg-black/40 border border-stone-700/60 rounded px-2 py-1.5 text-sm text-stone-300 hover:border-stone-500 transition-colors w-full';

                                const span = document.createElement('span');
                                span.className = 'truncate pr-2 text-xs font-semibold flex-1';
                                span.title = sound.title;
                                span.textContent = sound.title;
                                li.appendChild(span);

                                const btn = document.createElement('button');
                                btn.className = 'text-red-400 hover:text-red-500 cursor-pointer ml-1 flex-shrink-0 transition-transform hover:scale-110 active:scale-95';
                                btn.innerHTML = '<i class="fas fa-stop-circle"></i>';

                                btn.onclick = () => {
                                    if (sound.isSt) {
                                        if (typeof stopSoundtrack === 'function') stopSoundtrack();
                                    } else {
                                        if (typeof stopSingleSound === 'function') stopSingleSound(sound.id);
                                    }
                                    updateActiveSoundsUINative();
                                };

                                li.appendChild(btn);
                                ul.appendChild(li);
                            });

                            __activeSoundsContainer.appendChild(ul);
                        }

                        setInterval(updateActiveSoundsUINative, 1000);
                        setTimeout(updateActiveSoundsUINative, 100);
                    }

                    // 2. SOUNDTRACK MODAL CONTROLS
                    const __openManageBtn = document.getElementById('openManageSoundtracksButton');
                    if (__openManageBtn) {
                        __openManageBtn.removeAttribute('onclick');
                        __openManageBtn.onclick = () => {
                            if (typeof book !== 'undefined' && book) {
                                book.soundtracks = book.soundtracks || [];
                                if (typeof renderManifestList === 'function') renderManifestList();
                                document.getElementById('manageSoundtracksModal').style.display = 'flex';
                                document.getElementById('modalOverlay').style.display = 'block';
                                document.getElementById('editSoundtrackContainer').classList.add('hidden');
                            }
                        };
                    }

                    const __addStBtn = document.getElementById('addSoundtrackBtn');
                    if (__addStBtn) {
                        __addStBtn.onclick = () => {
                            if (typeof book !== 'undefined' && book) {
                                const newSt = { id: 'st_' + Date.now(), name: 'New Playlist', icon: 'fas fa-music', keywords: [], timeOfDay: 'none', chapter: 'none', songs: [], shuffle: false };
                                book.soundtracks = book.soundtracks || [];
                                book.soundtracks.push(newSt);
                                if (typeof openEditSoundtrack === 'function') openEditSoundtrack(newSt);
                                if (typeof renderManifestList === 'function') renderManifestList();
                            }
                        };
                    }

                    const __saveStBtn = document.getElementById('saveSoundtrackBtn');
                    if (__saveStBtn) {
                        __saveStBtn.onclick = () => {
                            if (typeof editStCurrentId !== 'undefined' && editStCurrentId && typeof book !== 'undefined' && book) {
                                const st = book.soundtracks.find(s => s.id === editStCurrentId);
                                if (st) {
                                    st.name = document.getElementById('editStName').value.trim() || 'Unnamed';
                                    st.icon = document.getElementById('editStIcon').value.trim() || 'fas fa-music';
                                    st.keywords = document.getElementById('editStKeywords').value.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
                                    st.timeOfDay = document.getElementById('editStTimeOfDay').value;
                                    st.chapters = Array.from(document.getElementById('editStChapter').selectedOptions).map(o => o.value).filter(v => v !== 'none');
                                    // st.chapter = st.chapters[0] || 'none'; // Keep legacy for compatibility
                                    st.volume = parseInt(document.getElementById('editStVolume').value, 10) || 100;
                                    st.shuffle = document.getElementById('editStShuffle').checked;
                                    if (typeof showTemporaryMessage === 'function') showTemporaryMessage('Saved playlist settings.', 'success');
                                    if (typeof renderManifestList === 'function') renderManifestList();
                                    if (typeof renderSoundtrackIcons === 'function') renderSoundtrackIcons();
                                }
                            }
                        };
                    }

                    const __closeStBtn = document.getElementById('closeSoundtracksModalBtn');
                    if (__closeStBtn) {
                        __closeStBtn.onclick = () => {
                            document.getElementById('manageSoundtracksModal').style.display = 'none';
                            document.getElementById('modalOverlay').style.display = 'none';
                            if (typeof saveToLocalStorage === 'function') saveToLocalStorage();
                        };
                    }

                    const __manageOverlayClose = document.getElementById('modalOverlay');
                    if (__manageOverlayClose) {
                        __manageOverlayClose.addEventListener('click', () => {
                            if (document.getElementById('manageSoundtracksModal').style.display === 'flex') {
                                if (typeof saveToLocalStorage === 'function') saveToLocalStorage();
                            }
                        });
                    }

                    // --- ROBUST MODAL BUTTON BINDINGS ---
                    const __stIds = [
                        'stPrevBtn', 'stPlayPauseBtn', 'stNextBtn', 'stShuffleBtn', 'stCloseBtn', 'stVolumeSlider',
                        'addStSongBtn', 'saveStSongBtn', 'cancelStSongBtn',
                        'importSpotifyPlaylistBtn', 'executeSpotifyImportBtn', 'cancelSpotifyImportBtn',
                        'openIconPickerBtn', 'cancelIconPickerBtn'
                    ];

                    __stIds.forEach(id => {
                        const btn = document.getElementById(id);
                        if (btn) btn.removeAttribute('onclick'); // clear previous
                    });

                    // 3. PLAYBACK CONTROLS
                    const __stPlayBtn = document.getElementById('stPlayPauseBtn');
                    if (__stPlayBtn) __stPlayBtn.onclick = () => { if (isStPlaying) pauseSoundtrack(); else resumeSoundtrack(); };

                    const __stNextBtn = document.getElementById('stNextBtn');
                    if (__stNextBtn) __stNextBtn.onclick = nextStSong;

                    const __stPrevBtn = document.getElementById('stPrevBtn');
                    if (__stPrevBtn) __stPrevBtn.onclick = prevStSong;

                    const __stShuffleBtn = document.getElementById('stShuffleBtn');
                    if (__stShuffleBtn) __stShuffleBtn.onclick = () => {
                        if (!activeSoundtrackId) return;
                        const st = book.soundtracks.find(s => s.id === activeSoundtrackId);
                        if (st) {
                            st.shuffle = !st.shuffle;
                            if (st.shuffle && st.songs.length > 1 && (!isStPlaying || activeStSongIndex === 0)) {
                                // If turning shuffle ON and at start or stopped, pick a random song to "show" it works
                                nextStSong();
                            }
                            updateSoundtrackBarUI();
                            saveToLocalStorage();
                        }
                    };

                    const __stStopBtn = document.getElementById('stCloseBtn');
                    if (__stStopBtn) __stStopBtn.onclick = stopSoundtrack;

                    const __stVolSlider = document.getElementById('stVolumeSlider');
                    if (__stVolSlider) {
                        __stVolSlider.oninput = (e) => {
                            globalSoundtrackVolume = parseInt(e.target.value, 10);
                            if (activeSoundtrackId && isStPlaying && stPlayerNode) {
                                const st = book.soundtracks.find(s => s.id === activeSoundtrackId);
                                const song = st.songs[activeStSongIndex];
                                const finalVol = getSoundtrackFinalVol(st, song);
                                if (stPlayerNode.gainNode && audioContext) {
                                    stPlayerNode.gainNode.gain.setTargetAtTime(finalVol, audioContext.currentTime, 0.1);
                                } else if (stPlayerNode.setVolume) {
                                    stPlayerNode.setVolume(finalVol * 100);
                                }
                            }
                        };
                    }

                    // 4. SPOTIFY IMPORT EXECUTION
                    const __executeSpotifyBtn = document.getElementById('executeSpotifyImportBtn');
                    if (__executeSpotifyBtn) __executeSpotifyBtn.onclick = async () => {
                        const url = document.getElementById('spotifyPlaylistUrlInput').value.trim();
                        const statusDiv = document.getElementById('spotifyImportStatus');
                        const token = localStorage.getItem('spotify_access_token');
                        if (!token) {
                            const msg = "Error: Please log in to Spotify via Settings first.";
                            statusDiv.innerText = msg;
                            if (typeof showTemporaryMessage === 'function') showTemporaryMessage(msg, 'error');
                            return;
                        }
                        const match = url.match(/playlist\/([a-zA-Z0-9]+)/);
                        if (!match) { statusDiv.innerText = "Invalid Spotify URL."; return; }

                        statusDiv.innerText = "Fetching playlist mapping... (this takes a moment)";
                        try {
                            const res = await fetch("https://api.spotify.com/v1/playlists/" + match[1], { headers: { 'Authorization': `Bearer ${token}` } });
                            const data = await res.json();

                            if (!data.tracks) {
                                statusDiv.innerText = "Error fetching playlist or empty playlist."; return;
                            }

                            const newSt = { id: 'st_' + Date.now(), name: data.name || 'Spotify Import', icon: 'fab fa-spotify', keywords: [], timeOfDay: 'none', chapter: 'none', songs: [], shuffle: false };

                            const apiKeys = book && book.settings && book.settings.youtubeApiKeys ? book.settings.youtubeApiKeys : [];
                            let apiKeyIndex = 0;
                            let apiKey = apiKeys.length > 0 ? apiKeys[apiKeyIndex] : null;

                            if (!apiKey) {
                                statusDiv.innerText = "Playlist fetched! No YouTube API key found in Settings. Generating empty stubs...";
                            } else {
                                statusDiv.innerText = `Playlist fetched! Mapping ${data.tracks.items.length} tracks to YouTube...`;
                            }

                            for (let i = 0; i < data.tracks.items.length; i++) {
                                const item = data.tracks.items[i];
                                if (item.track) {
                                    const artistStr = item.track.artists ? item.track.artists[0].name : 'Unknown';
                                    const songName = item.track.name + " - " + artistStr;
                                    let videoId = null;
                                    let urlStr = '';

                                    if (apiKey) {
                                        try {
                                            statusDiv.innerText = `Mapping track ${i + 1}/${data.tracks.items.length}: ${songName}...`;
                                            let ytRes = await fetch(`https://www.googleapis.com/youtube/v3/search?part=snippet&q=${encodeURIComponent(songName + ' auto-generated')}&key=${apiKey}&type=video&videoEmbeddable=true&maxResults=1`);

                                            if (!ytRes.ok && ytRes.status === 403) {
                                                apiKeyIndex++;
                                                if (apiKeyIndex < apiKeys.length) {
                                                    apiKey = apiKeys[apiKeyIndex];
                                                    ytRes = await fetch(`https://www.googleapis.com/youtube/v3/search?part=snippet&q=${encodeURIComponent(songName + ' auto-generated')}&key=${apiKey}&type=video&videoEmbeddable=true&maxResults=1`);
                                                } else { apiKey = null; }
                                            }

                                            if (ytRes && ytRes.ok) {
                                                const ytData = await ytRes.json();
                                                if (ytData.items && ytData.items.length > 0) {
                                                    videoId = ytData.items[0].id.videoId;
                                                    urlStr = `https://www.youtube.com/watch?v=${videoId}`;
                                                }
                                            }
                                        } catch (e) { }
                                    }
                                    newSt.songs.push({ name: songName, type: 'youtube', volume: 100, url: urlStr, videoId: videoId });
                                }
                            }
                            statusDiv.innerText = "Playlist imported successfully!";
                            book.soundtracks.push(newSt);
                            if (typeof openEditSoundtrack === 'function') openEditSoundtrack(newSt);
                            if (typeof renderManifestList === 'function') renderManifestList();
                            if (typeof renderSoundtrackIcons === 'function') renderSoundtrackIcons(); // Refresh main UI icons
                            saveToLocalStorage();
                            setTimeout(() => { document.getElementById('spotifyImportModal').style.display = 'none'; statusDiv.innerText = ''; }, 3000);
                        } catch (err) { statusDiv.innerText = "Error: " + err.message; }
                    };

                    const __addStSongBtn = document.getElementById('addStSongBtn');
                    if (__addStSongBtn) __addStSongBtn.onclick = () => {
                        document.getElementById('stSongEditIndex').value = '';
                        document.getElementById('stSongName').value = '';
                        document.getElementById('stSongYoutubeUrl').value = '';
                        document.getElementById('stSongVolume').value = 100;
                        document.getElementById('stSongFile').value = '';
                        document.getElementById('stAddSongModal').style.display = 'flex';
                    };

                    const __cancelStSongBtn = document.getElementById('cancelStSongBtn');
                    if (__cancelStSongBtn) __cancelStSongBtn.onclick = () => {
                        document.getElementById('stAddSongModal').style.display = 'none';
                    };

                    const __saveStSongBtn = document.getElementById('saveStSongBtn');
                    if (__saveStSongBtn) __saveStSongBtn.onclick = () => {
                        if (typeof editStCurrentId === 'undefined' || !editStCurrentId) return;
                        const st = (typeof book !== 'undefined' && book) ? book.soundtracks.find(s => s.id === editStCurrentId) : null;
                        if (!st) return;

                        const idx = document.getElementById('stSongEditIndex').value;
                        const typeBox = document.querySelector('input[name="stSongType"]:checked');
                        const type = typeBox ? typeBox.value : 'youtube';

                        let songData = {
                            name: document.getElementById('stSongName').value.trim() || 'New Song',
                            type: type,
                            volume: parseInt(document.getElementById('stSongVolume').value) || 100,
                            startTime: parseTimeHms(document.getElementById('stSongStartTime').value),
                            endTime: document.getElementById('stSongEndTime').value.trim() !== '' ? parseTimeHms(document.getElementById('stSongEndTime').value) : null
                        };

                        if (type === 'youtube') {
                            const url = document.getElementById('stSongYoutubeUrl').value.trim();
                            songData.url = url;
                            const m = url.match(/(?:https?:\/\/)?(?:www\.)?(?:youtube\.com\/(?:[^\/\n\s]+\/\S+\/|(?:v|e(?:mbed)?)\/|\S*?[?&]v=)|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
                            songData.videoId = m ? m[1] : null;
                        } else if (type === 'file') {
                            const fileInput = document.getElementById('stSongFile');
                            if (fileInput && fileInput.files.length > 0) {
                                songData.fileData = fileInput.files[0];
                                if (songData.name === 'New Song') songData.name = fileInput.files[0].name;
                            }
                        }

                        if (idx === '') {
                            st.songs.push(songData);
                        } else {
                            if (type === 'file' && !songData.fileData && st.songs[idx] && st.songs[idx].fileData) {
                                songData.fileData = st.songs[idx].fileData;
                            }
                            st.songs[idx] = songData;
                        }

                        document.getElementById('stAddSongModal').style.display = 'none';
                        if (typeof renderStSongs === 'function') renderStSongs(st);
                    };

                    const __importSpotifyBtn = document.getElementById('importSpotifyPlaylistBtn');
                    if (__importSpotifyBtn) __importSpotifyBtn.onclick = () => {
                        document.getElementById('spotifyImportModal').style.display = 'flex';
                    };

                    const __cancelSpotifyImportBtn = document.getElementById('cancelSpotifyImportBtn');
                    if (__cancelSpotifyImportBtn) __cancelSpotifyImportBtn.onclick = () => {
                        document.getElementById('spotifyImportModal').style.display = 'none';
                    };



                    const __openIconPickerBtn = document.getElementById('openIconPickerBtn');
                    if (__openIconPickerBtn) __openIconPickerBtn.onclick = () => {
                        if (typeof openIconPicker === 'function' && typeof editStCurrentId !== 'undefined' && editStCurrentId) {
                            openIconPicker(editStCurrentId);
                        } else {
                            document.getElementById('iconPickerModal').style.display = 'flex';
                            if (typeof renderIconPicker === 'function') renderIconPicker();
                        }
                    };

                    const __cancelIconPickerBtn = document.getElementById('cancelIconPickerBtn');
                    if (__cancelIconPickerBtn) __cancelIconPickerBtn.onclick = () => {
                        document.getElementById('iconPickerModal').style.display = 'none';
                    };

                    function renderIconPicker(searchQuery = '') {
                        const grid = document.getElementById('iconPickerGrid');
                        if (!grid) return;

                        const defaultIcons = [
                            'fas fa-music', 'fas fa-drum', 'fas fa-guitar', 'fas fa-play', 'fas fa-headphones',
                            'fas fa-volume-up', 'fas fa-wind', 'fas fa-fire', 'fas fa-tint', 'fas fa-bolt',
                            'fas fa-leaf', 'fas fa-skull', 'fas fa-dragon', 'fas fa-ghost', 'fas fa-khanda',
                            'fas fa-shield-alt', 'fas fa-meteor', 'fas fa-magic', 'fas fa-moon', 'fas fa-sun',
                            'fas fa-campground', 'fas fa-dungeon', 'fas fa-horse', 'fas fa-spider',
                            'fas fa-swords', 'fas fa-axe', 'fas fa-mace', 'fas fa-bow-arrow', 'fas fa-shield',
                            'fas fa-book', 'fas fa-book-dead', 'fas fa-scroll', 'fas fa-vial', 'fas fa-vials',
                            'fas fa-flask', 'fas fa-user-ninja', 'fas fa-user-secret', 'fas fa-user-tie',
                            'fas fa-user-astronaut', 'fas fa-mountain', 'fas fa-cloud', 'fas fa-snowflake',
                            'fas fa-anchor', 'fas fa-ship', 'fas fa-compass', 'fas fa-map', 'fas fa-map-marked-alt',
                            'fas fa-hammer', 'fas fa-tools', 'fas fa-wrench', 'fas fa-cog', 'fas fa-cogs',
                            'fas fa-atom', 'fas fa-biohazard', 'fas fa-radiation', 'fas fa-tree', 'fas fa-feather',
                            'fas fa-crow', 'fas fa-dove', 'fas fa-frog', 'fas fa-hippo', 'fas fa-otter',
                            'fas fa-cat', 'fas fa-dog', 'fas fa-paw', 'fas fa-heart', 'fas fa-star',
                            'fas fa-gem', 'fas fa-coins', 'fas fa-money-bill-wave', 'fas fa-crown',
                            'fas fa-key', 'fas fa-lock', 'fas fa-lock-open', 'fas fa-eye', 'fas fa-eye-slash',
                            'fas fa-bug', 'fas fa-virus', 'fas fa-microscope', 'fas fa-telescope', 'fas fa-rocket',
                            'fas fa-chess-knight', 'fas fa-chess-rook', 'fas fa-chess-king', 'fas fa-chess-queen',
                            'fas fa-dice', 'fas fa-dice-d20', 'fas fa-trophy', 'fas fa-medal', 'fas fa-first-aid',
                            'fas fa-hospital', 'fas fa-plus-circle', 'fas fa-minus-circle', 'fas fa-info-circle',
                            'fas fa-question-circle', 'fas fa-exclamation-circle'
                        ];

                        const allIcons = [
                            ...new Set([
                                ...defaultIcons,
                                // Solid
                                'fas fa-shuttle-space', 'fas fa-viking', 'fas fa-wand-sparkles', 'fas fa-hat-wizard', 'fas fa-biohazard',
                                'fas fa-radiation', 'fas fa-ankh', 'fas fa-camera', 'fas fa-camera-retro', 'fas fa-video',
                                'fas fa-film', 'fas fa-clapperboard', 'fas fa-ticket', 'fas fa-gift', 'fas fa-cake-candles',
                                'fas fa-glass-water', 'fas fa-beer-mug-empty', 'fas fa-wine-glass', 'fas fa-cocktail', 'fas fa-utensils',
                                'fas fa-burger', 'fas fa-pizza-slice', 'fas fa-ice-cream', 'fas fa-cookie', 'fas fa-coffee',
                                'fas fa-mug-hot', 'fas fa-apple-whole', 'fas fa-carrot', 'fas fa-lemon', 'fas fa-pepper-hot',
                                'fas fa-fish', 'fas fa-shrimp', 'fas fa-egg', 'fas fa-bone', 'fas fa-briefcase',
                                'fas fa-folder', 'fas fa-folder-open', 'fas fa-file', 'fas fa-file-lines', 'fas fa-clipboard',
                                'fas fa-pen-nib', 'fas fa-marker', 'fas fa-eraser', 'fas fa-brush', 'fas fa-paint-roller',
                                'fas fa-paint-brush', 'fas fa-palette', 'fas fa-compass-drafting', 'fas fa-cross', 'fas fa-church',
                                'fas fa-mosque', 'fas fa-synagogue', 'fas fa-vihara', 'fas fa-torii-gate', 'fas fa-dharmachakra',
                                'fas fa-om', 'fas fa-star-and-crescent', 'fas fa-yin-yang', 'fas fa-hamsa', 'fas fa-peace',
                                'fas fa-hand-holding-heart', 'fas fa-hands-holding-child', 'fas fa-baby', 'fas fa-child', 'fas fa-user-group',
                                'fas fa-users-viewfinder', 'fas fa-address-book', 'fas fa-address-card', 'fas fa-id-card', 'fas fa-landmark',
                                'fas fa-fort-awesome', 'fas fa-monument', 'fas fa-archway', 'fas fa-building', 'fas fa-city',
                                'fas fa-hotel', 'fas fa-house', 'fas fa-igloo', 'fas fa-tent', 'fas fa-warehouse',
                                'fas fa-car', 'fas fa-bus', 'fas fa-train', 'fas fa-plane', 'fas fa-helicopter',
                                'fas fa-motorcycle', 'fas fa-bicycle', 'fas fa-truck', 'fas fa-tractor', 'fas fa-rocket',
                                'fas fa-space-shuttle', 'fas fa-earth-americas', 'fas fa-earth-europe', 'fas fa-earth-asia', 'fas fa-earth-africa',
                                'fas fa-earth-oceania', 'fas fa-globe', 'fas fa-satellite', 'fas fa-satellite-dish', 'fas fa-robot',
                                'fas fa-microchip', 'fas fa-vr-cardboard', 'fas fa-gamepad', 'fas fa-keyboard', 'fas fa-mouse',
                                'fas fa-desktop', 'fas fa-laptop', 'fas fa-mobile-screen-button', 'fas fa-tablet-screen-button', 'fas fa-tv',
                                'fas fa-wifi', 'fas fa-power-off', 'fas fa-battery-full', 'fas fa-plug', 'fas fa-charging-station',
                                'fas fa-lightbulb', 'fas fa-fan', 'fas fa-bath', 'fas fa-shower', 'fas fa-bed',
                                'fas fa-chair', 'fas fa-couch', 'fas fa-toilet', 'fas fa-sink', 'fas fa-soap',
                                'fas fa-broom', 'fas fa-bucket', 'fas fa-glasses', 'fas fa-shirt', 'fas fa-socks',
                                'fas fa-mitten', 'fas fa-hat-cowboy', 'fas fa-graduation-cap', 'fas fa-scissors', 'fas fa-screwdriver',
                                'fas fa-toolbox', 'fas fa-gear', 'fas fa-wrench', 'fas fa-hammer', 'fas fa-trowel',
                                'fas fa-magnet', 'fas fa-link', 'fas fa-paperclip', 'fas fa-thumbtack', 'fas fa-anchor',
                                'fas fa-truck-monster', 'fas fa-trash-can', 'fas fa-recycle', 'fas fa-leaf', 'fas fa-seedling',
                                'fas fa-bug', 'fas fa-sprout', 'fas fa-bacteria', 'fas fa-microscope', 'fas fa-dna',
                                'fas fa-brain', 'fas fa-heart-pulse', 'fas fa-pills', 'fas fa-syringe', 'fas fa-bandage',
                                'fas fa-briefcase-medical', 'fas fa-stethoscope', 'fas fa-wheelchair', 'fas fa-lungs', 'fas fa-kidneys',
                                'fas fa-ribbon', 'fas fa-trophy', 'fas fa-medal', 'fas fa-award', 'fas fa-football',
                                'fas fa-basketball', 'fas fa-volleyball', 'fas fa-baseball', 'fas fa-golf-ball-tee', 'fas fa-bowling-ball',
                                'fas fa-table-tennis-paddle-ball', 'fas fa-dumbbell', 'fas fa-person-running', 'fas fa-person-swimming', 'fas fa-person-hiking',
                                'fas fa-bicycle', 'fas fa-snowboarding', 'fas fa-skating', 'fas fa-skiing', 'fas fa-mountain-sun',
                                'fas fa-tent', 'fas fa-campground', 'fas fa-binoculars', 'fas fa-map-location-dot', 'fas fa-magnifying-glass-location',
                                'fas fa-location-arrow', 'fas fa-compass', 'fas fa-flag', 'fas fa-bullhorn', 'fas fa-bell',
                                'fas fa-bell-slash', 'fas fa-comment', 'fas fa-comments', 'fas fa-quote-left', 'fas fa-quote-right',
                                'fas fa-share-nodes', 'fas fa-share', 'fas fa-reply', 'fas fa-forward', 'fas fa-backward',
                                'fas fa-play', 'fas fa-pause', 'fas fa-stop', 'fas fa-volume-high', 'fas fa-volume-low',
                                'fas fa-volume-off', 'fas fa-volume-xmark', 'fas fa-music', 'fas fa-microphone', 'fas fa-camera',
                                'fas fa-calculator', 'fas fa-coins', 'fas fa-money-bill', 'fas fa-credit-card', 'fas fa-wallet',
                                'fas fa-shop', 'fas fa-cart-shopping', 'fas fa-barcode', 'fas fa-qrcode', 'fas fa-tags',
                                'fas fa-ticket', 'fas fa-key', 'fas fa-lock', 'fas fa-unlock', 'fas fa-shield',
                                'fas fa-eye', 'fas fa-eye-slash', 'fas fa-house', 'fas fa-user', 'fas fa-user-plus',
                                'fas fa-user-minus', 'fas fa-user-check', 'fas fa-user-xmark', 'fas fa-users', 'fas fa-user-group',
                                'fas fa-magnifying-glass', 'fas fa-magnifying-glass-plus', 'fas fa-magnifying-glass-minus', 'fas fa-gear', 'fas fa-gears',
                                'fas fa-wrench', 'fas fa-screwdriver-wrench', 'fas fa-hammer', 'fas fa-trowel', 'fas fa-paint-roller',
                                'fas fa-brush', 'fas fa-pen', 'fas fa-pen-nib', 'fas fa-pencil', 'fas fa-highlighter',
                                'fas fa-eraser', 'fas fa-trash', 'fas fa-trash-can', 'fas fa-folder', 'fas fa-file',
                                'fas fa-floppy-disk', 'fas fa-print', 'fas fa-envelope', 'fas fa-inbox', 'fas fa-paper-plane',
                                'fas fa-paperclip', 'fas fa-link', 'fas fa-at', 'fas fa-hashtag', 'fas fa-check',
                                'fas fa-xmark', 'fas fa-plus', 'fas fa-minus', 'fas fa-equals', 'fas fa-divide',
                                'fas fa-percent', 'fas fa-arrow-up', 'fas fa-arrow-down', 'fas fa-arrow-left', 'fas fa-arrow-right',
                                'fas fa-arrows-up-down', 'fas fa-arrows-left-right', 'fas fa-chevron-up', 'fas fa-chevron-down', 'fas fa-chevron-left',
                                'fas fa-chevron-right', 'fas fa-angle-up', 'fas fa-angle-down', 'fas fa-angle-left', 'fas fa-angle-right',
                                'fas fa-caret-up', 'fas fa-caret-down', 'fas fa-caret-left', 'fas fa-caret-right', 'fas fa-circle-play',
                                // Regular
                                'far fa-bell', 'far fa-bookmark', 'far fa-calendar', 'far fa-chart-bar', 'far fa-clock',
                                'far fa-comment', 'far fa-envelope', 'far fa-eye', 'far fa-file', 'far fa-file-alt',
                                'far fa-folder', 'far fa-heart', 'far fa-image', 'far fa-lightbulb', 'far fa-map',
                                'far fa-moon', 'far fa-newspaper', 'far fa-paper-plane', 'far fa-question-circle', 'far fa-smile',
                                'far fa-star', 'far fa-sun', 'far fa-user', 'far fa-user-circle',
                                // Brands
                                'fab fa-spotify', 'fab fa-youtube', 'fab fa-twitch', 'fab fa-discord', 'fab fa-github',
                                'fab fa-facebook', 'fab fa-twitter', 'fab fa-instagram', 'fab fa-linkedin', 'fab fa-google',
                                'fab fa-amazon', 'fab fa-apple', 'fab fa-windows', 'fab fa-android', 'fab fa-linux',
                                'fab fa-steam', 'fab fa-xbox', 'fab fa-playstation', 'fab fa-reddit', 'fab fa-stack-overflow'
                            ])
                        ];

                        const iconsToUse = searchQuery.trim() === '' ? defaultIcons : allIcons;

                        const filteredIcons = iconsToUse.filter(icon => {
                            const name = icon.replace(/fa(s|r|b) fa-/, '').toLowerCase();
                            return name.includes(searchQuery.toLowerCase());
                        });

                        grid.innerHTML = '';

                        // Add "Use Custom" option if searching
                        if (searchQuery.trim().length > 2) {
                            const customIconClasses = [
                                `fas fa-${searchQuery.trim().toLowerCase()}`,
                                `fab fa-${searchQuery.trim().toLowerCase()}`,
                                `far fa-${searchQuery.trim().toLowerCase()}`
                            ];
                            
                            customIconClasses.forEach(iconClass => {
                                const btn = document.createElement('button');
                                btn.className = 'w-10 h-10 flex items-center justify-center text-xl text-stone-400 hover:text-[var(--accent-gold-light)] hover:bg-white/10 rounded transition-all border border-stone-700 bg-stone-900/40';
                                btn.innerHTML = `<i class="${iconClass}"></i>`;
                                btn.title = `Custom: ${iconClass}`;
                                btn.onclick = () => {
                                    const stId = document.getElementById('iconPickerModal').dataset.stId;
                                    const soundtrack = book.soundtracks.find(st => st.id === stId);
                                    if (soundtrack) {
                                        soundtrack.icon = iconClass;
                                        saveToLocalStorage();
                                        if (typeof renderSoundtrackMenu === 'function') renderSoundtrackMenu();
                                        if (typeof renderSoundtrackIcons === 'function') renderSoundtrackIcons();
                                        if (document.getElementById('editStIcon')) document.getElementById('editStIcon').value = iconClass;
                                        if (typeof renderManifestList === 'function') renderManifestList();
                                    }
                                    closeIconPicker();
                                };
                                grid.appendChild(btn);
                            });
                        }
                        filteredIcons.forEach(iconClass => {
                            const btn = document.createElement('button');
                            btn.className = 'w-10 h-10 flex items-center justify-center text-xl text-stone-400 hover:text-[var(--accent-gold-light)] hover:bg-white/10 rounded transition-all';
                            btn.innerHTML = `<i class="${iconClass}"></i>`;
                            btn.title = iconClass.replace('fas fa-', '');
                            btn.onclick = () => {
                                const stId = document.getElementById('iconPickerModal').dataset.stId;
                                const soundtrack = book.soundtracks.find(st => st.id === stId);
                                if (soundtrack) {
                                    soundtrack.icon = iconClass;
                                    saveToLocalStorage();
                                    if (typeof renderSoundtrackMenu === 'function') renderSoundtrackMenu();
                                    if (typeof renderSoundtrackIcons === 'function') renderSoundtrackIcons();
                                    if (document.getElementById('editStIcon')) document.getElementById('editStIcon').value = iconClass;
                                    if (typeof renderManifestList === 'function') renderManifestList();
                                }
                                closeIconPicker();
                            };
                            grid.appendChild(btn);
                        });

                        if (filteredIcons.length === 0) {
                            grid.innerHTML = '<div class="col-span-6 text-center text-stone-500 py-4">No icons found</div>';
                        }
                    }

                    function openIconPicker(stId) {
                        const modal = document.getElementById('iconPickerModal');
                        const overlay = document.getElementById('modalOverlay');
                        const searchInput = document.getElementById('iconPickerSearch');

                        modal.dataset.stId = stId;
                        if (searchInput) searchInput.value = '';

                        renderIconPicker();

                        modal.style.display = 'flex';
                        if (overlay) overlay.style.display = 'block';

                        if (searchInput) {
                            searchInput.focus();
                            searchInput.oninput = (e) => renderIconPicker(e.target.value);
                        }
                    }

                    function closeIconPicker() {
                        const modal = document.getElementById('iconPickerModal');
                        const overlay = document.getElementById('modalOverlay');
                        modal.style.display = 'none';
                        if (overlay) overlay.style.display = 'none';
                    }

                    const cancelIconPickerBtn = document.getElementById('cancelIconPickerBtn');
                    if (cancelIconPickerBtn) {
                        cancelIconPickerBtn.onclick = closeIconPicker;
                    }

                    // --- Song Modal Type Radio Listener ---
                    document.querySelectorAll('input[name="stSongType"]').forEach(radio => {
                        radio.addEventListener('change', (e) => {
                            const isYoutube = e.target.value === 'youtube';
                            document.getElementById('stSongYoutubeContainer').classList.toggle('hidden', !isYoutube);
                            document.getElementById('stSongFileContainer').classList.toggle('hidden', isYoutube);
                        });
                    });

                    // --- Time Utilities ---
                    function formatTimeHms(seconds) {
                        if (seconds === null || seconds === undefined || isNaN(seconds)) return '';
                        const hrs = Math.floor(seconds / 3600);
                        const mins = Math.floor((seconds % 3600) / 60);
                        const secs = Math.floor(seconds % 60);
                        return [hrs, mins, secs].map(v => v < 10 ? "0" + v : v).join(":");
                    }

                    function parseTimeHms(str) {
                        if (!str || typeof str !== 'string') return 0;
                        const parts = str.split(':').map(Number);
                        if (parts.length === 3) return (parts[0] * 3600) + (parts[1] * 60) + parts[2];
                        if (parts.length === 2) return (parts[0] * 60) + parts[1];
                        if (parts.length === 1) return parts[0];
                        return 0;
                    }

                    // --- Start the application ---

                    initializeApp();

                }); // End DOMContentLoaded listener
