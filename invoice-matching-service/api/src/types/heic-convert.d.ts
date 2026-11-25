// heic-convert ships no types: this is the one call we use (reader/file-prep.ts turns iPhone photos into JPEG).
declare module "heic-convert" {
  function convert(options: {
    buffer: Buffer | ArrayBuffer | Uint8Array;
    format: "JPEG" | "PNG";
    quality?: number;
  }): Promise<ArrayBuffer>;
  export default convert;
}
