#!/usr/bin/env python3
"""
Prepare the material library's maps (FLR-T-13.6) from CC0 originals, and the data module the views
read them by.

    python3 -m venv .venv && .venv/bin/pip install pillow==11.3.0 numpy==2.3.2
    .venv/bin/python -I packages/mesh/scripts/prepare-materials.py <cache-dir>

Every original is downloaded into <cache-dir> (each in a folder of its own) unless it is there
already, checked against the digest `materials/SOURCES.json` records for it once it has been
recorded, and turned into the library's maps:

- **albedo** — the base colour map, sRGB, averaging to the item's colour (all but a bare metal's);
- **normal** — a tangent-space normal map, +Y up (glTF's convention, Core 18.2);
- **orm** — occlusion in red, roughness in green, metalness in blue: glTF's metallic-roughness map
  with its occlusion map packed in, so one file is both of a material's maps.

Each map is cut from the original's 2K images: scaled to the library's 1K (2K for a hero material)
across a 3 × 3 tiling so its edges still meet, turned so a plank or a course runs along the
surface's `s`, and written as a JPEG. A few maps are drawn here instead — standing-seam roofing, lap
and board-and-batten siding, subway and zellige tile, a paint's roller stipple — from seeded noise
on a periodic grid, so they repeat seamlessly and are the same bytes every run.

Then it writes `materials/SOURCES.json` (each original's page, URL, licence, authors and SHA-256,
and each map's digest and size) and `src/materials/data.ts` (the items and their files).
"""
from __future__ import annotations

import hashlib
import io
import json
import os
import sys
import urllib.request
import zipfile

import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
PKG = os.path.dirname(HERE)
OUT = os.path.join(PKG, 'materials')
DATA_TS = os.path.join(PKG, 'src', 'materials', 'data.ts')
SOURCES = os.path.join(OUT, 'SOURCES.json')

UNITS_PER_MM = 1280
CC0 = 'CC0 1.0 Universal (public domain dedication)'

# ── The library ─────────────────────────────────────────────────────────────────────────────────
#
# One entry per item. `src`: a Poly Haven texture ('ph', its asset ID), an ambientCG material
# ('ac'), a generator below ('gen'), or none (a material of factors alone). `mm`: the real-world
# size of one tile, millimetres, as its publisher measured it (Poly Haven's `dimensions`) or, where
# ambientCG gives none, counted from what the image shows. `maps`: 'ANO' — albedo, normal and ORM;
# 'NO' — normal and ORM only, so the material's colour is its base colour (Core 18.1) and a person
# chooses it; 'N' — a normal map alone. `turn`: 90 to turn the image a quarter turn
# counter-clockwise, so planks and courses run along s. `px`: 1024, or 2048 for a hero.

