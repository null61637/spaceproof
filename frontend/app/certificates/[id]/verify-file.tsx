"use client";

import { useRef, useState } from "react";
import {
  MAX_FILE_BYTES,
  formatBytes,
  formatDate,
  type Verification,
} from "@/lib/certificates";
import { UploadError, fileProblem, uploadFile } from "@/lib/upload";
import { UploadProgress } from "../../upload-progress";

type Tone = "ok" | "bad" | "unknown";

const toneClass: Record<Tone, string> = {
  ok: "border-emerald-300 bg-emerald-50 text-emerald-950 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-100",
  bad: "border-red-300 bg-red-50 text-red-950 dark:border-red-800 dark:bg-red-950 dark:text-red-100",
  unknown:
    "border-amber-300 bg-amber-50 text-amber-950 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100",
};

// One message per result of the API (docs/API_EMISION_VERIFICACION.md). The
// words are about integrity only: matching the certificate says nothing about
// where the file comes from or who made it.
function describe(result: Verification): {
  tone: Tone;
  title: string;
  text: string;
} {
  switch (result.reason) {
    case "FILE_MISMATCH":
      return {
        tone: "bad",
        title: "Archivo alterado o distinto",
        text: "Este archivo no coincide con el que se certificó: fue modificado o es otro archivo.",
      };
    case "RECORD_MISMATCH":
      return {
        tone: "bad",
        title: "Manifiesto alterado",
        text: "Los datos guardados de este certificado no coinciden con su hash: el registro fue alterado después de emitirse.",
      };
    case "NOT_ANCHORED":
      return {
        tone: "unknown",
        title: "Coincide, pero todavía no está registrado en Avalanche",
        text: "El archivo y el manifiesto coinciden con lo certificado en SpaceProof. Avalanche respondió que el hash del certificado todavía no está registrado.",
      };
    case "ANCHOR_NOT_CONFIGURED":
      return {
        tone: "unknown",
        title: "No verificable en Avalanche: integración pendiente",
        text: "El archivo y el manifiesto coinciden con lo guardado en SpaceProof, pero el registro en Avalanche todavía no está disponible. Sin esa comprobación independiente, esto no es una verificación completa.",
      };
    case "ANCHOR_UNAVAILABLE":
      return {
        tone: "unknown",
        title: "No verificable en Avalanche: sin respuesta",
        text: "El archivo y el manifiesto coinciden con lo guardado en SpaceProof, pero no se pudo consultar Avalanche. Sin esa comprobación, esto no es una verificación completa. Intentá de nuevo en unos minutos.",
      };
    case null:
      break;
  }
  if (result.status === "VALID") {
    return {
      tone: "ok",
      title: "Integridad verificada",
      text: `El archivo y sus metadatos coinciden, bit a bit, con lo que se certificó, y el hash del certificado está registrado en Avalanche${
        result.anchoredAt ? ` desde el ${formatDate(result.anchoredAt)}` : ""
      }.`,
    };
  }
  // A status this interface does not know is never shown as a success.
  return {
    tone: "unknown",
    title: "Resultado no reconocido",
    text: "El servidor devolvió un resultado que esta página no sabe interpretar.",
  };
}

const CHECK_TEXT: Record<string, string> = {
  MATCH: "coincide",
  MISMATCH: "no coincide",
  NOT_CHECKED: "no se comprobó",
  ANCHORED: "registrado",
  NOT_ANCHORED: "no registrado",
  NOT_CONFIGURED: "integración pendiente",
  UNAVAILABLE: "sin respuesta",
};

