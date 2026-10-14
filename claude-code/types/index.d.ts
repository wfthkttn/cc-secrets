/** Masking replaced something this session, so `[secret]` in content may be a masked read. */
export type HasMasked = boolean

declare module 'claude-code' {
  interface PluginState {
    secrets: {
      hasMasked: HasMasked
    }
  }
}
