/** Masking replaced something this session, so `[secret]` in content may be a masked read. */
export type HasMasked = boolean

/** The session's ssh-agent forwarding as last switched in the Config tab; unset until then. */
export type Forward = boolean

declare module 'claude-code' {
  interface PluginState {
    secrets: {
      hasMasked: HasMasked
      forward: Forward
    }
  }
}
