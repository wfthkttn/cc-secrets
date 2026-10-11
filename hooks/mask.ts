const values = new Set<string>()

/** A value shorter than `minLength` characters is left unmasked: it would turn up in ordinary text. */
export function remember(value: string, minLength: number) {
  if ([...value].length >= minLength) values.add(value)
}

export function mask(text: string): string {
  let out = text
  for (const value of values) out = out.split(value).join('[secret]')
  return out
}