ITEMS: list[dict] = [
    # Wood
    dict(id='white-oak-plank', name='White oak plank, 8 in, matte', category='wood', uses=['floor'], src=('ph', 'laminate_floor_02'), mm=1700, px=2048, maps='ANO', color='#b9a283',
         description='Wide-plank white oak in a matte oil finish, end joints staggered. Planks run along s; turn the texture 90° to run them north–south.'),
    dict(id='smoked-oak-plank', name='Smoked oak plank, 11 in', category='wood', uses=['floor'], src=('ph', 'wood_floor'), mm=1700, px=1024, turn=90, maps='ANO', color='#8a6440',
         description='Wide smoked-oak boards, mid brown, satin.'),
    dict(id='oak-herringbone', name='Oak herringbone parquet', category='wood', uses=['floor'], src=('ph', 'herringbone_parquet'), mm=3400, px=2048, maps='ANO', color='#a87b4f',
         description='Oak parquet in herringbone, slats about 70 × 350 mm.'),
    dict(id='cedar-tongue-groove', name='Cedar tongue-and-groove boards', category='wood', uses=['ceiling', 'wall'], src=('ph', 'japanese_cedar_planks'), mm=1130, px=1024, turn=90, maps='ANO', color='#b0703c',
         description='Clear cedar boards about 6 in wide, for ceilings and soffits.'),
    dict(id='white-oak-veneer', name='White oak veneer, rift', category='wood', uses=['furniture', 'wall'], src=('ph', 'white_oak_veneer'), mm=500, px=1024, maps='ANO', color='#c4a57f',
         description='Rift-cut white oak for cabinetry, panelling and millwork.'),
    dict(id='walnut-veneer', name='Walnut veneer', category='wood', uses=['furniture', 'wall'], src=('ph', 'walnut_veneer'), mm=1800, px=1024, maps='ANO', color='#6b4a33',
         description='American walnut for cabinetry and panelling.'),
    # Decking
    dict(id='ipe-decking', name='Ipe decking, 5½ in', category='decking', uses=['floor', 'exterior'], src=('ph', 'wood_floor_deck'), mm=1800, px=1024, maps='ANO', color='#7a4a2e',
         description='Hardwood deck boards with open gaps, oiled.'),
    dict(id='composite-decking', name='Composite decking, driftwood grey', category='decking', uses=['floor', 'exterior'], src=('ph', 'wooden_planks'), mm=2000, px=1024, maps='ANO', color='#7d7266',
         description='Grey deck boards with open gaps.'),
    # Tile
    dict(id='porcelain-warm-stone', name='Porcelain tile 12 × 12, warm stone', category='tile', uses=['floor', 'wall'], src=('ph', 'floor_tiles_08'), mm=1500, px=1024, maps='ANO', color='#b9aa95',
         description='Stone-look porcelain, 300 mm square, with grout joints.'),
    dict(id='subway-white', name='Subway tile 3 × 6, white gloss', category='tile', uses=['wall'], src=('gen', 'subway'), mm=(609.6, 609.6), px=1024, maps='ANO', color='#f1f0ec',
         description='Glazed 3 × 6 in ceramic in running bond with light grey grout.'),
    dict(id='zellige-green', name='Zellige tile 4 × 4, green', category='tile', uses=['wall'], src=('gen', 'zellige'), mm=(609.6, 609.6), px=1024, maps='ANO', color='#4f7a68',
         description='Hand-made glazed tile, each one a different depth of green, tight joints.'),
    dict(id='square-white-gloss', name='Ceramic tile 5 × 5, white gloss', category='tile', uses=['wall'], src=('ac', 'Tiles107'), mm=1000, px=1024, maps='ANO', color='#f4f4f2',
         description='Glazed square wall tile with thin grey joints.'),
    dict(id='terrazzo-white', name='Terrazzo tile, white with grey chips', category='tile', uses=['floor'], src=('ac', 'Tiles043'), mm=2100, px=2048, maps='ANO', color='#dfe1dd',
         description='Honed terrazzo in 300 mm tiles, grey and black aggregate.'),
    dict(id='terracotta-tile', name='Terracotta tile', category='tile', uses=['floor'], src=('ph', 'terracotta_floor_tiles'), mm=2080, px=1024, maps='ANO', color='#9c5a3c',
         description='Unglazed terracotta squares with wide joints.'),
    # Stone
    dict(id='marble-carrara', name='Marble, grey-veined white', category='stone', uses=['counter', 'floor', 'wall'], src=('ac', 'Marble012'), mm=1800, px=2048, maps='ANO', color='#c9ccd1',
         description='Honed marble with soft grey veins, for counters, floors and slab walls.'),
    dict(id='quartz-white', name='Quartz, white with fine veining', category='stone', uses=['counter'], src=('ac', 'Marble021'), mm=1500, px=1024, maps='ANO', color='#efece8',
         description='A bright white engineered-stone look with faint veins, polished.'),
    dict(id='granite-salt-pepper', name='Granite, salt and pepper', category='stone', uses=['counter'], src=('ac', 'Granite002A'), mm=600, px=1024, maps='ANO', color='#a5a3a0',
         description='Polished grey granite.'),
    dict(id='bluestone-pavers', name='Bluestone pavers, 1 m', category='paver', uses=['floor', 'exterior'], src=('ph', 'large_floor_tiles_02'), mm=3000, px=1024, maps='ANO', color='#5f666a',
         description='Large thermal-finish bluestone slabs.'),
    dict(id='stacked-stone', name='Stacked fieldstone veneer', category='stone', uses=['wall', 'exterior'], src=('ph', 'stacked_stone_wall'), mm=2000, px=1024, maps='ANO', color='#7a6150',
         description='Dry-laid flat stone, for a chimney or a garden wall.'),
    # Brick
    dict(id='brick-red-running', name='Brick, red, running bond', category='brick', uses=['wall', 'exterior'], src=('ph', 'red_brick'), mm=1400, px=2048, maps='ANO', color='#9a4b34',
         description='Red clay brick in running bond, recessed grey mortar.'),
    dict(id='brick-whitewashed', name='Brick, whitewashed, running bond', category='brick', uses=['wall', 'exterior'], src=('ph', 'whitewashed_brick'), mm=2000, px=1024, maps='ANO', color='#cfc6bb',
         description='Brick under a thin limewash, its colour showing through.'),
    dict(id='brick-buff-roman', name='Brick, buff Roman', category='brick', uses=['wall', 'exterior'], src=('ac', 'Bricks093'), mm=2100, px=1024, maps='ANO', color='#c8b38a',
         description='Long, thin buff brick in a modern running bond.'),
    dict(id='brick-herringbone-paver', name='Brick pavers, herringbone', category='paver', uses=['floor', 'exterior'], src=('ph', 'herringbone_brick'), mm=1800, px=1024, maps='ANO', color='#5a4232',
         description='Clay pavers in herringbone, for a path or a patio.'),
    # Plaster and concrete
    dict(id='plaster-smooth', name='Plaster, smooth trowel', category='plaster', uses=['wall', 'ceiling'], src=('ph', 'white_plaster_02'), mm=1000, px=1024, maps='NO', color='#efebe4', normal_strength=0.6,
         description='Smooth-troweled plaster. Its colour is yours: the map is only its texture.'),
    dict(id='limewash-sand', name='Limewash plaster, sand', category='plaster', uses=['wall'], src=('ph', 'beige_wall_001'), mm=3000, px=1024, maps='ANO', color='#e4d6bf', tint='#e4d6bf', tint_contrast=0.55,
         description='Mottled, chalky limewash over plaster.'),
    dict(id='stucco', name='Stucco, sand finish', category='plaster', uses=['wall', 'exterior'], src=('ph', 'white_stucco'), mm=2000, px=1024, maps='NO', color='#ece6da',
         description='Exterior sand-finish stucco. Its colour is yours.'),
    dict(id='concrete-smooth', name='Concrete, smooth', category='concrete', uses=['floor', 'wall'], src=('ph', 'smooth_concrete_floor'), mm=2000, px=1024, maps='ANO', color='#a19d97', tint='#a19d97', tint_contrast=0.8,
         description='Troweled concrete, sealed.'),
    dict(id='concrete-broom', name='Concrete, broom finish', category='concrete', uses=['floor', 'exterior'], src=('ph', 'brushed_concrete_03'), mm=2000, px=1024, maps='ANO', color='#a6a39d', tint='#a6a39d', tint_contrast=0.9,
         description='Exterior slab with a broom finish.'),
    dict(id='epoxy-floor', name='Epoxy floor coating', category='concrete', uses=['floor'], src=None, color='#8c9196', roughness=300,
         description='A seamless resin floor. Its colour is yours.'),
    # Paint: the sheen is the roughness; the stipple of a roller is a normal map they share.
    dict(id='paint-flat', name='Paint, flat', category='paint', uses=['wall', 'ceiling'], src=('gen', 'stipple'), mm=(300, 300), px=512, maps='N', color='#f2ede3', roughness=950, shared='paint-stipple',
         description='Flat paint: no sheen. Its colour is yours.'),
    dict(id='paint-matte', name='Paint, matte', category='paint', uses=['wall', 'ceiling'], src=('gen', 'stipple'), mm=(300, 300), px=512, maps='N', color='#f2ede3', roughness=880, shared='paint-stipple',
         description='Matte paint. Its colour is yours.'),
    dict(id='paint-eggshell', name='Paint, eggshell', category='paint', uses=['wall'], src=('gen', 'stipple'), mm=(300, 300), px=512, maps='N', color='#f2ede3', roughness=720, shared='paint-stipple',
         description='Eggshell: a soft sheen. Its colour is yours.'),
    dict(id='paint-satin', name='Paint, satin', category='paint', uses=['wall'], src=('gen', 'stipple'), mm=(300, 300), px=512, maps='N', color='#f2ede3', roughness=560, shared='paint-stipple',
         description='Satin: a visible sheen, for kitchens, baths and trim. Its colour is yours.'),
    dict(id='paint-semi-gloss', name='Paint, semi-gloss', category='paint', uses=['wall'], src=('gen', 'stipple'), mm=(300, 300), px=512, maps='N', color='#f2ede3', roughness=360, shared='paint-stipple',
         description='Semi-gloss, for trim and doors. Its colour is yours.'),
    dict(id='paint-gloss', name='Paint, high gloss', category='paint', uses=['wall'], src=('gen', 'stipple'), mm=(300, 300), px=512, maps='N', color='#f2ede3', roughness=200, shared='paint-stipple',
         description='High-gloss lacquer. Its colour is yours.'),
    # Metal
    dict(id='stainless-brushed', name='Stainless steel, brushed', category='metal', uses=['counter', 'furniture'], src=('ac', 'Metal009'), mm=500, px=1024, maps='ANO', color='#b4b9be', metallic=1000,
         description='Brushed stainless, grain along s.'),
    dict(id='brass-satin', name='Brass, satin', category='metal', uses=['furniture'], src=('ac', 'Metal048A'), mm=1000, px=1024, maps='ANO', color='#c9a560', metallic=1000,
         description='Unlacquered satin brass.'),
    dict(id='steel-blackened', name='Steel, black powder coat', category='metal', uses=['furniture', 'exterior'], src=('ac', 'Metal027'), mm=1000, px=1024, maps='ANO', color='#26272b', metallic=0,
         description='Black powder-coated steel, for railings, frames and fixtures.'),
    dict(id='copper', name='Copper', category='metal', uses=['furniture', 'roof'], src=('ac', 'Metal035'), mm=1000, px=1024, maps='ANO', color='#b6714a', metallic=1000,
         description='Bright copper.'),
    dict(id='aluminium-anodised', name='Aluminium, clear anodised', category='metal', uses=['furniture', 'exterior'], src=('ac', 'Metal032'), mm=1000, px=1024, maps='ANO', color='#a9adb2', metallic=1000,
         description='Satin clear-anodised aluminium.'),
    # Fabric
    dict(id='linen-natural', name='Linen, natural', category='fabric', uses=['furniture'], src=('ph', 'rough_linen'), mm=271, px=1024, maps='ANO', color='#c9bda5', tint='#c9bda5', tint_contrast=1.0,
         description='A loose linen weave.'),
    dict(id='wool-herringbone', name='Wool herringbone, grey', category='fabric', uses=['furniture'], src=('ph', 'poly_wool_herringbone'), mm=273, px=1024, maps='ANO', color='#76767a',
         description='Upholstery-weight herringbone wool.'),
    dict(id='velvet-rust', name='Velvet, deep red', category='fabric', uses=['furniture'], src=('ph', 'velour_velvet'), mm=279, px=1024, maps='ANO', color='#7b1f2a',
         description='Cotton velvet.'),
    dict(id='leather-cognac', name='Leather, cognac', category='fabric', uses=['furniture'], src=('ph', 'fabric_leather_02'), mm=500, px=1024, maps='ANO', color='#8a5532',
         description='Aniline leather with a soft grain.'),
    dict(id='carpet-wool-beige', name='Carpet, wool, oatmeal', category='fabric', uses=['floor'], src=('ac', 'Carpet016'), mm=1700, px=1024, maps='ANO', color='#c2b593',
         description='Wall-to-wall cut-pile wool.'),
    # Glass: drawn see-through by a view that can; its factors are Core's.
    dict(id='glass-clear', name='Glass, clear', category='glass', uses=['wall'], src=None, color='#dfe9ec', roughness=20, look='glass',
         description='Clear float glass, for a shower screen or a partition.'),
    dict(id='glass-frosted', name='Glass, frosted', category='glass', uses=['wall'], src=None, color='#e8eef0', roughness=420, look='glass',
         description='Acid-etched glass: light through, no view.'),
    dict(id='glass-bronze', name='Glass, bronze tint', category='glass', uses=['wall'], src=None, color='#8b7a64', roughness=20, look='glass',
         description='Bronze-tinted glass.'),
    # Roofing
    dict(id='standing-seam', name='Standing-seam metal, 16 in panels', category='roofing', uses=['roof', 'wall'], src=('gen', 'standing_seam'), mm=(406.4, 812.8), px=(512, 1024), maps='NO', color='#3b4148',
         description='Painted steel panels with 1½ in seams running down the slope. Its colour is yours.'),
    dict(id='slate-roof', name='Slate roofing', category='roofing', uses=['roof'], src=('ph', 'roof_slates_03'), mm=3000, px=1024, maps='ANO', color='#4f5458',
         description='Natural slate in even courses.'),
    dict(id='cedar-shakes', name='Cedar shakes, weathered', category='roofing', uses=['roof', 'wall'], src=('ph', 'roof_slates_02'), mm=3000, px=1024, maps='ANO', color='#8a857c',
         description='Split cedar shakes weathered silver.'),
    dict(id='clay-barrel-tile', name='Clay barrel tile', category='roofing', uses=['roof'], src=('ph', 'clay_roof_tiles_02'), mm=2500, px=1024, maps='ANO', color='#a5532f',
         description='Terracotta barrel tile.'),
    # Siding
    dict(id='lap-siding', name='Fibre-cement lap siding, 7 in exposure', category='siding', uses=['wall', 'exterior'], src=('gen', 'lap_siding'), mm=(711.2, 711.2), px=1024, maps='NO', color='#8f9aa1',
         description='Painted fibre-cement lap boards with a cedar-grain emboss and a shadow line under each course. Its colour is yours.'),
    dict(id='board-and-batten', name='Board and batten, 12 in', category='siding', uses=['wall', 'exterior'], src=('gen', 'board_batten'), mm=(304.8, 609.6), px=(256, 512), maps='NO', color='#e8e4dc',
         description='Vertical boards with 2 in battens 12 in apart. Its colour is yours.'),
    dict(id='shiplap-v-groove', name='V-groove boards, painted', category='siding', uses=['wall', 'ceiling'], src=('ph', 'white_planks_clean'), mm=1800, px=1024, maps='NO', color='#efece6',
         description='Painted tongue-and-groove boards with a V joint, vertical; turn the texture 90° for shiplap. Its colour is yours.'),
    # Pavers
    dict(id='concrete-pavers', name='Concrete pavers, interlocking', category='paver', uses=['floor', 'exterior'], src=('ph', 'concrete_pavers'), mm=1920, px=1024, maps='ANO', color='#7c7a76',
         description='Grey interlocking concrete pavers.'),
    dict(id='rectangular-pavers', name='Concrete pavers, plank', category='paver', uses=['floor', 'exterior'], src=('ph', 'rectangular_paving'), mm=2000, px=1024, turn=90, maps='ANO', color='#7e7467',
         description='Long plank pavers in a running bond.'),
]

