export function backend(): 'native' | 'wasm'

export function zstd_compress(data: Uint8Array, level: number): Uint8Array

export class DDSketch {
  add(point: number): void
  addWithCount(point: number, count: number): void
  count(): number
  encode(): Uint8Array
}
