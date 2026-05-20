const SCROLLING_CLASS = 'scrolling'
const SCROLL_IDLE_MS = 700

function getScrollElement(target: EventTarget | null, root: Document): Element | null {
  if (target === root) return root.scrollingElement ?? root.documentElement
  if (target instanceof Element) return target
  return null
}

export function installAutoHideScrollbars(root: Document = document): () => void {
  const activeElements = new Set<Element>()
  const timers = new WeakMap<Element, number>()

  const clear = (element: Element) => {
    element.classList.remove(SCROLLING_CLASS)
    activeElements.delete(element)
    timers.delete(element)
  }

  const onScroll = (event: Event) => {
    const element = getScrollElement(event.target, root)
    if (!element) return

    element.classList.add(SCROLLING_CLASS)
    activeElements.add(element)

    const existingTimer = timers.get(element)
    if (existingTimer != null) window.clearTimeout(existingTimer)

    timers.set(element, window.setTimeout(() => clear(element), SCROLL_IDLE_MS))
  }

  root.addEventListener('scroll', onScroll, { capture: true, passive: true })

  return () => {
    root.removeEventListener('scroll', onScroll, true)
    activeElements.forEach(element => {
      const timer = timers.get(element)
      if (timer != null) window.clearTimeout(timer)
      clear(element)
    })
  }
}
