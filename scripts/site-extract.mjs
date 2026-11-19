/**
 * Pulls the text USERS SEE out of a .tsx/.ts source file, for ARHMS AI's site index.
 *
 * Kept (in source order):
 *   - JSX text (headings, paragraphs, buttons);  h1-h4 / *Title components start a section
 *   - user-facing JSX attributes: title, placeholder, aria-label, label, description, alt
 *   - strings under display keys in object literals (label, title, description, hint, ...)
 *   - toast.*('...') / toast('...') messages (they carry the rules users hit)
 *   - string literals that are the result of a JSX {cond ? 'a' : 'b'} / {'text'}
 *   - API docs objects { method, path, label, desc } as one "METHOD path: label. desc" line
 *
 * Never kept: comments, classNames, imports, URLs, code-looking tokens, secret-looking values.
 * Pure (no fs): scripts/build-site-index.mjs does the file walking.
 * Covered by lib/__tests__/ai-assistant-site-index.test.mts.
 */

const ATTRS = new Set(['title', 'placeholder', 'aria-label', 'label', 'description', 'alt', 'helperText', 'emptyText'])
const KEYS = new Set([
    'label', 'title', 'description', 'desc', 'hint', 'blurb', 'empty', 'error', 'message', 'subtitle',
    'heading', 'note', 'summary', 'lead', 'when', 'tip', 'cta', 'question', 'answer', 'body', 'text',
    'helper', 'caption', 'tagline', 'warning', 'info',
])
const HEADING_TAGS = /^(h1|h2|h3|h4|CardTitle|DialogTitle|SheetTitle|AlertTitle|AlertDialogTitle)$/

const SECRET_RE = /(sk-[A-Za-z0-9_-]{16,}|sb_(?:secret|publishable)_[A-Za-z0-9_-]{10,}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}|\b[0-9a-fA-F]{32,}\b)/

