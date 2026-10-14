import fs from 'node:fs';

/**
 * Reads up to `maxBytes` of a regular file and reports its full size. A named pipe, a
 * device or a folder is refused without blocking: reading a pipe waits for a writer
 * forever, and /dev/zero never ends. Throws when the file cannot be read.
 */
export function readRegularFile(file: string, maxBytes: number): { text: string; size: number } {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0));
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw new Error('not a regular file');
    const buf = Buffer.alloc(Math.min(stat.size, maxBytes));
    let got = 0;
    while (got < buf.length) {
      const n = fs.readSync(fd, buf, got, buf.length - got, got);
      if (n === 0) break;
      got += n;
    }
    return { text: buf.subarray(0, got).toString('utf8'), size: stat.size };
  } finally {
    fs.closeSync(fd);
  }
}
