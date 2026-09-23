// Crops a picked photo to a centered square and shrinks it to 256px, so what
// gets uploaded is a few KB. WebP where the browser can encode it; older
// Safari cannot and falls back to JPEG. The database re-checks size and type.

const SIZE = 256
const LIMIT = 90_000
const ATTEMPTS = [['image/webp', 0.82], ['image/jpeg', 0.85], ['image/jpeg', 0.7], ['image/jpeg', 0.55]]

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => { URL.revokeObjectURL(url); resolve(img) }
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("That photo type isn't supported. Try a JPEG or PNG.")) }
    img.src = url
  })
}

const toBlob = (canvas, type, quality) => new Promise((resolve) => canvas.toBlob(resolve, type, quality))

const toBase64 = (blob) => new Promise((resolve, reject) => {
  const reader = new FileReader()
  reader.onload = () => resolve(String(reader.result).split(',')[1])
  reader.onerror = () => reject(new Error('Could not read that photo.'))
  reader.readAsDataURL(blob)
})

// Returns base64 without the data: prefix.
export async function squarePhoto(file) {
  const img = await loadImage(file)
  const side = Math.min(img.naturalWidth, img.naturalHeight)
  if (!side) throw new Error('Could not read that photo.')
  const canvas = document.createElement('canvas')
  canvas.width = SIZE
  canvas.height = SIZE
  canvas.getContext('2d').drawImage(img,
    (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, SIZE, SIZE)
  for (const [type, quality] of ATTEMPTS) {
    const blob = await toBlob(canvas, type, quality)
    if (blob && blob.type === type && blob.size <= LIMIT) return toBase64(blob)
  }
  throw new Error('Could not shrink that photo. Try another one.')
}