/** Does this string read like words a person sees (not a class list, key, path or code)? */
export function isUserText(raw) {
    const s = String(raw ?? '').replace(/\s+/g, ' ').trim()
    if (s.length < 2 || s.length > 1200) return false
    if (!/[A-Za-z]/.test(s)) return false
    if (SECRET_RE.test(s)) return false
    if (/^https?:\/\//i.test(s) || /^(\/|\.\/|@\/)[\w/.[\]-]*$/.test(s)) return false // URL / path
    if (/^[a-z0-9]+([_.:-][a-z0-9]+)+$/i.test(s) && !/\s/.test(s)) return false // snake/kebab/dotted ids
    if (/\b(?:px|py|mx|my|text|bg|flex|grid|rounded|border|w|h|gap|items|justify)-[\w[\]/.]+/.test(s) && !/[.!?]$/.test(s)) return false // tailwind
    if (/^[a-z]+[A-Z]\w*$/.test(s)) return false // camelCase identifier
    if (/[{};=<>]|=>|\|\||&&/.test(s)) return false // code
    return true
}

const clean = s => String(s).replace(/\s+/g, ' ').trim()

function stringValue(ts, node) {
    if (!node) return null
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text
    if (ts.isTemplateExpression(node)) {
        // `Minimum top-up is GHS ${MIN}` -> "Minimum top-up is GHS …"
        let out = node.head.text
        for (const span of node.templateSpans) out += '…' + span.literal.text
        return out
    }
    if (ts.isParenthesizedExpression(node)) return stringValue(ts, node.expression)
    return null
}

function propName(ts, nameNode) {
    if (!nameNode) return null
    if (ts.isIdentifier(nameNode) || ts.isStringLiteral(nameNode)) return nameNode.text
    return null
}

/**
 * @returns {{ heading: boolean, text: string }[]} user-visible strings in source order
 */
export function extractUiText(ts, sourceText, fileName = 'file.tsx') {
    const sf = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true,
        fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
    const out = []
    const push = (text, heading = false) => {
        const t = clean(text)
        if (!isUserText(t)) return
        if (out.length && out[out.length - 1].text === t) return
        out.push({ heading, text: t })
    }

    const tagName = el => {
        const t = ts.isJsxElement(el) ? el.openingElement.tagName : ts.isJsxSelfClosingElement(el) ? el.tagName : null
        return t ? t.getText(sf) : ''
    }

    function visit(node, inHeading) {
        // Imports, type declarations: nothing user-visible.
        if (ts.isImportDeclaration(node) || ts.isTypeAliasDeclaration(node) || ts.isInterfaceDeclaration(node)) return

        if (ts.isJsxElement(node)) {
            const isHead = HEADING_TAGS.test(tagName(node))
            if (isHead) {
                // Collect the heading's own text as one heading entry.
                const parts = []
                const collect = n => {
                    if (ts.isJsxText(n)) parts.push(n.text)
                    else if (ts.isJsxExpression(n) && n.expression) {
                        const v = stringValue(ts, n.expression)
                        if (v) parts.push(v)
                    }
                    ts.forEachChild(n, collect)
                }
                node.children.forEach(collect)
                push(parts.join(' '), true)
                visit(node.openingElement, true)
                return
            }
        }

        if (ts.isJsxText(node) && !inHeading) push(node.text)

        if (ts.isJsxAttribute(node)) {
            const name = node.name.getText(sf)
            if (ATTRS.has(name) && node.initializer) {
                const v = ts.isStringLiteral(node.initializer)
                    ? node.initializer.text
                    : ts.isJsxExpression(node.initializer) ? stringValue(ts, node.initializer.expression) : null
                if (v) push(v)
            }
            return // never descend into className etc.
        }

        if (ts.isJsxExpression(node) && node.expression && !inHeading) {
            const e = node.expression
            const v = stringValue(ts, e)
            if (v) push(v)
            if (ts.isConditionalExpression(e)) {
                const a = stringValue(ts, e.whenTrue)
                const b = stringValue(ts, e.whenFalse)
                if (a) push(a)
                if (b) push(b)
            }
        }

        if (ts.isObjectLiteralExpression(node)) {
            const props = {}
            for (const p of node.properties) {
                if (ts.isPropertyAssignment(p)) {
                    const k = propName(ts, p.name)
                    const v = stringValue(ts, p.initializer)
                    if (k && v != null) props[k] = v
                }
            }
            // API docs endpoint: one combined line.
            if (props.method && props.path && (props.label || props.desc)) {
                push(`${props.method} ${props.path}: ${props.label ?? ''}. ${props.desc ?? ''}`)
            } else if (props.event && props.when) {
                push(`Webhook ${props.event}: ${props.when}`)
            } else {
                for (const [k, v] of Object.entries(props)) if (KEYS.has(k)) push(v)
            }
            // Still walk into nested values (arrays of items, functions), but not re-emit these props.
            for (const p of node.properties) {
                if (ts.isPropertyAssignment(p) && stringValue(ts, p.initializer) != null) continue
                visit(p, inHeading)
            }
            return
        }

        if (ts.isCallExpression(node)) {
            const callee = node.expression.getText(sf)
            if (/^toast(\.\w+)?$/.test(callee) && node.arguments.length) {
                const v = stringValue(ts, node.arguments[0])
                if (v) push(v)
            }
        }

        ts.forEachChild(node, n => visit(n, inHeading))
    }

    visit(sf, false)
    return out
}

/**
 * Group extracted strings into searchable chunks of ~maxChars, each under the
 * most recent heading.
 */
export function chunkEntries(entries, base, maxChars = 600) {
    const chunks = []
    let heading = ''
    let buf = []
    let len = 0
    const flush = () => {
        if (!buf.length) return
        chunks.push({ ...base, heading, text: buf.join(' · ') })
        buf = []
        len = 0
    }
    for (const e of entries) {
        if (e.heading) {
            flush()
            heading = e.text.slice(0, 120)
            continue
        }
        if (len + e.text.length > maxChars) flush()
        buf.push(e.text)
        len += e.text.length + 3
    }
    flush()
    return chunks
}

/** app/dashboard/x/page.tsx -> /dashboard/x ; app/page.tsx -> / ; app/shop/[shopSlug]/about/page.tsx -> /shop/about */
export function routeFromPageFile(rel) {
    const p = rel.replace(/\\/g, '/').replace(/^app\//, '').replace(/(^|\/)page\.tsx$/, '')
    const parts = p.split('/').filter(Boolean).filter(seg => !/^\(.*\)$/.test(seg) && !/^\[.*\]$/.test(seg))
    return '/' + parts.join('/')
}

/** Which assistant surface may see a page's text. null = never indexed. */
export function surfaceForRoute(route) {
    if (route === '/admin' || route.startsWith('/admin/') || route.startsWith('/api') || route.startsWith('/portal')) return null
    if (route === '/shop' || route.startsWith('/shop/')) return 'storefront'
    return 'dashboard'
}
