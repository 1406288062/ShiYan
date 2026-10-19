const ALLOWED_TAGS = new Set([
  'BR', 'P', 'STRONG', 'EM', 'H2', 'H3', 'H4', 'UL', 'OL', 'LI',
  'CODE', 'PRE', 'BLOCKQUOTE'
])
const REMOVE_ENTIRELY = new Set(['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'SVG', 'MATH'])

/**
 * Model output and document-derived HTML cross a trust boundary here.
 * The small browser-native allow-list keeps the prototype dependency-light
 * while stripping event handlers, URLs and executable elements.
 */
export function sanitizeHtml(value) {
  const source = String(value || '')
  if (typeof document === 'undefined') return escapeHtml(source)
  const template = document.createElement('template')
  template.innerHTML = source

  function clean(parent) {
    Array.from(parent.children).forEach(element => {
      const tag = element.tagName
      if (REMOVE_ENTIRELY.has(tag)) {
        element.remove()
        return
      }
      if (!ALLOWED_TAGS.has(tag)) {
        const text = document.createTextNode(element.textContent || '')
        element.replaceWith(text)
        return
      }
      Array.from(element.attributes).forEach(attribute => element.removeAttribute(attribute.name))
      clean(element)
    })
  }

  clean(template.content)
  return template.innerHTML
}

export function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
}
