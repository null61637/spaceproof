"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import {
  MAX_FILE_BYTES,
  formatBytes,
  type Certificate,
} from "@/lib/certificates";
import { UploadError, fileProblem, uploadFile } from "@/lib/upload";
import { UploadProgress } from "./upload-progress";

const inputClass = "input";

// The required texts of the manifest, with the label used in messages.
const REQUIRED_TEXTS = [
  ["title", "Título"],
  ["recipient", "Destinatario"],
  ["satellite", "Satélite"],
] as const;

/** The value of <input type="datetime-local">, read as UTC, as an instant. */
function utcInstant(value: string): string | null {
  // "2026-01-01T14:00" or, with seconds, "2026-01-01T14:00:51".
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(value)) return null;
  const instant = `${value.length === 16 ? `${value}:00` : value}Z`;
  return Number.isNaN(Date.parse(instant)) ? null : instant;
}

export function CertificateForm() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  // null = idle; otherwise the fraction of the file sent so far.
  const [progress, setProgress] = useState<number | null>(null);
  const upload = useRef<AbortController | null>(null);
  const sending = progress !== null;

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (sending) return;
    setError(null);

    const data = new FormData(event.currentTarget);
    const text = (name: string) => String(data.get(name) ?? "").trim();

    const file = data.get("file");
    if (!(file instanceof File) || file.name === "") {
      return setError("Elegí el archivo .tif que querés certificar.");
    }
    for (const [name, label] of REQUIRED_TEXTS) {
      if (text(name) === "") return setError(`Completá el campo «${label}».`);
    }
    const acquiredAt = utcInstant(text("acquiredAt"));
    if (acquiredAt === null) {
      return setError("Indicá la fecha y la hora de adquisición.");
    }
    const problem = await fileProblem(file, { requireTiff: true });
    if (problem) return setError(problem);

    const controller = new AbortController();
    upload.current = controller;
    setProgress(0);
    try {
      const certificate = await uploadFile<Certificate>({
        url: "/api/certificates",
        file,
        metadata: {
          title: text("title"),
          recipient: text("recipient"),
          satellite: text("satellite"),
          // Optional: left out when empty, stored as "not declared".
          ...(text("sensor") && { sensor: text("sensor") }),
          ...(text("sceneId") && { sceneId: text("sceneId") }),
          acquiredAt,
          fileName: file.name,
        },
        onProgress: setProgress,
        signal: controller.signal,
      });
      // The certificate page shows the issued data and keeps its id in the URL.
      router.push(`/certificates/${certificate.id}`);
    } catch (failure) {
      setProgress(null);
      if (failure instanceof UploadError && failure.aborted) return;
      setError(
        failure instanceof UploadError
          ? failure.message
          : "No se pudo emitir el certificado. Intentá de nuevo.",
      );
    }
  }

  return (
    <form onSubmit={handleSubmit} noValidate className="flex flex-col gap-4">
      <Field
        label="Archivo"
        htmlFor="file"
        hint={`Un archivo .tif o .tiff de hasta ${formatBytes(MAX_FILE_BYTES)}. Solo se comprueba que tenga firma TIFF; no se valida su contenido.`}
      >
        <input
          id="file"
          name="file"
          type="file"
          accept=".tif,.tiff,image/tiff"
          required
          disabled={sending}
          className="file-input"
        />
      </Field>

      <Field label="Título" htmlFor="title">
        <input
          id="title"
          name="title"
          required
          maxLength={200}
          disabled={sending}
          className={inputClass}
        />
      </Field>

      <Field label="Destinatario" htmlFor="recipient">
        <input
          id="recipient"
          name="recipient"
          required
          maxLength={200}
          disabled={sending}
          className={inputClass}
        />
      </Field>

      <Field label="Satélite" htmlFor="satellite" hint="Por ejemplo, Sentinel-2A.">
        <input
          id="satellite"
          name="satellite"
          required
          maxLength={200}
          disabled={sending}
          className={inputClass}
        />
      </Field>

      <Field
        label="Fecha y hora de adquisición (UTC)"
        htmlFor="acquiredAt"
        hint="En hora universal (UTC), como figura en los metadatos del producto."
      >
        <input
          id="acquiredAt"
          name="acquiredAt"
          type="datetime-local"
          step={1}
          min="0001-01-01T00:00:00"
          max="9999-12-31T23:59:59"
          required
          disabled={sending}
          className={inputClass}
        />
      </Field>

      <Field label="Sensor (opcional)" htmlFor="sensor">
        <input
          id="sensor"
          name="sensor"
          maxLength={200}
          disabled={sending}
          className={inputClass}
        />
      </Field>

      <Field label="Identificador de escena (opcional)" htmlFor="sceneId">
        <input
          id="sceneId"
          name="sceneId"
          maxLength={200}
          disabled={sending}
          className={inputClass}
        />
      </Field>

      <p className="hint rounded-lg border border-line px-3 py-2.5">
        SpaceProof no guarda tu archivo: solo calcula su huella (SHA-256).
        Conservá el original para poder verificarlo después. Los metadatos son
        los que vos declarás: no se extraen del archivo ni se contrastan.
      </p>

      {error && (
        <p
          role="alert"
          className="alert-error"
        >
          {error}
        </p>
      )}

      {sending && <UploadProgress fraction={progress} />}

      <div className="flex gap-3">
        <button
          type="submit"
          disabled={sending}
          className="btn"
        >
          {sending ? "Certificando…" : "Certificar archivo"}
        </button>
        {sending && (
          <button
            type="button"
            onClick={() => upload.current?.abort()}
            className="btn-secondary"
          >
            Cancelar
          </button>
        )}
      </div>
    </form>
  );
}

function Field({
  label,
  htmlFor,
  hint,
  children,
}: {
  label: string;
  htmlFor: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={htmlFor} className="label">
        {label}
      </label>
      {children}
      {hint && (
        <p className="hint">{hint}</p>
      )}
    </div>
  );
}
