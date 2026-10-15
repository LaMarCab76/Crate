// Platform-neutral inspection of native shared libraries: CPU architectures
// (Mach-O / ELF / PE) and runtime dependencies. Shared by the verify scripts
// of every native component (Chromaprint, crate-audio).

import { spawnSync } from 'node:child_process'

function parseMachOArchitectures(header) {
  const magic = header.subarray(0, 4).toString('hex')
  const cpuName = (value) => value === 0x01000007 ? 'x64' : value === 0x0100000c ? 'arm64' : null

  if (magic === 'cffaedfe' || magic === 'feedfacf') {
    const littleEndian = magic === 'cffaedfe'
    const cpu = littleEndian ? header.readUInt32LE(4) : header.readUInt32BE(4)
    const name = cpuName(cpu)
    if (!name) throw new Error(`Unsupported Mach-O CPU type 0x${cpu.toString(16)}`)
    return [name]
  }

  if (!['cafebabe', 'bebafeca', 'cafebabf', 'bfbafeca'].includes(magic)) {
    throw new Error('Not a supported Mach-O or universal binary')
  }
  const littleEndian = magic === 'bebafeca' || magic === 'bfbafeca'
  const fat64 = magic === 'cafebabf' || magic === 'bfbafeca'
  const read32 = littleEndian ? header.readUInt32LE.bind(header) : header.readUInt32BE.bind(header)
  const count = read32(4)
  const stride = fat64 ? 32 : 20
  if (count === 0 || count > 16 || header.length < 8 + count * stride) {
    throw new Error('Invalid Mach-O universal header')
  }
  const result = []
  for (let index = 0; index < count; index++) {
    const name = cpuName(read32(8 + index * stride))
    if (name) result.push(name)
  }
  return [...new Set(result)]
}

function parseElfArchitectures(header) {
  if (!header.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) || header[4] !== 2) {
    throw new Error('Not a 64-bit ELF shared library')
  }
  const machine = header[5] === 2 ? header.readUInt16BE(18) : header.readUInt16LE(18)
  if (machine === 62) return ['x64']
  if (machine === 183) return ['arm64']
  throw new Error(`Unsupported ELF machine ${machine}`)
}

function parsePeArchitectures(header) {
  if (!header.subarray(0, 2).equals(Buffer.from('MZ')) || header.length < 64) {
    throw new Error('Not a Portable Executable')
  }
  const peOffset = header.readUInt32LE(0x3c)
  if (peOffset + 6 > header.length || !header.subarray(peOffset, peOffset + 4).equals(Buffer.from('PE\0\0'))) {
    throw new Error('Invalid Portable Executable header')
  }
  const machine = header.readUInt16LE(peOffset + 4)
  if (machine === 0x8664) return ['x64']
  if (machine === 0xaa64) return ['arm64']
  throw new Error(`Unsupported PE machine 0x${machine.toString(16)}`)
}

export function parseArchitectures(buffer, platform) {
  if (platform === 'darwin') return parseMachOArchitectures(buffer)
  if (platform === 'linux') return parseElfArchitectures(buffer)
  return parsePeArchitectures(buffer)
}

function peRvaToOffset(binary, sections, rva) {
  for (const section of sections) {
    const extent = Math.max(section.virtualSize, section.rawSize)
    if (rva >= section.virtualAddress && rva < section.virtualAddress + extent) {
      const offset = section.rawOffset + (rva - section.virtualAddress)
      if (offset >= 0 && offset < binary.length) return offset
    }
  }
  throw new Error(`PE import RVA 0x${rva.toString(16)} is outside every section`)
}

export function parsePeImports(binary) {
  const peOffset = binary.readUInt32LE(0x3c)
  const coffOffset = peOffset + 4
  const sectionCount = binary.readUInt16LE(coffOffset + 2)
  const optionalSize = binary.readUInt16LE(coffOffset + 16)
  const optionalOffset = coffOffset + 20
  const magic = binary.readUInt16LE(optionalOffset)
  const dataDirectoriesOffset = optionalOffset + (magic === 0x20b ? 112 : magic === 0x10b ? 96 : 0)
  if (dataDirectoriesOffset === optionalOffset) throw new Error('Unsupported PE optional-header format')
  const importRva = binary.readUInt32LE(dataDirectoriesOffset + 8)
  if (importRva === 0) return []

  const sections = []
  const sectionTable = optionalOffset + optionalSize
  for (let index = 0; index < sectionCount; index += 1) {
    const offset = sectionTable + index * 40
    if (offset + 40 > binary.length) throw new Error('Truncated PE section table')
    sections.push({
      virtualSize: binary.readUInt32LE(offset + 8),
      virtualAddress: binary.readUInt32LE(offset + 12),
      rawSize: binary.readUInt32LE(offset + 16),
      rawOffset: binary.readUInt32LE(offset + 20),
    })
  }

  const imports = []
  let descriptor = peRvaToOffset(binary, sections, importRva)
  for (let count = 0; count < 256; count += 1, descriptor += 20) {
    if (descriptor + 20 > binary.length) throw new Error('Truncated PE import table')
    const fields = Array.from({ length: 5 }, (_, index) => binary.readUInt32LE(descriptor + index * 4))
    if (fields.every(value => value === 0)) return imports
    const nameOffset = peRvaToOffset(binary, sections, fields[3])
    const terminator = binary.indexOf(0, nameOffset)
    if (terminator < 0 || terminator - nameOffset > 512) throw new Error('Invalid PE import name')
    imports.push(binary.toString('ascii', nameOffset, terminator))
  }
  throw new Error('PE import table exceeds the safety limit')
}

export function readRuntimeDependencies(platform, libraryPath, binary, label) {
  if (platform === 'win32') return parsePeImports(binary)
  const command = platform === 'darwin' ? 'otool' : 'readelf'
  const args = platform === 'darwin' ? ['-L', libraryPath] : ['-d', libraryPath]
  const result = spawnSync(command, args, { encoding: 'utf8' })
  if (result.error || result.status !== 0) {
    throw new Error(`Unable to inspect ${label} runtime dependencies with ${command}: ${result.stderr || result.error?.message || 'unknown error'}`)
  }
  if (platform === 'darwin') {
    return result.stdout
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(line => line && !line.endsWith(':') && !line.includes('(architecture '))
      .map(line => line.replace(/\s+\(compatibility version.*$/, ''))
  }
  return [...result.stdout.matchAll(/\(NEEDED\)\s+Shared library: \[([^\]]+)\]/g)]
    .map(match => match[1])
}
