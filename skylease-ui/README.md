# SkyLease — House Rental App UI

Mobile UI design for a house rental app on **iPhone 17 Pro Max** (440×956), with a **sky blue & white** palette.

## What’s included

| Path | Purpose |
|------|---------|
| `index.html` | 7 interactive phone screens in device frames |
| `styles.css` | Design tokens as CSS variables + screen styles |
| `app.js` | Screen navigation / micro-interactions |
| `figma/design-tokens.json` | Colors, type, spacing for Figma Variables |
| `figma/TRANSFER.md` | Step-by-step Figma handoff |

## Screens

1. Splash (SkyLease brand)
2. Role select — find a house / lease a property
3. Explore homes — filters, availability, listings
4. Property detail — location map, inspection slots
5. Book inspection
6. Landlord hub — listings & KPIs
7. List property — type, photos, rent, location

## Preview locally

```bash
cd skylease-ui
python3 -m http.server 5173
```

Open http://localhost:5173

## Figma

See [`figma/TRANSFER.md`](figma/TRANSFER.md). Authenticate Figma MCP in Cursor Desktop for one-click transfer, or import `design-tokens.json` and rebuild on 440×956 frames.
