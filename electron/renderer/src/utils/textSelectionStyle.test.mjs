import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const css = readFileSync(new URL('../styles/globals.css', import.meta.url), 'utf8').replace(/\r\n/g, '\n')

function cssBlock(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = css.match(new RegExp(`${escaped}\\s*\\{(?<body>[^}]*)\\}`))
  assert.ok(match?.groups?.body, `Missing CSS block for ${selector}`)
  return match.groups.body
}

function declaration(block, property) {
  const escaped = property.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = block.match(new RegExp(`(?:^|\\n)\\s*${escaped}\\s*:\\s*(?<value>[^;]+);`))
  assert.ok(match?.groups?.value, `Missing ${property} declaration`)
  return match.groups.value.trim()
}

test('desktop chrome text cannot be selected accidentally', () => {
  const document = cssBlock('html, body')

  assert.equal(declaration(document, '-webkit-user-select'), 'none')
  assert.equal(declaration(document, 'user-select'), 'none')
})

test('editable fields retain normal text selection', () => {
  const editable = cssBlock('input,\ntextarea,\n[contenteditable]:not([contenteditable="false"])')

  assert.equal(declaration(editable, '-webkit-user-select'), 'text')
  assert.equal(declaration(editable, 'user-select'), 'text')
})
