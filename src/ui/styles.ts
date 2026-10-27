// The panel's styles. Colors, fonts and radii come from the app's theme variables, with fallbacks for any the theme
// lacks, so the panel follows light and dark mode.
export const css = /* css */ `
.osc-root {
  --osc-text: var(--text-base, var(--text-strong, inherit));
  --osc-strong: var(--text-strong, inherit);
  --osc-weak: var(--text-weak, color-mix(in srgb, currentColor 60%, transparent));
  --osc-border: var(--border-weak-base, color-mix(in srgb, currentColor 15%, transparent));
  --osc-surface: var(--surface-raised-base, color-mix(in srgb, currentColor 5%, transparent));
  --osc-inset: var(--surface-inset-base, color-mix(in srgb, currentColor 4%, transparent));
  --osc-input: var(--input-base, transparent);
  --osc-focus: var(--border-focus, var(--border-selected, Highlight));
  --osc-critical: var(--text-critical-base, var(--icon-critical-base, #d33));
  --osc-critical-surface: var(--surface-critical-weak, color-mix(in srgb, #d33 10%, transparent));
  --osc-radius: var(--radius-md, 6px);
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  color: var(--osc-text);
  font-family: var(--font-family-sans, system-ui, sans-serif);
  font-size: var(--font-size-small, 13px);
}
.osc-scroll { position: relative; flex: 1 1 auto; min-height: 0; overflow-y: auto; overscroll-behavior: contain; }
.osc-content { display: flex; flex-direction: column; gap: 12px; padding: 16px 12px; }
.osc-center { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; flex: 1; padding: 24px; text-align: center; color: var(--osc-weak); }
.osc-hint { max-width: 260px; margin: 48px auto 0; text-align: center; color: var(--osc-weak); line-height: 1.5; }
.osc-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.osc-spread { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.osc-muted { color: var(--osc-weak); }
.osc-error { color: var(--osc-critical); overflow-wrap: anywhere; }
.osc-banner { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin: 8px 12px 0; padding: 8px 10px; border-radius: var(--osc-radius); background: var(--osc-critical-surface); color: var(--osc-strong); }
.osc-msg { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.osc-user { align-self: flex-end; max-width: 88%; padding: 8px 12px; border-radius: 12px; background: var(--osc-surface); color: var(--osc-strong); }
.osc-user.osc-queued { opacity: 0.6; }
.osc-assistant { position: relative; }
.osc-assistant-actions { display: flex; justify-content: flex-end; opacity: 0; transition: opacity 120ms; }
.osc-assistant:hover .osc-assistant-actions, .osc-assistant:focus-within .osc-assistant-actions { opacity: 1; }
.osc-note { color: var(--osc-weak); font-style: italic; }
.osc-tool { border: 1px solid var(--osc-border); border-radius: var(--osc-radius); overflow: hidden; }
.osc-tool-head { all: unset; box-sizing: border-box; display: flex; align-items: center; gap: 6px; width: 100%; padding: 4px 8px; cursor: pointer; color: var(--osc-weak); }
.osc-tool-head:hover { background: var(--osc-inset); }
.osc-tool-head:focus-visible { outline: 2px solid var(--osc-focus); outline-offset: -2px; }
.osc-tool-name { color: var(--osc-strong); font-family: var(--font-family-mono, ui-monospace, monospace); white-space: nowrap; }
.osc-tool-summary { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.osc-tool-body { display: flex; flex-direction: column; gap: 6px; padding: 8px; border-top: 1px solid var(--osc-border); background: var(--osc-inset); }
.osc-label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--osc-weak); }
.osc-pre { margin: 0; max-height: 240px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; font-family: var(--font-family-mono, ui-monospace, monospace); font-size: 12px; }
.osc-chevron { transition: transform 120ms; flex: none; }
.osc-chevron[data-open] { transform: rotate(90deg); }
.osc-working { display: flex; align-items: center; gap: 8px; color: var(--osc-weak); }
.osc-dock { display: flex; flex-direction: column; gap: 8px; flex: none; padding: 10px 12px 12px; border-top: 1px solid var(--osc-border); }
.osc-card { display: flex; flex-direction: column; gap: 8px; padding: 10px; border: 1px solid var(--osc-border); border-radius: var(--osc-radius); background: var(--osc-surface); }
.osc-card-title { color: var(--osc-strong); font-weight: var(--font-weight-medium, 500); }
.osc-resources { margin: 0; padding: 0; list-style: none; font-family: var(--font-family-mono, ui-monospace, monospace); font-size: 12px; color: var(--osc-weak); overflow-wrap: anywhere; }
.osc-field { display: flex; flex-direction: column; gap: 6px; }
.osc-field[data-invalid] .osc-field-title { color: var(--osc-critical); }
.osc-field-title { color: var(--osc-strong); }
.osc-textarea { box-sizing: border-box; width: 100%; min-height: 44px; max-height: 200px; resize: none; padding: 8px 10px; border: 1px solid var(--osc-border); border-radius: var(--osc-radius); background: var(--osc-input); color: var(--osc-strong); font: inherit; line-height: 1.45; }
.osc-textarea:focus { outline: none; border-color: var(--osc-focus); }
.osc-tab { display: flex; align-items: center; gap: 6px; min-width: 0; }
.osc-tab-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
`
