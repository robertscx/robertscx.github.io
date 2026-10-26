#!/usr/bin/env node
/**
 * optimize-photos.js — generate web-optimized versions of photography images.
 *
 * Originals are never modified. Web versions are written with the SAME
 * filename (and extension) into the output directory, so existing markdown
 * references such as `![](/photos/000019390001.jpg)` keep working unchanged.
 *
 * Usage:
 *   node tools/optimize-photos.js [options]
 *
 * Options:
 *   --src <dir>        Originals directory      (default: photos-originals)
 *   --out <dir>        Output directory         (default: source/photos)
 *   --max-size <px>    Longest edge in pixels   (default: 2048)
 *   --quality <1-100>  JPEG/WebP quality        (default: 85)
 *   --force            Rebuild even if output is newer than the original
 *   --dry-run          Show what would happen, write nothing
 *   --help             Show this help
 *
 * Behaviour:
 *   - Auto-orients using EXIF, then strips EXIF (removes GPS/camera data).
 *   - Keeps the ICC colour profile so colours stay accurate.
 *   - Never enlarges images smaller than --max-size (withoutEnlargement).
 *   - If the optimized file would be larger than the original, the original
 *     is copied instead — output is never bigger than the source.
 *   - Skips files whose output is already newer than the source (incremental).
 */

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const EXT_OK = new Set(['.jpg', '.jpeg', '.png', '.webp']);

function parseArgs(argv) {
  const opts = {
    src: 'photos-originals',
    out: 'source/photos',
    maxSize: 2048,
    quality: 85,
    force: false,
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) fail(`Missing value for ${a}`);
      return v;
    };
    switch (a) {
      case '--src': opts.src = next(); break;
      case '--out': opts.out = next(); break;
      case '--max-size': opts.maxSize = parseInt(next(), 10); break;
      case '--quality': opts.quality = parseInt(next(), 10); break;
      case '--force': opts.force = true; break;
      case '--dry-run': opts.dryRun = true; break;
      case '--help':
      case '-h': printHelp(); process.exit(0); break;
      default:
        if (a.startsWith('-')) fail(`Unknown option: ${a}`);
    }
  }
  if (!Number.isFinite(opts.maxSize) || opts.maxSize < 1) fail('--max-size must be a positive number');
  if (!Number.isFinite(opts.quality) || opts.quality < 1 || opts.quality > 100) fail('--quality must be 1-100');
  return opts;
}

function printHelp() {
  const text = fs.readFileSync(__filename, 'utf8');
  const block = text.split('*/')[0];
  const lines = block
    .split('\n')
    .filter((l) => !l.startsWith('#!'))
    .map((l) => l.replace(/^\/\*\*?/, '').replace(/^ \* ?/, ''));
  console.log(lines.join('\n').trim());
}

function fail(msg) {
  console.error(`Error: ${msg}`);
  process.exit(1);
}

function fmt(bytes) {
  if (bytes >= 1024 * 1024) return (bytes / 1048576).toFixed(2) + ' MB';
  if (bytes >= 1024) return (bytes / 1024).toFixed(0) + ' KB';
  return bytes + ' B';
}

function pct(before, after) {
  if (before === 0) return '0.0%';
  return (((before - after) / before) * 100).toFixed(1) + '%';
}

