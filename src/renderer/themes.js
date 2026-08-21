// App-wide themes. The CSS side lives in styles.css as variable overrides on
// body[data-theme=...]; this module owns the registry (picker metadata) and
// the matching xterm palettes, since xterm paints on canvas and can't read
// CSS variables.

export const THEMES = {
  termivin: {
    label: 'Termivin',
    desc: 'Navy dark · green circuit map',
    swatches: ['#101418', '#4e9af5', '#35d97c'],
    xterm: {
      background: '#14181d',
      foreground: '#d8dee6',
      cursor: '#d8dee6',
      selectionBackground: '#2e4a6b',
      black: '#1c2126',
      brightBlack: '#5c6773',
    },
  },
  matrix: {
    label: 'Matrix',
    desc: 'Full phosphor-green hacker terminal',
    swatches: ['#060a07', '#2fd970', '#7dffb0'],
    xterm: {
      background: '#0b130d',
      foreground: '#c2ecd0',
      cursor: '#5dff9d',
      selectionBackground: '#14532d',
      black: '#132a1b',
      brightBlack: '#3f6b50',
    },
  },
  amber: {
    label: 'Amber CRT',
    desc: 'Retro amber phosphor glow',
    swatches: ['#0c0804', '#ffb347', '#ffd68f'],
    xterm: {
      background: '#120c05',
      foreground: '#f0d9ae',
      cursor: '#ffc46b',
      selectionBackground: '#5c4008',
      black: '#241a0b',
      brightBlack: '#7d6840',
    },
  },
  ice: {
    label: 'Ice Terminal',
    desc: 'Cold cyan on deep blue-black',
    swatches: ['#04090c', '#22d3ee', '#9df3ff'],
    xterm: {
      background: '#081217',
      foreground: '#cdeef7',
      cursor: '#4dd9f0',
      selectionBackground: '#0e4a5c',
      black: '#0f2530',
      brightBlack: '#4a7484',
    },
  },
  synthwave: {
    label: 'Synthwave',
    desc: 'Neon magenta over midnight purple',
    swatches: ['#0d0716', '#e879f9', '#f5c0ff'],
    xterm: {
      background: '#140d20',
      foreground: '#e8daf5',
      cursor: '#f472b6',
      selectionBackground: '#4a2a6b',
      black: '#241736',
      brightBlack: '#6a5590',
    },
  },
  bubblegum: {
    label: 'Bubblegum',
    desc: 'Hot pink over deep magenta',
    swatches: ['#1a0713', '#f472b6', '#fda4c9'],
    xterm: {
      background: '#1a0713',
      foreground: '#f7dbe8',
      cursor: '#f472b6',
      selectionBackground: '#6b1a3d',
      black: '#2a0f1c',
      brightBlack: '#7a4a63',
    },
  },
  nord: {
    label: 'Nord',
    desc: 'Arctic frost, muted Scandi blue',
    swatches: ['#2e3440', '#88c0d0', '#a3be8c'],
    xterm: {
      background: '#2e3440',
      foreground: '#d8dee9',
      cursor: '#88c0d0',
      selectionBackground: '#434c5e',
      black: '#3b4252',
      brightBlack: '#4c566a',
    },
  },
  dracula: {
    label: 'Dracula',
    desc: 'Cult classic purple, pink, cyan',
    swatches: ['#282a36', '#bd93f9', '#ff79c6'],
    xterm: {
      background: '#282a36',
      foreground: '#f8f8f2',
      cursor: '#ff79c6',
      selectionBackground: '#44475a',
      black: '#21222c',
      brightBlack: '#6272a4',
    },
  },
  gruvbox: {
    label: 'Gruvbox',
    desc: 'Warm retro brown & burnt orange',
    swatches: ['#282828', '#fe8019', '#b8bb26'],
    xterm: {
      background: '#282828',
      foreground: '#ebdbb2',
      cursor: '#fe8019',
      selectionBackground: '#504945',
      black: '#3c3836',
      brightBlack: '#7c6f64',
    },
  },
  tokyo: {
    label: 'Tokyo Night',
    desc: 'Deep navy with neon violet accents',
    swatches: ['#1a1b26', '#7aa2f7', '#bb9af7'],
    xterm: {
      background: '#1a1b26',
      foreground: '#c0caf5',
      cursor: '#7aa2f7',
      selectionBackground: '#33467c',
      black: '#24283b',
      brightBlack: '#565f89',
    },
  },
  sunset: {
    label: 'Sunset',
    desc: 'Warm coral over dusk violet',
    swatches: ['#1c0f1a', '#ff6b6b', '#ffb26b'],
    xterm: {
      background: '#1c0f1a',
      foreground: '#f9d5c2',
      cursor: '#ff8c42',
      selectionBackground: '#5c2a3a',
      black: '#2a1420',
      brightBlack: '#8a5a6a',
    },
  },
  rosepine: {
    label: 'Rose Pine',
    desc: 'Muted mauve & dusty rose',
    swatches: ['#191724', '#ebbcba', '#c4a7e7'],
    xterm: {
      background: '#191724',
      foreground: '#e0def4',
      cursor: '#ebbcba',
      selectionBackground: '#403d52',
      black: '#26233a',
      brightBlack: '#6e6a86',
    },
  },
};

export function themeInfo(name) {
  return THEMES[name] || THEMES.termivin;
}

// Stamp the theme onto the DOM. xterm instances are repainted separately
// (term-manager.applyXtermTheme) because canvas ignores CSS variables.
export function applyThemeToDom(name) {
  document.body.dataset.theme = THEMES[name] ? name : 'termivin';
}
