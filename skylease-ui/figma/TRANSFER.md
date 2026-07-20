# SkyLease → Figma Transfer Guide

## Device frame

| Spec | Value |
|------|--------|
| Device | iPhone 17 Pro Max |
| Artboard size | **440 × 956** pt |
| Outer radius | 55 |
| Screen radius | 47 |
| Dynamic Island | 126 × 36, top center |
| Safe area top | ~59 |
| Home indicator inset | 34 |

Create one Figma frame per screen with these exact dimensions. Name frames to match `data-figma-frame` in `index.html`.

## Screens (7)

1. **01 Splash** — brand hero, Get started / Browse
2. **02 Role Select** — Find a house / Lease my property
3. **03 Explore Homes** — search, type filters, listings, tab bar
4. **04 Property Detail** — media, availability, map, inspection slots
5. **05 Book Inspection** — booking form + summary
6. **06 Landlord Listings** — KPIs + property list
7. **07 List Property** — type picker, media upload, location/rent

## Color system (primary)

Import from `design-tokens.json` as Figma Variables (Collection: `SkyLease / Color`).

- Primary: `#0EA5E9` (sky/500)
- Primary soft: `#38BDF8` (sky/400)
- Surfaces: `#FFFFFF`, `#F7FBFF`
- Ink: `#0B1F2A`
- Borders: `#D6EAF7`

## Typography

- Display / brand: **Fraunces**
- UI: **Outfit**

Load both in Figma (or substitute with closest licensed fonts), then create text styles from the `typography.styles` block in `design-tokens.json`.

## Fastest transfer paths

### A. Cursor + Figma MCP (recommended)

1. In Cursor Desktop, authenticate the **Figma** MCP server.
2. Open or create a Figma file.
3. Ask the agent: *“Push the SkyLease screens from `skylease-ui` into this Figma file using iPhone 17 Pro Max frames.”*
4. The agent can use `generate_figma_design` / `use_figma` with these HTML frames.

### B. Manual capture

1. Serve `skylease-ui/index.html` in a browser.
2. Screenshot each phone frame (or export at 2×).
3. Place images on 440×956 frames, then rebuild with Auto Layout using tokens.

### C. html.to.design / Anima

1. Open the live prototype URL.
2. Capture each `.iphone-screen` node into Figma layers.
3. Re-bind fills to Variables from `design-tokens.json`.

## Layer naming convention

Use semantic names so handoff stays clean:

```
iPhone 17 Pro Max / 03 Explore Homes
  ├─ Status Bar
  ├─ Dynamic Island
  ├─ Explore Top
  │   ├─ Greeting
  │   └─ Search Field
  ├─ Filters
  ├─ Listing List
  │   └─ Listing Card / Azure Court
  └─ Tab Bar
```

## Interaction notes for prototyping in Figma

| From | Action | To |
|------|--------|-----|
| Splash → Get started | Tap | Role Select |
| Role → Find a house | Tap | Explore Homes |
| Role → Lease my property | Tap | Landlord Listings |
| Explore → listing | Tap | Property Detail |
| Detail → Book inspection | Tap | Book Inspection |
| Landlord → + Add | Tap | List Property |
