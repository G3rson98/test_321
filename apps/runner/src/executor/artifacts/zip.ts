/**
 * Lector/escritor ZIP mínimo (sin dependencias) para sanitizar trazas de Playwright y el reporte HTML embebido
 * (ESP §13.7: "inspecciona JSON/HTML/ZIP"). Soporta métodos 0 (store) y 8 (deflate). ZIP64, cifrado y otros
 * métodos se rechazan: la evidencia que no puede inspeccionarse no se publica (RNF-SEG-02).
 */
import zlib from 'node:zlib';

export interface ZipEntry {
  name: string;
  data: Buffer;
  isDirectory: boolean;
}

export class ZipFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ZipFormatError';
  }
}

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;
const LOC_SIG = 0x04034b50;
const MAX_ENTRY_BYTES = 512 * 1024 * 1024;

export function isZip(buf: Buffer): boolean {
  return buf.length >= 4 && buf.readUInt32LE(0) === LOC_SIG;
}

export function readZip(buf: Buffer, maxTotalBytes = 1024 * 1024 * 1024): ZipEntry[] {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ZipFormatError('ZIP sin directorio central');
  const count = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdOffset === 0xffffffff) throw new ZipFormatError('ZIP64 no soportado');
  const entries: ZipEntry[] = [];
  let p = cdOffset;
  let total = 0;
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CEN_SIG) throw new ZipFormatError('Directorio central corrupto');
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString(flags & 0x800 ? 'utf8' : 'latin1', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    if (flags & 0x1) throw new ZipFormatError('ZIP cifrado no soportado');
    if (compSize === 0xffffffff || size === 0xffffffff || localOffset === 0xffffffff) throw new ZipFormatError('ZIP64 no soportado');
    if (size > MAX_ENTRY_BYTES) throw new ZipFormatError('Entrada ZIP demasiado grande');
    total += size;
    if (total > maxTotalBytes) throw new ZipFormatError('ZIP excede el tamaño descomprimido permitido');
    if (name.includes('..') || name.startsWith('/')) throw new ZipFormatError('Ruta ZIP con traversal');
    if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== LOC_SIG) throw new ZipFormatError('Cabecera local corrupta');
    const lNameLen = buf.readUInt16LE(localOffset + 26);
    const lExtraLen = buf.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(start, start + compSize);
    let data: Buffer;
    if (method === 0) data = Buffer.from(raw);
    else if (method === 8) data = zlib.inflateRawSync(raw, { maxOutputLength: Math.max(size, 1) });
    else throw new ZipFormatError(`Método de compresión ${method} no soportado`);
    if (data.length !== size) throw new ZipFormatError('Tamaño descomprimido inconsistente');
    entries.push({ name, data, isDirectory: name.endsWith('/') });
  }
  return entries;
}

function dosDateTime(d: Date): { time: number; date: number } {
  const year = Math.max(1980, d.getUTCFullYear());
  return {
    time: (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | Math.floor(d.getUTCSeconds() / 2),
    date: ((year - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate(),
  };
}

export function writeZip(entries: readonly ZipEntry[], now = new Date()): Buffer {
  const { time, date } = dosDateTime(now);
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const crc = zlib.crc32(e.data) >>> 0;
    const compressed = e.isDirectory || e.data.length === 0 ? Buffer.alloc(0) : zlib.deflateRawSync(e.data);
    const method = compressed.length === 0 ? 0 : 8;
    const loc = Buffer.alloc(30);
    loc.writeUInt32LE(LOC_SIG, 0);
    loc.writeUInt16LE(20, 4);
    loc.writeUInt16LE(0x800, 6);
    loc.writeUInt16LE(method, 8);
    loc.writeUInt16LE(time, 10);
    loc.writeUInt16LE(date, 12);
    loc.writeUInt32LE(crc, 14);
    loc.writeUInt32LE(compressed.length, 18);
    loc.writeUInt32LE(e.data.length, 22);
    loc.writeUInt16LE(name.length, 26);
    loc.writeUInt16LE(0, 28);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(CEN_SIG, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0x800, 8);
    cen.writeUInt16LE(method, 10);
    cen.writeUInt16LE(time, 12);
    cen.writeUInt16LE(date, 14);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(compressed.length, 20);
    cen.writeUInt32LE(e.data.length, 24);
    cen.writeUInt16LE(name.length, 28);
    cen.writeUInt32LE(offset, 42);
    locals.push(loc, name, compressed);
    centrals.push(cen, name);
    offset += loc.length + name.length + compressed.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(EOCD_SIG, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}
