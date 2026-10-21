/*
* Center Subject — the subject's bounding box from a remove-background mask.
*
* Added for the InDesign plugin integration: UXP can't decode PNG masks, so
* subject-status measures the box here (jimp, already a dependency) and
* returns it next to maskUrl. The box is a share (0..1) of the photo, so the
* 2048 px copy sent to Photoshop gives the same box as the original.
*
* Mask: white (or opaque) = subject. A row / column counts only if at least
* MIN_SHARE of its pixels are subject, so single stray pixels don't stretch
* the box.
*/

const THRESHOLD = 128
const MIN_SHARE = 0.002

/** PURE. Box of the subject pixels in an RGBA bitmap ({ width, height, data }). */
function boxFromBitmap (bitmap) {
  const { width, height, data } = bitmap
  const rows = new Array(height).fill(0)
  const cols = new Array(width).fill(0)
  let subject = 0
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      const lum = Math.max(data[i], data[i + 1], data[i + 2])
      if (lum >= THRESHOLD && data[i + 3] >= THRESHOLD) { rows[y]++; cols[x]++; subject++ }
    }
  }
  if (!subject) return null
  const minRow = Math.max(2, Math.round(width * MIN_SHARE))
  const minCol = Math.max(2, Math.round(height * MIN_SHARE))
  const top = rows.findIndex((n) => n >= minRow)
  const left = cols.findIndex((n) => n >= minCol)
  let bottom = height - 1; while (bottom > 0 && rows[bottom] < minRow) bottom--
  let right = width - 1; while (right > 0 && cols[right] < minCol) right--
  if (top === -1 || left === -1 || bottom < top || right < left) return null
  const r4 = (n) => Math.round(n * 10000) / 10000
  return {
    x: r4(left / width), y: r4(top / height),
    width: r4((right - left + 1) / width), height: r4((bottom - top + 1) / height),
    coverage: r4(subject / (width * height)),
    maskSize: { width, height }
  }
}

/** Downloads the mask (pre-signed URL returned by Adobe) and measures it. */
async function subjectBoxFromMask (maskUrl, fetchFn) {
  const res = await fetchFn(maskUrl)
  if (!res.ok) throw new Error(`mask download failed (HTTP ${res.status})`)
  const Jimp = require('jimp')
  const img = await Jimp.read(Buffer.from(await res.arrayBuffer()))
  return boxFromBitmap(img.bitmap)
}

module.exports = { boxFromBitmap, subjectBoxFromMask, THRESHOLD, MIN_SHARE }
