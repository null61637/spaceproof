import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { ApiError, getCertificate } from "@/lib/api";
import { formatBytes, formatDate, formatUtc } from "@/lib/certificates";
import { VerifyFile } from "./verify-file";

export default function CertificatePage({
  params,
}: PageProps<"/certificates/[id]">) {
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-6 px-4 py-10 sm:px-6">
      <Link
        href="/"
        className="text-sm text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
      >
        ← Volver a certificados
      </Link>
      <Suspense fallback={<DetailSkeleton />}>
        <CertificateDetail params={params} />
      </Suspense>
    </main>
  );
}

async function CertificateDetail({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  let certificate;
  try {
    certificate = await getCertificate(id);
  } catch (error) {
    // 400 = malformed id, 404 = unknown id: both mean "no such certificate".
    if (error instanceof ApiError && [400, 404].includes(error.status)) {
      notFound();
    }
    throw error;
  }
  // Certificates issued before files existed (hash version 1) have none.
  const hasFile = certificate.fileSha256 !== null;

  return (
    <article className="flex flex-col gap-8">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold break-words">
          {certificate.title}
        </h1>
        <p className="text-zinc-500 dark:text-zinc-400">
          Emitido a {certificate.recipient}
        </p>
      </header>

      <dl className="grid gap-4 rounded-lg border border-zinc-200 p-4 text-sm sm:grid-cols-[11rem_1fr] dark:border-zinc-800">
        <Row label="ID del certificado">
          <code className="font-mono break-all">{certificate.id}</code>
          <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
            Guardá este identificador o la dirección de esta página: lo vas a
            necesitar para verificar el archivo.
          </p>
        </Row>
        <Row label="Fecha de emisión">
          <time dateTime={certificate.createdAt}>
            {formatDate(certificate.createdAt)}
          </time>
        </Row>
        {hasFile && (
          <>
            <Row label="Archivo">
              <span className="break-all">
                {certificate.fileName ?? "Sin nombre"}
              </span>
              {certificate.fileSizeBytes !== null && (
                <span className="text-zinc-500 dark:text-zinc-400">
                  {" "}
                  · {formatBytes(certificate.fileSizeBytes)}
                </span>
              )}
            </Row>
            <Row label="SHA-256 del archivo">
              <code className="font-mono break-all">
                {certificate.fileSha256}
              </code>
            </Row>
            <Row label="Satélite (declarado)">{certificate.satellite}</Row>
            <Row label="Sensor (declarado)">
              {certificate.sensor ?? <Absent>No declarado</Absent>}
            </Row>
            <Row label="Escena (declarada)">
              {certificate.sceneId ?? <Absent>No declarada</Absent>}
            </Row>
            <Row label="Adquisición (declarada)">
              {certificate.acquiredAt && (
                <time dateTime={certificate.acquiredAt}>
                  {formatUtc(certificate.acquiredAt)}
                </time>
              )}
            </Row>
          </>
        )}
        <Row label={hasFile ? "Hash del manifiesto" : "Hash SHA-256"}>
          <code className="font-mono break-all">{certificate.contentHash}</code>
          {hasFile && (
            <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
              Vincula el archivo con los metadatos: es el hash que se
              registrará en Avalanche.
            </p>
          )}
        </Row>
        <Row label="Registro en Avalanche">
          <Absent>
            Integración pendiente: este certificado todavía no está registrado
            en la blockchain.
          </Absent>
        </Row>
      </dl>

      <section aria-labelledby="verify" className="flex flex-col gap-3">
        <h2 id="verify" className="text-lg font-semibold">
          Verificar un archivo
        </h2>
        {hasFile ? (
          <>
            <p className="text-sm text-zinc-600 dark:text-zinc-300">
              Volvé a subir el archivo para comprobar si es, bit a bit, el que
              se certificó.
            </p>
            <VerifyFile certificateId={certificate.id} />
          </>
        ) : (
          <p className="text-sm text-zinc-600 dark:text-zinc-300">
            Este certificado se emitió antes de que SpaceProof certificara
            archivos: cubre solo el título y el destinatario, y no tiene un
            archivo contra el cual verificar.
          </p>
        )}
      </section>

      <section
        aria-labelledby="scope"
        className="flex flex-col gap-2 rounded-lg border border-zinc-200 p-4 text-sm dark:border-zinc-800"
      >
        <h2 id="scope" className="text-base font-semibold">
          Qué prueba este certificado
        </h2>
        <p>
          Que un archivo y los metadatos de arriba coinciden, bit a bit, con lo
          que se certificó en la fecha de emisión.
        </p>
        <p>No prueba, por sí mismo:</p>
        <ul className="list-disc pl-5">
          <li>que el archivo provenga realmente de un satélite;</li>
          <li>que los metadatos declarados sean verdaderos;</li>
          <li>quién produjo originalmente la imagen.</li>
        </ul>
        <p className="text-zinc-500 dark:text-zinc-400">
          Tampoco valida el formato: solo se comprobó que el archivo tuviera
          firma TIFF. SpaceProof no conserva el archivo original.
        </p>
      </section>
    </article>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="font-medium text-zinc-500 dark:text-zinc-400">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </>
  );
}

function Absent({ children }: { children: React.ReactNode }) {
  return <span className="text-zinc-500 dark:text-zinc-400">{children}</span>;
}

function DetailSkeleton() {
  return (
    <div
      role="status"
      aria-label="Cargando certificado"
      className="flex flex-col gap-4"
    >
      <div className="h-8 w-2/3 animate-pulse rounded bg-zinc-100 dark:bg-zinc-900" />
      <div className="h-40 animate-pulse rounded-lg bg-zinc-100 dark:bg-zinc-900" />
    </div>
  );
}
