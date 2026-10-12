// Shared value formatting of graph values.
const numeric = new Intl.NumberFormat('en-US', { maximumSignificantDigits: 3, useGrouping: false })

export function formatValue(value: number | null, unit: string | null): string {
  if (value === null || !Number.isFinite(value)) return '—'
  const bytes = unit === 'bytes' || unit === 'bytes/s'
  const base = bytes ? 1024 : 1000
  const prefixes = bytes ? ['B', 'KiB', 'MiB', 'GiB', 'TiB'] : ['', 'k', 'M', 'G']
  let index = 0
  if (bytes || unit) {
    while (Math.abs(value) >= base && index < prefixes.length - 1) {
      value /= base
      index++
    }
  }
  const suffix = bytes
    ? `${prefixes[index]}${unit === 'bytes/s' ? '/s' : ''}`
    : unit ? `${prefixes[index] ? `${prefixes[index]} ` : ''}${unit}` : ''
  return `${numeric.format(value)}${suffix ? ` ${suffix}` : ''}`
}

export function formatDate(seconds: number): string {
  return new Date(seconds * 1000).toLocaleString()
}
