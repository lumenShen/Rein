type OverlayHandler = (e: KeyboardEvent) => void

const stack: OverlayHandler[] = []
let listening = false

function onKeydown(e: KeyboardEvent): void {
  stack[stack.length - 1]?.(e)
}

function syncListener(): void {
  if (stack.length > 0 && !listening) {
    window.addEventListener('keydown', onKeydown)
    listening = true
  } else if (stack.length === 0 && listening) {
    window.removeEventListener('keydown', onKeydown)
    listening = false
  }
}

export function pushOverlay(handler: OverlayHandler): () => void {
  stack.push(handler)
  syncListener()
  return () => {
    const i = stack.indexOf(handler)
    if (i >= 0) stack.splice(i, 1)
    syncListener()
  }
}
