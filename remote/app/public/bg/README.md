# Backdrops

The full-bleed photographs behind the Studio Glass UI (`shell/Backdrop.jsx`, SPEC §10.1).
`manifest.json` is the contract: `[{ file, credit, link, tone, blurhash }]`, where `tone` is
`dawn` | `day` | `dusk` | `night` and drives the time-of-day pick (dawn 5–8, day 8–17,
dusk 17–20, night 20–5). Settings shows `credit` + `link` from this manifest.

All ten are from [Unsplash](https://unsplash.com/license), whose licence permits free use and
redistribution, including bundling them in this app. Attribution is not required by the licence —
we credit anyway. None are Unsplash+ / premium.

Each image is ≤ 2400px wide, JPEG, and picked for a dark centre (the greeting headline) and a dark
bottom-left (the attention cards). Total: 3.57 MB.

| File | Tone | Size | Photographer | Scene |
|---|---|---:|---|---|
| `01.jpg` | dawn | 410 KB | [Melissa De Yoe](https://unsplash.com/photos/a-foggy-night-with-the-sun-shining-through-the-trees-nmNGB3FWUiE) | Blue-hour mist over a still lake, pines in silhouette and one warm lamp glowing on the far shore. |
| `02.jpg` | dawn | 428 KB | [Anne Nygård](https://unsplash.com/photos/silhouette-of-trees-during-sunset-wfM8tEjIn1A) | Low gold sun burning through fog behind a screen of black pine trunks; the bottom third is pure shadow. |
| `03.jpg` | day | 409 KB | [Mario Häfliger](https://unsplash.com/photos/a-wooden-walkway-in-the-middle-of-a-forest-uWOqJ1uoJqc) | A wooden boardwalk running straight into a dark conifer forest — the closest echo of the reference shot. |
| `04.jpg` | day | 424 KB | [Vital Sinkevich](https://unsplash.com/photos/landscape-photography-of-forest-LAKQ3i-xn84) | Moss-wrapped spruce trunks in a rain-dark wood; saturated deep greens, no sky. |
| `05.jpg` | dusk | 321 KB | [Chris wu](https://unsplash.com/photos/a-foggy-mountain-range-with-low-lying-clouds-xyCpmrP_0Qo) | Layered forested ridges dissolving into low cloud — near-monochrome slate green, almost black at the bottom. |
| `06.jpg` | dusk | 363 KB | [Brendan Miranda](https://unsplash.com/photos/silhouette-of-mountains-near-body-of-water-0K1C90geDao) | Teal storm cloud over snow-dusted peaks with a thin sunset slit at the horizon and a dark foreground plain. |
| `07.jpg` | dusk | 408 KB | [Wes Hicks](https://unsplash.com/photos/a-path-in-the-middle-of-a-dark-forest-FnaiTxmOHhA) | A stony trail climbing through mossy spruce into hanging fog; damp greens, heavy shadow on both edges. |
| `08.jpg` | night | 202 KB | [Ben Griffiths](https://unsplash.com/photos/glowing-light-in-dark-pine-forest-l7R85WBKl1c) | A foggy pine avenue at night with a single distant lamp — the darkest frame in the set, bottom half near black. |
| `09.jpg` | night | 409 KB | [Georg Abrosimov](https://unsplash.com/photos/a-dark-forest-filled-with-lots-of-trees-gHP0l8X1OWQ) | A small clearing deep in a spruce wood after dusk; ferns lit faintly blue-green against black timber. |
| `10.jpg` | night | 284 KB | [Alexandro Fernandez](https://unsplash.com/photos/moonlight-illuminates-mist-over-a-dark-lake-Q8t3xiUspGY) | Moonrise over a mirror-still lake with mist on the water, star field above, forested ridge in silhouette. |

## Replacing or adding an image

Keep the file ≤ 450 KB and ≤ 2400px wide, add a row to `manifest.json` with a `tone`, and keep at
least two images per tone so the rotation has something to rotate through.

```sh
sips -Z 2400 -s format jpeg -s formatOptions 78 in.jpg --out NN.jpg
```
