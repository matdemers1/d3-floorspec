/** What a library material is, for browsing: the editor's categories (FLR-T-13.6). */
export type LibraryCategory = 'wood' | 'decking' | 'tile' | 'stone' | 'brick' | 'plaster' | 'concrete' | 'paint' | 'metal' | 'fabric' | 'glass' | 'roofing' | 'siding' | 'paver';

/** Where a library material is meant to go: a hint for the picker, never a rule. */
export type LibraryUse = 'floor' | 'wall' | 'ceiling' | 'counter' | 'roof' | 'exterior' | 'furniture';

/** One of the library's map files, beside this package's `materials/` (`@floorspec/mesh/materials/<file>`). */
export interface LibraryFile {
  readonly sha256: string;
  readonly byteLength: number;
  /** Pixels. */
  readonly width: number;
  readonly height: number;
  readonly mediaType: 'image/jpeg';
}

/** The maps of a library material, by file: base colour, normal, and occlusion-roughness-metalness packed (glTF's). */
export interface LibraryMaps {
  readonly albedo?: string;
  readonly normal?: string;
  readonly orm?: string;
}

/** An item as the generated data module holds it. */
export interface LibraryItemData {
  readonly id: string;
  readonly name: string;
  readonly category: LibraryCategory;
  readonly uses: readonly LibraryUse[];
  readonly description: string;
  /** `#rrggbb`: its base colour where no map is drawn (Core 18.1) — and, for an item with no albedo map, its base colour, the one a person changes. */
  readonly color: string;
  /** Thousandths (Core 18.1). Absent: the ORM map's, or Core's default. */
  readonly metallic?: number;
  readonly roughness?: number;
  /** A view hint the standard does not carry: drawn see-through where a view can. */
  readonly look?: 'glass';
  /** One tile's real-world size in base units, and its maps. */
  readonly texture?: { readonly size: readonly [number, number]; readonly maps: LibraryMaps };
  /** Where its maps came from: a Poly Haven or ambientCG asset, or drawn by the prepare script. */
  readonly origin?: string;
}