export function VerifyFile({ certificateId }: { certificateId: string }) {
  const [result, setResult] = useState<Verification | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const upload = useRef<AbortController | null>(null);
  const sending = progress !== null;

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (sending) return;
    setError(null);
    setResult(null);

    const file = new FormData(event.currentTarget).get("file");
    if (!(file instanceof File) || file.name === "") {
      return setError("Elegí el archivo que querés comprobar.");
    }
    // No TIFF check here: an altered file must be reported as altered.
    const problem = await fileProblem(file, { requireTiff: false });
    if (problem) return setError(problem);

    const controller = new AbortController();
    upload.current = controller;
    setProgress(0);
    try {
      setResult(
        await uploadFile<Verification>({
          url: `/api/certificates/${encodeURIComponent(certificateId)}/verify-file`,
          file,
          onProgress: setProgress,
          signal: controller.signal,
        }),
      );
    } catch (failure) {
      if (!(failure instanceof UploadError && failure.aborted)) {
        setError(
          failure instanceof UploadError
            ? failure.message
            : "No se pudo verificar el archivo. Intentá de nuevo.",
        );
      }
    } finally {
      setProgress(null);
    }
  }

  const outcome = result && describe(result);

  return (
    <div className="flex flex-col gap-4">
      <form onSubmit={handleSubmit} noValidate className="flex flex-col gap-3">
        <label htmlFor="verify-file" className="text-sm font-medium">
          Archivo a comprobar
        </label>
        <input
          id="verify-file"
          name="file"
          type="file"
          required
          disabled={sending}
          className="w-full text-sm file:mr-3 file:rounded-md file:border-0 file:bg-zinc-100 file:px-3 file:py-2 file:text-sm file:font-medium hover:file:bg-zinc-200 dark:file:bg-zinc-800 dark:hover:file:bg-zinc-700"
        />
        <p className="text-xs text-zinc-500 dark:text-zinc-400">
          Hasta {formatBytes(MAX_FILE_BYTES)}. El archivo se usa solo para
          calcular su huella: no se guarda.
        </p>

        {sending && <UploadProgress fraction={progress} />}

        <div className="flex gap-3">
          <button
            type="submit"
            disabled={sending}
            className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
          >
            {sending ? "Verificando…" : "Verificar archivo"}
          </button>
          {sending && (
            <button
              type="button"
              onClick={() => upload.current?.abort()}
              className="rounded-md border border-zinc-300 px-4 py-2 text-sm font-medium transition-colors hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-900"
            >
              Cancelar
            </button>
          )}
        </div>
      </form>

      {error && (
        <p
          role="alert"
          className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200"
        >
          {error}
        </p>
      )}

      {result && outcome && (
        <div
          role="status"
          aria-live="polite"
          className={`flex flex-col gap-2 rounded-lg border p-4 ${toneClass[outcome.tone]}`}
        >
          <p className="text-base font-semibold">{outcome.title}</p>
          <p className="text-sm">{outcome.text}</p>

          <ul className="text-sm">
            <li>Archivo: {CHECK_TEXT[result.checks.file]}</li>
            <li>Manifiesto: {CHECK_TEXT[result.checks.record]}</li>
            <li>Registro en Avalanche: {CHECK_TEXT[result.checks.anchor]}</li>
          </ul>

          <details className="text-xs">
            <summary className="cursor-pointer font-medium">
              Detalle técnico
            </summary>
            <dl className="mt-2 flex flex-col gap-2">
              {result.file && (
                <>
                  <Hash
                    label="SHA-256 del archivo certificado"
                    value={result.file.storedSha256}
                  />
                  <Hash
                    label={`SHA-256 del archivo recibido (${formatBytes(result.file.receivedSizeBytes)})`}
                    value={result.file.receivedSha256}
                  />
                </>
              )}
              <Hash
                label="Hash del manifiesto guardado"
                value={result.storedHash}
              />
              <Hash
                label="Hash del manifiesto recalculado"
                value={result.computedHash}
              />
            </dl>
          </details>
        </div>
      )}
    </div>
  );
}

function Hash({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="font-medium">{label}</dt>
      <dd>
        <code className="font-mono break-all">{value}</code>
      </dd>
    </div>
  );
}
