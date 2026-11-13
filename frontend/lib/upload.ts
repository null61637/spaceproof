import {
  MAX_FILE_BYTES,
  errorMessage,
  formatBytes,
  type CertificateMetadata,
} from "./certificates";

// Browser-side: sends a file to the two file routes of the API, as the raw
// request body (Content-Type image/tiff). Contract:
// docs/API_EMISION_VERIFICACION.md.

export class UploadError extends Error {
  constructor(
    /** HTTP status; 0 when no response arrived. */
    readonly status: number,
    message: string,
    readonly aborted = false,
  ) {
    super(message);
  }
}

// The four signatures the backend accepts: classic TIFF and BigTIFF, both
// byte orders. Only these 4 bytes are checked, here and on the server.
const TIFF_SIGNATURES = ["49492a00", "4d4d002a", "49492b00", "4d4d002b"];

/**
 * Checks, before uploading, what the server would reject anyway. Returns the
 * message to show, or null when the file can be sent.
 */
export async function fileProblem(
  file: File,
  { requireTiff }: { requireTiff: boolean },
): Promise<string | null> {
  if (file.size === 0) return "El archivo está vacío.";
  if (file.size > MAX_FILE_BYTES) {
    return `El archivo pesa ${formatBytes(file.size)} y el máximo es ${formatBytes(MAX_FILE_BYTES)}.`;
  }
  if (!requireTiff) return null;
  if (!/\.tiff?$/i.test(file.name)) {
    return "El archivo debe tener extensión .tif o .tiff.";
  }
  const head = new Uint8Array(await file.slice(0, 4).arrayBuffer());
  const signature = Array.from(head, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  if (!TIFF_SIGNATURES.includes(signature)) {
    return "El archivo no tiene firma TIFF: no parece ser un .tif.";
  }
  return null;
}

/** base64url of the UTF-8 JSON, as X-SpaceProof-Metadata expects. */
export function encodeMetadata(metadata: CertificateMetadata): string {
  const bytes = new TextEncoder().encode(JSON.stringify(metadata));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

// What to tell the user for each way a file route can fail.
function failureMessage(status: number, body: unknown): string {
  const detail = errorMessage(body, status);
  switch (status) {
    case 400:
      return `El servidor rechazó los datos enviados: ${detail}.`;
    case 404:
      return "Este certificado no existe.";
    case 408:
      return "La subida tardó más de cinco minutos y el servidor la interrumpió. Probá con una conexión más rápida o con un archivo más chico.";
    case 409:
      return "Este certificado no tiene un archivo asociado: no se puede verificar contra un archivo.";
    case 413:
      return `El archivo supera el máximo de ${formatBytes(MAX_FILE_BYTES)}.`;
    case 415:
      return "El archivo no tiene firma TIFF: no parece ser un .tif.";
    case 502:
    case 503:
    case 504:
      return "El servicio no está disponible en este momento. Intentá de nuevo en unos minutos.";
    default: {
      const requestId = (body as { requestId?: unknown } | null)?.requestId;
      return typeof requestId === "string"
        ? `Ocurrió un error en el servidor (referencia ${requestId}). Intentá de nuevo.`
        : "Ocurrió un error en el servidor. Intentá de nuevo.";
    }
  }
}

/**
 * POSTs a file as the request body and resolves with the JSON answer.
 * XMLHttpRequest, not fetch: it is what reports upload progress.
 */
export function uploadFile<T>({
  url,
  file,
  metadata,
  onProgress,
  signal,
}: {
  url: string;
  file: File;
  metadata?: CertificateMetadata;
  /** Fraction of the file sent so far, from 0 to 1. */
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
}): Promise<T> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url);
    xhr.responseType = "json";
    xhr.setRequestHeader("Content-Type", "image/tiff");
    if (metadata) {
      xhr.setRequestHeader("X-SpaceProof-Metadata", encodeMetadata(metadata));
    }
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress?.(event.loaded / event.total);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300 && xhr.response !== null) {
        resolve(xhr.response as T);
      } else {
        reject(
          new UploadError(xhr.status, failureMessage(xhr.status, xhr.response)),
        );
      }
    };
    xhr.onerror = () =>
      reject(
        new UploadError(
          0,
          "No se pudo completar la subida: se cortó la conexión con el servidor. Intentá de nuevo.",
        ),
      );
    xhr.onabort = () => reject(new UploadError(0, "Subida cancelada.", true));
    signal?.addEventListener("abort", () => xhr.abort(), { once: true });
    xhr.send(file);
  });
}
