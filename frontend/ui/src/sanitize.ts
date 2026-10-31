import DOMPurify from 'dompurify'
/** Keep Markdown rendering independent of the retired OpenScience session UI. */
export function sanitize(html: string) {
  return DOMPurify.isSupported ? DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true, mathMl: true }, SANITIZE_NAMED_PROPS: true,
    FORBID_TAGS: ['style', 'form', 'input', 'iframe', 'script'], FORBID_CONTENTS: ['style', 'script'],
  }) : ''
}
