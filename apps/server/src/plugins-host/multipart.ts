import { AppError } from '../errors.js';

// Just enough of multipart/form-data for one uploaded package and a few small fields. The body is
// already in memory (the route's body limit bounds it), so parts are located with plain searches.

export interface FormPart { name: string; filename?: string; data: Buffer }

const MAX_PARTS = 8;
const bad = (message: string) => new AppError('INVALID_INPUT', message);

export function boundaryOf(contentType: string): string | undefined {
  const match = /;\s*boundary=(?:"([^"]{1,200})"|([^;\s]{1,200}))/i.exec(contentType);
  return match?.[1] ?? match?.[2];
}

export function parseMultipart(body: Buffer, contentType: string): FormPart[] {
  const boundary = boundaryOf(contentType);
  if (!boundary) throw bad('The multipart body has no boundary');
  const delimiter = Buffer.from(`--${boundary}`);
  const parts: FormPart[] = [];
  let at = body.indexOf(delimiter);
  if (at < 0) throw bad('The multipart body is empty');
  for (;;) {
    at += delimiter.length;
    // `--` after a delimiter ends the body; otherwise a line break, then the part's headers.
    if (body.subarray(at, at + 2).toString('latin1') === '--') break;
    if (body.subarray(at, at + 2).toString('latin1') !== '\r\n') throw bad('The multipart body is damaged');
    at += 2;
    const headerEnd = body.indexOf('\r\n\r\n', at);
    if (headerEnd < 0) throw bad('The multipart body is damaged');
    const headers = body.subarray(at, headerEnd).toString('utf8');
    const next = body.indexOf(Buffer.concat([Buffer.from('\r\n'), delimiter]), headerEnd + 4);
    if (next < 0) throw bad('The multipart body is truncated');
    const disposition = /^content-disposition:\s*form-data;(.*)$/im.exec(headers)?.[1] ?? '';
    const name = /\bname="([^"]*)"/i.exec(disposition)?.[1];
    const filename = /\bfilename="([^"]*)"/i.exec(disposition)?.[1];
    if (name === undefined) throw bad('A multipart part has no name');
    if (parts.length >= MAX_PARTS) throw bad('The multipart body has too many parts');
    parts.push({ name, ...(filename !== undefined ? { filename } : {}), data: body.subarray(headerEnd + 4, next) });
    at = next + 2;
  }
  return parts;
}
