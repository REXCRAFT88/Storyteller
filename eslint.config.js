// ESLint flat config. The primary value here is `no-undef`: it catches
// references to variables/elements that don't exist — the exact class of decay
// that produced ANALYSIS.md B4. Run `npm run lint`.
import js from '@eslint/js';

export default [
  js.configs.recommended,
  {
    files: ['js/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      globals: {
        // Browser
        window: 'readonly', document: 'readonly', navigator: 'readonly',
        localStorage: 'readonly', location: 'readonly', console: 'readonly',
        setTimeout: 'readonly', clearTimeout: 'readonly', setInterval: 'readonly',
        clearInterval: 'readonly', fetch: 'readonly', URL: 'readonly',
        Audio: 'readonly', AudioContext: 'readonly', webkitAudioContext: 'readonly',
        SpeechRecognition: 'readonly', webkitSpeechRecognition: 'readonly',
        FileReader: 'readonly', Blob: 'readonly', File: 'readonly',
        HTMLVideoElement: 'readonly', requestAnimationFrame: 'readonly',
        cancelAnimationFrame: 'readonly', crypto: 'readonly', indexedDB: 'readonly',
        alert: 'readonly', confirm: 'readonly', prompt: 'readonly',
        // Additional standard browser/DOM globals
        Event: 'readonly', CustomEvent: 'readonly', Option: 'readonly',
        URLSearchParams: 'readonly', TextEncoder: 'readonly', TextDecoder: 'readonly',
        btoa: 'readonly', atob: 'readonly', DOMParser: 'readonly', Image: 'readonly',
        FileList: 'readonly', FormData: 'readonly', Map: 'readonly', Set: 'readonly',
        Promise: 'readonly', Intl: 'readonly', structuredClone: 'readonly',
        getComputedStyle: 'readonly', MutationObserver: 'readonly',
        ResizeObserver: 'readonly', performance: 'readonly', screen: 'readonly',
        AudioBuffer: 'readonly', AudioBufferSourceNode: 'readonly',
        Headers: 'readonly', HTMLCanvasElement: 'readonly', HTMLElement: 'readonly',
        // Third-party globals loaded via CDN
        Fuse: 'readonly', YT: 'readonly', syrinscape: 'readonly', tailwind: 'readonly',
        onYouTubeIframeAPIReady: 'writable',
      },
    },
    rules: {
      'no-undef': 'error',
      'no-unused-vars': ['warn', { args: 'none', varsIgnorePattern: '^_' }],
      'no-empty': ['warn', { allowEmptyCatch: true }],
      'no-constant-condition': ['warn', { checkLoops: false }],
    },
  },
];
