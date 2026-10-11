export type After = (ms: number, fn: () => void) => { cancel(): void }

/**
 * Which requests show as pop-out cards. A shown card hides after `ms` unless
 * it holds the focus; losing the focus starts the wait again.
 */
export class Popouts {
  private timers = new Map<string, { cancel(): void } | null>()
  private focused: string | null = null

  constructor(
    private readonly ms: number,
    private readonly after: After,
    private readonly changed: () => void,
  ) {}

  shown(): string[] {
    return [...this.timers.keys()]
  }

  add(id: string) {
    this.timers.set(id, null)
    this.wait(id)
    this.changed()
  }

  remove(id: string) {
    if (!this.timers.has(id)) return
    this.timers.get(id)?.cancel()
    this.timers.delete(id)
    if (this.focused === id) this.focused = null
    this.changed()
  }

  clear() {
    for (const timer of this.timers.values()) timer?.cancel()
    this.timers.clear()
    this.focused = null
    this.changed()
  }

  /** `id` took the keyboard; a request that isn't popped out still takes the focus from the others. */
  focus(id: string | null) {
    if (this.focused === id) return
    this.blur()
    this.focused = id
    if (id === null || !this.timers.has(id)) return
    this.timers.get(id)?.cancel()
    this.timers.set(id, null)
  }

  blur() {
    const was = this.focused
    this.focused = null
    if (was !== null && this.timers.has(was)) this.wait(was)
  }

  private wait(id: string) {
    this.timers.get(id)?.cancel()
    this.timers.set(
      id,
      this.after(this.ms, () => this.remove(id)),
    )
  }
}
