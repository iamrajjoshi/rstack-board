/**
 * Parses JSON as `T` without validating it. For JSON this tool wrote itself (API responses,
 * event rows, `server.json`) or was handed as a whole document; a wrong shape fails where a
 * missing field is first read.
 */
// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- the caller names the shape
export function parseJson<T>(text: string): T {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the one unchecked JSON boundary
  return JSON.parse(text) as T;
}
