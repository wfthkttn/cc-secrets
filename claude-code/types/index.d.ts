/** Masking replaced something this session, so `[secret]` in content may be a masked read. */
export type HasMasked = boolean
/** An earlier load of this session attached to the daemon, so what it guarded is still to be guarded. */
export type WasAttached = boolean

declare module 'claude-code' {
  interface PluginState {
    'cc-secrets': {
      hasMasked: HasMasked
      wasAttached: WasAttached
    }
  }
}
