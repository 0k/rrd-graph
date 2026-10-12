import { test } from 'vitest'
import assert from 'node:assert/strict'
import { formatValue } from '../src/utils/format.ts'

test('values use IEC for bytes and bytes/s, including negative and zero', () => {
  for (const [value, unit, expected] of [
    [0, 'bytes', '0 B'], [1024, 'bytes', '1 KiB'], [1536, 'bytes/s', '1.5 KiB/s'],
    [-1048576, 'bytes', '-1 MiB'], [1024 ** 3, 'bytes', '1 GiB'],
    [1024 ** 4, 'bytes', '1 TiB'],
  ]) assert.equal(formatValue(value, unit), expected)
})
test('other units use SI and plain numbers retain sensible precision', () => {
  for (const [value, unit, expected] of [
    [1500, 'widgets', '1.5 k widgets'], [2e6, 'Hz', '2 M Hz'],
    [3e9, '%', '3 G %'], [0.01234, null, '0.0123'], [12.3456, '', '12.3'],
    [null, 'bytes', '—'], [NaN, null, '—'],
  ]) assert.equal(formatValue(value, unit), expected)
})
