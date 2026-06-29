import { Hono } from 'hono'
import { Bindings, Variables } from '../types'
import { authMiddleware } from '../middleware/auth'

const files = new Hono<{ Bindings: Bindings; Variables: Variables }>()

// define previewable extensions
const PREVIEWABLE_EXTS = new Set([
  'txt', 'md', 'html', 'css', 'js', 'json',
  'jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'ico',
  'pdf',
  'mp4', 'webm', 'ogg', 'mp3', 'wav'
])

files.get('/download/:filename', authMiddleware, async (c) => {
  const filename = c.req.param('filename')
  
  if (!c.env.FILE_SHARE) {
    return c.json({ ok: false, message: 'File storage is not configured' }, 500)
  }

  // fetch from R2
  const object = await c.env.FILE_SHARE.get(filename)
  if (!object) {
    return c.notFound()
  }

  // determine if we should preview inline or download as attachment
  const extMatch = filename.match(/\.([a-z0-9]+)$/i)
  const ext = extMatch ? extMatch[1].toLowerCase() : ''
  const isPreviewable = PREVIEWABLE_EXTS.has(ext)

  const headers = new Headers()
  object.writeHttpMetadata(headers)
  headers.set('etag', object.httpEtag)

  // fallback content-type if not present in R2
  if (!headers.has('content-type')) {
    headers.set('content-type', 'application/octet-stream')
  }

  const disposition = isPreviewable ? 'inline' : 'attachment'
  headers.set('Content-Disposition', `${disposition}; filename="${filename}"`)

  return new Response(object.body, {
    headers,
  })
})

export default files
