export interface ProbeFileRef {
  fileName: string;
  mimeType: string;
  assetId?: string;
}

export interface ProbeResolver {
  read(ref: ProbeFileRef): Promise<Uint8Array>;
}
