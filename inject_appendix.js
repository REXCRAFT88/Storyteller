const fs = require('fs');
let html = fs.readFileSync('index.html', 'utf8');

if (!html.includes('value="play_soundtrack"')) {
    html = html.replace('<option value="start_pages">Start Pages</option>',
        '<option value="play_soundtrack">Play Soundtrack</option>\n<option value="stop_soundtrack">Stop Soundtrack</option>\n<option value="start_pages">Start Pages</option>');
}

const renderInjection = `
                        case 'play_soundtrack':
                            paramsContainer.innerHTML = '<label class="block text-sm font-medium mb-1 mt-2">Select Soundtrack:</label><select class="appendix-st-select bg-stone-900 border border-stone-700 rounded px-2 py-1 w-full text-sm"></select>';
                            const stSelect = paramsContainer.querySelector('.appendix-st-select');
                            stSelect.innerHTML = '<option value="">-- Select --</option>';
                            (window.book.soundtracks || []).forEach(st => {
                                stSelect.innerHTML += '<option value="'+st.id+'">'+st.name+'</option>';
                            });
                            if (params && params.soundtrackId) stSelect.value = params.soundtrackId;
                            targetContainer.innerHTML = '<p class="text-xs text-gray-500 mt-2">Target: Global Context (Audio System)</p>';
                            break;
                        case 'stop_soundtrack':
                            paramsContainer.innerHTML = '<p class="text-xs text-gray-500 mt-2">Stops the currently playing soundtrack.</p>';
                            targetContainer.innerHTML = '<p class="text-xs text-gray-500 mt-2">Target: Global Context (Audio System)</p>';
                            break;
`;
if (!html.includes("case 'play_soundtrack':")) {
    html = html.replace("case 'start_pages':", renderInjection + "                        case 'start_pages':");
}

const paramInjection = `
                            case 'play_soundtrack':
                                const stSel = paramsContainer.querySelector('.appendix-st-select');
                                if(stSel) params.soundtrackId = stSel.value;
                                break;
                            case 'stop_soundtrack':
                                break;
`;
if (!html.includes("params.soundtrackId = stSel.value;")) {
    html = html.replace("case 'increase_volume':", paramInjection + "                            case 'increase_volume':");
}

const reversalInjection = `
                                    case 'play_soundtrack': reversedType = 'stop_soundtrack'; break;
                                    case 'stop_soundtrack': return null;
`;
if (!html.includes("reversedType = 'stop_soundtrack'")) {
    html = html.replace("case 'start_pages': reversedType = 'end_pages'; break;", reversalInjection + "                                    case 'start_pages': reversedType = 'end_pages'; break;");
}

const execInjection = `
                                case 'play_soundtrack':
                                    if(effect.params && effect.params.soundtrackId && typeof toggleSoundtrack !== 'undefined'){
                                        if (activeSoundtrackId !== effect.params.soundtrackId) {
                                            toggleSoundtrack(effect.params.soundtrackId);
                                        }
                                    }
                                    break;
                                case 'stop_soundtrack':
                                    if(typeof stopSoundtrack !== 'undefined') stopSoundtrack();
                                    break;
`;
if (!html.includes("stopSoundtrack()")) {
    html = html.replace(/(case 'start_pages':\s+targetPageIds\.forEach)/, execInjection + "$1");
}

fs.writeFileSync('index.html', html, 'utf8');
console.log('Appendix hooks injected.');
