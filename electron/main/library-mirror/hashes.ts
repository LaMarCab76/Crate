import { createHash, type Hash } from 'node:crypto'

const QUICK_XOR_WIDTH_BITS = 160
const QUICK_XOR_SHIFT = 11
const QUICK_XOR_BYTES = QUICK_XOR_WIDTH_BITS / 8

/** Streaming implementation of Microsoft's QuickXorHash (base64 output). */
export class QuickXorHasher {
  private readonly state = new Uint8Array(QUICK_XOR_BYTES)
  private length = 0n

  update(chunk: Uint8Array): this {
    for (let index = 0; index < chunk.byteLength; index++) {
      const absoluteIndex = this.length + BigInt(index)
      const shift = Number((absoluteIndex * BigInt(QUICK_XOR_SHIFT)) % BigInt(QUICK_XOR_WIDTH_BITS))
      const byteIndex = Math.floor(shift / 8)
      const bitOffset = shift % 8
      const value = chunk[index]
      this.state[byteIndex] ^= (value << bitOffset) & 0xff
      if (bitOffset !== 0) {
        this.state[(byteIndex + 1) % QUICK_XOR_BYTES] ^= value >>> (8 - bitOffset)
      }
    }
    this.length += BigInt(chunk.byteLength)
    return this
  }

  digest(): string {
    const result = Uint8Array.from(this.state)
    let length = this.length
    for (let index = 0; index < 8; index++) {
      result[QUICK_XOR_BYTES - 8 + index] ^= Number(length & 0xffn)
      length >>= 8n
    }
    return Buffer.from(result).toString('base64')
  }
}

export interface MirrorHashers {
  sha256: Hash
  quickXor: QuickXorHasher
}

export function createMirrorHashers(): MirrorHashers {
  return { sha256: createHash('sha256'), quickXor: new QuickXorHasher() }
}

export function updateMirrorHashers(hashers: MirrorHashers, chunk: Uint8Array): void {
  hashers.sha256.update(chunk)
  hashers.quickXor.update(chunk)
}

export function digestMirrorHashers(hashers: MirrorHashers): { sha256: string; quickXorHash: string } {
  return {
    sha256: hashers.sha256.digest('hex'),
    quickXorHash: hashers.quickXor.digest(),
  }
}
