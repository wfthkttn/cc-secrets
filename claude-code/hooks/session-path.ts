/**
 * PATH with the daemon's `bin` first, and neither it nor `previous` (an earlier attach's bin, from a daemon since
 * restarted on another build) anywhere else.
 */
export function pathWith(path: string, bin: string, previous: string | null): string {
  const kept = path === '' ? [] : path.split(':').filter(dir => dir !== bin && dir !== previous)
  return [bin, ...kept].join(':')
}
