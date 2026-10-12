# Sky maps — sources and licence

The four sky maps in this directory (`clear.hdr`, `overcast.hdr`, `dusk.hdr`, `night.hdr`) are
derived from HDRIs published by [Poly Haven](https://polyhaven.com) under **CC0 1.0 Universal**
(public domain dedication; https://polyhaven.com/license). No attribution is required; it is given
here anyway, with thanks.

| Map | Original | Authors |
|---|---|---|
| `clear.hdr` | [Kloofendal 48d Partly Cloudy (Pure Sky)](https://polyhaven.com/a/kloofendal_48d_partly_cloudy_puresky) | Greg Zaal (photography), Jarod Guest (sky edits) |
| `overcast.hdr` | [Kloofendal Overcast (Pure Sky)](https://polyhaven.com/a/kloofendal_overcast_puresky) | Greg Zaal (photography), Jarod Guest (sky edits) |
| `dusk.hdr` | [Belfast Sunset (Pure Sky)](https://polyhaven.com/a/belfast_sunset_puresky) | Dimitrios Savva (photography), Greg Zaal (processing), Jarod Guest (sky edits) |
| `night.hdr` | [Kloppenheim 02 (Pure Sky)](https://polyhaven.com/a/kloppenheim_02_puresky) | Greg Zaal (photography), Jarod Guest (sky edits) |

Each was downloaded at 2K (2048 × 1024, Radiance `.hdr`) from the URL in `SOURCES.json`, checked
against the SHA-256 recorded there, and prepared by `scripts/prepare-sky.ts`: its sun (the night
map's moon) taken out of the picture — the views add an analytic sun — and only the sky kept, from
the zenith to 6° under the horizon. The prepared files' digests are in `SOURCES.json` too.

To prepare them again, download the originals into one directory and run
`pnpm --filter @d3-floorspec/server exec tsx ../../packages/mesh/scripts/prepare-sky.ts <dir>`.
