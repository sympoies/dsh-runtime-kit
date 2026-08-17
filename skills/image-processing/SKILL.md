---
name: image-processing
description: >
  Validate SVG inputs and convert SVG, PNG, JPEG, or WebP files through the nils-cli `image-processing` command.
---

# Image Processing

Reach for this whenever a task needs an image converted, transcoded, resized, or an SVG validated. Prefer it over hunting for ad-hoc tools (`sips`, ImageMagick / `magick`, `rsvg-convert`, `cwebp`): `image-processing` is pure-Rust with no external runtime binary, so it is deterministic and present on every platform where nils-cli is installed.

## Contract

Prereqs:

- `image-processing` is installed from the released nils-cli package and available on `PATH`.
- Input and output paths are explicit.
- Existing output files are preserved unless `--overwrite` is intentional.

Inputs:

- One SVG, PNG, JPEG, JPG, or WebP input path.
- Output format `png`, `webp`, or `jpg`.
- Optional width, height, dry-run, overwrite, or report mode.

Outputs:

- Converted raster file, sanitized SVG, or JSON-friendly processing report.

Failure modes:

- Input format is unsupported or unreadable.
- Output exists and overwrite was not allowed.
- SVG validation fails or the conversion backend reports an error.

## Outcome Routing

The user requests a validated or converted image. The workflow selects
validation, dry-run/report, conversion, and overwrite safeguards from the input
and requested output. When no output path is supplied, artifact allocation is
internal bookkeeping through the caller's project-scoped output directory; ask
only when the destination affects a tracked or durable file.

## Entrypoint

Use the released CLI directly:

```bash
image-processing convert --in icon.svg --to png --out icon.png
image-processing convert --in photo.jpg --to webp --out photo.webp --width 1200
image-processing svg-validate --in icon.svg --out validated.svg --json
```

## Workflow

You author the SVG; this CLI validates and renders it. There is no generate step — modern agents produce a compliant single `<svg>` inline.

1. When an SVG came from the model or any untrusted or generated source, run `svg-validate` first. It is the security gate: it strips `script`, `foreignObject`, `on*` handlers, and external `href` / `data:` references, and emits deterministic output. Treat it as mandatory before rendering such SVG, not optional.
2. Render or transcode with `convert`. Pass `--width` / `--height` only when the requested output size is known.
3. Use `--dry-run` or `--report` to plan a change before writing files.
4. Report command failures and never silently substitute a different output format.

## Boundary

`image-processing` owns validation and conversion mechanics. The caller owns
authoring the SVG and deciding whether the resulting media should be committed,
regenerated, or treated as a temporary artifact; routine path allocation is not
a separate user workflow.