async function processOne(srcFile, outFile, opts) {
  const originalSize = fs.statSync(srcFile).size;

  if (!opts.force && fs.existsSync(outFile)) {
    const outStat = fs.statSync(outFile);
    if (outStat.mtimeMs >= fs.statSync(srcFile).mtimeMs && outStat.size > 0) {
      return { status: 'skipped', originalSize, outputSize: outStat.size };
    }
  }

  const ext = path.extname(srcFile).toLowerCase();
  const meta = await sharp(srcFile).metadata();
  const longEdge = Math.max(meta.width || 0, meta.height || 0);
  const resized = longEdge > opts.maxSize;

  if (opts.dryRun) {
    return { status: 'would-process', originalSize, outputSize: null, resized, longEdge };
  }

  // Build the pipeline: auto-orient, then resize only if needed.
  let pipeline = sharp(srcFile).rotate();
  if (resized) {
    pipeline = pipeline.resize({
      width: opts.maxSize,
      height: opts.maxSize,
      fit: 'inside',
      withoutEnlargement: true,
    });
  }
  // Keep colour accurate; drop EXIF/GPS.
  if (typeof pipeline.keepIccProfile === 'function') {
    pipeline = pipeline.keepIccProfile();
  }

  const tmpFile = outFile + '.tmp';
  try {
    if (ext === '.png') {
      await pipeline
        .png({ compressionLevel: 9, palette: false, effort: 10 })
        .toFile(tmpFile);
    } else if (ext === '.webp') {
      await pipeline.webp({ quality: opts.quality, effort: 5 }).toFile(tmpFile);
    } else {
      await pipeline
        .jpeg({ quality: opts.quality, mozjpeg: true, progressive: true })
        .toFile(tmpFile);
    }
  } catch (err) {
    // Fall back to a plain copy below if the re-encode fails.
    console.error(`  ! re-encode failed for ${path.basename(srcFile)}: ${err.message}`);
    fs.rmSync(tmpFile, { force: true });
    fs.copyFileSync(srcFile, outFile);
    return { status: 'copied', originalSize, outputSize: originalSize };
  }

  const newSize = fs.statSync(tmpFile).size;
  if (newSize >= originalSize) {
    // Never ship something bigger than the source.
    fs.rmSync(tmpFile, { force: true });
    fs.copyFileSync(srcFile, outFile);
    return { status: 'copied', originalSize, outputSize: originalSize };
  }

  fs.renameSync(tmpFile, outFile);
  return { status: 'optimized', originalSize, outputSize: newSize, resized, longEdge };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const srcDir = path.resolve(opts.src);
  const outDir = path.resolve(opts.out);

  if (!fs.existsSync(srcDir)) {
    fail(`Source directory not found: ${srcDir}\nCreate it and put your originals there, or pass --src <dir>.`);
  }

  const files = fs
    .readdirSync(srcDir)
    .filter((f) => EXT_OK.has(path.extname(f).toLowerCase()))
    .filter((f) => fs.statSync(path.join(srcDir, f)).isFile())
    .sort();

  if (files.length === 0) {
    fail(`No images (.jpg/.jpeg/.png/.webp) found in ${srcDir}`);
  }

  if (!opts.dryRun) fs.mkdirSync(outDir, { recursive: true });

  console.log(`Source : ${srcDir}`);
  console.log(`Output : ${outDir}`);
  console.log(`Settings: max ${opts.maxSize}px, quality ${opts.quality}${opts.dryRun ? ', DRY RUN' : ''}`);
  console.log(`Found  : ${files.length} image(s)\n`);

  let totalBefore = 0;
  let totalAfter = 0;
  let optimized = 0;
  let skipped = 0;
  let copied = 0;
  let errors = 0;

  for (const f of files) {
    const srcFile = path.join(srcDir, f);
    const outFile = path.join(outDir, f);
    try {
      const r = await processOne(srcFile, outFile, opts);
      if (r.status === 'skipped') {
        skipped++;
        totalBefore += r.originalSize;
        totalAfter += r.outputSize;
        console.log(`  = ${f}  (up to date, ${fmt(r.originalSize)})`);
        continue;
      }
      if (r.status === 'would-process') {
        optimized++;
        totalBefore += r.originalSize;
        const note = r.resized ? ` -> ${opts.maxSize}px` : ' (no resize)';
        console.log(`  ? ${f}  ${fmt(r.originalSize)}${note}`);
        continue;
      }
      totalBefore += r.originalSize;
      totalAfter += r.outputSize;
      if (r.status === 'copied') {
        copied++;
        console.log(`  > ${f}  kept original ${fmt(r.originalSize)} (re-encode not smaller)`);
      } else {
        optimized++;
        const note = r.resized ? ` (${r.longEdge}px -> ${opts.maxSize}px)` : '';
        console.log(
          `  + ${f}  ${fmt(r.originalSize)} -> ${fmt(r.outputSize)}  (-${pct(r.originalSize, r.outputSize)})${note}`
        );
      }
    } catch (err) {
      errors++;
      console.error(`  ! ${f}: ${err.message}`);
    }
  }

  console.log('\n' + '-'.repeat(60));
  if (opts.dryRun) {
    console.log(`Would process ${optimized} image(s). Total source size: ${fmt(totalBefore)}`);
    console.log('Re-run without --dry-run to generate the files.');
  } else {
    console.log(`Optimized ${optimized}, copied ${copied}, skipped ${skipped}, errors ${errors}`);
    console.log(`Total: ${fmt(totalBefore)} -> ${fmt(totalAfter)}  (-${pct(totalBefore, totalAfter)})`);
    if (errors > 0) process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error('Fatal:', e.message);
  process.exit(1);
});
