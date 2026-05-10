# DarkNyx — Design System

> **Settle in the dark. Prove in the light.**
> Identity package for the DarkNyx darkpool protocol.

## Folder map

```
design-system/
├── svg/              Master vector files — source of truth
├── png/              Raster exports
│   ├── mark-ink/     Transparent, ink color, 16–1024px
│   ├── mark-chalk/   Transparent, chalk color, 16–1024px
│   ├── app-icon-light/   Square w/ chalk bg + ink mark, padded
│   └── app-icon-dark/    Square w/ ink bg + chalk mark, padded
├── favicon/          Web favicon bundle (drop into site root)
├── social/           OG images, social avatars, Twitter banner
├── tokens/           Design tokens — JSON + CSS
├── cli/              ASCII art for terminal banners
└── brand-guidelines.html   Open this in a browser
```

## Quick start

### Web favicon
Copy everything in `favicon/` to your site root, then paste `favicon/head-snippet.html` into your `<head>`.

### Design tokens
Import `tokens/tokens.css` into your global stylesheet. Use CSS custom properties:

```css
.button { background: var(--nyx-ink); color: var(--nyx-chalk); border-radius: var(--nyx-radius-xs); }
```

For tooling (Style Dictionary, Tailwind plugin, etc.) import `tokens/tokens.json`.

### Logo in code
Use the SVG directly — it inherits `currentColor`:

```html
<img src="/svg/nyx-mark.svg" alt="DarkNyx" style="color: #f5f3ee">
```

## Rules at a glance

- **Min size:** 16px. Use `nyx-mark-micro.svg` below 24px.
- **Clearspace:** x on all sides, where x = height of the half-moon.
- **Don't:** stretch, rotate, flip, recolor with gradients, add shadows, or place on low-contrast backgrounds.
- **Cobalt accent** is for marketing surfaces only — never in the mark itself.

## Type

- **Display + body:** [Space Grotesk](https://fonts.google.com/specimen/Space+Grotesk) — weights 400/500/600/700
- **Mono / data:** [JetBrains Mono](https://fonts.google.com/specimen/JetBrains+Mono) — weights 400/500

Both Google Fonts, OFL licensed.

---

For the full system, open `brand-guidelines.html`.
