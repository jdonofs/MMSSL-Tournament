import { useRef, useState } from 'react'
import { supabase } from '../supabaseClient'
import TeamLogo from './TeamLogo'

// Normalizes any uploaded image to a 500×500 PNG square.
// Users are expected to upload square logos; this just ensures a consistent
// resolution regardless of the exact input size.
function normalizeLogoImage(file) {
  const SIZE = 500

  return new Promise((resolve, reject) => {
    const img = new Image()
    const objectUrl = URL.createObjectURL(file)

    img.onload = () => {
      const canvas = document.createElement('canvas')
      canvas.width = SIZE
      canvas.height = SIZE
      const ctx = canvas.getContext('2d')

      // Scale to fit inside the square, centered, with transparent background
      const scale = Math.min(SIZE / img.width, SIZE / img.height)
      const w = img.width * scale
      const h = img.height * scale
      const x = (SIZE - w) / 2
      const y = (SIZE - h) / 2

      ctx.clearRect(0, 0, SIZE, SIZE)
      ctx.drawImage(img, x, y, w, h)

      URL.revokeObjectURL(objectUrl)
      canvas.toBlob((blob) => {
        if (blob) resolve(blob)
        else reject(new Error('Canvas export failed'))
      }, 'image/png')
    }

    img.onerror = () => {
      URL.revokeObjectURL(objectUrl)
      reject(new Error('Could not load image'))
    }

    img.src = objectUrl
  })
}

export default function LogoUpload({
  logoKey,
  logoUrl,
  teamName,
  storagePath,
  onUpload,
  onError,
  height = 36,
}) {
  const [uploading, setUploading] = useState(false)
  const inputRef = useRef(null)

  const handleFile = async (e) => {
    const file = e.target.files?.[0]
    if (!file) return

    setUploading(true)

    let blob
    try {
      blob = await normalizeLogoImage(file)
    } catch (err) {
      onError?.(err.message)
      setUploading(false)
      e.target.value = ''
      return
    }

    const path = `${storagePath}.png`

    const { error: uploadError } = await supabase.storage
      .from('team-logos')
      .upload(path, blob, { upsert: true, contentType: 'image/png' })

    if (uploadError) {
      onError?.(uploadError.message)
      setUploading(false)
      e.target.value = ''
      return
    }

    const { data } = supabase.storage.from('team-logos').getPublicUrl(path)
    onUpload(`${data.publicUrl}?t=${Date.now()}`)
    setUploading(false)
    e.target.value = ''
  }

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      <TeamLogo logoKey={logoKey} logoUrl={logoUrl} teamName={teamName} height={height} placeholder />
      <input
        ref={inputRef}
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp"
        style={{ display: 'none' }}
        onChange={handleFile}
      />
      <button
        className="ghost-button"
        onClick={() => inputRef.current?.click()}
        disabled={uploading}
        type="button"
        style={{ fontSize: 12, padding: '4px 12px' }}
      >
        {uploading ? 'Uploading…' : logoUrl ? 'Replace' : 'Upload'}
      </button>
    </div>
  )
}
