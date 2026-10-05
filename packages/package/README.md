# @floorspec/package

The `.floorspec` package (FLR-T-9.1, FLR-REQ-126, FLR-REQ-135, FLR-REQ-151): a Floorspec document
and the files of its assets, as **one ZIP archive** or as **the identical unpacked folder**, and
both read back under limits a hostile archive cannot get past. Isomorphic (FLR-ADR-010): the editor
opens a package in the browser, the server builds one on export and opens one on import, and the
CLI (`floorspec package`, `floorspec unpack`) writes and reads them on disk.

## What the standard says, and what this adds

Core 0.3 (18.4) defines a document's **package** as the directory that holds the document's file;
an asset's `path` is relative to that directory, and a **package validator** is given the
directory's files and checks each asset located by `path` against its file (`FS-INV-1005` missing,
`FS-INV-1006` digest, `FS-INV-1007` length). Core 9.4 and 0.5 name a one-file form — "a ZIP
archive holding `model.json` and its assets" — and defer defining it to a later draft.

This package is that one-file form as D3 Floorspec writes it. **It is not yet part of the
standard**: the layout below is a candidate for a later Core draft (Core 9.4 / 18.4), offered as
written here.

## The layout

```text
kitchen.floorspec              (a ZIP archive)
  model.json                   ← the document, byte for byte as exported (its canonical form)
  assets/
    cf77ab…6c.png              ← "path": "assets/cf77ab…6c.png" — wherever the document's path says
```

Unpacked, the folder holds exactly the same files at the same paths — and this is the whole of the
package's definition: **the ZIP is the folder, zipped.** The document file and every asset's file
are byte-identical between the two forms (tested: `test/package.test.ts`, and the CLI's tests
round-trip a package through `floorspec unpack`).

| Rule | Value |
|---|---|
| Document | `model.json` at the archive's root |
| Assets | each asset located by `path` (Core 8.6) has its file at that path; an asset located by `uri` has none |
| Other files | none written; a reader lists and ignores them |
| Entry order | `model.json` first, then the assets' files in code-point order of path |
| Directory entries | none |
| Names | UTF-8 (general-purpose flag bit 11), the asset paths exactly — no `./`, no `\`, no leading `/` |
| Timestamps | every entry 1980-01-01 00:00:00 (MS-DOS date `0x0021`, time `0`) |
| Compression | each file deflated (method 8, level 9) when that makes it smaller, otherwise stored (method 0) — a JPEG or PNG is usually stored |
| Attributes | "made by" Unix, APPNOTE 2.0 (`0x0314`); external attributes `0100644 << 16` (a regular file, mode 0644) |
| Not used | extra fields, data descriptors, ZIP64, encryption, multi-disk, an archive comment |
| Media type | `application/zip` until one is registered; extension `.floorspec` |

So the same document and the same files make the same archive, byte for byte, on any machine at
any time (no clock, no host, no file-system order reaches it); an export's `ETag` is the archive's
SHA-256. Which deflater is used is not part of the layout: a reader must not assume one. The
document's bytes are the canonical form (Core 9.2) when D3 Floorspec writes them, but a reader
takes whatever document is there and validates it.

## Reading a package

`readPackage(bytes, limits)` (= `readZip` + `openEntries`) treats the archive as untrusted:

- **Structure.** The end-of-central-directory record must end the file exactly; the central
  directory is what is believed, and each local header must name the same file. Entries' data must
  lie inside the archive and **no two entries may share bytes** (the overlapping-entry bomb).
- **Zip-slip.** Every name must be a safe path: relative, `/`-separated, no empty, `.` or `..`
  segment, no `:` in the first segment (Core 8.6.2), and also no `\`, no control characters, at most
  1,024 bytes and 255 per segment. **One unsafe name refuses the whole archive.** No path is ever
  joined to a directory by this package; the CLI, which writes folders, checks again.
- **Not files.** A symbolic link, device, FIFO or socket (Unix mode in the external attributes) is
  refused; so are encryption, ZIP64, split archives and methods other than stored and deflated. A
  path that appears twice is refused.
- **Size.** Checked from the central directory before anything is inflated, and inflation writes
  into a buffer of the declared size — a lying header cannot make memory grow — then length and
  CRC-32 must match.

| Limit (`DEFAULT_LIMITS`) | Default | The server's import |
|---|---|---|
| `maxArchiveBytes` — the archive | 256 MB | 128 MB (the request body) |
| `maxEntries` — files | 4,096 | 4,096 |
| `maxEntryBytes` — one file, uncompressed | 64 MB | `ASSET_MAX_BYTES` (20 MB by default), what one upload may be |
| `maxTotalBytes` — every file, uncompressed | 512 MB | 512 MB |
| `maxDocumentBytes` — the document | 32 MB | 32 MB |

**Where the document is.** `model.json` at the root. A reader is lenient in one way only, so that a
person can zip the Core 18.4 directory form themselves: failing `model.json`, the root's single
`*.floorspec.json` (Core 9.4's name for a document's file); failing both, the same inside a single
top-level folder (what zipping a folder, rather than its contents, makes). `__MACOSX/`,
`.DS_Store`, `Thumbs.db` and `desktop.ini` are dropped silently.

**What is read.** The document's bytes; the files its assets' paths name (`files`, which is what a
package validator is given: `validate(document, { package: new Package(files) })`); the assets
whose file is not there (`missing`, which the validator reports as `FS-INV-1005`); and every other
file (`ignored`), listed so a person can see it and never read further.

## Writing a package

`packageEntries(document, filesBySha256)` takes the document's bytes and a lookup of files by
SHA-256 (the asset store's key) and gives the entries in order, and the assets it could not include
— never bytes whose digest is not the one the document names, and never a throw: export is always
available (FLR-REQ-151). `packageZip(built)` is the archive; the folder is the same entries written
as files.

## documentToBatch

A whole document as one batch of Floorspec Ops (FLR-ADR-008), from the empty document a new
project starts as: `setProperty $document /floorspec` when the document declares another Core
version (an import keeps its version), the top-level and project members, an `addElement` for every
element (Core 0.3's roofs, stairs, option sets and options included), the program's adjacency, and
extension elements. Tested against every valid document of the Core 0.1, 0.2 and 0.3 conformance
suites: the batch, applied by `@floorspec/ops` to the empty document, gives the document's content
hash exactly. Used by the editor's templates and by the server's import.
