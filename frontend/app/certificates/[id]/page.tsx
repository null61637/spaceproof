import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { ApiError, getCertificate } from "@/lib/api";
import { formatBytes, formatDate, formatUtc } from "@/lib/certificates";
import { AnchorStatus } from "./anchor-status";
import { VerifyFile } from "./verify-file";

export default function CertificatePage({
  params,
}: PageProps<"/certificates/[id]">) {
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-8 px-4 py-10 sm:px-6 sm:py-14">
      <Link href="/" className="hint hover:text-foreground">
        ← Todos los certificados
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
    <article className="flex flex-col gap-10">
      <header className="flex flex-col gap-2">
        <p className="eyebrow">Certificado de integridad</p>
        <h1 className="text-3xl font-semibold tracking-tight break-words sm:text-4xl">
          {certificate.title}
        </h1>
        <p className="text-muted">
          Emitido a {certificate.recipient} ·{" "}
          <time dateTime={certificate.createdAt}>
            {formatDate(certificate.createdAt)}
          </time>
        </p>
      </header>

      <AnchorStatus certificateId={certificate.id} />

      <section aria-labelledby="verify" className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <h2 id="verify" className="text-xl font-semibold">
            Verificar un archivo
          </h2>
          <p className="text-sm text-muted">
            {hasFile
              ? "Subí el archivo para comprobar si es, bit a bit, el que se certificó."
              : "Este certificado se emitió antes de que SpaceProof certificara archivos: cubre solo el título y el destinatario, y no tiene un archivo contra el cual verificar."}
          </p>
        </div>
        {hasFile && (
          <div className="card p-5">
            <VerifyFile certificateId={certificate.id} />
          </div>
        )}
      </section>

      <section aria-labelledby="details" className="flex flex-col gap-4">
        <h2 id="details" className="text-xl font-semibold">
          Qué se certificó
        </h2>
        <dl className="card grid gap-x-6 gap-y-4 p-5 text-sm sm:grid-cols-[11rem_1fr]">
          <Row label="ID del certificado">
            <code className="hash">{certificate.id}</code>
            <p className="hint mt-1">
              Guardá este identificador o la dirección de esta página: lo vas
              a necesitar para verificar el archivo.
            </p>
          </Row>
          {hasFile && (
            <>
              <Row label="Archivo">
                <span className="break-all">
                  {certificate.fileName ?? "Sin nombre"}
                </span>
                {certificate.fileSizeBytes !== null && (
                  <span className="text-muted">
                    {" "}
                    · {formatBytes(certificate.fileSizeBytes)}
                  </span>
                )}
              </Row>
              <Row label="SHA-256 del archivo">
                <code className="hash">{certificate.fileSha256}</code>
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
            <code className="hash">{certificate.contentHash}</code>
            <p className="hint mt-1">
              {hasFile
                ? "Une el archivo con los metadatos. Es el único dato que se registra en Avalanche."
                : "Es el único dato que se registra en Avalanche."}{" "}
              <a
                href={`/api/certificates/${certificate.id}/manifest`}
                target="_blank"
                rel="noreferrer"
                className="link"
              >
                Ver el manifiesto
              </a>
            </p>
          </Row>
        </dl>
      </section>

      <section
        aria-labelledby="scope"
        className="flex flex-col gap-2 text-sm text-muted"
      >
        <h2 id="scope" className="text-base font-semibold text-foreground">
          Qué prueba este certificado
        </h2>
        <p>
          Que un archivo y los metadatos de arriba coinciden, bit a bit, con
          lo que se certificó en la fecha de emisión, y que la huella de ese
          conjunto está registrada en un contrato público.
        </p>
        <p>No prueba, por sí mismo:</p>
        <ul className="list-disc pl-5">
          <li>que el archivo provenga realmente de un satélite;</li>
          <li>que los metadatos declarados sean verdaderos;</li>
          <li>quién produjo originalmente la imagen.</li>
        </ul>
        <p>
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
      <dt className="text-muted">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </>
  );
}

function Absent({ children }: { children: React.ReactNode }) {
  return <span className="text-muted">{children}</span>;
}

function DetailSkeleton() {
  return (
    <div
      role="status"
      aria-label="Cargando certificado"
      className="flex flex-col gap-4"
    >
      <div className="skeleton h-10 w-2/3" />
      <div className="skeleton h-28" />
      <div className="skeleton h-40" />
    </div>
  );
}
