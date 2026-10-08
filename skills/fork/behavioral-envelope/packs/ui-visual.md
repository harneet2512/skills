# UI visual

Colors, tokens, typography, spacing, layout, themes.

### VIS-01 Contrast
- **Ask:** Does every text and icon on the changed color meet contrast in every theme?
- **Right way:** Text at least 4.5:1, large text at least 3:1, computed not eyeballed and not rounded (S2). Meaningful non-text elements such as focus rings and input borders need contrast too (S3).
- **Proof:** Contrast ratios computed for each foreground and background pair, light and dark.

### VIS-02 Every state
- **Ask:** Do hover, pressed, focus, disabled, loading, selected and error states still look distinct and correct?
- **Right way:** Change the state colors together; keep a visible focus indicator (S3).
- **Proof:** Screenshot of each state.

### VIS-03 Token or one-off
- **Ask:** Is the change made at the design token, or hard-coded in one place?
- **Right way:** Change the token when the intent is system-wide; never hard-code a value that a token already names.
- **Proof:** Search shows no stray hard-coded copies of the old value.

### VIS-04 Everywhere it appears
- **Ask:** Which other screens use the changed component, token or style?
- **Right way:** List every usage; check each against the new value.
- **Proof:** Before and after screenshots of every affected screen.

### VIS-05 Themes
- **Ask:** Does it hold in dark mode, high-contrast mode and any brand theme?
- **Right way:** Define values per theme, not one value forced into all.
- **Proof:** Screenshots per theme.

### VIS-06 Meaning not carried by color alone
- **Ask:** Does any state (error, success, danger, selected) rely only on color?
- **Right way:** Pair color with text, icon or shape so color-blind users get the meaning.
- **Proof:** Grayscale screenshot still distinguishes the states.

### VIS-07 Small screens and zoom
- **Ask:** Does the layout survive phone width, long text, text resized to 200 percent, and a 320 CSS pixel wide viewport?
- **Right way:** Fluid layout, wrapping text, no fixed heights on text containers; text resizes (SC 1.4.4) and content reflows (SC 1.4.10) without loss (S3).
- **Proof:** Screenshots at 320 pixels wide and with text at 200 percent.

### VIS-08 Browsers
- **Ask:** Does it render the same in Safari, Chrome and Firefox, including mobile Safari?
- **Right way:** Avoid unsupported CSS without fallbacks; check the browsers the product supports.
- **Proof:** Screenshot in each supported browser, or a cross-browser run.

### VIS-09 Visual regression
- **Ask:** Did anything change that was not meant to?
- **Right way:** Compare screenshots before and after on the affected screens.
- **Proof:** Screenshot diff with only intended differences.

### VIS-10 Other languages
- **Ask:** Does the change add user-facing text, and does it fit when translated, longer or right-to-left?
- **Right way:** Text through the translation layer, never hard-coded; layouts that tolerate longer strings; dates and numbers formatted per locale.
- **Proof:** Screenshot with the longest supported language, or pseudo-localized text.
