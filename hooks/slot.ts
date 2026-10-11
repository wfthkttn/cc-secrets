type Element = { type?: unknown; props?: { key?: unknown }; children?: unknown[] }

/**
 * The tree with the Box keyed `key` given `content` as its only child; the
 * same tree when no such Box is in it. Copies the path to the Box, since
 * render trees are frozen.
 */
export function fillSlot(tree: unknown, key: string, content: () => unknown): unknown {
  return fill(tree, key, content) ?? tree
}

export function hasSlot(tree: unknown, key: string): boolean {
  if (tree === null || typeof tree !== 'object') return false
  const element = tree as Element
  if (element.props?.key === key) return true
  return Array.isArray(element.children) && element.children.some(child => hasSlot(child, key))
}

function fill(node: unknown, key: string, content: () => unknown): unknown {
  if (node === null || typeof node !== 'object') return undefined
  const element = node as Element
  if (element.props?.key === key) return { ...element, children: [content()] }
  if (!Array.isArray(element.children)) return undefined
  for (let i = 0; i < element.children.length; i++) {
    const filled = fill(element.children[i], key, content)
    if (filled !== undefined) {
      const children = [...element.children]
      children[i] = filled
      return { ...element, children }
    }
  }
  return undefined
}
