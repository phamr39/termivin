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
};

export function themeInfo(name) {
  return THEMES[name] || THEMES.termivin;
}

// Stamp the theme onto the DOM. xterm instances are repainted separately
// (term-manager.applyXtermTheme) because canvas ignores CSS variables.
export function applyThemeToDom(name) {
  document.body.dataset.theme = THEMES[name] ? name : 'termivin';
}