# ── Downloading ─────────────────────────────────────────────────────────────────────────────────


def sha256(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


def fetch(url: str, path: str) -> bytes:
    if not os.path.exists(path):
        os.makedirs(os.path.dirname(path), exist_ok=True)
        req = urllib.request.Request(url, headers={'User-Agent': 'd3-floorspec prepare-materials'})
        with urllib.request.urlopen(req, timeout=300) as r:
            data = r.read()
        with open(path, 'wb') as f:
            f.write(data)
    with open(path, 'rb') as f:
        return f.read()


def ph_json(path: str, cache: str, name: str) -> dict:
    return json.loads(fetch(f'https://api.polyhaven.com/{path}', os.path.join(cache, '_api', name)))


class Originals:
    """Every original downloaded, with its digest, checked against the record when there is one."""

    def __init__(self, cache: str, known: dict[str, str]):
        self.cache = cache
        self.known = known
        self.records: dict[str, dict] = {}

    def get(self, key: str, url: str, path: str, meta: dict) -> bytes:
        data = fetch(url, path)
        digest = sha256(data)
        if key in self.known and self.known[key] != digest:
            raise SystemExit(f'{key}: {url} is not the file recorded (sha256 {digest}, recorded {self.known[key]})')
        self.records[key] = dict(meta, url=url, sha256=digest, bytes=len(data))
        return data


def ph_maps(o: Originals, asset: str) -> dict[str, Image.Image]:
    files = ph_json(f'files/{asset}', o.cache, f'ph-files-{asset}.json')
    info = ph_json(f'info/{asset}', o.cache, f'ph-info-{asset}.json')
    out: dict[str, Image.Image] = {}
    authors = ', '.join(f'{k} ({v})' for k, v in sorted(info.get('authors', {}).items()))
    for role, key in (('albedo', 'Diffuse'), ('normal', 'nor_gl'), ('arm', 'arm'), ('ao', 'AO'), ('rough', 'Rough')):
        if key not in files or '2k' not in files[key]:
            continue
        if role in ('ao', 'rough') and 'arm' in out:
            continue
        url = files[key]['2k']['jpg']['url']
        data = o.get(f'ph:{asset}:{key}', url, os.path.join(o.cache, f'ph-{asset}', os.path.basename(url)),
                     dict(provider='Poly Haven', asset=asset, title=info.get('name', asset), authors=authors, page=f'https://polyhaven.com/a/{asset}', licence=CC0, map=key))
        out[role] = Image.open(io.BytesIO(data))
        out[role].load()
    return out


def ac_maps(o: Originals, asset: str) -> dict[str, Image.Image]:
    url = f'https://ambientcg.com/get?file={asset}_2K-JPG.zip'
    data = o.get(f'ac:{asset}', url, os.path.join(o.cache, f'ac-{asset}', f'{asset}_2K-JPG.zip'),
                 dict(provider='ambientCG', asset=asset, title=asset, authors='Lennart Demes (ambientCG)', page=f'https://ambientcg.com/view?id={asset}', licence=CC0, map='2K-JPG zip'))
    z = zipfile.ZipFile(io.BytesIO(data))
    out: dict[str, Image.Image] = {}
    for role, suffix in (('albedo', '_Color.jpg'), ('normal', '_NormalGL.jpg'), ('rough', '_Roughness.jpg'), ('metal', '_Metalness.jpg'), ('ao', '_AmbientOcclusion.jpg')):
        names = [n for n in z.namelist() if n.endswith(suffix)]
        if names:
            out[role] = Image.open(io.BytesIO(z.read(names[0])))
            out[role].load()
    return out


# ── Image work ──────────────────────────────────────────────────────────────────────────────────


def seamless_resize(img: Image.Image, size: tuple[int, int]) -> Image.Image:
    """Scale a tileable image without seams: scale a 3 × 3 tiling and keep its middle."""
    w, h = img.size
    big = Image.new(img.mode, (3 * w, 3 * h))
    for i in range(3):
        for j in range(3):
            big.paste(img, (i * w, j * h))
    W, H = size
    big = big.resize((3 * W, 3 * H), Image.Resampling.LANCZOS)
    return big.crop((W, H, 2 * W, 2 * H))


def turn(img: Image.Image, normal: bool) -> Image.Image:
    """A quarter turn counter-clockwise; a normal map's vectors turn with it: (x, y) → (−y, x)."""
    t = img.transpose(Image.Transpose.ROTATE_90)
    if not normal:
        return t
    a = np.asarray(t.convert('RGB')).astype(np.int16)
    out = np.stack([255 - a[..., 1], a[..., 0], a[..., 2]], axis=-1).astype(np.uint8)
    return Image.fromarray(out)


def srgb_to_linear(c: np.ndarray) -> np.ndarray:
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def linear_to_srgb(c: np.ndarray) -> np.ndarray:
    c = np.clip(c, 0, 1)
    return np.where(c <= 0.0031308, c * 12.92, 1.055 * np.power(c, 1 / 2.4) - 0.055)


def hex_linear(h: str) -> np.ndarray:
    return srgb_to_linear(np.array([int(h[i:i + 2], 16) / 255 for i in (1, 3, 5)]))


def tint(img: Image.Image, colour: str, contrast: float) -> Image.Image:
    """The original's variation of lightness, about a colour: what makes a limewash mottled."""
    a = srgb_to_linear(np.asarray(img.convert('RGB')).astype(np.float64) / 255)
    lum = a @ np.array([0.2126, 0.7152, 0.0722])
    k = 1 + contrast * (lum / lum.mean() - 1)
    out = hex_linear(colour)[None, None, :] * k[..., None]
    return Image.fromarray((linear_to_srgb(out) * 255 + 0.5).astype(np.uint8))


def calibrate(img: Image.Image, colour: str) -> Image.Image:
    """
    The map's mean made its item's colour (FLR-T-13.17), each channel scaled in linear light — the
    grain, veining and joints kept, only their level and cast moved. Core 18.1 makes a material's
    `color` the colour shown where its map is not (a plan, a swatch, a distant view) and the map's
    texel the colour where it is: the two are one material only when the map averages to the colour.
    A publisher's scan is lit and exposed as its photographer chose — white oak came out a mid
    brown, half as light as white oak is — so every map is brought to the colour the library states.
    A few rounds, as texels scaled past white are clipped.
    """
    a = srgb_to_linear(np.asarray(img.convert('RGB')).astype(np.float64) / 255)
    target = hex_linear(colour)
    for _ in range(6):
        a = np.clip(a * (target / np.maximum(a.reshape(-1, 3).mean(0), 1e-6))[None, None, :], 0, 1)
    return Image.fromarray((linear_to_srgb(a) * 255 + 0.5).astype(np.uint8))


def calibrated(item: dict) -> bool:
    """Whether an item's albedo map is brought to its colour: every one but a bare metal's, whose map is its measured reflectance."""
    return item.get('metallic', 0) < 1000


def flatten_normal(img: Image.Image, strength: float) -> Image.Image:
    """A normal map's relief scaled by `strength` (< 1 flatter)."""
    a = np.asarray(img.convert('RGB')).astype(np.float64) / 255 * 2 - 1
    a[..., 0] *= strength
    a[..., 1] *= strength
    a[..., 2] = np.maximum(a[..., 2], 1e-3)
    a /= np.linalg.norm(a, axis=-1, keepdims=True)
    return Image.fromarray(((a * 0.5 + 0.5) * 255 + 0.5).astype(np.uint8))


def gray(img: Image.Image | None, size: tuple[int, int], fill: int) -> np.ndarray:
    if img is None:
        return np.full((size[1], size[0]), fill, np.uint8)
    return np.asarray(seamless_resize(img.convert('L'), size))


# ── Generators: height fields on a periodic grid, so they repeat without seams ───────────────────


def noise(shape: tuple[int, int], seed: int, scale: tuple[float, float]) -> np.ndarray:
    """Periodic noise: white noise low-passed in Fourier space. `scale`: correlation length in pixels (x, y). Unit variance."""
    rng = np.random.default_rng(seed)
    h, w = shape
    f = np.fft.rfft2(rng.standard_normal(shape))
    fy = np.fft.fftfreq(h)[:, None]
    fx = np.fft.rfftfreq(w)[None, :]
    f *= np.exp(-((fx * scale[0]) ** 2 + (fy * scale[1]) ** 2) * (np.pi ** 2) * 2)
    n = np.fft.irfft2(f, s=shape)
    return (n - n.mean()) / (n.std() + 1e-12)


def normals_from_height(hmm: np.ndarray, mm_per_px: tuple[float, float]) -> np.ndarray:
    """A height field (millimetres) to a +Y-up normal map: image rows run down, the surface's v up."""
    dx = (np.roll(hmm, -1, axis=1) - np.roll(hmm, 1, axis=1)) / (2 * mm_per_px[0])
    dy = (np.roll(hmm, -1, axis=0) - np.roll(hmm, 1, axis=0)) / (2 * mm_per_px[1])
    n = np.stack([-dx, dy, np.ones_like(hmm)], axis=-1)
    n /= np.linalg.norm(n, axis=-1, keepdims=True)
    return ((n * 0.5 + 0.5) * 255 + 0.5).astype(np.uint8)


def smoothstep(e0: float, e1: float, x: np.ndarray) -> np.ndarray:
    t = np.clip((x - e0) / (e1 - e0), 0, 1)
    return t * t * (3 - 2 * t)


def gen(kind: str, mm: tuple[float, float], px: tuple[int, int]) -> dict[str, np.ndarray]:
    W, H = px
    sx, sy = mm[0] / W, mm[1] / H
    X, Y = np.meshgrid((np.arange(W) + 0.5) * sx, (np.arange(H) + 0.5) * sy)  # mm; Y down the image
    out: dict[str, np.ndarray] = {}
    if kind == 'stipple':
        # A roller's orange peel: bumps about 1.5 mm across, a few hundredths of a millimetre high.
        h = noise((H, W), 11, (1.5 / sx, 1.5 / sy)) * 0.025 + noise((H, W), 12, (5 / sx, 5 / sy)) * 0.02
        out['normal'] = normals_from_height(h, (sx, sy))
    elif kind == 'standing_seam':
        # One 406.4 mm panel: a seam along each edge (x = 0), two pencil ribs, a little oil-canning.
        d = np.minimum(X, mm[0] - X)  # distance to the seam, mm
        seam = 38 * (1 - smoothstep(4, 9, d))  # the seam stands 38 mm, 12 mm wide at its base
        ribs = sum(1.2 * np.exp(-((X - c) / 3.0) ** 2) for c in (mm[0] / 3, 2 * mm[0] / 3))
        can = noise((H, W), 21, (60 / sx, 300 / sy)) * 0.6
        h = seam + ribs + can
        out['normal'] = normals_from_height(h, (sx, sy))
        # The seam's own shade on the panel beside it — a normal map casts no shadow — wide enough to
        # read from the street, as a 38 mm seam's does.
        ao = 1 - 0.4 * np.exp(-((d - 9) / 16) ** 2) * (d > 6)
        # The seam's top catches the light: a little smoother than the panel.
        rough = 0.38 + 0.03 * noise((H, W), 22, (20 / sx, 80 / sy)) - 0.12 * (1 - smoothstep(4, 9, d))
        out['orm'] = np.stack([ao, rough, np.zeros_like(ao)], -1)
    elif kind == 'lap_siding':
        exposure = mm[1] / 4  # 177.8 mm: four courses a tile
        c = (mm[1] - Y) % exposure  # height above the course's bottom edge, mm (Y runs down)
        taper = 8 * (1 - c / exposure)  # 8 mm thick at the drip edge, nothing where the next laps over
        grain = noise((H, W), 31, (90 / sx, 0.9 / sy)) * 0.045 + noise((H, W), 32, (400 / sx, 6 / sy)) * 0.04
        h = taper + grain
        out['normal'] = normals_from_height(h, (sx, sy))
        # The shadow line under each drip edge, in the course below.
        below = (exposure - c)  # distance under the edge above, mm
        ao = 1 - 0.7 * np.exp(-below / 5) - 0.1 * np.exp(-c / 3)
        rough = 0.72 + 0.04 * noise((H, W), 33, (30 / sx, 3 / sy))
        out['orm'] = np.stack([ao, rough, np.zeros_like(ao)], -1)
    elif kind == 'board_batten':
        d = np.minimum(X, mm[0] - X)  # to the batten's centre line at x = 0
        batten = 19 * (1 - smoothstep(23, 27, d))  # 2 in batten, 3/4 in proud
        grain = noise((H, W), 41, (0.9 / sx, 90 / sy)) * 0.1
        h = batten + grain
        out['normal'] = normals_from_height(h, (sx, sy))
        ao = 1 - 0.4 * np.exp(-np.maximum(d - 25.4, 0) / 5) * (d > 25.4)
        rough = 0.75 + 0.03 * noise((H, W), 42, (30 / sx, 30 / sy))
        out['orm'] = np.stack([ao, rough, np.zeros_like(ao)], -1)
    elif kind in ('subway', 'zellige'):
        if kind == 'subway':
            tw, th, joint = 152.4, 76.2, 2.0
        else:
            tw, th, joint = 101.6, 101.6, 1.2
        row = np.floor(Y / th).astype(int)
        shift = (row % 2) * (tw / 2) if kind == 'subway' else 0
        Xs = (X + shift) % mm[0]
        col = np.floor(Xs / tw).astype(int)
        u = Xs - col * tw  # mm into the tile
        v = Y - row * th
        e = np.minimum(np.minimum(u, tw - u), np.minimum(v, th - v))  # to the tile's edge
        rng = np.random.default_rng(51 if kind == 'subway' else 61)
        nx, ny = int(round(mm[0] / tw)), int(round(mm[1] / th))
        jit = rng.standard_normal((ny, nx, 4))
        J = jit[row % ny, col % nx]
        grout = e < joint / 2
        if kind == 'subway':
            bevel = 3.0 * smoothstep(joint / 2, joint / 2 + 3.5, e)
            wave = noise((H, W), 52, (40 / sx, 40 / sy)) * 0.05
            h = np.where(grout, 0, bevel + wave + 0.05 * J[..., 0])
            base = hex_linear('#f1f0ec')[None, None, :] * (1 + 0.018 * J[..., 1:2])
            alb = np.where(grout[..., None], hex_linear('#c9c7c1')[None, None, :], base)
            rough = np.where(grout, 0.85, 0.08 + 0.02 * noise((H, W), 53, (25 / sx, 25 / sy)))
            ao = np.where(grout, 0.7, 1 - 0.25 * np.exp(-(e - joint / 2) / 1.2))
        else:
            # Each tile its own depth of glaze, pooled darker at the edges, its face undulating.
            bevel = 1.6 * smoothstep(joint / 2, joint / 2 + 6, e)
            und = noise((H, W), 62, (14 / sx, 14 / sy)) * 0.35 + J[..., 2:3][..., 0] * 0.15 * np.sin(u / tw * np.pi) * np.sin(v / th * np.pi)
            h = np.where(grout, 0, bevel + und)
            hue = hex_linear('#4f7a68')
            depth = 1 + 0.28 * J[..., 0:1] + 0.10 * noise((H, W), 63, (10 / sx, 10 / sy))[..., None]
            pool = 1 - 0.35 * (1 - smoothstep(joint / 2, joint / 2 + 9, e))[..., None]
            shift_c = np.stack([1 + 0.10 * J[..., 1], 1 + 0.04 * J[..., 3], 1 - 0.06 * J[..., 1]], -1)
            alb = np.where(grout[..., None], hex_linear('#d9d4c8')[None, None, :], hue[None, None, :] * depth * pool * shift_c)
            rough = np.where(grout, 0.9, 0.12 + 0.05 * np.abs(noise((H, W), 64, (6 / sx, 6 / sy))))
            ao = np.where(grout, 0.65, 1.0)
        out['normal'] = normals_from_height(h, (sx, sy))
        out['albedo'] = (linear_to_srgb(alb) * 255 + 0.5).astype(np.uint8)
        out['orm'] = np.stack([ao, rough, np.zeros_like(ao)], -1)
    else:
        raise SystemExit(f'no generator {kind}')
    if 'orm' in out:
        out['orm'] = (np.clip(out['orm'], 0, 1) * 255 + 0.5).astype(np.uint8)
    return out


# ── Writing ─────────────────────────────────────────────────────────────────────────────────────

JPEG = {'albedo': dict(quality=84, subsampling='4:2:0'), 'normal': dict(quality=88, subsampling='4:4:4'), 'orm': dict(quality=84, subsampling='4:4:4')}


def write(name: str, role: str, img: Image.Image, files: dict, origin) -> str:
    buf = io.BytesIO()
    img.convert('RGB').save(buf, 'JPEG', optimize=True, **JPEG[role])
    data = buf.getvalue()
    path = os.path.join(OUT, name)
    with open(path, 'wb') as f:
        f.write(data)
    files[name] = dict(sha256=sha256(data), byteLength=len(data), width=img.size[0], height=img.size[1], mediaType='image/jpeg', origin=origin)
    return name


def prepare(item: dict, o: Originals, files: dict) -> dict[str, str]:
    src = item.get('src')
    if src is None:
        return {}
    px = item['px'] if isinstance(item['px'], tuple) else (item['px'], item['px'])
    want = item['maps']
    out: dict[str, str] = {}
    if src[0] == 'gen':
        stem = item.get('shared', item['id'])
        if item.get('shared') and f'{stem}.normal.jpg' in files:
            return {'normal': f'{stem}.normal.jpg'}
        mm = item['mm']
        g = gen(src[1], mm, px)
        origin = f'generated: prepare-materials.py {src[1]}'
        if 'A' in want:
            a = Image.fromarray(g['albedo'])
            out['albedo'] = write(f'{stem}.albedo.jpg', 'albedo', calibrate(a, item['color']) if calibrated(item) else a, files, origin)
        if 'N' in want:
            out['normal'] = write(f'{stem}.normal.jpg', 'normal', Image.fromarray(g['normal']), files, origin)
        if 'O' in want:
            out['orm'] = write(f'{stem}.orm.jpg', 'orm', Image.fromarray(g['orm']), files, origin)
        return out
    maps = ph_maps(o, src[1]) if src[0] == 'ph' else ac_maps(o, src[1])
    origin = f'{"Poly Haven" if src[0] == "ph" else "ambientCG"} {src[1]}'
    q = item.get('turn', 0) == 90
    if 'A' in want:
        a = seamless_resize(maps['albedo'].convert('RGB'), px)
        if item.get('tint'):
            a = tint(a, item['tint'], item.get('tint_contrast', 1.0))
        if calibrated(item):
            a = calibrate(a, item['color'])
        out['albedo'] = write(f'{item["id"]}.albedo.jpg', 'albedo', turn(a, False) if q else a, files, origin)
    if 'N' in want:
        n = seamless_resize(maps['normal'].convert('RGB'), px)
        if 'normal_strength' in item:
            n = flatten_normal(n, item['normal_strength'])
        out['normal'] = write(f'{item["id"]}.normal.jpg', 'normal', turn(n, True) if q else n, files, origin)
    if 'O' in want:
        if 'arm' in maps:
            orm = seamless_resize(maps['arm'].convert('RGB'), px)
        else:
            ao = gray(maps.get('ao'), px, 255)
            rough = gray(maps.get('rough'), px, 230)
            metal = gray(maps.get('metal'), px, 0)
            orm = Image.fromarray(np.stack([ao, rough, metal], -1))
        out['orm'] = write(f'{item["id"]}.orm.jpg', 'orm', turn(orm, False) if q else orm, files, origin)
    return out


PREVIEW_MM = 609.6  # a picker's swatch shows 2 ft of the surface, as the editor's material cards do
PREVIEW_PX = 192


def preview(item: dict, maps: dict[str, str], size: list[int] | None) -> None:
    """
    A picker's swatch (FLR-T-13.6): 2 ft of the surface at its real scale, lit from the upper left by
    its normal map and shaded by its occlusion. A colour-agnostic item's is grey, for the picker to
    multiply by the colour a person chose.
    """
    os.makedirs(os.path.join(OUT, 'previews'), exist_ok=True)
    n = PREVIEW_PX
    if not maps or size is None:
        img = np.ones((n, n, 3))
    else:
        tw, th = size[0] / UNITS_PER_MM, size[1] / UNITS_PER_MM
        # Each preview pixel's place in the tile, in its own map's pixels; the swatch's bottom-left is the tile's.
        xs = (np.arange(n) + 0.5) / n * PREVIEW_MM
        ys = (n - np.arange(n) - 0.5) / n * PREVIEW_MM

        def lookup(file: str) -> np.ndarray:
            a = np.asarray(Image.open(os.path.join(OUT, file)).convert('RGB')).astype(np.float64) / 255
            h, w = a.shape[:2]
            u = ((xs / tw) % 1 * w).astype(int).clip(0, w - 1)
            v = ((1 - (ys / th) % 1) * h).astype(int).clip(0, h - 1)
            return a[v[:, None], u[None, :]]

        albedo = srgb_to_linear(lookup(maps['albedo'])) if 'albedo' in maps else np.ones((n, n, 3))
        light = np.array([-0.45, 0.55, 0.70])
        light /= np.linalg.norm(light)
        if 'normal' in maps:
            nm = lookup(maps['normal']) * 2 - 1
            nm[..., :2] *= 2  # a swatch is small: its relief drawn twice as deep
            nm /= np.linalg.norm(nm, axis=-1, keepdims=True)
            shade = 0.3 + 0.7 * np.clip(nm @ light, 0, 1) / light[2]
        else:
            shade = np.full((n, n), 1.0)
        ao = lookup(maps['orm'])[..., 0] if 'orm' in maps else np.ones((n, n))
        img = albedo * (shade * (0.55 + 0.45 * ao))[..., None] * (0.92 if 'albedo' in maps else 0.86)
    out = Image.fromarray((linear_to_srgb(img) * 255 + 0.5).astype(np.uint8))
    out.save(os.path.join(OUT, 'previews', f'{item["id"]}.jpg'), 'JPEG', quality=82, optimize=True)


def ts_string(s: str) -> str:
    return json.dumps(s, ensure_ascii=False).replace("'", "\\'")


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit('usage: prepare-materials.py <cache-dir>')
    cache = os.path.abspath(sys.argv[1])
    known: dict[str, str] = {}
    if os.path.exists(SOURCES):
        with open(SOURCES) as f:
            for rec in json.load(f).get('originals', []):
                known[rec['key']] = rec['sha256']
    os.makedirs(OUT, exist_ok=True)
    for d in (OUT, os.path.join(OUT, 'previews')):
        for name in os.listdir(d) if os.path.isdir(d) else []:
            if name.endswith('.jpg'):
                os.remove(os.path.join(d, name))
    o = Originals(cache, known)
    files: dict[str, dict] = {}
    items = []
    for item in ITEMS:
        maps = prepare(item, o, files)
        mm = item.get('mm')
        size = None
        if maps:
            w, h = (mm, mm) if isinstance(mm, (int, float)) else mm
            if item.get('turn', 0) == 90:
                w, h = h, w
            size = [int(round(w * UNITS_PER_MM)), int(round(h * UNITS_PER_MM))]
        items.append((item, maps, size))
        preview(item, maps, size)
        print(f'{item["id"]:24} {", ".join(f"{k}={v}" for k, v in maps.items()) or "(factors only)"}')

    total = sum(f['byteLength'] for f in files.values())
    sources = dict(
        licence=f'{CC0}. Poly Haven (https://polyhaven.com/license) and ambientCG (https://docs.ambientcg.com/license/) publish every asset under CC0; the generated maps are dedicated to the public domain under CC0 too.',
        prepared='packages/mesh/scripts/prepare-materials.py',
        originals=[dict(key=k, **v) for k, v in sorted(o.records.items())],
        files=[dict(file=k, **v) for k, v in sorted(files.items())],
        totalBytes=total,
    )
    with open(SOURCES, 'w') as f:
        json.dump(sources, f, indent=2, ensure_ascii=False)
        f.write('\n')

    lines = [
        '// Generated by packages/mesh/scripts/prepare-materials.py — do not edit. The items of the material',
        '// library (FLR-T-13.6) and the maps each is drawn with; see materials/SOURCES.json for where each came from.',
        "import type { LibraryCategory, LibraryFile, LibraryItemData } from './types.js';",
        '',
        'export const FILES: Readonly<Record<string, LibraryFile>> = {',
    ]
    for name, fl in sorted(files.items()):
        lines.append(f"  '{name}': {{ sha256: '{fl['sha256']}', byteLength: {fl['byteLength']}, width: {fl['width']}, height: {fl['height']}, mediaType: 'image/jpeg' }},")
    lines += ['};', '', 'export const ITEMS: readonly LibraryItemData[] = [']
    for item, maps, size in items:
        parts = [f"id: '{item['id']}'", f"name: {ts_string(item['name'])}", f"category: '{item['category']}' satisfies LibraryCategory", f"uses: [{', '.join(repr(u).replace(chr(39), chr(39)) for u in item['uses'])}]", f"description: {ts_string(item['description'])}", f"color: '{item['color']}'"]
        # Not a metal: metalness 0, whatever a map's blue channel says (Core 18.1: the factor times the map).
        metallic = item.get('metallic', 0 if item['category'] != 'metal' and 'O' in item.get('maps', '') else None)
        if metallic is not None:
            parts.append(f"metallic: {metallic}")
        if 'roughness' in item:
            parts.append(f"roughness: {item['roughness']}")
        if item.get('look'):
            parts.append(f"look: '{item['look']}'")
        if maps:
            mp = ', '.join(f"{k}: '{v}'" for k, v in maps.items())
            parts.append(f'texture: {{ size: [{size[0]}, {size[1]}], maps: {{ {mp} }} }}')
        src = item.get('src')
        if src is not None:
            parts.append(f"origin: '{'generated' if src[0] == 'gen' else ('Poly Haven ' if src[0] == 'ph' else 'ambientCG ') + src[1]}'")
        lines.append('  { ' + ', '.join(parts) + ' },')
    lines += ['];', '']
    with open(DATA_TS, 'w') as f:
        f.write('\n'.join(lines))
    print(f'{len(files)} files, {total / 1e6:.1f} MB')


if __name__ == '__main__':
    main()
